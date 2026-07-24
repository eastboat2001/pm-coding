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
const SELECTED_ATTRIBUTE_PATTERN = /\bselected(?:\s*=\s*(?:['"]selected['"]|selected))?\b/i;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const HTML_TAG_TOKEN_PATTERN = /<(\/)?([a-z][\w:-]*)\b([^>]*)>/gi;
const VOID_HTML_TAG_PATTERN = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/iu;
const DATA_ATTRIBUTE_PATTERN = /\bdata-([a-z0-9_.:-]+)\s*=\s*(['"])([^'"]*)\2/gi;
const DEFAULT_SCRIPT_TIMEOUT_MS = 500;
const MAX_TIMER_FLUSH = 50;
const MAX_CHART_INTERACTION_SAMPLES = 32;
const MAX_FILTER_PAIR_SAMPLES = 48;
const MAX_EMPTY_STATE_CHART_MISMATCH_REPORTS = 4;
const VISUALIZATION_SEMANTIC_SOURCE =
	"(?:chart|trend|graph|plot|yield|defect|donut|pareto|visuali[sz]ation|viz|heatmap|treemap|choropleth|map|gauge|network|diagram|timeline|calendar|matrix)";
const VISUALIZATION_SEMANTIC_PATTERN = new RegExp(VISUALIZATION_SEMANTIC_SOURCE, "iu");
const BROWSER_GLOBALS_NOT_SIMULATED = new Set([
	"AbortController",
	"Audio",
	"Blob",
	"CSS",
	"CustomEvent",
	"DOMParser",
	"File",
	"FileReader",
	"FormData",
	"Headers",
	"Image",
	"IntersectionObserver",
	"MutationObserver",
	"Request",
	"Response",
	"TextDecoder",
	"TextEncoder",
	"URL",
	"Worker",
	"atob",
	"btoa",
	"crypto",
	"fetch",
	"getComputedStyle",
	"indexedDB",
	"matchMedia",
	"performance",
]);
const BROWSER_MEMBERS_NOT_SIMULATED = new Set([
	"document.createDocumentFragment",
	"document.elementFromPoint",
	"document.getElementsByClassName",
	"document.getElementsByName",
	"document.getElementsByTagName",
	"navigator.clipboard.writeText",
	"navigator.share",
	"window.getComputedStyle",
	"window.matchMedia",
]);

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
	const hasUnsimulatedExternalScripts = warnings.some((warning) =>
		warning.startsWith("Runtime smoke gate skipped external script "),
	);

	const timeout = input.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
	const runtime = new SmokeRuntime(
		html,
		new Map(scripts.map((script) => [script.label, script.content])),
		timeout,
		hasUnsimulatedExternalScripts,
	);
	const context = runtime.context();
	const startupErrorCount = errors.length;
	for (const script of scripts) {
		runScript(script, context, timeout, "script evaluation", errors, warnings);
		runtime.flushTimers(errors, warnings);
	}
	runtime.dispatchDocumentEvent("DOMContentLoaded", errors, warnings);
	// DOMContentLoaded is dispatched at document and bubbles through window in a
	// browser. Generated static apps commonly register the startup listener on
	// window, so exercise that path too instead of silently skipping initialization.
	runtime.dispatchWindowEvent("DOMContentLoaded", errors, warnings);
	runtime.flushTimers(errors, warnings);
	await runtime.settleAsyncCallbacks(errors, warnings);
	runtime.dispatchWindowEvent("load", errors, warnings);
	runtime.flushTimers(errors, warnings);
	await runtime.settleAsyncCallbacks(errors, warnings);
	if (hasUnsimulatedExternalScripts) downgradeExternalScriptGlobalErrors(errors, warnings);
	runtime.captureDefaultView();
	// Once startup has failed, exercising every select and pairwise combination
	// only creates cascades from the same uninitialized state. Preserve the first
	// actionable root error and avoid flooding repair context with derivative
	// failures that cannot add confidence.
	const startupSucceeded = errors.length === startupErrorCount;
	if (startupSucceeded) {
		runtime.exerciseInteractions(errors, warnings);
		runtime.flushTimers(errors, warnings);
		await runtime.settleAsyncCallbacks(errors, warnings);
	}
	if (hasUnsimulatedExternalScripts) downgradeExternalScriptGlobalErrors(errors, warnings);

	// A failed startup commonly leaves every KPI placeholder and loading element
	// untouched. Those are consequences of the root exception, not independent
	// repair targets. Keep console.error evidence, but suppress derivative rendered-
	// state failures until startup itself succeeds.
	errors.push(...runtime.validationErrors(startupSucceeded));
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
	private pendingAsyncCallbackCount = 0;
	private readonly asyncCallbackErrors: unknown[] = [];
	private timerId = 0;
	private successfulFilterInteraction = false;
	private defaultMetricCount = 0;
	private defaultMetricsAllEmpty = false;
	private defaultMetricsAllZero = false;
	private defaultHasVisibleCanvas = false;
	private defaultMetricsRepresentative = false;
	private readonly reportedInvalidRenderedData = new Set<string>();
	private readonly reportedEmptyStateChartMismatch = new Set<string>();
	private readonly hasDeterministicFixtureData: boolean;
	private readonly hasSourceDashboardDataSurfaces: boolean;

	constructor(
		html: string,
		private readonly sources: Map<string, string>,
		private readonly scriptTimeoutMs: number,
		private readonly hasUnsimulatedExternalScripts: boolean,
	) {
		this.document = new SmokeDocument(html, this.missingSelectors);
		this.hasDeterministicFixtureData = [...sources.values()].some((source) => {
			const namedFixture =
				/\b(?:(?:const|let|var)\s+(?=[A-Za-z_$][\w$]*\b)(?=[\w$]*(?:mock|fixture|demo|sample))[A-Za-z_$][\w$]*\s*=\s*(?:\{|\[|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(?:generate|build|create)[A-Za-z_$][\w$]*\s*\()|function\s+(?=[A-Za-z_$][\w$]*\b)(?=[\w$]*(?:mock|fixture|demo|sample))[A-Za-z_$][\w$]*\s*\()/iu.test(
					source,
				);
			// Generated static dashboards often disclose deterministic fixtures in a
			// comment while using business-specific names such as WEEKS/DEFECTS and
			// genWeekData. Require that explicit disclosure plus local literal data;
			// a generic "simulation" word alone is not sufficient.
			const fixtureDisclosure = (source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu) ?? []).some((comment) =>
				/(?:deterministic[\s\S]{0,80}(?:mock|fixture|demo|sample|simulation)|(?:mock|fixture|demo|sample|simulation)[\s\S]{0,80}deterministic)/iu.test(
					comment,
				),
			);
			const hasLocalLiteralData =
				/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[/u.test(source) ||
				/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{[\s\S]{0,4096}?\b[A-Za-z_$][\w$]*\s*:\s*\[/u.test(source);
			const explicitlyDisclosedFixture = fixtureDisclosure && hasLocalLiteralData;
			return namedFixture || explicitlyDisclosedFixture;
		});
		const combinedSource = `${html}\n${[...sources.values()].join("\n")}`;
		const sourceChartSurfaceCount = (
			combinedSource.match(
				new RegExp(
					String.raw`(?:\b(?:id|class)\s*=\s*["'][^"']*${VISUALIZATION_SEMANTIC_SOURCE}[^"']*["']|(?:getElementById|querySelector)\s*\(\s*["'][^"']*${VISUALIZATION_SEMANTIC_SOURCE}[^"']*["']\s*\))`,
					"giu",
				),
			) ?? []
		).length;
		this.hasSourceDashboardDataSurfaces =
			sourceChartSurfaceCount >= 2 &&
			/(?:<table\b|<tbody\b|\b(?:render|update|refresh)(?:Detail|Table|Results?)\b|\b(?:detail|result)[-_ ]?(?:table|grid)\b)/iu.test(
				combinedSource,
			);
	}

	context(): Context {
		const charts = this.charts;
		class RuntimeSmokeResizeObserver {
			private readonly observed = new Set<SmokeElement>();

			constructor(
				private readonly callback: (
					entries: Array<{ target: SmokeElement; contentRect: ReturnType<SmokeElement["getBoundingClientRect"]> }>,
					observer: RuntimeSmokeResizeObserver,
				) => void,
			) {}

			observe(target: SmokeElement): void {
				if (!(target instanceof SmokeElement) || this.observed.has(target)) return;
				this.observed.add(target);
				this.callback([{ target, contentRect: target.getBoundingClientRect() }], this);
			}

			unobserve(target: SmokeElement): void {
				this.observed.delete(target);
			}

			disconnect(): void {
				this.observed.clear();
			}
		}
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
			devicePixelRatio: 2,
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
			ResizeObserver: RuntimeSmokeResizeObserver,
			Event: SmokeEvent,
			Node: SmokeElement,
			HTMLElement: SmokeElement,
			__piSmokeAsyncStarted: () => {
				this.pendingAsyncCallbackCount += 1;
			},
			__piSmokeAsyncFinished: () => {
				this.pendingAsyncCallbackCount = Math.max(0, this.pendingAsyncCallbackCount - 1);
			},
			__piSmokeAsyncFailed: (error: unknown) => {
				this.asyncCallbackErrors.push(error);
				this.pendingAsyncCallbackCount = Math.max(0, this.pendingAsyncCallbackCount - 1);
			},
		};
		Object.assign(this.contextValues, windowObject);
		// A browser's Window is also the classic-script global object. Keeping a
		// separate stand-in makes `window.foo = ...; foo()` fail only in the VM and
		// also drops HTML named globals. Point all aliases at the context object so
		// global property assignment and identifier lookup share browser semantics.
		this.contextValues.window = this.contextValues;
		this.contextValues.self = this.contextValues;
		this.contextValues.globalThis = this.contextValues;
		return createContext(this.contextValues);
	}

	captureDefaultView(): void {
		const metrics = this.document.visibleMetricElements();
		this.defaultMetricCount = metrics.length;
		this.defaultMetricsAllEmpty = metrics.length >= 2 && metrics.every((metric) => metric.hasEmptyMetricValue());
		this.defaultMetricsAllZero = metrics.length >= 2 && metrics.every((metric) => metric.hasOnlyZeroMetricValues());
		this.defaultMetricsRepresentative =
			metrics.length >= 2 && !this.defaultMetricsAllEmpty && !this.defaultMetricsAllZero;
		this.defaultHasVisibleCanvas = this.document.elementsByTagName("canvas").some((canvas) => canvas.isVisible());
	}

	exerciseInteractions(errors: string[], warnings: string[]): void {
		const filterActions = this.document.filterActionElements();
		const selects = this.document.elementsByTagName("select");
		const originalSelectValues = new Map(selects.map((element) => [element, element.value]));
		if (filterActions.length > 0 && this.hasDeterministicFixtureData && this.defaultMetricsRepresentative) {
			const before = this.observableDataFingerprint();
			let defaultApplyFailed = false;
			try {
				for (const action of filterActions) {
					action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
						this.invokeCallback(listener, [event], action),
					);
					this.flushTimers(errors, warnings);
				}
			} catch (error) {
				defaultApplyFailed = true;
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: default filter action handler failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
			this.recordInvalidRenderedData(errors, "after the unchanged default filter action");
			this.recordEmptyStateChartMismatch(errors, "after the unchanged default filter action");
			if (
				!defaultApplyFailed &&
				before !== this.observableDataFingerprint() &&
				this.document.visibleMetricsAllZeroOrEmpty()
			) {
				const evidence = this.fixtureFieldMismatchEvidence();
				errors.push(
					evidence
						? `Runtime smoke gate: applying unchanged default filters replaced representative KPI data with an empty result; ${evidence.path}:${evidence.line} filter predicate reads missing fixture field ${evidence.field}.`
						: "Runtime smoke gate: applying unchanged default filters replaced representative KPI data with an empty result.",
				);
			}
		}
		let combinedFilterInteractionWorked = false;
		if (filterActions.length > 0) {
			const before = this.observableDataFingerprint();
			for (const element of selects) {
				const [candidate] = element.interactionCandidates();
				if (candidate !== undefined) element.value = candidate;
			}
			try {
				for (const action of filterActions) {
					action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
						this.invokeCallback(listener, [event], action),
					);
					this.flushTimers(errors, warnings);
				}
				combinedFilterInteractionWorked = before !== this.observableDataFingerprint();
				if (combinedFilterInteractionWorked) this.successfulFilterInteraction = true;
				this.recordInvalidRenderedData(errors, "after combined filter options changed");
				this.recordEmptyStateChartMismatch(errors, "after combined filter options changed");
			} catch (error) {
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: filter action handler failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
			for (const [element, value] of originalSelectValues) element.value = value;
			try {
				for (const action of filterActions) {
					action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
						this.invokeCallback(listener, [event], action),
					);
					this.flushTimers(errors, warnings);
				}
			} catch (error) {
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: filter action reset handler failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
		}
		for (const element of selects) {
			const canExercise = element.hasListeners("change") || filterActions.length > 0;
			// Delegated events, form submission, or framework handlers are not fully
			// represented by the synthetic DOM. Without a direct change listener or an
			// explicit Apply/Search action, do not manufacture an inert-control error.
			if (!canExercise) continue;
			const originalValue = element.value;
			const testValues = element.interactionCandidates();
			if (testValues.length === 0) continue;
			const beforeSnapshot = this.document.observableDataSnapshot();
			const before = this.observableDataFingerprint();
			let changedObservableData = false;
			let interactionFailed = false;
			const partialUpdateGaps = new Set<string>();
			for (const testValue of testValues) {
				element.value = testValue;
				try {
					element.dispatchEvent(new SmokeEvent("change"), (listener, event) =>
						this.invokeCallback(listener, [event], element),
					);
					this.flushTimers(errors, warnings);
					if (before === this.observableDataFingerprint()) {
						for (const action of filterActions) {
							action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
								this.invokeCallback(listener, [event], action),
							);
							this.flushTimers(errors, warnings);
							if (before !== this.observableDataFingerprint()) break;
						}
					}
					changedObservableData = changedObservableData || before !== this.observableDataFingerprint();
					if (changedObservableData) this.successfulFilterInteraction = true;
					if (
						before !== this.observableDataFingerprint() &&
						this.hasDeterministicFixtureData &&
						!this.hasUnsimulatedExternalScripts &&
						this.document.isSharedGlobalDashboardFilter(element) &&
						element.listenerMatches(
							"change",
							/(?:renderAll|renderDashboard|updateDashboard|refreshDashboard)\s*\(/iu,
						)
					) {
						for (const gap of synchronizedSurfaceGaps(beforeSnapshot, this.document.observableDataSnapshot())) {
							partialUpdateGaps.add(gap);
						}
					}
					this.recordInvalidRenderedData(
						errors,
						element.id ? `after select #${element.id} changed` : "after a select changed",
					);
					this.recordEmptyStateChartMismatch(
						errors,
						element.id ? `after select #${element.id} changed` : "after a select changed",
					);
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
					for (const action of filterActions) {
						action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
							this.invokeCallback(listener, [event], action),
						);
						this.flushTimers(errors, warnings);
					}
				} catch (error) {
					interactionFailed = true;
					recordRuntimeIssue(
						error,
						`Runtime smoke gate: select reset handler failed${element.id ? ` for #${element.id}` : ""}: ${describeRuntimeError(error, this.sources)}`,
						errors,
						warnings,
					);
				}
			}
			const combinedInteractionExplainsEmptyDefault =
				combinedFilterInteractionWorked && (this.defaultMetricsAllEmpty || this.defaultMetricsAllZero);
			if (partialUpdateGaps.size > 0 && !interactionFailed) {
				errors.push(
					`Runtime smoke gate: deterministic global select${element.id ? ` #${element.id}` : ""} changed some dashboard data but left synchronized surfaces unchanged: ${[...partialUpdateGaps].join(", ")}.`,
				);
			}
			if (!changedObservableData && !interactionFailed && !combinedInteractionExplainsEmptyDefault) {
				const hasFilterAction = filterActions.some((action) =>
					/(?:filter|apply|search|query|筛选|应用|查询)/iu.test(
						`${action.id} ${action.className} ${action.textContent}`,
					),
				);
				const hasDashboardRenderListener = element.listenerMatches(
					"change",
					/(?:renderAll|renderDashboard|updateDashboard|refreshDashboard|applyFilters)\s*\(/iu,
				);
				const deterministicDashboardEvidence =
					this.hasDeterministicFixtureData &&
					!this.hasUnsimulatedExternalScripts &&
					(this.defaultMetricCount >= 2 ||
						this.document.hasDashboardDataSurfaces() ||
						this.hasSourceDashboardDataSurfaces) &&
					Boolean(element.id) &&
					(this.document.isDashboardDataFilter(element) || hasDashboardRenderListener || hasFilterAction);
				const noEffectMessage = `Runtime smoke gate: ${deterministicDashboardEvidence ? "deterministic fixture " : ""}select${element.id ? ` #${element.id}` : ""} changed value but did not change rendered metrics, chart data, results, or empty state.`;
				(deterministicDashboardEvidence ? errors : warnings).push(noEffectMessage);
			}
		}
		this.exercisePairwiseFilterStates(selects, filterActions, originalSelectValues, errors, warnings);
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
				this.recordInvalidRenderedData(errors, "after a chart mark click");
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

	private exercisePairwiseFilterStates(
		selects: SmokeElement[],
		filterActions: SmokeElement[],
		originalValues: Map<SmokeElement, string>,
		errors: string[],
		warnings: string[],
	): void {
		if (
			!this.hasDeterministicFixtureData ||
			(!this.document.hasDashboardDataSurfaces() && !this.hasSourceDashboardDataSurfaces)
		) {
			return;
		}
		let samples = 0;
		outer: for (let leftIndex = 0; leftIndex < selects.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < selects.length; rightIndex += 1) {
				const left = selects[leftIndex];
				const right = selects[rightIndex];
				if (!left || !right) continue;
				for (const leftValue of left.interactionCandidates().slice(0, 4)) {
					for (const rightValue of right.interactionCandidates().slice(0, 4)) {
						if (samples >= MAX_FILTER_PAIR_SAMPLES) break outer;
						samples += 1;
						left.value = leftValue;
						right.value = rightValue;
						try {
							for (const element of [left, right]) {
								element.dispatchEvent(new SmokeEvent("change"), (listener, event) =>
									this.invokeCallback(listener, [event], element),
								);
								this.flushTimers(errors, warnings);
							}
							for (const action of filterActions) {
								action.dispatchEvent(new SmokeEvent("click"), (listener, event) =>
									this.invokeCallback(listener, [event], action),
								);
								this.flushTimers(errors, warnings);
							}
							const phase = `after selects ${left.selectorIdentity()}=${leftValue} and ${right.selectorIdentity()}=${rightValue} changed`;
							this.recordInvalidRenderedData(errors, phase);
							this.recordEmptyStateChartMismatch(errors, phase);
						} catch (error) {
							recordRuntimeIssue(
								error,
								`Runtime smoke gate: pairwise select handlers failed for ${left.selectorIdentity()} and ${right.selectorIdentity()}: ${describeRuntimeError(error, this.sources)}`,
								errors,
								warnings,
							);
						} finally {
							left.value = originalValues.get(left) ?? "";
							right.value = originalValues.get(right) ?? "";
							for (const element of [left, right]) {
								try {
									element.dispatchEvent(new SmokeEvent("change"), (listener, event) =>
										this.invokeCallback(listener, [event], element),
									);
									this.flushTimers(errors, warnings);
								} catch {
									// The original interaction error above already carries bounded evidence.
								}
							}
						}
					}
				}
			}
		}
	}

	private recordInvalidRenderedData(errors: string[], phase: string): void {
		const [evidence] = this.document.invalidRenderedDataSurfaces();
		if (!evidence) return;
		const key = `${evidence.selector}\u0000${evidence.token}\u0000${phase}`;
		if (this.reportedInvalidRenderedData.has(key)) return;
		this.reportedInvalidRenderedData.add(key);
		errors.push(
			`Runtime smoke gate: dashboard data surface ${evidence.selector} rendered invalid token ${evidence.token} ${phase}. Evidence: ${evidence.sample}`,
		);
	}

	private recordEmptyStateChartMismatch(errors: string[], phase: string): void {
		const evidence = this.document.dashboardEmptyStateWithChartData();
		if (!evidence) return;
		if (this.reportedEmptyStateChartMismatch.size >= MAX_EMPTY_STATE_CHART_MISMATCH_REPORTS) return;
		const key = `${evidence.emptySelector}\u0000${evidence.chartSelectors.join(",")}\u0000${phase}`;
		if (this.reportedEmptyStateChartMismatch.has(key)) return;
		this.reportedEmptyStateChartMismatch.add(key);
		errors.push(
			`Runtime smoke gate: dashboard rendered explicit empty state in ${evidence.emptySelector} while chart surfaces ${evidence.chartSelectors.join(", ")} still contained data ${phase}.`,
		);
	}

	private observableDataFingerprint(): string {
		const activeCharts = this.charts.filter((chart) => !chart.isDestroyed()).map((chart) => chart.dataSnapshot());
		return JSON.stringify({
			document: this.document.observableDataSnapshot(),
			charts: activeCharts,
			location: this.contextValues.location,
		});
	}

	private fixtureFieldMismatchEvidence(): { path: string; line: number; field: string } | undefined {
		const combinedSource = [...this.sources.values()].join("\n");
		for (const [path, source] of this.sources) {
			for (const match of source.matchAll(
				/\.filter\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,500}?\b\1\.([A-Za-z_$][\w$]*)/gu,
			)) {
				const field = match[2];
				if (!field) continue;
				const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				if (new RegExp(`\\b${escaped}\\s*:`, "u").test(combinedSource)) continue;
				return {
					path,
					line: source.slice(0, match.index ?? 0).split(/\r?\n/).length,
					field,
				};
			}
		}
		return undefined;
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

	async settleAsyncCallbacks(errors: string[], warnings: string[]): Promise<void> {
		// Browser event listeners and timer callbacks may be async. Observing the
		// returned promises prevents an application rejection from escaping as a
		// process-level unhandledRejection (which previously terminated the Worker).
		// Alternate microtask turns with the deterministic timer queue so common
		// `await delay(...)` startup flows can finish without real wall-clock waits.
		for (let turn = 0; turn < 12; turn += 1) {
			for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();
			this.flushTimers(errors, warnings);
			for (let microtask = 0; microtask < 16; microtask += 1) await Promise.resolve();
			// Promises created inside a node:vm context may not deliver their host-side
			// observation handlers until the next event-loop turn.
			await new Promise<void>((resolve) => setImmediate(resolve));
			while (this.asyncCallbackErrors.length > 0) {
				const error = this.asyncCallbackErrors.shift();
				recordRuntimeIssue(
					error,
					`Runtime smoke gate: asynchronous callback failed: ${describeRuntimeError(error, this.sources)}`,
					errors,
					warnings,
				);
			}
			if (this.pendingAsyncCallbackCount === 0 && this.timers.length === 0) return;
		}
		warnings.push(
			`Runtime smoke gate stopped waiting for ${this.pendingAsyncCallbackCount} asynchronous callback(s) after bounded deterministic startup sampling.`,
		);
	}

	validationErrors(includeRenderedState = true): string[] {
		const errors: string[] = [];
		if (includeRenderedState) this.recordInvalidRenderedData(errors, "during initial or restored rendering");
		for (const message of this.consoleErrors) {
			errors.push(`Runtime smoke gate: console.error was called with ${message}.`);
		}
		if (!includeRenderedState) return errors;
		for (const element of this.document.visibleLoadingElements()) {
			errors.push(`Runtime smoke gate: loading element #${element.id} remained visible after startup.`);
		}
		for (const element of this.document.metricPlaceholderElements()) {
			errors.push(`Runtime smoke gate: metric placeholder #${element.id} still shows "--" after startup.`);
		}
		return errors;
	}

	validationWarnings(): string[] {
		if (this.successfulFilterInteraction && this.defaultMetricsAllEmpty) {
			return [
				`Runtime smoke gate: the default filter state leaves all ${this.defaultMetricCount} visible KPI metrics empty even though a valid filter interaction renders data; verify empty multi-select placeholders are excluded from filter values.`,
			];
		}
		if (this.defaultMetricsAllZero && this.defaultHasVisibleCanvas) {
			return [
				`Runtime smoke gate: all ${this.defaultMetricCount} visible KPI metrics remain zero after startup while chart content is present; verify the default view renders representative data or an explicit empty state.`,
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
			new Script(`(() => {
				const result = __piSmokeCallback.call(__piSmokeCallbackThis, ...__piSmokeCallbackArgs);
				if (result && typeof result.then === "function") {
					__piSmokeAsyncStarted();
					result.then(__piSmokeAsyncFinished, __piSmokeAsyncFailed);
				}
			})()`).runInContext(this.contextValues, { timeout: this.scriptTimeoutMs });
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

	hasListeners(type: string): boolean {
		return (this.listeners.get(type)?.length ?? 0) > 0 || typeof this.eventHandlerProperty(type) === "function";
	}

	listenerMatches(type: string, pattern: RegExp): boolean {
		const propertyHandler = this.eventHandlerProperty(type);
		return (
			(this.listeners.get(type) ?? []).some((listener) => pattern.test(listener.toString())) ||
			(typeof propertyHandler === "function" && pattern.test(propertyHandler.toString()))
		);
	}

	dispatchEvent(event: SmokeEvent, invokeListener?: ListenerInvoker): boolean {
		event.target = this;
		const propertyHandler = this.eventHandlerProperty(event.type);
		const listeners = [
			...(typeof propertyHandler === "function" ? [propertyHandler as Listener] : []),
			...(this.listeners.get(event.type) ?? []),
		];
		for (const listener of listeners) {
			try {
				if (invokeListener) invokeListener(listener, event);
				else listener(event);
			} catch (error) {
				throw enrichListenerError(error, listener);
			}
		}
		return !event.defaultPrevented;
	}

	private eventHandlerProperty(type: string): unknown {
		return (this as unknown as Record<string, unknown>)[`on${type}`];
	}
}

class SmokeDocument extends SmokeEventTarget {
	readonly body: SmokeElement;
	readonly documentElement: SmokeElement;
	readonly head: SmokeElement;
	readyState = "loading";
	private readonly elements: SmokeElement[] = [];
	private readonly byId = new Map<string, SmokeElement>();

	constructor(
		html: string,
		private readonly missingSelectors: Set<string>,
	) {
		super("document");
		this.documentElement = this.createElement("html");
		this.head = this.createElement("head");
		this.body = this.createElement("body");
		this.parse(html);
	}

	createElement(tagName: string): SmokeElement {
		const element =
			tagName.toLowerCase() === "canvas" ? new SmokeCanvasElement(this) : new SmokeElement(tagName, this);
		this.track(element);
		return element;
	}

	createElementNS(_namespace: string | null, qualifiedName: string): SmokeElement {
		return this.createElement(qualifiedName);
	}

	createTextNode(value: unknown): SmokeElement {
		const node = new SmokeElement("#text", this);
		node.textContent = value;
		return node;
	}

	getElementById(id: string): SmokeElement | null {
		const element = this.byId.get(id) ?? null;
		if (!element) this.missingSelectors.add(`#${id}`);
		return element;
	}

	updateElementId(element: SmokeElement, previousId: string, nextId: string): void {
		if (previousId && this.byId.get(previousId) === element) this.byId.delete(previousId);
		if (nextId) this.byId.set(nextId, element);
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

	visibleMetricsAllZeroOrEmpty(): boolean {
		const metrics = this.visibleMetricElements();
		return (
			metrics.length >= 2 &&
			metrics.every((metric) => metric.hasEmptyMetricValue() || metric.hasOnlyZeroMetricValues())
		);
	}

	hasDashboardDataSurfaces(): boolean {
		const semanticChartCount = this.elements.filter((element) => {
			if (!/^(?:canvas|svg)$/iu.test(element.tagName)) return false;
			if (!element.isVisible()) return false;
			return VISUALIZATION_SEMANTIC_PATTERN.test(`${element.id} ${element.className}`);
		}).length;
		const hasDetailResult = this.elements.some((element) => {
			const signal = `${element.id} ${element.className} ${element.tagName}`;
			return /(?:table|tbody|detail|result)/iu.test(signal);
		});
		return semanticChartCount >= 2 && hasDetailResult;
	}

	dashboardEmptyStateWithChartData(): { emptySelector: string; chartSelectors: string[] } | undefined {
		const metrics = this.visibleMetricElements();
		if (
			metrics.length < 2 ||
			!metrics.every((metric) => metric.hasEmptyMetricValue() || metric.hasOnlyZeroMetricValues())
		) {
			return undefined;
		}
		const emptyResult = this.elements.find((element) => element.hasExplicitEmptyResult());
		if (!emptyResult) return undefined;
		const charts = this.elements.filter(
			(element) =>
				/^(?:canvas|svg)$/iu.test(element.tagName) &&
				element.isVisible() &&
				VISUALIZATION_SEMANTIC_PATTERN.test(`${element.id} ${element.className}`) &&
				element.hasRenderedChartData(),
		);
		if (charts.length < 2) return undefined;
		return {
			emptySelector: emptyResult.selectorIdentity(),
			chartSelectors: charts.slice(0, 8).map((chart) => chart.selectorIdentity()),
		};
	}

	invalidRenderedDataSurfaces(): Array<{ selector: string; token: "NaN" | "undefined"; sample: string }> {
		if (!this.hasDashboardDataSurfaces()) return [];
		return this.elements.flatMap((element) => {
			const invalid = element.invalidRenderedData();
			if (!invalid) return [];
			return [
				{
					selector: element.selectorIdentity(),
					token: invalid.token,
					sample: invalid.sample,
				},
			];
		});
	}

	observableDataSnapshot(): unknown[] {
		const snapshots: unknown[] = [];
		const canvases = new Map<string, unknown>();
		for (const element of this.elements) {
			if (element instanceof SmokeCanvasElement) {
				const identity = element.id || element.className;
				if (identity) canvases.set(identity, element.observableCanvasSnapshot());
				continue;
			}
			snapshots.push(...element.observableDataSnapshot());
		}
		return [...snapshots, ...canvases.values()];
	}

	elementsByTagName(tagName: string): SmokeElement[] {
		return this.elements.filter((element) => element.tagName.toLowerCase() === tagName.toLowerCase());
	}

	elementSibling(element: SmokeElement, direction: -1 | 1): SmokeElement | null {
		const parent = element.parentElement;
		const start = this.elements.indexOf(element);
		if (start < 0) return null;
		for (let index = start + direction; index >= 0 && index < this.elements.length; index += direction) {
			const candidate = this.elements[index];
			if (candidate?.parentElement === parent) return candidate;
		}
		return null;
	}

	elementChildren(parent: SmokeElement): SmokeElement[] {
		return this.elements.filter((candidate) => candidate !== parent && candidate.parentElement === parent);
	}

	elementSiblingBoundary(parent: SmokeElement, direction: -1 | 1): SmokeElement | null {
		const children = this.elementChildren(parent);
		return direction === 1 ? (children[0] ?? null) : (children.at(-1) ?? null);
	}

	filterActionElements(): SmokeElement[] {
		return this.elements.filter((element) => {
			if (!/^(?:button|input)$/i.test(element.tagName) || !element.hasListeners("click")) return false;
			return /(?:apply|filter|search|refresh|update|run)/i.test(
				`${element.id} ${element.className} ${element.textContent}`,
			);
		});
	}

	isSharedGlobalDashboardFilter(element: SmokeElement): boolean {
		let scope = element.parentElement;
		while (scope && scope !== this.body) {
			if (
				/(?:^|\s)(?:filters?|filter-bar|filter-section|dashboard-filters?)(?:\s|$)/iu.test(
					`${scope.id} ${scope.className}`,
				)
			) {
				const selectCount = this.elements.filter(
					(candidate) => candidate.tagName.toLowerCase() === "select" && scope?.contains(candidate),
				).length;
				return selectCount >= 2;
			}
			scope = scope.parentElement;
		}
		return false;
	}

	isDashboardDataFilter(element: SmokeElement): boolean {
		if (/(?:filter|facet|search|query|筛选|过滤|查询)/iu.test(`${element.id} ${element.className}`)) return true;
		if (Object.keys(element.dataset).some((key) => /(?:filter|facet|scope|query)/iu.test(key))) return true;
		let scope = element.parentElement;
		while (scope && scope !== this.body) {
			if (/(?:filter|facet|search|query|筛选|过滤|查询)/iu.test(`${scope.id} ${scope.className}`)) return true;
			scope = scope.parentElement;
		}
		return false;
	}

	private parse(html: string): void {
		for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
			const tagName = match[1] ?? "";
			if (/^(script|link|meta|title|html|head|body)$/i.test(tagName)) continue;
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
			if (tagName.toLowerCase() === "select") element.setSelectMarkup(selectInnerMarkup(html, match));
			for (const [name, value] of dataAttributes(attrs)) element.dataset[name] = value;
			if (element.id) this.byId.set(element.id, element);
		}
		this.assignParsedParents(html);
	}

	private assignParsedParents(html: string): void {
		const parsedElements = this.elements.slice(3);
		const stack: Array<{ element: SmokeElement; tagName: string }> = [
			{ element: this.documentElement, tagName: "html" },
		];
		let parsedIndex = 0;
		for (const token of html.matchAll(HTML_TAG_TOKEN_PATTERN)) {
			const closing = token[1] === "/";
			const tagName = (token[2] ?? "").toLowerCase();
			if (closing) {
				let stackIndex = -1;
				for (let index = stack.length - 1; index >= 0; index -= 1) {
					if (stack[index]?.tagName === tagName) {
						stackIndex = index;
						break;
					}
				}
				if (stackIndex > 0) stack.splice(stackIndex);
				continue;
			}
			if (tagName === "html") continue;
			if (tagName === "head") {
				stack.splice(1, stack.length, { element: this.head, tagName });
				continue;
			}
			if (tagName === "body") {
				stack.splice(1, stack.length, { element: this.body, tagName });
				continue;
			}
			if (/^(?:script|link|meta|title)$/iu.test(tagName)) continue;
			const element = parsedElements[parsedIndex++];
			if (!element) break;
			element.setParsedParent(stack.at(-1)?.element ?? this.body);
			const selfClosing = /\/\s*>$/u.test(token[0]);
			if (!selfClosing && !VOID_HTML_TAG_PATTERN.test(tagName)) stack.push({ element, tagName });
		}
	}

	private track(element: SmokeElement): void {
		this.elements.push(element);
		if (element.id) this.updateElementId(element, "", element.id);
	}
}

class SmokeElement extends SmokeEventTarget {
	private identifier = "";
	className = "";
	clientWidth = 1024;
	clientHeight = 768;
	private text = "";
	private html = "";
	private currentValue = "";
	private hasExplicitSelection = false;
	private appendedParent: SmokeElement | null = null;
	private parsedParent: SmokeElement | null = null;
	checked = false;
	readonly children: SmokeElement[] = [];
	readonly dataset: Record<string, string> = {};
	readonly style = new SmokeStyle();
	private readonly attributes = new Map<string, string>();
	private interactionValues: string[] = [];

	constructor(
		readonly tagName: string,
		private readonly ownerDocument: SmokeDocument,
	) {
		super(tagName);
	}

	get id(): string {
		return this.identifier;
	}

	set id(value: string) {
		const next = String(value ?? "");
		const previous = this.identifier;
		this.identifier = next;
		this.ownerDocument.updateElementId(this, previous, next);
	}

	get classList(): SmokeClassList {
		return new SmokeClassList(this);
	}

	get parentElement(): SmokeElement | null {
		if (this.appendedParent) return this.appendedParent;
		if (this.parsedParent) return this.parsedParent;
		if (this.tagName.toLowerCase() === "html") return null;
		if (/^(?:head|body)$/iu.test(this.tagName)) return this.ownerDocument.documentElement ?? null;
		return this.ownerDocument.body ?? null;
	}

	get nextElementSibling(): SmokeElement | null {
		return this.ownerDocument.elementSibling(this, 1);
	}

	get previousElementSibling(): SmokeElement | null {
		return this.ownerDocument.elementSibling(this, -1);
	}

	get parentNode(): SmokeElement | null {
		return this.parentElement;
	}

	get firstElementChild(): SmokeElement | null {
		return this.ownerDocument.elementSiblingBoundary(this, 1);
	}

	get lastElementChild(): SmokeElement | null {
		return this.ownerDocument.elementSiblingBoundary(this, -1);
	}

	get firstChild(): SmokeElement | null {
		return this.firstElementChild;
	}

	get lastChild(): SmokeElement | null {
		return this.lastElementChild;
	}

	get childElementCount(): number {
		return this.ownerDocument.elementChildren(this).length;
	}

	setParsedParent(parent: SmokeElement): void {
		this.parsedParent = parent;
	}

	matches(selector: string): boolean {
		return selectorMatches(this, selector);
	}

	closest(selector: string): SmokeElement | null {
		let candidate: SmokeElement | null = this;
		while (candidate) {
			if (candidate.matches(selector)) return candidate;
			candidate = candidate.parentElement;
		}
		return null;
	}

	contains(candidate: SmokeElement | null): boolean {
		let current = candidate;
		while (current) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}

	getBoundingClientRect(): {
		x: number;
		y: number;
		left: number;
		top: number;
		right: number;
		bottom: number;
		width: number;
		height: number;
		toJSON: () => Record<string, number>;
	} {
		const width = this.clientWidth;
		const height = this.clientHeight;
		return {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: width,
			bottom: height,
			width,
			height,
			toJSON: () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }),
		};
	}

	get textContent(): string {
		return (
			this.text +
			this.children
				.map((child) => child.textContent || stripTags(child.innerHTML).replace(/\s+/gu, " ").trim())
				.join("")
		);
	}

	set textContent(value: unknown) {
		this.text = value === null ? "" : String(value);
	}

	get innerHTML(): string {
		return this.html;
	}

	set innerHTML(value: unknown) {
		this.html = value === null ? "" : String(value);
		if (this.html === "") this.children.length = 0;
		if (this.tagName.toLowerCase() === "select") this.setSelectMarkup(this.html);
	}

	get value(): string {
		return this.currentValue;
	}

	set value(value: unknown) {
		this.currentValue = value === null || value === undefined ? "" : String(value);
		if (this.tagName.toLowerCase() === "select") this.hasExplicitSelection = true;
	}

	get selectedOptions(): Array<{ value: string }> {
		if (this.tagName.toLowerCase() !== "select") return [];
		return this.hasExplicitSelection || this.currentValue ? [{ value: this.currentValue }] : [];
	}

	get options(): Array<{ value: string; selected: boolean }> {
		if (this.tagName.toLowerCase() !== "select") return [];
		// HTMLSelectElement.options is an iterable HTMLOptionsCollection in a real
		// browser. The smoke runtime only needs stable value/selection semantics;
		// exposing undefined here turns valid Array.from(select.options) code into
		// a VM-only TypeError and then floods every exercised filter interaction.
		return this.interactionValues.map((value) => ({ value, selected: value === this.currentValue }));
	}

	get innerText(): string {
		return this.textContent;
	}

	set innerText(value: unknown) {
		this.text = value === null ? "" : String(value);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
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
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.getAttribute(name) !== null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
		if (name === "id") this.id = "";
		else if (name === "class") this.className = "";
		else if (name === "style") this.style.cssText = "";
		else if (name.startsWith("data-")) delete this.dataset[toDatasetName(name.slice("data-".length))];
	}

	toggleAttribute(name: string, force?: boolean): boolean {
		const present = this.hasAttribute(name);
		const next = force ?? !present;
		if (next) this.setAttribute(name, "");
		else this.removeAttribute(name);
		return next;
	}

	appendChild(child: SmokeElement): SmokeElement {
		this.children.push(child);
		child.appendedParent = this;
		if (this.tagName.toLowerCase() === "select" && child.tagName.toLowerCase() === "option") {
			const optionValue = child.value || child.textContent;
			if (optionValue && !this.interactionValues.includes(optionValue)) this.interactionValues.push(optionValue);
			if (!this.currentValue && !this.hasExplicitSelection) this.currentValue = optionValue;
		}
		return child;
	}

	append(...nodes: Array<SmokeElement | string>): void {
		for (const node of nodes) this.appendChild(this.asSmokeNode(node));
	}

	prepend(...nodes: Array<SmokeElement | string>): void {
		for (const node of [...nodes].reverse()) {
			const child = this.asSmokeNode(node);
			this.children.unshift(child);
			child.appendedParent = this;
		}
	}

	replaceChildren(...nodes: Array<SmokeElement | string>): void {
		for (const child of this.children) child.appendedParent = null;
		this.children.length = 0;
		this.text = "";
		this.html = "";
		this.append(...nodes);
	}

	add(option: SmokeElement): void {
		if (this.tagName.toLowerCase() !== "select" || option.tagName.toLowerCase() !== "option") {
			throw new TypeError("HTMLSelectElement.add requires an option element.");
		}
		this.appendChild(option);
	}

	removeChild(child: SmokeElement): SmokeElement {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.appendedParent = null;
		child.remove();
		return child;
	}

	insertRow(index = -1): SmokeElement {
		return this.insertChildAt(this.ownerDocument.createElement("tr"), index);
	}

	deleteRow(index: number): void {
		this.deleteChildAt(index);
	}

	insertCell(index = -1): SmokeElement {
		return this.insertChildAt(this.ownerDocument.createElement("td"), index);
	}

	deleteCell(index: number): void {
		this.deleteChildAt(index);
	}

	setSelectMarkup(markup: string): void {
		const options = selectOptions(markup);
		this.interactionValues = [...new Set(options.map((option) => option.value).filter(Boolean))];
		const selected = options.find((option) => option.selected);
		const browserDefault = selected ?? options[0];
		this.hasExplicitSelection = browserDefault !== undefined;
		this.currentValue = browserDefault?.value ?? "";
	}

	interactionCandidates(): string[] {
		return this.interactionValues.filter((value) => value !== this.value);
	}

	private insertChildAt(child: SmokeElement, index: number): SmokeElement {
		const insertionIndex = index < 0 || index >= this.children.length ? this.children.length : index;
		this.children.splice(insertionIndex, 0, child);
		child.appendedParent = this;
		return child;
	}

	private deleteChildAt(index: number): void {
		const deletionIndex = index < 0 ? this.children.length - 1 : index;
		if (deletionIndex < 0 || deletionIndex >= this.children.length) return;
		this.children.splice(deletionIndex, 1);
	}

	observableDataSnapshot(): unknown[] {
		const signal = `${this.id} ${this.className}`;
		const content = `${this.textContent} ${this.innerHTML}`.trim();
		if (this.tagName.toLowerCase() === "svg" && VISUALIZATION_SEMANTIC_PATTERN.test(signal)) {
			return [[this.id || this.className, "chart", content, this.style.display]];
		}
		const metric =
			/\b(?:kpi|metric)-?value\b/i.test(this.className) ||
			/(?:kpi|metric).*(?:value|yield|count|output|loss)$/i.test(this.id) ||
			/(?:kpi|metric).*(?:row|grid|list)$/i.test(this.id);
		if (metric) {
			return [[this.id, "metric", content.match(/--|-?\d[\d,.]*(?:%|\s*Lots?)?/gi) ?? [], this.style.display]];
		}
		if (/(?:result|table|tbody|detail|empty|error)/i.test(signal) || /^(?:table|tbody)$/i.test(this.tagName)) {
			return [[this.id, "result", content, this.style.display]];
		}
		return [];
	}

	selectorIdentity(): string {
		if (this.id) return `#${this.id}`;
		const [firstClass] = this.className.trim().split(/\s+/u).filter(Boolean);
		return firstClass ? `.${firstClass}` : this.tagName.toLowerCase();
	}

	invalidRenderedData(): { token: "NaN" | "undefined"; sample: string } | undefined {
		if (!this.isVisible() || this.observableDataSnapshot().length === 0) return undefined;
		const rendered = `${this.textContent} ${this.innerHTML}`
			.replace(/<[^>]*>/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		if (!rendered) return undefined;
		const metric = this.hasMetricSignal();
		if (
			/\bNaN\b/u.test(rendered) &&
			(metric || /(?:\d|%|\b(?:week|month|quarter|date|lot|yield|rate|count|total)\b)/iu.test(rendered))
		) {
			return { token: "NaN", sample: rendered.slice(0, 180) };
		}
		const invalidUndefined =
			metric ||
			/(?:\d|[-–—:/,([])\s*undefined\b|\bundefined\s*(?:[-–—:/,)\]]|$)|\b(?:week|month|quarter|date|lot|yield|rate|count|total)\s*[:#-]?\s*undefined\b/iu.test(
				rendered,
			);
		if (/\bundefined\b/u.test(rendered) && invalidUndefined) {
			return { token: "undefined", sample: rendered.slice(0, 180) };
		}
		return undefined;
	}

	remove(): void {
		this.classList.add("hidden");
	}

	querySelector(selector: string): SmokeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): SmokeElement[] {
		return this.ownerDocument
			.querySelectorAll(selector)
			.filter((candidate) => candidate !== this && this.contains(candidate));
	}

	click(): void {
		this.dispatchEvent(new SmokeEvent("click"));
	}

	focus(): void {
		this.dispatchEvent(new SmokeEvent("focus"));
	}

	blur(): void {
		this.dispatchEvent(new SmokeEvent("blur"));
	}

	scrollIntoView(): void {
		// Geometry/scroll position is intentionally not simulated. The method is a
		// safe no-op so valid navigation code is not reported as a script defect.
	}

	animate(): { cancel: () => void; play: () => void; finished: Promise<void> } {
		return { cancel: () => undefined, play: () => undefined, finished: Promise.resolve() };
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
		const signal = `${this.id} ${this.className}`.trim();
		return (
			/\b(?:kpi|metric)-?value\b/i.test(this.className) ||
			/(?:kpi|metric).*(?:value|yield|count|output|loss)$/i.test(signal)
		);
	}

	hasOnlyZeroMetricValues(): boolean {
		const values = this.textContent.match(/-?\d[\d,.]*/g);
		if (!values?.length) return false;
		return values.every((value) => Number(value.replace(/,/g, "")) === 0);
	}

	hasEmptyMetricValue(): boolean {
		return /^(?:\s*|--|—|n\/?a|no\s+data|null|undefined)$/i.test(this.textContent.trim());
	}

	hasExplicitEmptyResult(): boolean {
		if (!this.isVisible()) return false;
		const signal = `${this.id} ${this.className} ${this.tagName}`;
		if (!/(?:result|table|tbody|detail|empty)/iu.test(signal)) return false;
		const rendered = `${this.textContent} ${this.innerHTML}`
			.replace(/<[^>]*>/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		return /(?:no\s+(?:data|records?|results?)|nothing\s+to\s+show|暂无(?:数据|记录)|无数据)/iu.test(rendered);
	}

	hasRenderedChartData(): boolean {
		if (this.tagName.toLowerCase() !== "svg") return false;
		return /<(?:path|rect|circle|polyline|polygon|line)\b/iu.test(this.innerHTML) || this.hasChartShapeDescendant();
	}

	private hasChartShapeDescendant(): boolean {
		return this.children.some(
			(child) =>
				/^(?:path|rect|circle|polyline|polygon|line)$/iu.test(child.tagName) || child.hasChartShapeDescendant(),
		);
	}

	private asSmokeNode(node: SmokeElement | string): SmokeElement {
		return typeof node === "string" ? this.ownerDocument.createTextNode(node) : node;
	}
}

class SmokeCanvasElement extends SmokeElement {
	private bitmapWidth = 300;
	private bitmapHeight = 150;
	private context2d: SmokeCanvasRenderingContext2D | undefined;

	constructor(ownerDocument: SmokeDocument) {
		super("canvas", ownerDocument);
		this.context2d = new SmokeCanvasRenderingContext2D(this);
	}

	get width(): number {
		return this.bitmapWidth;
	}

	set width(value: number) {
		this.bitmapWidth = normalizedCanvasDimension(value, 300);
		this.context2d?.resetForBitmapResize();
	}

	get height(): number {
		return this.bitmapHeight;
	}

	override hasRenderedChartData(): boolean {
		return this.context2d?.hasDrawingCommands() === true;
	}

	set height(value: number) {
		this.bitmapHeight = normalizedCanvasDimension(value, 150);
		this.context2d?.resetForBitmapResize();
	}

	getContext(contextId: string): SmokeCanvasRenderingContext2D | null {
		return contextId.toLowerCase() === "2d" ? (this.context2d ?? null) : null;
	}

	observableCanvasSnapshot(): unknown[] {
		return [
			this.id || this.className,
			"canvas",
			this.width,
			this.height,
			this.context2d?.snapshot() ?? [],
			this.style.display,
		];
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
	private lineDash: number[] = [];
	private readonly commands: string[] = [];

	constructor(readonly canvas: SmokeCanvasElement) {}

	beginPath(): void {
		this.record("beginPath", []);
	}
	closePath(): void {
		this.record("closePath", []);
	}
	moveTo(x: number, y: number): void {
		this.record("moveTo", [x, y]);
	}
	lineTo(x: number, y: number): void {
		this.record("lineTo", [x, y]);
	}
	quadraticCurveTo(controlX: number, controlY: number, x: number, y: number): void {
		this.record("quadraticCurveTo", [controlX, controlY, x, y]);
	}
	bezierCurveTo(
		controlX1: number,
		controlY1: number,
		controlX2: number,
		controlY2: number,
		x: number,
		y: number,
	): void {
		this.record("bezierCurveTo", [controlX1, controlY1, controlX2, controlY2, x, y]);
	}
	arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
		this.record("arcTo", [x1, y1, x2, y2, radius]);
	}
	rect(x: number, y: number, width: number, height: number): void {
		this.record("rect", [x, y, width, height]);
	}
	roundRect(x: number, y: number, width: number, height: number, radii?: unknown): void {
		this.record("roundRect", [x, y, width, height, radii]);
	}
	arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
		this.record("arc", [x, y, radius, startAngle, endAngle]);
	}
	ellipse(
		x: number,
		y: number,
		radiusX: number,
		radiusY: number,
		rotation: number,
		startAngle: number,
		endAngle: number,
		anticlockwise?: boolean,
	): void {
		this.record("ellipse", [x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise]);
	}
	fill(): void {
		this.record("fill", [this.fillStyle, this.globalAlpha]);
	}
	stroke(): void {
		this.record("stroke", [this.strokeStyle, this.lineWidth, this.lineDash, this.globalAlpha]);
	}
	fillRect(x: number, y: number, width: number, height: number): void {
		this.record("fillRect", [x, y, width, height, this.fillStyle, this.globalAlpha]);
	}
	strokeRect(x: number, y: number, width: number, height: number): void {
		this.record("strokeRect", [x, y, width, height, this.strokeStyle, this.lineWidth, this.lineDash]);
	}
	clearRect(x: number, y: number, width: number, height: number): void {
		this.commands.length = 0;
		this.record("clearRect", [x, y, width, height]);
	}
	fillText(text: string, x: number, y: number): void {
		this.record("fillText", [text, x, y, this.fillStyle, this.font, this.textAlign, this.globalAlpha]);
	}
	strokeText(text: string, x: number, y: number): void {
		this.record("strokeText", [text, x, y, this.strokeStyle, this.font, this.textAlign, this.globalAlpha]);
	}
	save(): void {
		this.record("save", []);
	}
	restore(): void {
		this.record("restore", []);
	}
	translate(x: number, y: number): void {
		this.record("translate", [x, y]);
	}
	rotate(angle: number): void {
		this.record("rotate", [angle]);
	}
	scale(x: number, y: number): void {
		this.record("scale", [x, y]);
	}
	transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.record("transform", [a, b, c, d, e, f]);
	}
	setTransform(...values: number[]): void {
		this.record("setTransform", values);
	}
	resetTransform(): void {
		this.record("resetTransform", []);
	}
	setLineDash(values: number[]): void {
		this.lineDash = [...values];
	}
	getLineDash(): number[] {
		return [...this.lineDash];
	}
	clip(): void {
		this.record("clip", []);
	}
	measureText(text: string): { width: number } {
		return { width: String(text).length * 6 };
	}
	createLinearGradient(): { addColorStop: (_offset: number, _color: string) => void } {
		return { addColorStop: (_offset: number, _color: string) => undefined };
	}
	createRadialGradient(): { addColorStop: (_offset: number, _color: string) => void } {
		return { addColorStop: (_offset: number, _color: string) => undefined };
	}
	drawImage(...values: unknown[]): void {
		this.record("drawImage", values.slice(1));
	}

	snapshot(): string[] {
		return [...this.commands];
	}

	hasDrawingCommands(): boolean {
		return this.commands.some((command) => !command.startsWith('["clearRect"'));
	}

	resetForBitmapResize(): void {
		this.commands.length = 0;
		this.fillStyle = "#000000";
		this.strokeStyle = "#000000";
		this.lineWidth = 1;
		this.shadowColor = "rgba(0, 0, 0, 0)";
		this.shadowBlur = 0;
		this.font = "10px sans-serif";
		this.textAlign = "start";
		this.globalAlpha = 1;
		this.lineDash = [];
	}

	private record(name: string, values: unknown[]): void {
		this.commands.push(JSON.stringify([name, ...values]));
		if (this.commands.length > 512) this.commands.splice(0, this.commands.length - 512);
	}
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

	getElementsAtEventForMode(
		_event: unknown,
		_mode: unknown,
		_options: unknown,
		_useFinalPosition: unknown,
	): Array<{ datasetIndex: number; index: number }> {
		const labels = Array.isArray(this.data.labels) ? this.data.labels : [];
		const datasets = Array.isArray(this.data.datasets) ? this.data.datasets : [];
		const firstDataset = datasets[0];
		const values =
			firstDataset &&
			typeof firstDataset === "object" &&
			Array.isArray((firstDataset as Record<string, unknown>).data)
				? ((firstDataset as Record<string, unknown>).data as unknown[])
				: [];
		return Math.max(labels.length, values.length) > 0 ? [{ datasetIndex: 0, index: 0 }] : [];
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

function normalizedCanvasDimension(value: number, fallback: number): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function synchronizedSurfaceGaps(before: readonly unknown[], after: readonly unknown[]): string[] {
	const beforeByKey = observableSurfaceMap(before);
	const afterByKey = observableSurfaceMap(after);
	const changedKinds = new Set<string>();
	for (const [key, snapshot] of beforeByKey) {
		const next = afterByKey.get(key);
		if (next !== undefined && next !== snapshot) changedKinds.add(key.split("\u0000", 1)[0] ?? "");
	}
	const gaps: string[] = [];
	for (const kind of ["chart", "result"] as const) {
		if (changedKinds.has(kind)) continue;
		const selectors = [...beforeByKey.keys()]
			.filter((key) => key.startsWith(`${kind}\u0000`))
			.map((key) => key.slice(kind.length + 1))
			.filter(Boolean)
			.slice(0, 4);
		if (selectors.length > 0) gaps.push(`${kind} ${selectors.join("/")}`);
	}
	return gaps;
}

function observableSurfaceMap(snapshots: readonly unknown[]): Map<string, string> {
	const values = new Map<string, string>();
	for (const snapshot of snapshots) {
		if (!Array.isArray(snapshot) || snapshot.length < 2) continue;
		const identity = typeof snapshot[0] === "string" ? snapshot[0] : "";
		const rawKind = typeof snapshot[1] === "string" ? snapshot[1] : "";
		const kind = /^(?:canvas|chart)$/u.test(rawKind) ? "chart" : rawKind;
		if (!identity || !/^(?:chart|metric|result)$/u.test(kind)) continue;
		values.set(`${kind}\u0000${identity.startsWith("#") ? identity : `#${identity}`}`, JSON.stringify(snapshot));
	}
	return values;
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

function selectInnerMarkup(html: string, match: RegExpMatchArray): string {
	const contentStart = (match.index ?? 0) + match[0].length;
	const closeIndex = html.toLowerCase().indexOf("</select>", contentStart);
	return closeIndex < 0 ? "" : html.slice(contentStart, closeIndex);
}

function selectOptions(markup: string): Array<{ value: string; selected: boolean }> {
	const options: Array<{ value: string; selected: boolean }> = [];
	for (const option of markup.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
		const attrs = option[1] ?? "";
		VALUE_ATTRIBUTE_PATTERN.lastIndex = 0;
		const valueMatch = VALUE_ATTRIBUTE_PATTERN.exec(attrs);
		options.push({
			value: valueMatch ? (valueMatch[2] ?? "") : stripTags(option[2] ?? "").trim(),
			selected: SELECTED_ATTRIBUTE_PATTERN.test(attrs),
		});
	}
	return options;
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
	const unsupportedCapability = unsupportedSmokeCapabilityFromError(error);
	if (unsupportedCapability) {
		warnings.push(`Runtime smoke gate skipped unsupported browser capability ${unsupportedCapability}.`);
		return;
	}
	errors.push(message);
}

function unsupportedSmokeCapabilityFromError(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const missingGlobal = message.match(/^(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined\b/u)?.[1];
	if (missingGlobal && BROWSER_GLOBALS_NOT_SIMULATED.has(missingGlobal)) return missingGlobal;
	const missingMember = message.match(
		/(?:^TypeError:\s*|\b)((?:document|navigator|window)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?) is not a function\b/u,
	)?.[1];
	return missingMember && BROWSER_MEMBERS_NOT_SIMULATED.has(missingMember) ? missingMember : undefined;
}

function downgradeExternalScriptGlobalErrors(errors: string[], warnings: string[]): void {
	for (let index = errors.length - 1; index >= 0; index -= 1) {
		const message = errors[index] ?? "";
		const missingGlobal = message.match(/(?:^|:\s*)(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined\b/u)?.[1];
		if (!missingGlobal) continue;
		errors.splice(index, 1);
		warnings.push(
			`Runtime smoke gate could not evaluate ${missingGlobal} because an external script was not simulated; this observation is advisory.`,
		);
	}
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
