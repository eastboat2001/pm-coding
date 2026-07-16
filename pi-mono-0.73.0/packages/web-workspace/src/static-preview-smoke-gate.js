import { existsSync, readFileSync } from "node:fs";
import { normalize } from "node:path";
import { createContext, Script } from "node:vm";
import { classifyStaticResourceReference, staticHtmlAttributeValue } from "./static-preview.js";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(['"])([^'"]+)\1/i;
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(['"])([^'"]*)\1/i;
const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*(['"])([^'"]*)\1/i;
const WIDTH_ATTRIBUTE_PATTERN = /\bwidth\s*=\s*(['"]?)(\d+)\1/i;
const HEIGHT_ATTRIBUTE_PATTERN = /\bheight\s*=\s*(['"]?)(\d+)\1/i;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const DATA_ATTRIBUTE_PATTERN = /\bdata-([a-z0-9_.:-]+)\s*=\s*(['"])([^'"]*)\2/gi;
const DEFAULT_SCRIPT_TIMEOUT_MS = 500;
const MAX_TIMER_FLUSH = 50;
export async function runStaticPreviewSmokeGate(input) {
    const errors = [];
    const warnings = [];
    const checkedFiles = [];
    let guard;
    let indexPath;
    try {
        guard = WorkspacePathGuard.forProjectContent(input.serveRoot);
        indexPath = guard.authorizeExisting(input.indexFile || "index.html", "file").absolutePath;
    }
    catch (error) {
        if (!(error instanceof WorkspacePathAuthorizationError))
            throw error;
        return {
            valid: false,
            errors: ["Runtime smoke gate requires an authorized index.html inside the serve root."],
            warnings,
            checkedFiles,
        };
    }
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
    const scripts = readScripts(guard, html, errors, warnings);
    checkedFiles.push(...scripts.map((script) => script.label));
    checkedFiles.push(...authorizeLinkedResources(guard, html, errors));
    const timeout = input.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const runtime = new SmokeRuntime(html, new Map(scripts.map((script) => [script.label, script.content])), timeout);
    const context = runtime.context();
    for (const script of scripts) {
        runScript(script, context, timeout, "script evaluation", errors, warnings);
        runtime.flushTimers(errors, warnings);
    }
    runtime.dispatchDocumentEvent("DOMContentLoaded", errors, warnings);
    runtime.flushTimers(errors, warnings);
    runtime.dispatchWindowEvent("load", errors, warnings);
    runtime.flushTimers(errors, warnings);
    errors.push(...runtime.validationErrors());
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        checkedFiles,
    };
}
function readScripts(guard, html, errors, warnings) {
    const scripts = [];
    let inlineIndex = 0;
    for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
        const attrs = match[1] ?? "";
        const inlineContent = match[2] ?? "";
        const src = staticHtmlAttributeValue(attrs, "src");
        if (!src) {
            if (inlineContent.trim())
                scripts.push({ label: `inline script ${++inlineIndex}`, content: inlineContent });
            continue;
        }
        const reference = classifyStaticResourceReference(src);
        if (reference?.kind === "external") {
            warnings.push(`Runtime smoke gate skipped external script ${src}.`);
            continue;
        }
        if (reference?.kind !== "local")
            continue;
        try {
            const authorized = guard.authorizeExisting(reference.relativePath, "file");
            scripts.push({
                label: authorized.relativePath.replace(/\\/g, "/"),
                content: readFileSync(authorized.absolutePath, "utf8"),
            });
        }
        catch (error) {
            if (!(error instanceof WorkspacePathAuthorizationError))
                throw error;
            errors.push(`Runtime smoke gate could not read local script ${src}.`);
        }
    }
    return scripts;
}
function authorizeLinkedResources(guard, html, errors) {
    const checked = [];
    for (const match of html.matchAll(/<(link|img|source|video|audio|track)\b[^>]*>/gi)) {
        const tag = match[0];
        const value = staticHtmlAttributeValue(tag, /\blink\b/i.test(match[1] ?? "") ? "href" : "src");
        const reference = classifyStaticResourceReference(value);
        if (!value || reference?.kind !== "local")
            continue;
        try {
            checked.push(guard.authorizeExisting(reference.relativePath, "file").relativePath.replace(/\\/g, "/"));
        }
        catch (error) {
            if (!(error instanceof WorkspacePathAuthorizationError))
                throw error;
            errors.push(`Runtime smoke gate could not authorize local asset ${value}.`);
        }
    }
    return checked;
}
function runScript(script, context, timeoutMs, phase, errors, warnings) {
    try {
        new Script(`${script.content}\n//# sourceURL=${script.label}`, { filename: script.label }).runInContext(context, {
            timeout: timeoutMs,
        });
    }
    catch (error) {
        recordRuntimeIssue(error, `Runtime smoke gate: ${script.label} failed during ${phase}: ${describeScriptError(script, error)}`, errors, warnings);
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
    scriptTimeoutMs;
    document;
    windowTarget = new SmokeEventTarget("window");
    contextValues = {};
    timers = [];
    cancelledTimerIds = new Set();
    consoleErrors = [];
    missingSelectors = new Set();
    timerId = 0;
    constructor(html, sources, scriptTimeoutMs) {
        this.sources = sources;
        this.scriptTimeoutMs = scriptTimeoutMs;
        this.document = new SmokeDocument(html, this.missingSelectors);
    }
    context() {
        const windowObject = {
            document: this.document,
            console: {
                log: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: (...values) => this.consoleErrors.push(values.map(String).join(" ")),
            },
            addEventListener: (type, listener) => this.windowTarget.addEventListener(type, listener),
            removeEventListener: (type, listener) => this.windowTarget.removeEventListener(type, listener),
            dispatchEvent: (event) => this.windowTarget.dispatchEvent(event),
            setTimeout: (listener, _delay, ...args) => this.enqueueTimer("timeout", () => listener(...args)),
            clearTimeout: (timerId) => this.cancelTimer(timerId),
            setInterval: (listener, _delay, ...args) => this.enqueueTimer("interval", () => listener(...args)),
            clearInterval: (timerId) => this.cancelTimer(timerId),
            requestAnimationFrame: (listener) => this.enqueueTimer("animation_frame", () => listener(Date.now())),
            cancelAnimationFrame: (timerId) => this.cancelTimer(timerId),
            localStorage: new SmokeStorage(),
            sessionStorage: new SmokeStorage(),
            location: { href: "http://localhost/preview/", pathname: "/preview/", search: "", hash: "" },
            navigator: {
                userAgent: "pi-static-preview-smoke-gate",
                geolocation: {
                    getCurrentPosition: () => {
                        throw new UnsupportedSmokeCapabilityError("navigator.geolocation.getCurrentPosition");
                    },
                },
            },
            Chart: SmokeChart,
            Event: SmokeEvent,
        };
        windowObject.window = windowObject;
        windowObject.self = windowObject;
        windowObject.globalThis = windowObject;
        Object.assign(this.contextValues, windowObject);
        return createContext(this.contextValues);
    }
    dispatchDocumentEvent(type, errors, warnings) {
        this.document.readyState = type === "DOMContentLoaded" ? "interactive" : this.document.readyState;
        this.document.dispatchSmokeEvent(type, errors, warnings, this.sources, (listener, event) => this.invokeCallback(listener, [event]));
    }
    dispatchWindowEvent(type, errors, warnings) {
        if (type === "load")
            this.document.readyState = "complete";
        try {
            this.windowTarget.dispatchEvent(new SmokeEvent(type), (listener, event) => this.invokeCallback(listener, [event]));
        }
        catch (error) {
            recordRuntimeIssue(error, `Runtime smoke gate: window ${type} handler failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
        }
    }
    flushTimers(errors, warnings) {
        let timeoutCount = 0;
        const sampledPersistentTimerIds = new Set(this.timers.filter((timer) => timer.kind !== "timeout").map((timer) => timer.id));
        while (this.timers.length > 0) {
            const timer = this.timers.shift();
            if (!timer || this.cancelledTimerIds.delete(timer.id))
                continue;
            if (timer.kind !== "timeout" && !sampledPersistentTimerIds.delete(timer.id))
                continue;
            if (timer.kind === "timeout") {
                if (timeoutCount >= MAX_TIMER_FLUSH) {
                    this.timers.unshift(timer);
                    break;
                }
                timeoutCount += 1;
            }
            try {
                this.invokeCallback(timer.callback, []);
            }
            catch (error) {
                recordRuntimeIssue(error, `Runtime smoke gate: timer callback failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
        }
        if (this.timers.some((timer) => timer.kind === "timeout" && !this.cancelledTimerIds.has(timer.id))) {
            this.timers.length = 0;
            errors.push(`Runtime smoke gate: timer queue exceeded ${MAX_TIMER_FLUSH} callbacks.`);
        }
        this.timers.length = 0;
        this.cancelledTimerIds.clear();
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
    enqueueTimer(kind, callback) {
        this.timerId += 1;
        this.timers.push({ id: this.timerId, kind, callback });
        return this.timerId;
    }
    cancelTimer(timerId) {
        this.cancelledTimerIds.add(timerId);
    }
    invokeCallback(callback, args) {
        this.contextValues.__piSmokeCallback = callback;
        this.contextValues.__piSmokeCallbackArgs = args;
        try {
            new Script("__piSmokeCallback(...__piSmokeCallbackArgs)").runInContext(this.contextValues, {
                timeout: this.scriptTimeoutMs,
            });
        }
        finally {
            delete this.contextValues.__piSmokeCallback;
            delete this.contextValues.__piSmokeCallbackArgs;
        }
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
    dispatchEvent(event, invokeListener) {
        event.target = this;
        for (const listener of this.listeners.get(event.type) ?? []) {
            try {
                if (invokeListener)
                    invokeListener(listener, event);
                else
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
        const element = tagName.toLowerCase() === "canvas" ? new SmokeCanvasElement(this) : new SmokeElement(tagName, this);
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
    dispatchSmokeEvent(type, errors, warnings, sources, invokeListener) {
        try {
            this.dispatchEvent(new SmokeEvent(type), invokeListener);
        }
        catch (error) {
            recordRuntimeIssue(error, `Runtime smoke gate: document ${type} handler failed: ${describeRuntimeError(error, sources)}`, errors, warnings);
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
            if (element instanceof SmokeCanvasElement) {
                element.width = numericAttributeMatch(attrs, WIDTH_ATTRIBUTE_PATTERN, element.width);
                element.height = numericAttributeMatch(attrs, HEIGHT_ATTRIBUTE_PATTERN, element.height);
            }
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
    text = "";
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
    get textContent() {
        return this.text;
    }
    set textContent(value) {
        this.text = value === null ? "" : String(value);
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
class SmokeCanvasElement extends SmokeElement {
    width = 300;
    height = 150;
    context2d = new SmokeCanvasRenderingContext2D();
    constructor(ownerDocument) {
        super("canvas", ownerDocument);
    }
    getContext(contextId) {
        return contextId.toLowerCase() === "2d" ? this.context2d : null;
    }
}
class SmokeCanvasRenderingContext2D {
    fillStyle = "#000000";
    strokeStyle = "#000000";
    lineWidth = 1;
    shadowColor = "rgba(0, 0, 0, 0)";
    shadowBlur = 0;
    font = "10px sans-serif";
    textAlign = "start";
    globalAlpha = 1;
    beginPath() { }
    closePath() { }
    moveTo(_x, _y) { }
    lineTo(_x, _y) { }
    rect(_x, _y, _width, _height) { }
    arc(_x, _y, _radius, _startAngle, _endAngle) { }
    fill() { }
    stroke() { }
    fillRect(_x, _y, _width, _height) { }
    strokeRect(_x, _y, _width, _height) { }
    clearRect(_x, _y, _width, _height) { }
    fillText(_text, _x, _y) { }
    strokeText(_text, _x, _y) { }
    save() { }
    restore() { }
    translate(_x, _y) { }
    rotate(_angle) { }
    scale(_x, _y) { }
    setTransform(..._values) { }
    drawImage(..._values) { }
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
class UnsupportedSmokeCapabilityError extends Error {
    capability;
    constructor(capability) {
        super(`Static smoke runtime does not simulate ${capability}.`);
        this.capability = capability;
        this.name = "UnsupportedSmokeCapabilityError";
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
function numericAttributeMatch(attrs, pattern, fallback) {
    pattern.lastIndex = 0;
    const value = Number(pattern.exec(attrs)?.[2]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
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
    return selector.split(",").some((part) => simpleSelectorMatches(element, part
        .trim()
        .split(/\s+|>|\+/)
        .filter(Boolean)
        .pop() ?? ""));
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
function recordRuntimeIssue(error, message, errors, warnings) {
    if (error instanceof UnsupportedSmokeCapabilityError) {
        warnings.push(`Runtime smoke gate skipped unsupported browser capability ${error.capability}.`);
        return;
    }
    errors.push(message);
}
function enrichListenerError(error, listener) {
    if (error instanceof UnsupportedSmokeCapabilityError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    const line = sourceLineFromListener(listener, message);
    return new Error(line ? `${message} near \`${line}\`` : message);
}
function sourceLineFromListener(listener, errorMessage) {
    const source = listener.toString();
    const property = errorMessage.match(/reading ['"`]([^'"`]+)['"`]/)?.[1];
    const lines = source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
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
function relativeCheckedPath(root, file) {
    const relative = normalize(file)
        .slice(normalize(root).length)
        .replace(/^[/\\]+/, "");
    return relative || file;
}
function toDatasetName(name) {
    return name.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
}
//# sourceMappingURL=static-preview-smoke-gate.js.map