import { existsSync, readFileSync } from "node:fs";
import { normalize } from "node:path";
import { type Context, createContext, Script } from "node:vm";
import { classifyStaticResourceReference, staticHtmlAttributeValue } from "./static-preview.js";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";

export interface StaticPreviewSmokeGateInput {
	serveRoot: string;
	indexFile?: string;
	scriptTimeoutMs?: number;
}

export interface StaticPreviewSmokeGateResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	checkedFiles: string[];
}

type ScriptBlock = {
	label: string;
	content: string;
};

type Listener = (event: SmokeEvent) => void;
type ListenerInvoker = (listener: Listener, event: SmokeEvent) => void;
type SmokeTimerKind = "timeout" | "interval" | "animation_frame";

interface SmokeTimer {
	id: number;
	kind: SmokeTimerKind;
	callback: () => void;
}

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(['"])([^'"]+)\1/i;
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(['"])([^'"]*)\1/i;
const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*(['"])([^'"]*)\1/i;
const WIDTH_ATTRIBUTE_PATTERN = /\bwidth\s*=\s*(['"]?)(\d+)\1/i;
const HEIGHT_ATTRIBUTE_PATTERN = /\bheight\s*=\s*(['"]?)(\d+)\1/i;
const VALUE_ATTRIBUTE_PATTERN = /\bvalue\s*=\s*(['"])([^'"]*)\1/i;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const DATA_ATTRIBUTE_PATTERN = /\bdata-([a-z0-9_.:-]+)\s*=\s*(['"])([^'"]*)\2/gi;
const DEFAULT_SCRIPT_TIMEOUT_MS = 500;
const MAX_TIMER_FLUSH = 50;
const MAX_CHART_INTERACTION_SAMPLES = 32;

export async function runStaticPreviewSmokeGate(
	input: StaticPreviewSmokeGateInput,
): Promise<StaticPreviewSmokeGateResult> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const checkedFiles: string[] = [];
	let guard: WorkspacePathGuard;
	let indexPath: string;
	try {
		guard = WorkspacePathGuard.forProjectContent(input.serveRoot);
		indexPath = guard.authorizeExisting(input.indexFile || "index.html", "file").absolutePath;
	} catch (error) {
		if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
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
	runtime.exerciseInteractions(errors, warnings);
	runtime.flushTimers(errors, warnings);

	errors.push(...runtime.validationErrors());
	warnings.push(...runtime.validationWarnings());

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		checkedFiles,
	};
}

function readScripts(guard: WorkspacePathGuard, html: string, errors: string[], warnings: string[]): ScriptBlock[] {
	const scripts: ScriptBlock[] = [];
	let inlineIndex = 0;
	for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
		const attrs = match[1] ?? "";
		const inlineContent = match[2] ?? "";
		const src = staticHtmlAttributeValue(attrs, "src");
		if (!src) {
			if (inlineContent.trim()) scripts.push({ label: `inline script ${++inlineIndex}`, content: inlineContent });
			continue;
		}
		const reference = classifyStaticResourceReference(src);
		if (reference?.kind === "external") {
			warnings.push(`Runtime smoke gate skipped external script ${src}.`);
			continue;
		}
		if (reference?.kind !== "local") continue;
		try {
			const authorized = guard.authorizeExisting(reference.relativePath, "file");
			scripts.push({
				label: authorized.relativePath.replace(/\\/g, "/"),
				content: readFileSync(authorized.absolutePath, "utf8"),
			});
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			errors.push(`Runtime smoke gate could not read local script ${src}.`);
		}
	}
	return scripts;
}

function authorizeLinkedResources(guard: WorkspacePathGuard, html: string, errors: string[]): string[] {
	const checked: string[] = [];
	for (const match of html.matchAll(/<(link|img|source|video|audio|track)\b[^>]*>/gi)) {
		const tag = match[0];
		const value = staticHtmlAttributeValue(tag, /\blink\b/i.test(match[1] ?? "") ? "href" : "src");
		const reference = classifyStaticResourceReference(value);
		if (!value || reference?.kind !== "local") continue;
		try {
			checked.push(guard.authorizeExisting(reference.relativePath, "file").relativePath.replace(/\\/g, "/"));
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			errors.push(`Runtime smoke gate could not authorize local asset ${value}.`);
		}
	}
	return checked;
}

function runScript(
	script: ScriptBlock,
	context: Context,
	timeoutMs: number,
	phase: string,
	errors: string[],
	warnings: string[],
): void {
	try {
		new Script(`${script.content}\n//# sourceURL=${script.label}`, { filename: script.label }).runInContext(context, {
			timeout: timeoutMs,
		});
	} catch (error) {
		recordRuntimeIssue(
			error,
			`Runtime smoke gate: ${script.label} failed during ${phase}: ${describeScriptError(script, error)}`,
			errors,
			warnings,
		);
	}
}

function describeScriptError(script: ScriptBlock, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const line = sourceLineForError(script, error);
	return line ? `${message} near \`${line}\`` : message;
}

function sourceLineForError(script: ScriptBlock, error: unknown): string {
	if (!(error instanceof Error) || !error.stack) return "";
	const escapedLabel = script.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = error.stack.match(new RegExp(`${escapedLabel}:(\\d+):(\\d+)`));
	const lineNumber = Number(match?.[1]);
	if (!Number.isFinite(lineNumber) || lineNumber <= 0) return "";
	return script.content.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
}

class SmokeRuntime {
	private readonly document: SmokeDocument;
	private readonly windowTarget = new SmokeEventTarget("window");
	private readonly contextValues: Record<string, unknown> = {};
	private readonly timers: SmokeTimer[] = [];
	private readonly cancelledTimerIds = new Set<number>();
	private readonly consoleErrors: string[] = [];
	private readonly charts: SmokeChart[] = [];
	private readonly missingSelectors = new Set<string>();
	private timerId = 0;

	constructor(
		html: string,
		private readonly sources: Map<string, string>,
		private readonly scriptTimeoutMs: number,
	) {
		this.document = new SmokeDocument(html, this.missingSelectors);
	}

	context(): Context {
		const charts = this.charts;
		class RuntimeSmokeChart extends SmokeChart {
			constructor(context: unknown, config: unknown) {
				super(context, config);
				charts.push(this);
			}
		}
		const windowObject: Record<string, unknown> = {
			document: this.document,
			// Dialog APIs are synchronous browser primitives. Treating them as missing
			// turns otherwise valid interaction handlers into VM-only ReferenceErrors.
			// They have no observable page effect in the smoke runtime, so deterministic
			// no-op/default implementations are sufficient for startup validation.
			alert: (_message?: unknown) => undefined,
			confirm: (_message?: unknown) => true,
			prompt: (_message?: unknown, defaultValue?: unknown) =>
				defaultValue === undefined || defaultValue === null ? "" : String(defaultValue),
			console: {
				log: () => undefined,
				info: () => undefined,
				warn: () => undefined,
				error: (...values: unknown[]) => this.consoleErrors.push(values.map(String).join(" ")),
			},
			addEventListener: (type: string, listener: Listener) => this.windowTarget.addEventListener(type, listener),
			removeEventListener: (type: string, listener: Listener) =>
				this.windowTarget.removeEventListener(type, listener),
			dispatchEvent: (event: SmokeEvent) => this.windowTarget.dispatchEvent(event),
			setTimeout: (listener: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
				this.enqueueTimer("timeout", () => listener(...args)),
			clearTimeout: (timerId: number) => this.cancelTimer(timerId),
			setInterval: (listener: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
				this.enqueueTimer("interval", () => listener(...args)),
			clearInterval: (timerId: number) => this.cancelTimer(timerId),
			requestAnimationFrame: (listener: (time: number) => void) =>
				this.enqueueTimer("animation_frame", () => listener(Date.now())),
			cancelAnimationFrame: (timerId: number) => this.cancelTimer(timerId),
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
			Chart: RuntimeSmokeChart,
			Event: SmokeEvent,
		};
		windowObject.window = windowObject;
		windowObject.self = windowObject;
		windowObject.globalThis = windowObject;
		Object.assign(this.contextValues, windowObject);
		return createContext(this.contextValues);
	}

	exerciseInteractions(errors: string[], warnings: string[]): void {
		for (const element of this.document.elementsByTagName("select")) {
			const originalValue = element.value;
			const testValues = element.interactionCandidates();
			if (testValues.length === 0) continue;
			const before = this.observableDataFingerprint();
			let changedObservableData = false;
			let interactionFailed = false;
			for (const testValue of testValues) {
				element.value = testValue;
				try {
					element.dispatchEvent(new SmokeEvent("change"), (listener, event) =>
						this.invokeCallback(listener, [event], element),
					);
					this.flushTimers(errors, warnings);
					changedObservableData = before !== this.observableDataFingerprint();
				} catch (error) {
					interactionFailed = true;
					recordRuntimeIssue(
						error,
						`Runtime smoke gate: select change handler failed${element.id ? ` for #${element.id}` : ""}: ${describeRuntimeError(error, this.sources)}`,
						errors,
						warnings,
					);
				}

				// Every control is evaluated from the page's default filter state. Leaving a
				// previous select mutated can create an empty combination and falsely make
				// otherwise functional controls look inert.
				element.value = originalValue;
				try {
					element.dispatchEvent(new SmokeEvent("change"), (listener, event) =>
						this.invokeCallback(listener, [event], element),
					);
					this.flushTimers(errors, warnings);
				} catch (error) {
					interactionFailed = true;
					recordRuntimeIssue(
						error,
						`Runtime smoke gate: select reset handler failed${element.id ? ` for #${element.id}` : ""}: ${describeRuntimeError(error, this.sources)}`,
						errors,
						warnings,
					);
				}

				if (changedObservableData || interactionFailed) break;
			}
			if (!changedObservableData && !interactionFailed) {
				errors.push(
					`Runtime smoke gate: select${element.id ? ` #${element.id}` : ""} changed value but did not change rendered metrics, chart data, results, or empty state.`,
				);
			}
		}
		// Chart callbacks commonly re-render the page and create replacement Chart
		// instances. Iterate a bounded snapshot: walking the live array would also
		// visit every replacement appended by the callback and can grow forever.
		const chartsAtInteractionStart = this.charts
			.filter((chart) => !chart.isDestroyed())
			.slice(0, MAX_CHART_INTERACTION_SAMPLES);
		if (this.charts.filter((chart) => !chart.isDestroyed()).length > MAX_CHART_INTERACTION_SAMPLES) {
			warnings.push(
				`Runtime smoke gate sampled the first ${MAX_CHART_INTERACTION_SAMPLES} active charts for interaction checks.`,
			);
		}
		for (const chart of chartsAtInteractionStart) {
			const onClick = chart.clickHandler();
			if (!onClick) continue;
			try {
				this.invokeCallback(onClick, [new SmokeEvent("click"), [{ index: 0 }], chart]);
			} catch (error) {
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: chart click handler failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
		}
	}

	private observableDataFingerprint(): string {
		const activeCharts = this.charts.filter((chart) => !chart.isDestroyed()).map((chart) => chart.dataSnapshot());
		return JSON.stringify({
			document: this.document.observableDataSnapshot(),
			charts: activeCharts,
			location: this.contextValues.location,
		});
	}

	dispatchDocumentEvent(type: string, errors: string[], warnings: string[]): void {
		this.document.readyState = type === "DOMContentLoaded" ? "interactive" : this.document.readyState;
		this.document.dispatchSmokeEvent(type, errors, warnings, this.sources, (listener, event) =>
			this.invokeCallback(listener, [event]),
		);
	}

	dispatchWindowEvent(type: string, errors: string[], warnings: string[]): void {
		if (type === "load") this.document.readyState = "complete";
		try {
			this.windowTarget.dispatchEvent(new SmokeEvent(type), (listener, event) =>
				this.invokeCallback(listener, [event]),
			);
		} catch (error) {
			recordRuntimeIssue(
				error,
				`Runtime smoke gate: window ${type} handler failed: ${describeRuntimeError(error, this.sources)}`,
				errors,
				warnings,
			);
		}
	}

	flushTimers(errors: string[], warnings: string[]): void {
		let timeoutCount = 0;
		const sampledPersistentTimerIds = new Set(
			this.timers.filter((timer) => timer.kind !== "timeout").map((timer) => timer.id),
		);
		while (this.timers.length > 0) {
			const timer = this.timers.shift();
			if (!timer || this.cancelledTimerIds.delete(timer.id)) continue;
			if (timer.kind !== "timeout" && !sampledPersistentTimerIds.delete(timer.id)) continue;
			if (timer.kind === "timeout") {
				if (timeoutCount >= MAX_TIMER_FLUSH) {
					this.timers.unshift(timer);
					break;
				}
				timeoutCount += 1;
			}
			try {
				this.invokeCallback(timer.callback, []);
			} catch (error) {
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: timer callback failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
		}
		if (this.timers.some((timer) => timer.kind === "timeout" && !this.cancelledTimerIds.has(timer.id))) {
			this.timers.length = 0;
			errors.push(`Runtime smoke gate: timer queue exceeded ${MAX_TIMER_FLUSH} callbacks.`);
		}
		this.timers.length = 0;
		this.cancelledTimerIds.clear();
	}

	validationErrors(): string[] {
		const errors: string[] = [];
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

	validationWarnings(): string[] {
		const metrics = this.document.visibleMetricElements();
		if (
			metrics.length >= 2 &&
			this.document.elementsByTagName("canvas").some((canvas) => canvas.isVisible()) &&
			metrics.every((metric) => metric.hasOnlyZeroMetricValues())
		) {
			return [
				`Runtime smoke gate: all ${metrics.length} visible KPI metrics remain zero after startup while chart content is present; verify the default view renders representative data or an explicit empty state.`,
			];
		}
		return [];
	}

	private enqueueTimer(kind: SmokeTimerKind, callback: () => void): number {
		this.timerId += 1;
		this.timers.push({ id: this.timerId, kind, callback });
		return this.timerId;
	}

	private cancelTimer(timerId: number): void {
		this.cancelledTimerIds.add(timerId);
	}

	private invokeCallback(callback: unknown, args: unknown[], thisArg?: unknown): void {
		this.contextValues.__piSmokeCallback = callback;
		this.contextValues.__piSmokeCallbackArgs = args;
		this.contextValues.__piSmokeCallbackThis = thisArg;
		try {
			new Script("__piSmokeCallback.call(__piSmokeCallbackThis, ...__piSmokeCallbackArgs)").runInContext(
				this.contextValues,
				{
					timeout: this.scriptTimeoutMs,
				},
			);
		} finally {
			delete this.contextValues.__piSmokeCallback;
			delete this.contextValues.__piSmokeCallbackArgs;
			delete this.contextValues.__piSmokeCallbackThis;
		}
	}
}

class SmokeEvent {
	defaultPrevented = false;
	target: unknown;

	constructor(
		public readonly type: string,
		public readonly detail?: unknown,
	) {}

	preventDefault(): void {
		this.defaultPrevented = true;
	}
}

class SmokeEventTarget {
	private readonly listeners = new Map<string, Listener[]>();

	constructor(readonly label: string) {}

	addEventListener(type: string, listener: Listener): void {
		if (typeof listener !== "function") return;
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
		);
	}

	dispatchEvent(event: SmokeEvent, invokeListener?: ListenerInvoker): boolean {
		event.target = this;
		for (const listener of this.listeners.get(event.type) ?? []) {
			try {
				if (invokeListener) invokeListener(listener, event);
				else listener(event);
			} catch (error) {
				throw enrichListenerError(error, listener);
			}
		}
		return !event.defaultPrevented;
	}
}

class SmokeDocument extends SmokeEventTarget {
	readonly body: SmokeElement;
	readonly documentElement: SmokeElement;
	readyState = "loading";
	private readonly elements: SmokeElement[] = [];
	private readonly byId = new Map<string, SmokeElement>();

	constructor(
		html: string,
		private readonly missingSelectors: Set<string>,
	) {
		super("document");
		this.documentElement = this.createElement("html");
		this.body = this.createElement("body");
		this.parse(html);
	}

	createElement(tagName: string): SmokeElement {
		const element =
			tagName.toLowerCase() === "canvas" ? new SmokeCanvasElement(this) : new SmokeElement(tagName, this);
		this.track(element);
		return element;
	}

	getElementById(id: string): SmokeElement | null {
		const element = this.byId.get(id) ?? null;
		if (!element) this.missingSelectors.add(`#${id}`);
		return element;
	}

	querySelector(selector: string): SmokeElement | null {
		const element = this.querySelectorAll(selector)[0] ?? null;
		if (!element) this.missingSelectors.add(selector.trim());
		return element;
	}

	querySelectorAll(selector: string): SmokeElement[] {
		const matches = this.elements.filter((element) => selectorMatches(element, selector));
		if (matches.length === 0) this.missingSelectors.add(selector.trim());
		return matches;
	}

	dispatchSmokeEvent(
		type: string,
		errors: string[],
		warnings: string[],
		sources?: Map<string, string>,
		invokeListener?: ListenerInvoker,
	): void {
		try {
			this.dispatchEvent(new SmokeEvent(type), invokeListener);
		} catch (error) {
			recordRuntimeIssue(
				error,
				`Runtime smoke gate: document ${type} handler failed: ${describeRuntimeError(error, sources)}`,
				errors,
				warnings,
			);
		}
	}

	visibleLoadingElements(): SmokeElement[] {
		return this.elements.filter((element) => element.id && element.isVisible() && element.hasLoadingSignal());
	}

	metricPlaceholderElements(): SmokeElement[] {
		return this.elements.filter((element) => element.id && element.isVisible() && element.hasMetricPlaceholder());
	}

	visibleMetricElements(): SmokeElement[] {
		return this.elements.filter((element) => element.isVisible() && element.hasMetricSignal());
	}

	observableDataSnapshot(): unknown[] {
		return this.elements.flatMap((element) => element.observableDataSnapshot());
	}

	elementsByTagName(tagName: string): SmokeElement[] {
		return this.elements.filter((element) => element.tagName.toLowerCase() === tagName.toLowerCase());
	}

	private parse(html: string): void {
		for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
			const tagName = match[1] ?? "";
			if (/^(script|link|meta|title|html|body)$/i.test(tagName)) continue;
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
			if (tagName.toLowerCase() === "select") element.setInteractionValues(selectOptionValues(html, match));
			for (const [name, value] of dataAttributes(attrs)) element.dataset[name] = value;
			if (element.id) this.byId.set(element.id, element);
		}
	}

	private track(element: SmokeElement): void {
		this.elements.push(element);
		if (element.id) this.byId.set(element.id, element);
	}
}

class SmokeElement extends SmokeEventTarget {
	id = "";
	className = "";
	clientWidth = 1024;
	clientHeight = 768;
	private text = "";
	innerHTML = "";
	value = "";
	checked = false;
	readonly children: SmokeElement[] = [];
	readonly dataset: Record<string, string> = {};
	readonly style = new SmokeStyle();
	private interactionValues: string[] = [];

	constructor(
		readonly tagName: string,
		private readonly ownerDocument: SmokeDocument,
	) {
		super(tagName);
	}

	get classList(): SmokeClassList {
		return new SmokeClassList(this);
	}

	get parentElement(): SmokeElement | null {
		if (this.tagName.toLowerCase() === "html") return null;
		if (this.tagName.toLowerCase() === "body") return this.ownerDocument.documentElement ?? null;
		return this.ownerDocument.body ?? null;
	}

	get textContent(): string {
		return this.text;
	}

	set textContent(value: unknown) {
		this.text = value === null ? "" : String(value);
	}

	get innerText(): string {
		return this.text;
	}

	set innerText(value: unknown) {
		this.text = value === null ? "" : String(value);
	}

	setAttribute(name: string, value: string): void {
		if (name === "id") this.id = value;
		else if (name === "class") this.className = value;
		else if (name === "style") this.style.cssText = value;
		else if (name.startsWith("data-")) this.dataset[toDatasetName(name.slice("data-".length))] = value;
	}

	getAttribute(name: string): string | null {
		if (name === "id") return this.id || null;
		if (name === "class") return this.className || null;
		if (name === "style") return this.style.cssText || null;
		if (name.startsWith("data-")) return this.dataset[toDatasetName(name.slice("data-".length))] ?? null;
		return null;
	}

	appendChild(child: SmokeElement): SmokeElement {
		this.children.push(child);
		if (this.tagName.toLowerCase() === "select" && child.tagName.toLowerCase() === "option") {
			const optionValue = child.value || child.textContent;
			if (optionValue && !this.interactionValues.includes(optionValue)) this.interactionValues.push(optionValue);
			if (!this.value) this.value = optionValue;
		}
		return child;
	}

	setInteractionValues(values: string[]): void {
		this.interactionValues = [...new Set(values.filter(Boolean))];
		if (!this.value && this.interactionValues[0]) this.value = this.interactionValues[0];
	}

	interactionCandidates(): string[] {
		return this.interactionValues.filter((value) => value !== this.value);
	}

	observableDataSnapshot(): unknown[] {
		const signal = `${this.id} ${this.className}`;
		const content = `${this.textContent} ${this.innerHTML}`.trim();
		const metric =
			/\b(?:kpi|metric)-?value\b/i.test(this.className) ||
			/(?:kpi|metric).*(?:value|yield|count|output|loss)$/i.test(this.id) ||
			/(?:kpi|metric).*(?:row|grid|list)$/i.test(this.id);
		if (metric) {
			return [[this.id, "metric", content.match(/--|-?\d[\d,.]*(?:%|\s*Lots?)?/gi) ?? [], this.style.display]];
		}
		if (/\b(?:result|table|tbody|detail|empty|error)\b/i.test(signal) || /^(?:table|tbody)$/i.test(this.tagName)) {
			return [[this.id, "result", content, this.style.display]];
		}
		return [];
	}

	remove(): void {
		this.classList.add("hidden");
	}

	querySelector(selector: string): SmokeElement | null {
		return this.ownerDocument.querySelector(selector);
	}

	querySelectorAll(selector: string): SmokeElement[] {
		return this.ownerDocument.querySelectorAll(selector);
	}

	isVisible(): boolean {
		return (
			!/\b(d-none|hidden|visually-hidden|sr-only)\b/i.test(this.className) &&
			!/none/i.test(this.style.display) &&
			!/hidden/i.test(this.style.visibility)
		);
	}

	hasLoadingSignal(): boolean {
		const signal = `${this.id} ${this.className} ${this.textContent}`;
		return /\bloading\b|loading chart|loading data|spinner/i.test(signal);
	}

	hasMetricPlaceholder(): boolean {
		if (!this.textContent.includes("--")) return false;
		const signal = `${this.id} ${this.className}`;
		return /(kpi|metric|value|yield|count|output|loss|updated)/i.test(signal);
	}

	hasMetricSignal(): boolean {
		const signal = `${this.id} ${this.className}`;
		return /\b(?:kpi|metric)-?value\b/i.test(this.className) || /(?:kpi|metric).*(?:value|yield|count|output|loss)$/i.test(signal);
	}

	hasOnlyZeroMetricValues(): boolean {
		const values = this.textContent.match(/-?\d[\d,.]*/g);
		if (!values?.length) return false;
		return values.every((value) => Number(value.replace(/,/g, "")) === 0);
	}
}

class SmokeCanvasElement extends SmokeElement {
	width = 300;
	height = 150;
	private readonly context2d = new SmokeCanvasRenderingContext2D();

	constructor(ownerDocument: SmokeDocument) {
		super("canvas", ownerDocument);
	}

	getContext(contextId: string): SmokeCanvasRenderingContext2D | null {
		return contextId.toLowerCase() === "2d" ? this.context2d : null;
	}
}

class SmokeCanvasRenderingContext2D {
	fillStyle: string | object = "#000000";
	strokeStyle: string | object = "#000000";
	lineWidth = 1;
	shadowColor = "rgba(0, 0, 0, 0)";
	shadowBlur = 0;
	font = "10px sans-serif";
	textAlign = "start";
	globalAlpha = 1;

	beginPath(): void {}
	closePath(): void {}
	moveTo(_x: number, _y: number): void {}
	lineTo(_x: number, _y: number): void {}
	quadraticCurveTo(_controlX: number, _controlY: number, _x: number, _y: number): void {}
	bezierCurveTo(
		_controlX1: number,
		_controlY1: number,
		_controlX2: number,
		_controlY2: number,
		_x: number,
		_y: number,
	): void {}
	arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _radius: number): void {}
	rect(_x: number, _y: number, _width: number, _height: number): void {}
	arc(_x: number, _y: number, _radius: number, _startAngle: number, _endAngle: number): void {}
	fill(): void {}
	stroke(): void {}
	fillRect(_x: number, _y: number, _width: number, _height: number): void {}
	strokeRect(_x: number, _y: number, _width: number, _height: number): void {}
	clearRect(_x: number, _y: number, _width: number, _height: number): void {}
	fillText(_text: string, _x: number, _y: number): void {}
	strokeText(_text: string, _x: number, _y: number): void {}
	save(): void {}
	restore(): void {}
	translate(_x: number, _y: number): void {}
	rotate(_angle: number): void {}
	scale(_x: number, _y: number): void {}
	setTransform(..._values: number[]): void {}
	drawImage(..._values: unknown[]): void {}
}

class SmokeClassList {
	constructor(private readonly element: SmokeElement) {}

	add(...classNames: string[]): void {
		this.set([...this.values(), ...classNames]);
	}

	remove(...classNames: string[]): void {
		const remove = new Set(classNames);
		this.set(this.values().filter((className) => !remove.has(className)));
	}

	contains(className: string): boolean {
		return this.values().includes(className);
	}

	toggle(className: string, force?: boolean): boolean {
		const hasClass = this.contains(className);
		const shouldAdd = force ?? !hasClass;
		if (shouldAdd) this.add(className);
		else this.remove(className);
		return shouldAdd;
	}

	private values(): string[] {
		return this.element.className.split(/\s+/).filter(Boolean);
	}

	private set(values: string[]): void {
		this.element.className = [...new Set(values)].join(" ");
	}
}

class SmokeStyle {
	display = "";
	visibility = "";
	private readonly properties = new Map<string, string>();

	get cssText(): string {
		return [...this.properties.entries()].map(([name, value]) => `${name}: ${value}`).join("; ");
	}

	set cssText(value: string) {
		this.properties.clear();
		for (const declaration of value.split(";")) {
			const [name, ...rest] = declaration.split(":");
			if (!name || rest.length === 0) continue;
			this.setProperty(name.trim(), rest.join(":").trim());
		}
	}

	setProperty(name: string, value: string): void {
		this.properties.set(name, value);
		if (name === "display") this.display = value;
		if (name === "visibility") this.visibility = value;
	}

	getPropertyValue(name: string): string {
		return this.properties.get(name) ?? "";
	}

	removeProperty(name: string): void {
		this.properties.delete(name);
		if (name === "display") this.display = "";
		if (name === "visibility") this.visibility = "";
	}
}

class SmokeStorage {
	private readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	clear(): void {
		this.values.clear();
	}
}

class UnsupportedSmokeCapabilityError extends Error {
	constructor(readonly capability: string) {
		super(`Static smoke runtime does not simulate ${capability}.`);
		this.name = "UnsupportedSmokeCapabilityError";
	}
}

class SmokeChart {
	readonly data: Record<string, unknown>;
	readonly options: Record<string, unknown>;
	private destroyed = false;

	constructor(_context: unknown, config: unknown = {}) {
		const candidate = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
		this.data =
			candidate.data && typeof candidate.data === "object" ? (candidate.data as Record<string, unknown>) : {};
		this.options =
			candidate.options && typeof candidate.options === "object"
				? (candidate.options as Record<string, unknown>)
				: {};
	}

	clickHandler(): ((...args: unknown[]) => unknown) | undefined {
		return typeof this.options.onClick === "function"
			? (this.options.onClick as (...args: unknown[]) => unknown)
			: undefined;
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	dataSnapshot(): string {
		try {
			return JSON.stringify(this.data, (_key, value) => (typeof value === "function" ? undefined : value));
		} catch {
			return "[unserializable chart data]";
		}
	}

	destroy(): void {
		this.destroyed = true;
	}
	update(): void {}
}

function attributeMatch(attrs: string, pattern: RegExp): string {
	pattern.lastIndex = 0;
	return pattern.exec(attrs)?.[2]?.trim() ?? "";
}

function numericAttributeMatch(attrs: string, pattern: RegExp, fallback: number): number {
	pattern.lastIndex = 0;
	const value = Number(pattern.exec(attrs)?.[2]);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function dataAttributes(attrs: string): Array<[string, string]> {
	const values: Array<[string, string]> = [];
	DATA_ATTRIBUTE_PATTERN.lastIndex = 0;
	for (const match of attrs.matchAll(DATA_ATTRIBUTE_PATTERN)) {
		values.push([toDatasetName(match[1] ?? ""), match[3] ?? ""]);
	}
	return values;
}

function elementText(html: string, tagName: string, match: RegExpMatchArray): string {
	const contentStart = (match.index ?? 0) + match[0].length;
	const closeIndex = html.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`, contentStart);
	const inner = closeIndex >= 0 ? html.slice(contentStart, closeIndex) : "";
	return stripTags(inner).trim();
}

function selectOptionValues(html: string, match: RegExpMatchArray): string[] {
	const contentStart = (match.index ?? 0) + match[0].length;
	const closeIndex = html.toLowerCase().indexOf("</select>", contentStart);
	if (closeIndex < 0) return [];
	const inner = html.slice(contentStart, closeIndex);
	const values: string[] = [];
	for (const option of inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
		const value = attributeMatch(option[1] ?? "", VALUE_ATTRIBUTE_PATTERN) || stripTags(option[2] ?? "").trim();
		if (value) values.push(value);
	}
	return [...new Set(values)];
}

function selectorMatches(element: SmokeElement, selector: string): boolean {
	return selector.split(",").some((part) =>
		simpleSelectorMatches(
			element,
			part
				.trim()
				.split(/\s+|>|\+/)
				.filter(Boolean)
				.pop() ?? "",
		),
	);
}

function simpleSelectorMatches(element: SmokeElement, selector: string): boolean {
	if (!selector) return false;
	const id = selector.match(/#([A-Za-z][\w:.-]*)/)?.[1];
	if (id && element.id !== id) return false;
	const classNames = [...selector.matchAll(/\.([A-Za-z][\w:-]*)/g)].map((match) => match[1] ?? "");
	if (classNames.some((className) => !element.className.split(/\s+/).includes(className))) return false;
	const attr = selector.match(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/);
	if (attr) {
		const attrValue = element.getAttribute(attr[1] ?? "");
		if (attr[2] !== undefined ? attrValue !== attr[2] : attrValue === null) return false;
	}
	const tag = selector.match(/^([a-z][\w:-]*)/i)?.[1];
	return !tag || element.tagName.toLowerCase() === tag.toLowerCase();
}

function describeRuntimeError(error: unknown, sources?: Map<string, string>): string {
	const message = error instanceof Error ? error.message : String(error);
	const line = sourceLineFromSources(error, sources);
	return line ? `${message} near \`${line}\`` : message;
}

function recordRuntimeIssue(error: unknown, message: string, errors: string[], warnings: string[]): void {
	if (error instanceof UnsupportedSmokeCapabilityError) {
		warnings.push(`Runtime smoke gate skipped unsupported browser capability ${error.capability}.`);
		return;
	}
	errors.push(message);
}

function enrichListenerError(error: unknown, listener: Listener): Error {
	if (error instanceof UnsupportedSmokeCapabilityError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const line = sourceLineFromListener(listener, message);
	return new Error(line ? `${message} near \`${line}\`` : message);
}

function sourceLineFromListener(listener: Listener, errorMessage: string): string {
	const source = listener.toString();
	const property = errorMessage.match(/reading ['"`]([^'"`]+)['"`]/)?.[1];
	const lines = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (property) {
		const propertyLine = lines.find((line) => line.includes(`.${property}`) || line.includes(`[${property}`));
		if (propertyLine) return propertyLine;
	}
	return lines.find((line) => !line.startsWith("(") && !line.startsWith("function")) ?? "";
}

function sourceLineFromSources(error: unknown, sources?: Map<string, string>): string {
	if (!(error instanceof Error) || !error.stack || !sources) return "";
	for (const [label, content] of sources) {
		const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = error.stack.match(new RegExp(`${escapedLabel}:(\\d+):(\\d+)`));
		const lineNumber = Number(match?.[1]);
		if (Number.isFinite(lineNumber) && lineNumber > 0) return content.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
	}
	return "";
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function relativeCheckedPath(root: string, file: string): string {
	const relative = normalize(file)
		.slice(normalize(root).length)
		.replace(/^[/\\]+/, "");
	return relative || file;
}

function toDatasetName(name: string): string {
	return name.replace(/-([a-z])/g, (_, value: string) => value.toUpperCase());
}
