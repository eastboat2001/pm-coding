import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Script, createContext } from "node:vm";
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(['"])([^'"]+)\1/i;
const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(['"])([^'"]+)\1/i;
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(['"])([^'"]*)\1/i;
const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*(['"])([^'"]*)\1/i;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const DATA_ATTRIBUTE_PATTERN = /\bdata-([a-z0-9_.:-]+)\s*=\s*(['"])([^'"]*)\2/gi;
const DEFAULT_SCRIPT_TIMEOUT_MS = 500;
const MAX_TIMER_FLUSH = 50;
export async function runStaticPreviewSmokeGate(input) {
    const indexPath = input.indexFile ? join(input.serveRoot, input.indexFile) : join(input.serveRoot, "index.html");
    const errors = [];
    const warnings = [];
    const checkedFiles = [];
    if (!existsSync(indexPath)) {
        return {
            valid: false,
            errors: [`Runtime smoke gate requires index.html at ${indexPath}.`],
            warnings,
            checkedFiles,
        };
    }
    const html = readFileSync(indexPath, "utf8");
    checkedFiles.push(relativeCheckedPath(input.serveRoot, indexPath));
    const scripts = readScripts(input.serveRoot, html, errors, warnings);
    checkedFiles.push(...scripts.map((script) => script.label));
    const runtime = new SmokeRuntime(html, new Map(scripts.map((script) => [script.label, script.content])));
    const context = runtime.context();
    const timeout = input.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    for (const script of scripts) {
        runScript(script, context, timeout, "script evaluation", errors);
        runtime.flushTimers(errors);
    }
    runtime.dispatchDocumentEvent("DOMContentLoaded", errors);
    runtime.flushTimers(errors);
    runtime.dispatchWindowEvent("load", errors);
    runtime.flushTimers(errors);
    errors.push(...runtime.validationErrors());
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        checkedFiles,
    };
}
function readScripts(serveRoot, html, errors, warnings) {
    const scripts = [];
    let inlineIndex = 0;
    for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
        const attrs = match[1] ?? "";
        const inlineContent = match[2] ?? "";
        const src = attributeMatch(attrs, SRC_ATTRIBUTE_PATTERN);
        if (!src) {
            if (inlineContent.trim())
                scripts.push({ label: `inline script ${++inlineIndex}`, content: inlineContent });
            continue;
        }
        if (isExternalResource(src)) {
            warnings.push(`Runtime smoke gate skipped external script ${src}.`);
            continue;
        }
        if (src.startsWith("/") || src.startsWith("data:")) {
            warnings.push(`Runtime smoke gate skipped non-local script ${src}.`);
            continue;
        }
        const scriptPath = normalize(join(serveRoot, src));
        if (!pathIsInside(serveRoot, scriptPath) || !existsSync(scriptPath)) {
            errors.push(`Runtime smoke gate could not read local script ${src}.`);
            continue;
        }
        scripts.push({ label: src.replace(/^\.\//, ""), content: readFileSync(scriptPath, "utf8") });
    }
    return scripts;
}
function runScript(script, context, timeoutMs, phase, errors) {
    try {
        new Script(`${script.content}\n//# sourceURL=${script.label}`, { filename: script.label }).runInContext(context, {
            timeout: timeoutMs,
        });
    }
    catch (error) {
        errors.push(`Runtime smoke gate: ${script.label} failed during ${phase}: ${describeScriptError(script, error)}`);
    }
}
function describeScriptError(script, error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = sourceLineForError(script, error);
    return line ? `${message} near \`${line}\`` : message;
}
function sourceLineForError(script, error) {
    if (!(error instanceof Error) || !error.stack)
        return "";
    const escapedLabel = script.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = error.stack.match(new RegExp(`${escapedLabel}:(\\d+):(\\d+)`));
    const lineNumber = Number(match?.[1]);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0)
        return "";
    return script.content.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
}
class SmokeRuntime {
    sources;
    document;
    windowTarget = new SmokeEventTarget("window");
    timers = [];
    consoleErrors = [];
    missingSelectors = new Set();
    timerId = 0;
    constructor(html, sources) {
        this.sources = sources;
        this.document = new SmokeDocument(html, this.missingSelectors);
    }
    context() {
        const runtime = this;
        const windowObject = {
            document: this.document,
            console: {
                log: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: (...values) => runtime.consoleErrors.push(values.map(String).join(" ")),
            },
            addEventListener: (type, listener) => this.windowTarget.addEventListener(type, listener),
            removeEventListener: (type, listener) => this.windowTarget.removeEventListener(type, listener),
            dispatchEvent: (event) => this.windowTarget.dispatchEvent(event),
            setTimeout: (listener, _delay, ...args) => this.enqueueTimer(() => listener(...args)),
            clearTimeout: () => undefined,
            setInterval: (listener, _delay, ...args) => this.enqueueTimer(() => listener(...args)),
            clearInterval: () => undefined,
            requestAnimationFrame: (listener) => this.enqueueTimer(() => listener(Date.now())),
            cancelAnimationFrame: () => undefined,
            localStorage: new SmokeStorage(),
            sessionStorage: new SmokeStorage(),
            location: { href: "http://localhost/preview/", pathname: "/preview/", search: "", hash: "" },
            navigator: { userAgent: "pi-static-preview-smoke-gate" },
            Chart: SmokeChart,
            Event: SmokeEvent,
        };
        windowObject.window = windowObject;
        windowObject.self = windowObject;
        windowObject.globalThis = windowObject;
        return createContext(windowObject);
    }
    dispatchDocumentEvent(type, errors) {
        this.document.readyState = type === "DOMContentLoaded" ? "interactive" : this.document.readyState;
        this.document.dispatchSmokeEvent(type, errors, this.sources);
    }
    dispatchWindowEvent(type, errors) {
        if (type === "load")
            this.document.readyState = "complete";
        try {
            this.windowTarget.dispatchEvent(new SmokeEvent(type));
        }
        catch (error) {
            errors.push(`Runtime smoke gate: window ${type} handler failed: ${describeRuntimeError(error, this.sources)}`);
        }
    }
    flushTimers(errors) {
        let count = 0;
        while (this.timers.length > 0 && count < MAX_TIMER_FLUSH) {
            const timer = this.timers.shift();
            count += 1;
            try {
                timer?.();
            }
            catch (error) {
                errors.push(`Runtime smoke gate: timer callback failed: ${describeRuntimeError(error, this.sources)}`);
            }
        }
        if (this.timers.length > 0) {
            this.timers.length = 0;
            errors.push(`Runtime smoke gate: timer queue exceeded ${MAX_TIMER_FLUSH} callbacks.`);
        }
    }
    validationErrors() {
        const errors = [];
        for (const message of this.consoleErrors) {
            errors.push(`Runtime smoke gate: console.error was called with ${message}.`);
        }
        for (const element of this.document.visibleLoadingElements()) {
            errors.push(`Runtime smoke gate: loading element #${element.id} remained visible after startup.`);
        }
        for (const element of this.document.metricPlaceholderElements()) {
            errors.push(`Runtime smoke gate: metric placeholder #${element.id} still shows "--" after startup.`);
        }
        return errors;
    }
    enqueueTimer(listener) {
        this.timers.push(listener);
        this.timerId += 1;
        return this.timerId;
    }
}
class SmokeEvent {
    type;
    detail;
    defaultPrevented = false;
    target;
    constructor(type, detail) {
        this.type = type;
        this.detail = detail;
    }
    preventDefault() {
        this.defaultPrevented = true;
    }
}
class SmokeEventTarget {
    label;
    listeners = new Map();
    constructor(label) {
        this.label = label;
    }
    addEventListener(type, listener) {
        if (typeof listener !== "function")
            return;
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }
    dispatchEvent(event) {
        event.target = this;
        for (const listener of this.listeners.get(event.type) ?? []) {
            try {
                listener(event);
            }
            catch (error) {
                throw enrichListenerError(error, listener);
            }
        }
        return !event.defaultPrevented;
    }
}
class SmokeDocument extends SmokeEventTarget {
    missingSelectors;
    body;
    documentElement;
    readyState = "loading";
    elements = [];
    byId = new Map();
    constructor(html, missingSelectors) {
        super("document");
        this.missingSelectors = missingSelectors;
        this.documentElement = this.createElement("html");
        this.body = this.createElement("body");
        this.parse(html);
    }
    createElement(tagName) {
        const element = new SmokeElement(tagName, this);
        this.track(element);
        return element;
    }
    getElementById(id) {
        const element = this.byId.get(id) ?? null;
        if (!element)
            this.missingSelectors.add(`#${id}`);
        return element;
    }
    querySelector(selector) {
        const element = this.querySelectorAll(selector)[0] ?? null;
        if (!element)
            this.missingSelectors.add(selector.trim());
        return element;
    }
    querySelectorAll(selector) {
        const matches = this.elements.filter((element) => selectorMatches(element, selector));
        if (matches.length === 0)
            this.missingSelectors.add(selector.trim());
        return matches;
    }
    dispatchSmokeEvent(type, errors, sources) {
        try {
            this.dispatchEvent(new SmokeEvent(type));
        }
        catch (error) {
            errors.push(`Runtime smoke gate: document ${type} handler failed: ${describeRuntimeError(error, sources)}`);
        }
    }
    visibleLoadingElements() {
        return this.elements.filter((element) => element.id && element.isVisible() && element.hasLoadingSignal());
    }
    metricPlaceholderElements() {
        return this.elements.filter((element) => element.id && element.isVisible() && element.hasMetricPlaceholder());
    }
    parse(html) {
        for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
            const tagName = match[1] ?? "";
            if (/^(script|link|meta|title|html|body)$/i.test(tagName))
                continue;
            const attrs = match[2] ?? "";
            const element = this.createElement(tagName);
            element.id = attributeMatch(attrs, ID_ATTRIBUTE_PATTERN);
            element.className = attributeMatch(attrs, CLASS_ATTRIBUTE_PATTERN);
            element.style.cssText = attributeMatch(attrs, STYLE_ATTRIBUTE_PATTERN);
            element.textContent = elementText(html, tagName, match);
            for (const [name, value] of dataAttributes(attrs))
                element.dataset[name] = value;
            if (element.id)
                this.byId.set(element.id, element);
        }
    }
    track(element) {
        this.elements.push(element);
        if (element.id)
            this.byId.set(element.id, element);
    }
}
class SmokeElement extends SmokeEventTarget {
    tagName;
    ownerDocument;
    id = "";
    className = "";
    textContent = "";
    innerHTML = "";
    value = "";
    checked = false;
    children = [];
    dataset = {};
    style = new SmokeStyle();
    constructor(tagName, ownerDocument) {
        super(tagName);
        this.tagName = tagName;
        this.ownerDocument = ownerDocument;
    }
    get classList() {
        return new SmokeClassList(this);
    }
    setAttribute(name, value) {
        if (name === "id")
            this.id = value;
        else if (name === "class")
            this.className = value;
        else if (name === "style")
            this.style.cssText = value;
        else if (name.startsWith("data-"))
            this.dataset[toDatasetName(name.slice("data-".length))] = value;
    }
    getAttribute(name) {
        if (name === "id")
            return this.id || null;
        if (name === "class")
            return this.className || null;
        if (name === "style")
            return this.style.cssText || null;
        if (name.startsWith("data-"))
            return this.dataset[toDatasetName(name.slice("data-".length))] ?? null;
        return null;
    }
    appendChild(child) {
        this.children.push(child);
        return child;
    }
    remove() {
        this.classList.add("hidden");
    }
    querySelector(selector) {
        return this.ownerDocument.querySelector(selector);
    }
    querySelectorAll(selector) {
        return this.ownerDocument.querySelectorAll(selector);
    }
    isVisible() {
        return (!/\b(d-none|hidden|visually-hidden|sr-only)\b/i.test(this.className) &&
            !/none/i.test(this.style.display) &&
            !/hidden/i.test(this.style.visibility));
    }
    hasLoadingSignal() {
        const signal = `${this.id} ${this.className} ${this.textContent}`;
        return /\bloading\b|loading chart|loading data|spinner/i.test(signal);
    }
    hasMetricPlaceholder() {
        if (!this.textContent.includes("--"))
            return false;
        const signal = `${this.id} ${this.className}`;
        return /(kpi|metric|value|yield|count|output|loss|updated)/i.test(signal);
    }
}
class SmokeClassList {
    element;
    constructor(element) {
        this.element = element;
    }
    add(...classNames) {
        this.set([...this.values(), ...classNames]);
    }
    remove(...classNames) {
        const remove = new Set(classNames);
        this.set(this.values().filter((className) => !remove.has(className)));
    }
    contains(className) {
        return this.values().includes(className);
    }
    toggle(className, force) {
        const hasClass = this.contains(className);
        const shouldAdd = force ?? !hasClass;
        if (shouldAdd)
            this.add(className);
        else
            this.remove(className);
        return shouldAdd;
    }
    values() {
        return this.element.className.split(/\s+/).filter(Boolean);
    }
    set(values) {
        this.element.className = [...new Set(values)].join(" ");
    }
}
class SmokeStyle {
    display = "";
    visibility = "";
    properties = new Map();
    get cssText() {
        return [...this.properties.entries()].map(([name, value]) => `${name}: ${value}`).join("; ");
    }
    set cssText(value) {
        this.properties.clear();
        for (const declaration of value.split(";")) {
            const [name, ...rest] = declaration.split(":");
            if (!name || rest.length === 0)
                continue;
            this.setProperty(name.trim(), rest.join(":").trim());
        }
    }
    setProperty(name, value) {
        this.properties.set(name, value);
        if (name === "display")
            this.display = value;
        if (name === "visibility")
            this.visibility = value;
    }
    getPropertyValue(name) {
        return this.properties.get(name) ?? "";
    }
    removeProperty(name) {
        this.properties.delete(name);
        if (name === "display")
            this.display = "";
        if (name === "visibility")
            this.visibility = "";
    }
}
class SmokeStorage {
    values = new Map();
    getItem(key) {
        return this.values.get(key) ?? null;
    }
    setItem(key, value) {
        this.values.set(key, value);
    }
    removeItem(key) {
        this.values.delete(key);
    }
    clear() {
        this.values.clear();
    }
}
class SmokeChart {
    destroy() { }
    update() { }
}
function attributeMatch(attrs, pattern) {
    pattern.lastIndex = 0;
    return pattern.exec(attrs)?.[2]?.trim() ?? "";
}
function dataAttributes(attrs) {
    const values = [];
    DATA_ATTRIBUTE_PATTERN.lastIndex = 0;
    for (const match of attrs.matchAll(DATA_ATTRIBUTE_PATTERN)) {
        values.push([toDatasetName(match[1] ?? ""), match[3] ?? ""]);
    }
    return values;
}
function elementText(html, tagName, match) {
    const contentStart = (match.index ?? 0) + match[0].length;
    const closeIndex = html.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`, contentStart);
    const inner = closeIndex >= 0 ? html.slice(contentStart, closeIndex) : "";
    return stripTags(inner).trim();
}
function selectorMatches(element, selector) {
    return selector
        .split(",")
        .some((part) => simpleSelectorMatches(element, part.trim().split(/\s+|>|\+/).filter(Boolean).pop() ?? ""));
}
function simpleSelectorMatches(element, selector) {
    if (!selector)
        return false;
    const id = selector.match(/#([A-Za-z][\w:.-]*)/)?.[1];
    if (id && element.id !== id)
        return false;
    const classNames = [...selector.matchAll(/\.([A-Za-z][\w:-]*)/g)].map((match) => match[1] ?? "");
    if (classNames.some((className) => !element.className.split(/\s+/).includes(className)))
        return false;
    const attr = selector.match(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/);
    if (attr) {
        const attrValue = element.getAttribute(attr[1] ?? "");
        if (attr[2] !== undefined ? attrValue !== attr[2] : attrValue === null)
            return false;
    }
    const tag = selector.match(/^([a-z][\w:-]*)/i)?.[1];
    return !tag || element.tagName.toLowerCase() === tag.toLowerCase();
}
function describeRuntimeError(error, sources) {
    const message = error instanceof Error ? error.message : String(error);
    const line = sourceLineFromSources(error, sources);
    return line ? `${message} near \`${line}\`` : message;
}
function enrichListenerError(error, listener) {
    const message = error instanceof Error ? error.message : String(error);
    const line = sourceLineFromListener(listener, message);
    return new Error(line ? `${message} near \`${line}\`` : message);
}
function sourceLineFromListener(listener, errorMessage) {
    const source = listener.toString();
    const property = errorMessage.match(/reading ['"`]([^'"`]+)['"`]/)?.[1];
    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (property) {
        const propertyLine = lines.find((line) => line.includes(`.${property}`) || line.includes(`[${property}`));
        if (propertyLine)
            return propertyLine;
    }
    return lines.find((line) => !line.startsWith("(") && !line.startsWith("function")) ?? "";
}
function sourceLineFromSources(error, sources) {
    if (!(error instanceof Error) || !error.stack || !sources)
        return "";
    for (const [label, content] of sources) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = error.stack.match(new RegExp(`${escapedLabel}:(\\d+):(\\d+)`));
        const lineNumber = Number(match?.[1]);
        if (Number.isFinite(lineNumber) && lineNumber > 0)
            return content.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
    }
    return "";
}
function stripTags(value) {
    return value.replace(/<[^>]+>/g, " ");
}
function isExternalResource(value) {
    return /^https?:\/\//i.test(value) || value.startsWith("//");
}
function pathIsInside(root, target) {
    const normalizedRoot = normalize(root);
    const normalizedTarget = normalize(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}
function relativeCheckedPath(root, file) {
    const relative = normalize(file).slice(normalize(root).length).replace(/^[/\\]+/, "");
    return relative || file;
}
function toDatasetName(name) {
    return name.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
}
//# sourceMappingURL=static-preview-smoke-gate.js.map