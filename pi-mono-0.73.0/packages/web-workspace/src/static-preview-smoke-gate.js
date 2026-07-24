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
const VISUALIZATION_SEMANTIC_SOURCE = "(?:chart|trend|graph|plot|yield|defect|donut|pareto|visuali[sz]ation|viz|heatmap|treemap|choropleth|map|gauge|network|diagram|timeline|calendar|matrix)";
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
    const hasUnsimulatedExternalScripts = warnings.some((warning) => warning.startsWith("Runtime smoke gate skipped external script "));
    const timeout = input.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const runtime = new SmokeRuntime(html, new Map(scripts.map((script) => [script.label, script.content])), timeout, hasUnsimulatedExternalScripts);
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
    if (hasUnsimulatedExternalScripts)
        downgradeExternalScriptGlobalErrors(errors, warnings);
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
    if (hasUnsimulatedExternalScripts)
        downgradeExternalScriptGlobalErrors(errors, warnings);
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
    hasUnsimulatedExternalScripts;
    document;
    windowTarget = new SmokeEventTarget("window");
    contextValues = {};
    timers = [];
    cancelledTimerIds = new Set();
    consoleErrors = [];
    charts = [];
    missingSelectors = new Set();
    pendingAsyncCallbackCount = 0;
    asyncCallbackErrors = [];
    timerId = 0;
    successfulFilterInteraction = false;
    defaultMetricCount = 0;
    defaultMetricsAllEmpty = false;
    defaultMetricsAllZero = false;
    defaultHasVisibleCanvas = false;
    defaultMetricsRepresentative = false;
    reportedInvalidRenderedData = new Set();
    reportedEmptyStateChartMismatch = new Set();
    hasDeterministicFixtureData;
    hasSourceDashboardDataSurfaces;
    constructor(html, sources, scriptTimeoutMs, hasUnsimulatedExternalScripts) {
        this.sources = sources;
        this.scriptTimeoutMs = scriptTimeoutMs;
        this.hasUnsimulatedExternalScripts = hasUnsimulatedExternalScripts;
        this.document = new SmokeDocument(html, this.missingSelectors);
        this.hasDeterministicFixtureData = [...sources.values()].some((source) => {
            const namedFixture = /\b(?:(?:const|let|var)\s+(?=[A-Za-z_$][\w$]*\b)(?=[\w$]*(?:mock|fixture|demo|sample))[A-Za-z_$][\w$]*\s*=\s*(?:\{|\[|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(?:generate|build|create)[A-Za-z_$][\w$]*\s*\()|function\s+(?=[A-Za-z_$][\w$]*\b)(?=[\w$]*(?:mock|fixture|demo|sample))[A-Za-z_$][\w$]*\s*\()/iu.test(source);
            // Generated static dashboards often disclose deterministic fixtures in a
            // comment while using business-specific names such as WEEKS/DEFECTS and
            // genWeekData. Require that explicit disclosure plus local literal data;
            // a generic "simulation" word alone is not sufficient.
            const fixtureDisclosure = (source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu) ?? []).some((comment) => /(?:deterministic[\s\S]{0,80}(?:mock|fixture|demo|sample|simulation)|(?:mock|fixture|demo|sample|simulation)[\s\S]{0,80}deterministic)/iu.test(comment));
            const hasLocalLiteralData = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[/u.test(source) ||
                /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{[\s\S]{0,4096}?\b[A-Za-z_$][\w$]*\s*:\s*\[/u.test(source);
            const explicitlyDisclosedFixture = fixtureDisclosure && hasLocalLiteralData;
            return namedFixture || explicitlyDisclosedFixture;
        });
        const combinedSource = `${html}\n${[...sources.values()].join("\n")}`;
        const sourceChartSurfaceCount = (combinedSource.match(new RegExp(String.raw `(?:\b(?:id|class)\s*=\s*["'][^"']*${VISUALIZATION_SEMANTIC_SOURCE}[^"']*["']|(?:getElementById|querySelector)\s*\(\s*["'][^"']*${VISUALIZATION_SEMANTIC_SOURCE}[^"']*["']\s*\))`, "giu")) ?? []).length;
        this.hasSourceDashboardDataSurfaces =
            sourceChartSurfaceCount >= 2 &&
                /(?:<table\b|<tbody\b|\b(?:render|update|refresh)(?:Detail|Table|Results?)\b|\b(?:detail|result)[-_ ]?(?:table|grid)\b)/iu.test(combinedSource);
    }
    context() {
        const charts = this.charts;
        class RuntimeSmokeResizeObserver {
            callback;
            observed = new Set();
            constructor(callback) {
                this.callback = callback;
            }
            observe(target) {
                if (!(target instanceof SmokeElement) || this.observed.has(target))
                    return;
                this.observed.add(target);
                this.callback([{ target, contentRect: target.getBoundingClientRect() }], this);
            }
            unobserve(target) {
                this.observed.delete(target);
            }
            disconnect() {
                this.observed.clear();
            }
        }
        class RuntimeSmokeChart extends SmokeChart {
            constructor(context, config) {
                super(context, config);
                charts.push(this);
            }
        }
        const windowObject = {
            document: this.document,
            // Dialog APIs are synchronous browser primitives. Treating them as missing
            // turns otherwise valid interaction handlers into VM-only ReferenceErrors.
            // They have no observable page effect in the smoke runtime, so deterministic
            // no-op/default implementations are sufficient for startup validation.
            alert: (_message) => undefined,
            confirm: (_message) => true,
            prompt: (_message, defaultValue) => defaultValue === undefined || defaultValue === null ? "" : String(defaultValue),
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
            __piSmokeAsyncFailed: (error) => {
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
    captureDefaultView() {
        const metrics = this.document.visibleMetricElements();
        this.defaultMetricCount = metrics.length;
        this.defaultMetricsAllEmpty = metrics.length >= 2 && metrics.every((metric) => metric.hasEmptyMetricValue());
        this.defaultMetricsAllZero = metrics.length >= 2 && metrics.every((metric) => metric.hasOnlyZeroMetricValues());
        this.defaultMetricsRepresentative =
            metrics.length >= 2 && !this.defaultMetricsAllEmpty && !this.defaultMetricsAllZero;
        this.defaultHasVisibleCanvas = this.document.elementsByTagName("canvas").some((canvas) => canvas.isVisible());
    }
    exerciseInteractions(errors, warnings) {
        const filterActions = this.document.filterActionElements();
        const selects = this.document.elementsByTagName("select");
        const originalSelectValues = new Map(selects.map((element) => [element, element.value]));
        if (filterActions.length > 0 && this.hasDeterministicFixtureData && this.defaultMetricsRepresentative) {
            const before = this.observableDataFingerprint();
            let defaultApplyFailed = false;
            try {
                for (const action of filterActions) {
                    action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                    this.flushTimers(errors, warnings);
                }
            }
            catch (error) {
                defaultApplyFailed = true;
                recordRuntimeIssue(error, `Runtime smoke gate: default filter action handler failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
            this.recordInvalidRenderedData(errors, "after the unchanged default filter action");
            this.recordEmptyStateChartMismatch(errors, "after the unchanged default filter action");
            if (!defaultApplyFailed &&
                before !== this.observableDataFingerprint() &&
                this.document.visibleMetricsAllZeroOrEmpty()) {
                const evidence = this.fixtureFieldMismatchEvidence();
                errors.push(evidence
                    ? `Runtime smoke gate: applying unchanged default filters replaced representative KPI data with an empty result; ${evidence.path}:${evidence.line} filter predicate reads missing fixture field ${evidence.field}.`
                    : "Runtime smoke gate: applying unchanged default filters replaced representative KPI data with an empty result.");
            }
        }
        let combinedFilterInteractionWorked = false;
        if (filterActions.length > 0) {
            const before = this.observableDataFingerprint();
            for (const element of selects) {
                const [candidate] = element.interactionCandidates();
                if (candidate !== undefined)
                    element.value = candidate;
            }
            try {
                for (const action of filterActions) {
                    action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                    this.flushTimers(errors, warnings);
                }
                combinedFilterInteractionWorked = before !== this.observableDataFingerprint();
                if (combinedFilterInteractionWorked)
                    this.successfulFilterInteraction = true;
                this.recordInvalidRenderedData(errors, "after combined filter options changed");
                this.recordEmptyStateChartMismatch(errors, "after combined filter options changed");
            }
            catch (error) {
                recordRuntimeIssue(error, `Runtime smoke gate: filter action handler failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
            for (const [element, value] of originalSelectValues)
                element.value = value;
            try {
                for (const action of filterActions) {
                    action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                    this.flushTimers(errors, warnings);
                }
            }
            catch (error) {
                recordRuntimeIssue(error, `Runtime smoke gate: filter action reset handler failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
        }
        for (const element of selects) {
            const canExercise = element.hasListeners("change") || filterActions.length > 0;
            // Delegated events, form submission, or framework handlers are not fully
            // represented by the synthetic DOM. Without a direct change listener or an
            // explicit Apply/Search action, do not manufacture an inert-control error.
            if (!canExercise)
                continue;
            const originalValue = element.value;
            const testValues = element.interactionCandidates();
            if (testValues.length === 0)
                continue;
            const beforeSnapshot = this.document.observableDataSnapshot();
            const before = this.observableDataFingerprint();
            let changedObservableData = false;
            let interactionFailed = false;
            const partialUpdateGaps = new Set();
            for (const testValue of testValues) {
                element.value = testValue;
                try {
                    element.dispatchEvent(new SmokeEvent("change"), (listener, event) => this.invokeCallback(listener, [event], element));
                    this.flushTimers(errors, warnings);
                    if (before === this.observableDataFingerprint()) {
                        for (const action of filterActions) {
                            action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                            this.flushTimers(errors, warnings);
                            if (before !== this.observableDataFingerprint())
                                break;
                        }
                    }
                    changedObservableData = changedObservableData || before !== this.observableDataFingerprint();
                    if (changedObservableData)
                        this.successfulFilterInteraction = true;
                    if (before !== this.observableDataFingerprint() &&
                        this.hasDeterministicFixtureData &&
                        !this.hasUnsimulatedExternalScripts &&
                        this.document.isSharedGlobalDashboardFilter(element) &&
                        element.listenerMatches("change", /(?:renderAll|renderDashboard|updateDashboard|refreshDashboard)\s*\(/iu)) {
                        for (const gap of synchronizedSurfaceGaps(beforeSnapshot, this.document.observableDataSnapshot())) {
                            partialUpdateGaps.add(gap);
                        }
                    }
                    this.recordInvalidRenderedData(errors, element.id ? `after select #${element.id} changed` : "after a select changed");
                    this.recordEmptyStateChartMismatch(errors, element.id ? `after select #${element.id} changed` : "after a select changed");
                }
                catch (error) {
                    interactionFailed = true;
                    recordRuntimeIssue(error, `Runtime smoke gate: select change handler failed${element.id ? ` for #${element.id}` : ""}: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
                }
                // Every control is evaluated from the page's default filter state. Leaving a
                // previous select mutated can create an empty combination and falsely make
                // otherwise functional controls look inert.
                element.value = originalValue;
                try {
                    element.dispatchEvent(new SmokeEvent("change"), (listener, event) => this.invokeCallback(listener, [event], element));
                    this.flushTimers(errors, warnings);
                    for (const action of filterActions) {
                        action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                        this.flushTimers(errors, warnings);
                    }
                }
                catch (error) {
                    interactionFailed = true;
                    recordRuntimeIssue(error, `Runtime smoke gate: select reset handler failed${element.id ? ` for #${element.id}` : ""}: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
                }
            }
            const combinedInteractionExplainsEmptyDefault = combinedFilterInteractionWorked && (this.defaultMetricsAllEmpty || this.defaultMetricsAllZero);
            if (partialUpdateGaps.size > 0 && !interactionFailed) {
                errors.push(`Runtime smoke gate: deterministic global select${element.id ? ` #${element.id}` : ""} changed some dashboard data but left synchronized surfaces unchanged: ${[...partialUpdateGaps].join(", ")}.`);
            }
            if (!changedObservableData && !interactionFailed && !combinedInteractionExplainsEmptyDefault) {
                const hasFilterAction = filterActions.some((action) => /(?:filter|apply|search|query|筛选|应用|查询)/iu.test(`${action.id} ${action.className} ${action.textContent}`));
                const hasDashboardRenderListener = element.listenerMatches("change", /(?:renderAll|renderDashboard|updateDashboard|refreshDashboard|applyFilters)\s*\(/iu);
                const deterministicDashboardEvidence = this.hasDeterministicFixtureData &&
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
            warnings.push(`Runtime smoke gate sampled the first ${MAX_CHART_INTERACTION_SAMPLES} active charts for interaction checks.`);
        }
        for (const chart of chartsAtInteractionStart) {
            const onClick = chart.clickHandler();
            if (!onClick)
                continue;
            try {
                this.invokeCallback(onClick, [new SmokeEvent("click"), [{ index: 0 }], chart]);
                this.recordInvalidRenderedData(errors, "after a chart mark click");
            }
            catch (error) {
                recordRuntimeIssue(error, `Runtime smoke gate: chart click handler failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
        }
    }
    exercisePairwiseFilterStates(selects, filterActions, originalValues, errors, warnings) {
        if (!this.hasDeterministicFixtureData ||
            (!this.document.hasDashboardDataSurfaces() && !this.hasSourceDashboardDataSurfaces)) {
            return;
        }
        let samples = 0;
        outer: for (let leftIndex = 0; leftIndex < selects.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < selects.length; rightIndex += 1) {
                const left = selects[leftIndex];
                const right = selects[rightIndex];
                if (!left || !right)
                    continue;
                for (const leftValue of left.interactionCandidates().slice(0, 4)) {
                    for (const rightValue of right.interactionCandidates().slice(0, 4)) {
                        if (samples >= MAX_FILTER_PAIR_SAMPLES)
                            break outer;
                        samples += 1;
                        left.value = leftValue;
                        right.value = rightValue;
                        try {
                            for (const element of [left, right]) {
                                element.dispatchEvent(new SmokeEvent("change"), (listener, event) => this.invokeCallback(listener, [event], element));
                                this.flushTimers(errors, warnings);
                            }
                            for (const action of filterActions) {
                                action.dispatchEvent(new SmokeEvent("click"), (listener, event) => this.invokeCallback(listener, [event], action));
                                this.flushTimers(errors, warnings);
                            }
                            const phase = `after selects ${left.selectorIdentity()}=${leftValue} and ${right.selectorIdentity()}=${rightValue} changed`;
                            this.recordInvalidRenderedData(errors, phase);
                            this.recordEmptyStateChartMismatch(errors, phase);
                        }
                        catch (error) {
                            recordRuntimeIssue(error, `Runtime smoke gate: pairwise select handlers failed for ${left.selectorIdentity()} and ${right.selectorIdentity()}: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
                        }
                        finally {
                            left.value = originalValues.get(left) ?? "";
                            right.value = originalValues.get(right) ?? "";
                            for (const element of [left, right]) {
                                try {
                                    element.dispatchEvent(new SmokeEvent("change"), (listener, event) => this.invokeCallback(listener, [event], element));
                                    this.flushTimers(errors, warnings);
                                }
                                catch {
                                    // The original interaction error above already carries bounded evidence.
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    recordInvalidRenderedData(errors, phase) {
        const [evidence] = this.document.invalidRenderedDataSurfaces();
        if (!evidence)
            return;
        const key = `${evidence.selector}\u0000${evidence.token}\u0000${phase}`;
        if (this.reportedInvalidRenderedData.has(key))
            return;
        this.reportedInvalidRenderedData.add(key);
        errors.push(`Runtime smoke gate: dashboard data surface ${evidence.selector} rendered invalid token ${evidence.token} ${phase}. Evidence: ${evidence.sample}`);
    }
    recordEmptyStateChartMismatch(errors, phase) {
        const evidence = this.document.dashboardEmptyStateWithChartData();
        if (!evidence)
            return;
        if (this.reportedEmptyStateChartMismatch.size >= MAX_EMPTY_STATE_CHART_MISMATCH_REPORTS)
            return;
        const key = `${evidence.emptySelector}\u0000${evidence.chartSelectors.join(",")}\u0000${phase}`;
        if (this.reportedEmptyStateChartMismatch.has(key))
            return;
        this.reportedEmptyStateChartMismatch.add(key);
        errors.push(`Runtime smoke gate: dashboard rendered explicit empty state in ${evidence.emptySelector} while chart surfaces ${evidence.chartSelectors.join(", ")} still contained data ${phase}.`);
    }
    observableDataFingerprint() {
        const activeCharts = this.charts.filter((chart) => !chart.isDestroyed()).map((chart) => chart.dataSnapshot());
        return JSON.stringify({
            document: this.document.observableDataSnapshot(),
            charts: activeCharts,
            location: this.contextValues.location,
        });
    }
    fixtureFieldMismatchEvidence() {
        const combinedSource = [...this.sources.values()].join("\n");
        for (const [path, source] of this.sources) {
            for (const match of source.matchAll(/\.filter\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,500}?\b\1\.([A-Za-z_$][\w$]*)/gu)) {
                const field = match[2];
                if (!field)
                    continue;
                const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                if (new RegExp(`\\b${escaped}\\s*:`, "u").test(combinedSource))
                    continue;
                return {
                    path,
                    line: source.slice(0, match.index ?? 0).split(/\r?\n/).length,
                    field,
                };
            }
        }
        return undefined;
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
    async settleAsyncCallbacks(errors, warnings) {
        // Browser event listeners and timer callbacks may be async. Observing the
        // returned promises prevents an application rejection from escaping as a
        // process-level unhandledRejection (which previously terminated the Worker).
        // Alternate microtask turns with the deterministic timer queue so common
        // `await delay(...)` startup flows can finish without real wall-clock waits.
        for (let turn = 0; turn < 12; turn += 1) {
            for (let microtask = 0; microtask < 8; microtask += 1)
                await Promise.resolve();
            this.flushTimers(errors, warnings);
            for (let microtask = 0; microtask < 16; microtask += 1)
                await Promise.resolve();
            // Promises created inside a node:vm context may not deliver their host-side
            // observation handlers until the next event-loop turn.
            await new Promise((resolve) => setImmediate(resolve));
            while (this.asyncCallbackErrors.length > 0) {
                const error = this.asyncCallbackErrors.shift();
                recordRuntimeIssue(error, `Runtime smoke gate: asynchronous callback failed: ${describeRuntimeError(error, this.sources)}`, errors, warnings);
            }
            if (this.pendingAsyncCallbackCount === 0 && this.timers.length === 0)
                return;
        }
        warnings.push(`Runtime smoke gate stopped waiting for ${this.pendingAsyncCallbackCount} asynchronous callback(s) after bounded deterministic startup sampling.`);
    }
    validationErrors(includeRenderedState = true) {
        const errors = [];
        if (includeRenderedState)
            this.recordInvalidRenderedData(errors, "during initial or restored rendering");
        for (const message of this.consoleErrors) {
            errors.push(`Runtime smoke gate: console.error was called with ${message}.`);
        }
        if (!includeRenderedState)
            return errors;
        for (const element of this.document.visibleLoadingElements()) {
            errors.push(`Runtime smoke gate: loading element #${element.id} remained visible after startup.`);
        }
        for (const element of this.document.metricPlaceholderElements()) {
            errors.push(`Runtime smoke gate: metric placeholder #${element.id} still shows "--" after startup.`);
        }
        return errors;
    }
    validationWarnings() {
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
    enqueueTimer(kind, callback) {
        this.timerId += 1;
        this.timers.push({ id: this.timerId, kind, callback });
        return this.timerId;
    }
    cancelTimer(timerId) {
        this.cancelledTimerIds.add(timerId);
    }
    invokeCallback(callback, args, thisArg) {
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
        }
        finally {
            delete this.contextValues.__piSmokeCallback;
            delete this.contextValues.__piSmokeCallbackArgs;
            delete this.contextValues.__piSmokeCallbackThis;
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
    hasListeners(type) {
        return (this.listeners.get(type)?.length ?? 0) > 0 || typeof this.eventHandlerProperty(type) === "function";
    }
    listenerMatches(type, pattern) {
        const propertyHandler = this.eventHandlerProperty(type);
        return ((this.listeners.get(type) ?? []).some((listener) => pattern.test(listener.toString())) ||
            (typeof propertyHandler === "function" && pattern.test(propertyHandler.toString())));
    }
    dispatchEvent(event, invokeListener) {
        event.target = this;
        const propertyHandler = this.eventHandlerProperty(event.type);
        const listeners = [
            ...(typeof propertyHandler === "function" ? [propertyHandler] : []),
            ...(this.listeners.get(event.type) ?? []),
        ];
        for (const listener of listeners) {
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
    eventHandlerProperty(type) {
        return this[`on${type}`];
    }
}
class SmokeDocument extends SmokeEventTarget {
    missingSelectors;
    body;
    documentElement;
    head;
    readyState = "loading";
    elements = [];
    byId = new Map();
    constructor(html, missingSelectors) {
        super("document");
        this.missingSelectors = missingSelectors;
        this.documentElement = this.createElement("html");
        this.head = this.createElement("head");
        this.body = this.createElement("body");
        this.parse(html);
    }
    createElement(tagName) {
        const element = tagName.toLowerCase() === "canvas" ? new SmokeCanvasElement(this) : new SmokeElement(tagName, this);
        this.track(element);
        return element;
    }
    createElementNS(_namespace, qualifiedName) {
        return this.createElement(qualifiedName);
    }
    createTextNode(value) {
        const node = new SmokeElement("#text", this);
        node.textContent = value;
        return node;
    }
    getElementById(id) {
        const element = this.byId.get(id) ?? null;
        if (!element)
            this.missingSelectors.add(`#${id}`);
        return element;
    }
    updateElementId(element, previousId, nextId) {
        if (previousId && this.byId.get(previousId) === element)
            this.byId.delete(previousId);
        if (nextId)
            this.byId.set(nextId, element);
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
    visibleMetricElements() {
        return this.elements.filter((element) => element.isVisible() && element.hasMetricSignal());
    }
    visibleMetricsAllZeroOrEmpty() {
        const metrics = this.visibleMetricElements();
        return (metrics.length >= 2 &&
            metrics.every((metric) => metric.hasEmptyMetricValue() || metric.hasOnlyZeroMetricValues()));
    }
    hasDashboardDataSurfaces() {
        const semanticChartCount = this.elements.filter((element) => {
            if (!/^(?:canvas|svg)$/iu.test(element.tagName))
                return false;
            if (!element.isVisible())
                return false;
            return VISUALIZATION_SEMANTIC_PATTERN.test(`${element.id} ${element.className}`);
        }).length;
        const hasDetailResult = this.elements.some((element) => {
            const signal = `${element.id} ${element.className} ${element.tagName}`;
            return /(?:table|tbody|detail|result)/iu.test(signal);
        });
        return semanticChartCount >= 2 && hasDetailResult;
    }
    dashboardEmptyStateWithChartData() {
        const metrics = this.visibleMetricElements();
        if (metrics.length < 2 ||
            !metrics.every((metric) => metric.hasEmptyMetricValue() || metric.hasOnlyZeroMetricValues())) {
            return undefined;
        }
        const emptyResult = this.elements.find((element) => element.hasExplicitEmptyResult());
        if (!emptyResult)
            return undefined;
        const charts = this.elements.filter((element) => /^(?:canvas|svg)$/iu.test(element.tagName) &&
            element.isVisible() &&
            VISUALIZATION_SEMANTIC_PATTERN.test(`${element.id} ${element.className}`) &&
            element.hasRenderedChartData());
        if (charts.length < 2)
            return undefined;
        return {
            emptySelector: emptyResult.selectorIdentity(),
            chartSelectors: charts.slice(0, 8).map((chart) => chart.selectorIdentity()),
        };
    }
    invalidRenderedDataSurfaces() {
        if (!this.hasDashboardDataSurfaces())
            return [];
        return this.elements.flatMap((element) => {
            const invalid = element.invalidRenderedData();
            if (!invalid)
                return [];
            return [
                {
                    selector: element.selectorIdentity(),
                    token: invalid.token,
                    sample: invalid.sample,
                },
            ];
        });
    }
    observableDataSnapshot() {
        const snapshots = [];
        const canvases = new Map();
        for (const element of this.elements) {
            if (element instanceof SmokeCanvasElement) {
                const identity = element.id || element.className;
                if (identity)
                    canvases.set(identity, element.observableCanvasSnapshot());
                continue;
            }
            snapshots.push(...element.observableDataSnapshot());
        }
        return [...snapshots, ...canvases.values()];
    }
    elementsByTagName(tagName) {
        return this.elements.filter((element) => element.tagName.toLowerCase() === tagName.toLowerCase());
    }
    elementSibling(element, direction) {
        const parent = element.parentElement;
        const start = this.elements.indexOf(element);
        if (start < 0)
            return null;
        for (let index = start + direction; index >= 0 && index < this.elements.length; index += direction) {
            const candidate = this.elements[index];
            if (candidate?.parentElement === parent)
                return candidate;
        }
        return null;
    }
    elementChildren(parent) {
        return this.elements.filter((candidate) => candidate !== parent && candidate.parentElement === parent);
    }
    elementSiblingBoundary(parent, direction) {
        const children = this.elementChildren(parent);
        return direction === 1 ? (children[0] ?? null) : (children.at(-1) ?? null);
    }
    filterActionElements() {
        return this.elements.filter((element) => {
            if (!/^(?:button|input)$/i.test(element.tagName) || !element.hasListeners("click"))
                return false;
            return /(?:apply|filter|search|refresh|update|run)/i.test(`${element.id} ${element.className} ${element.textContent}`);
        });
    }
    isSharedGlobalDashboardFilter(element) {
        let scope = element.parentElement;
        while (scope && scope !== this.body) {
            if (/(?:^|\s)(?:filters?|filter-bar|filter-section|dashboard-filters?)(?:\s|$)/iu.test(`${scope.id} ${scope.className}`)) {
                const selectCount = this.elements.filter((candidate) => candidate.tagName.toLowerCase() === "select" && scope?.contains(candidate)).length;
                return selectCount >= 2;
            }
            scope = scope.parentElement;
        }
        return false;
    }
    isDashboardDataFilter(element) {
        if (/(?:filter|facet|search|query|筛选|过滤|查询)/iu.test(`${element.id} ${element.className}`))
            return true;
        if (Object.keys(element.dataset).some((key) => /(?:filter|facet|scope|query)/iu.test(key)))
            return true;
        let scope = element.parentElement;
        while (scope && scope !== this.body) {
            if (/(?:filter|facet|search|query|筛选|过滤|查询)/iu.test(`${scope.id} ${scope.className}`))
                return true;
            scope = scope.parentElement;
        }
        return false;
    }
    parse(html) {
        for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
            const tagName = match[1] ?? "";
            if (/^(script|link|meta|title|html|head|body)$/i.test(tagName))
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
            if (tagName.toLowerCase() === "select")
                element.setSelectMarkup(selectInnerMarkup(html, match));
            for (const [name, value] of dataAttributes(attrs))
                element.dataset[name] = value;
            if (element.id)
                this.byId.set(element.id, element);
        }
        this.assignParsedParents(html);
    }
    assignParsedParents(html) {
        const parsedElements = this.elements.slice(3);
        const stack = [
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
                if (stackIndex > 0)
                    stack.splice(stackIndex);
                continue;
            }
            if (tagName === "html")
                continue;
            if (tagName === "head") {
                stack.splice(1, stack.length, { element: this.head, tagName });
                continue;
            }
            if (tagName === "body") {
                stack.splice(1, stack.length, { element: this.body, tagName });
                continue;
            }
            if (/^(?:script|link|meta|title)$/iu.test(tagName))
                continue;
            const element = parsedElements[parsedIndex++];
            if (!element)
                break;
            element.setParsedParent(stack.at(-1)?.element ?? this.body);
            const selfClosing = /\/\s*>$/u.test(token[0]);
            if (!selfClosing && !VOID_HTML_TAG_PATTERN.test(tagName))
                stack.push({ element, tagName });
        }
    }
    track(element) {
        this.elements.push(element);
        if (element.id)
            this.updateElementId(element, "", element.id);
    }
}
class SmokeElement extends SmokeEventTarget {
    tagName;
    ownerDocument;
    identifier = "";
    className = "";
    clientWidth = 1024;
    clientHeight = 768;
    text = "";
    html = "";
    currentValue = "";
    hasExplicitSelection = false;
    appendedParent = null;
    parsedParent = null;
    checked = false;
    children = [];
    dataset = {};
    style = new SmokeStyle();
    attributes = new Map();
    interactionValues = [];
    constructor(tagName, ownerDocument) {
        super(tagName);
        this.tagName = tagName;
        this.ownerDocument = ownerDocument;
    }
    get id() {
        return this.identifier;
    }
    set id(value) {
        const next = String(value ?? "");
        const previous = this.identifier;
        this.identifier = next;
        this.ownerDocument.updateElementId(this, previous, next);
    }
    get classList() {
        return new SmokeClassList(this);
    }
    get parentElement() {
        if (this.appendedParent)
            return this.appendedParent;
        if (this.parsedParent)
            return this.parsedParent;
        if (this.tagName.toLowerCase() === "html")
            return null;
        if (/^(?:head|body)$/iu.test(this.tagName))
            return this.ownerDocument.documentElement ?? null;
        return this.ownerDocument.body ?? null;
    }
    get nextElementSibling() {
        return this.ownerDocument.elementSibling(this, 1);
    }
    get previousElementSibling() {
        return this.ownerDocument.elementSibling(this, -1);
    }
    get parentNode() {
        return this.parentElement;
    }
    get firstElementChild() {
        return this.ownerDocument.elementSiblingBoundary(this, 1);
    }
    get lastElementChild() {
        return this.ownerDocument.elementSiblingBoundary(this, -1);
    }
    get firstChild() {
        return this.firstElementChild;
    }
    get lastChild() {
        return this.lastElementChild;
    }
    get childElementCount() {
        return this.ownerDocument.elementChildren(this).length;
    }
    setParsedParent(parent) {
        this.parsedParent = parent;
    }
    matches(selector) {
        return selectorMatches(this, selector);
    }
    closest(selector) {
        let candidate = this;
        while (candidate) {
            if (candidate.matches(selector))
                return candidate;
            candidate = candidate.parentElement;
        }
        return null;
    }
    contains(candidate) {
        let current = candidate;
        while (current) {
            if (current === this)
                return true;
            current = current.parentElement;
        }
        return false;
    }
    getBoundingClientRect() {
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
    get textContent() {
        return (this.text +
            this.children
                .map((child) => child.textContent || stripTags(child.innerHTML).replace(/\s+/gu, " ").trim())
                .join(""));
    }
    set textContent(value) {
        this.text = value === null ? "" : String(value);
    }
    get innerHTML() {
        return this.html;
    }
    set innerHTML(value) {
        this.html = value === null ? "" : String(value);
        if (this.html === "")
            this.children.length = 0;
        if (this.tagName.toLowerCase() === "select")
            this.setSelectMarkup(this.html);
    }
    get value() {
        return this.currentValue;
    }
    set value(value) {
        this.currentValue = value === null || value === undefined ? "" : String(value);
        if (this.tagName.toLowerCase() === "select")
            this.hasExplicitSelection = true;
    }
    get selectedOptions() {
        if (this.tagName.toLowerCase() !== "select")
            return [];
        return this.hasExplicitSelection || this.currentValue ? [{ value: this.currentValue }] : [];
    }
    get options() {
        if (this.tagName.toLowerCase() !== "select")
            return [];
        // HTMLSelectElement.options is an iterable HTMLOptionsCollection in a real
        // browser. The smoke runtime only needs stable value/selection semantics;
        // exposing undefined here turns valid Array.from(select.options) code into
        // a VM-only TypeError and then floods every exercised filter interaction.
        return this.interactionValues.map((value) => ({ value, selected: value === this.currentValue }));
    }
    get innerText() {
        return this.textContent;
    }
    set innerText(value) {
        this.text = value === null ? "" : String(value);
    }
    setAttribute(name, value) {
        this.attributes.set(name, value);
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
        return this.attributes.get(name) ?? null;
    }
    hasAttribute(name) {
        return this.getAttribute(name) !== null;
    }
    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === "id")
            this.id = "";
        else if (name === "class")
            this.className = "";
        else if (name === "style")
            this.style.cssText = "";
        else if (name.startsWith("data-"))
            delete this.dataset[toDatasetName(name.slice("data-".length))];
    }
    toggleAttribute(name, force) {
        const present = this.hasAttribute(name);
        const next = force ?? !present;
        if (next)
            this.setAttribute(name, "");
        else
            this.removeAttribute(name);
        return next;
    }
    appendChild(child) {
        this.children.push(child);
        child.appendedParent = this;
        if (this.tagName.toLowerCase() === "select" && child.tagName.toLowerCase() === "option") {
            const optionValue = child.value || child.textContent;
            if (optionValue && !this.interactionValues.includes(optionValue))
                this.interactionValues.push(optionValue);
            if (!this.currentValue && !this.hasExplicitSelection)
                this.currentValue = optionValue;
        }
        return child;
    }
    append(...nodes) {
        for (const node of nodes)
            this.appendChild(this.asSmokeNode(node));
    }
    prepend(...nodes) {
        for (const node of [...nodes].reverse()) {
            const child = this.asSmokeNode(node);
            this.children.unshift(child);
            child.appendedParent = this;
        }
    }
    replaceChildren(...nodes) {
        for (const child of this.children)
            child.appendedParent = null;
        this.children.length = 0;
        this.text = "";
        this.html = "";
        this.append(...nodes);
    }
    add(option) {
        if (this.tagName.toLowerCase() !== "select" || option.tagName.toLowerCase() !== "option") {
            throw new TypeError("HTMLSelectElement.add requires an option element.");
        }
        this.appendChild(option);
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0)
            this.children.splice(index, 1);
        child.appendedParent = null;
        child.remove();
        return child;
    }
    insertRow(index = -1) {
        return this.insertChildAt(this.ownerDocument.createElement("tr"), index);
    }
    deleteRow(index) {
        this.deleteChildAt(index);
    }
    insertCell(index = -1) {
        return this.insertChildAt(this.ownerDocument.createElement("td"), index);
    }
    deleteCell(index) {
        this.deleteChildAt(index);
    }
    setSelectMarkup(markup) {
        const options = selectOptions(markup);
        this.interactionValues = [...new Set(options.map((option) => option.value).filter(Boolean))];
        const selected = options.find((option) => option.selected);
        const browserDefault = selected ?? options[0];
        this.hasExplicitSelection = browserDefault !== undefined;
        this.currentValue = browserDefault?.value ?? "";
    }
    interactionCandidates() {
        return this.interactionValues.filter((value) => value !== this.value);
    }
    insertChildAt(child, index) {
        const insertionIndex = index < 0 || index >= this.children.length ? this.children.length : index;
        this.children.splice(insertionIndex, 0, child);
        child.appendedParent = this;
        return child;
    }
    deleteChildAt(index) {
        const deletionIndex = index < 0 ? this.children.length - 1 : index;
        if (deletionIndex < 0 || deletionIndex >= this.children.length)
            return;
        this.children.splice(deletionIndex, 1);
    }
    observableDataSnapshot() {
        const signal = `${this.id} ${this.className}`;
        const content = `${this.textContent} ${this.innerHTML}`.trim();
        if (this.tagName.toLowerCase() === "svg" && VISUALIZATION_SEMANTIC_PATTERN.test(signal)) {
            return [[this.id || this.className, "chart", content, this.style.display]];
        }
        const metric = /\b(?:kpi|metric)-?value\b/i.test(this.className) ||
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
    selectorIdentity() {
        if (this.id)
            return `#${this.id}`;
        const [firstClass] = this.className.trim().split(/\s+/u).filter(Boolean);
        return firstClass ? `.${firstClass}` : this.tagName.toLowerCase();
    }
    invalidRenderedData() {
        if (!this.isVisible() || this.observableDataSnapshot().length === 0)
            return undefined;
        const rendered = `${this.textContent} ${this.innerHTML}`
            .replace(/<[^>]*>/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
        if (!rendered)
            return undefined;
        const metric = this.hasMetricSignal();
        if (/\bNaN\b/u.test(rendered) &&
            (metric || /(?:\d|%|\b(?:week|month|quarter|date|lot|yield|rate|count|total)\b)/iu.test(rendered))) {
            return { token: "NaN", sample: rendered.slice(0, 180) };
        }
        const invalidUndefined = metric ||
            /(?:\d|[-–—:/,([])\s*undefined\b|\bundefined\s*(?:[-–—:/,)\]]|$)|\b(?:week|month|quarter|date|lot|yield|rate|count|total)\s*[:#-]?\s*undefined\b/iu.test(rendered);
        if (/\bundefined\b/u.test(rendered) && invalidUndefined) {
            return { token: "undefined", sample: rendered.slice(0, 180) };
        }
        return undefined;
    }
    remove() {
        this.classList.add("hidden");
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector) {
        return this.ownerDocument
            .querySelectorAll(selector)
            .filter((candidate) => candidate !== this && this.contains(candidate));
    }
    click() {
        this.dispatchEvent(new SmokeEvent("click"));
    }
    focus() {
        this.dispatchEvent(new SmokeEvent("focus"));
    }
    blur() {
        this.dispatchEvent(new SmokeEvent("blur"));
    }
    scrollIntoView() {
        // Geometry/scroll position is intentionally not simulated. The method is a
        // safe no-op so valid navigation code is not reported as a script defect.
    }
    animate() {
        return { cancel: () => undefined, play: () => undefined, finished: Promise.resolve() };
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
    hasMetricSignal() {
        const signal = `${this.id} ${this.className}`.trim();
        return (/\b(?:kpi|metric)-?value\b/i.test(this.className) ||
            /(?:kpi|metric).*(?:value|yield|count|output|loss)$/i.test(signal));
    }
    hasOnlyZeroMetricValues() {
        const values = this.textContent.match(/-?\d[\d,.]*/g);
        if (!values?.length)
            return false;
        return values.every((value) => Number(value.replace(/,/g, "")) === 0);
    }
    hasEmptyMetricValue() {
        return /^(?:\s*|--|—|n\/?a|no\s+data|null|undefined)$/i.test(this.textContent.trim());
    }
    hasExplicitEmptyResult() {
        if (!this.isVisible())
            return false;
        const signal = `${this.id} ${this.className} ${this.tagName}`;
        if (!/(?:result|table|tbody|detail|empty)/iu.test(signal))
            return false;
        const rendered = `${this.textContent} ${this.innerHTML}`
            .replace(/<[^>]*>/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
        return /(?:no\s+(?:data|records?|results?)|nothing\s+to\s+show|暂无(?:数据|记录)|无数据)/iu.test(rendered);
    }
    hasRenderedChartData() {
        if (this.tagName.toLowerCase() !== "svg")
            return false;
        return /<(?:path|rect|circle|polyline|polygon|line)\b/iu.test(this.innerHTML) || this.hasChartShapeDescendant();
    }
    hasChartShapeDescendant() {
        return this.children.some((child) => /^(?:path|rect|circle|polyline|polygon|line)$/iu.test(child.tagName) || child.hasChartShapeDescendant());
    }
    asSmokeNode(node) {
        return typeof node === "string" ? this.ownerDocument.createTextNode(node) : node;
    }
}
class SmokeCanvasElement extends SmokeElement {
    bitmapWidth = 300;
    bitmapHeight = 150;
    context2d;
    constructor(ownerDocument) {
        super("canvas", ownerDocument);
        this.context2d = new SmokeCanvasRenderingContext2D(this);
    }
    get width() {
        return this.bitmapWidth;
    }
    set width(value) {
        this.bitmapWidth = normalizedCanvasDimension(value, 300);
        this.context2d?.resetForBitmapResize();
    }
    get height() {
        return this.bitmapHeight;
    }
    hasRenderedChartData() {
        return this.context2d?.hasDrawingCommands() === true;
    }
    set height(value) {
        this.bitmapHeight = normalizedCanvasDimension(value, 150);
        this.context2d?.resetForBitmapResize();
    }
    getContext(contextId) {
        return contextId.toLowerCase() === "2d" ? (this.context2d ?? null) : null;
    }
    observableCanvasSnapshot() {
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
    canvas;
    fillStyle = "#000000";
    strokeStyle = "#000000";
    lineWidth = 1;
    shadowColor = "rgba(0, 0, 0, 0)";
    shadowBlur = 0;
    font = "10px sans-serif";
    textAlign = "start";
    globalAlpha = 1;
    lineDash = [];
    commands = [];
    constructor(canvas) {
        this.canvas = canvas;
    }
    beginPath() {
        this.record("beginPath", []);
    }
    closePath() {
        this.record("closePath", []);
    }
    moveTo(x, y) {
        this.record("moveTo", [x, y]);
    }
    lineTo(x, y) {
        this.record("lineTo", [x, y]);
    }
    quadraticCurveTo(controlX, controlY, x, y) {
        this.record("quadraticCurveTo", [controlX, controlY, x, y]);
    }
    bezierCurveTo(controlX1, controlY1, controlX2, controlY2, x, y) {
        this.record("bezierCurveTo", [controlX1, controlY1, controlX2, controlY2, x, y]);
    }
    arcTo(x1, y1, x2, y2, radius) {
        this.record("arcTo", [x1, y1, x2, y2, radius]);
    }
    rect(x, y, width, height) {
        this.record("rect", [x, y, width, height]);
    }
    roundRect(x, y, width, height, radii) {
        this.record("roundRect", [x, y, width, height, radii]);
    }
    arc(x, y, radius, startAngle, endAngle) {
        this.record("arc", [x, y, radius, startAngle, endAngle]);
    }
    ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise) {
        this.record("ellipse", [x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise]);
    }
    fill() {
        this.record("fill", [this.fillStyle, this.globalAlpha]);
    }
    stroke() {
        this.record("stroke", [this.strokeStyle, this.lineWidth, this.lineDash, this.globalAlpha]);
    }
    fillRect(x, y, width, height) {
        this.record("fillRect", [x, y, width, height, this.fillStyle, this.globalAlpha]);
    }
    strokeRect(x, y, width, height) {
        this.record("strokeRect", [x, y, width, height, this.strokeStyle, this.lineWidth, this.lineDash]);
    }
    clearRect(x, y, width, height) {
        this.commands.length = 0;
        this.record("clearRect", [x, y, width, height]);
    }
    fillText(text, x, y) {
        this.record("fillText", [text, x, y, this.fillStyle, this.font, this.textAlign, this.globalAlpha]);
    }
    strokeText(text, x, y) {
        this.record("strokeText", [text, x, y, this.strokeStyle, this.font, this.textAlign, this.globalAlpha]);
    }
    save() {
        this.record("save", []);
    }
    restore() {
        this.record("restore", []);
    }
    translate(x, y) {
        this.record("translate", [x, y]);
    }
    rotate(angle) {
        this.record("rotate", [angle]);
    }
    scale(x, y) {
        this.record("scale", [x, y]);
    }
    transform(a, b, c, d, e, f) {
        this.record("transform", [a, b, c, d, e, f]);
    }
    setTransform(...values) {
        this.record("setTransform", values);
    }
    resetTransform() {
        this.record("resetTransform", []);
    }
    setLineDash(values) {
        this.lineDash = [...values];
    }
    getLineDash() {
        return [...this.lineDash];
    }
    clip() {
        this.record("clip", []);
    }
    measureText(text) {
        return { width: String(text).length * 6 };
    }
    createLinearGradient() {
        return { addColorStop: (_offset, _color) => undefined };
    }
    createRadialGradient() {
        return { addColorStop: (_offset, _color) => undefined };
    }
    drawImage(...values) {
        this.record("drawImage", values.slice(1));
    }
    snapshot() {
        return [...this.commands];
    }
    hasDrawingCommands() {
        return this.commands.some((command) => !command.startsWith('["clearRect"'));
    }
    resetForBitmapResize() {
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
    record(name, values) {
        this.commands.push(JSON.stringify([name, ...values]));
        if (this.commands.length > 512)
            this.commands.splice(0, this.commands.length - 512);
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
class UnsupportedSmokeCapabilityError extends Error {
    capability;
    constructor(capability) {
        super(`Static smoke runtime does not simulate ${capability}.`);
        this.capability = capability;
        this.name = "UnsupportedSmokeCapabilityError";
    }
}
class SmokeChart {
    data;
    options;
    destroyed = false;
    constructor(_context, config = {}) {
        const candidate = config && typeof config === "object" ? config : {};
        this.data =
            candidate.data && typeof candidate.data === "object" ? candidate.data : {};
        this.options =
            candidate.options && typeof candidate.options === "object"
                ? candidate.options
                : {};
    }
    clickHandler() {
        return typeof this.options.onClick === "function"
            ? this.options.onClick
            : undefined;
    }
    isDestroyed() {
        return this.destroyed;
    }
    dataSnapshot() {
        try {
            return JSON.stringify(this.data, (_key, value) => (typeof value === "function" ? undefined : value));
        }
        catch {
            return "[unserializable chart data]";
        }
    }
    getElementsAtEventForMode(_event, _mode, _options, _useFinalPosition) {
        const labels = Array.isArray(this.data.labels) ? this.data.labels : [];
        const datasets = Array.isArray(this.data.datasets) ? this.data.datasets : [];
        const firstDataset = datasets[0];
        const values = firstDataset &&
            typeof firstDataset === "object" &&
            Array.isArray(firstDataset.data)
            ? firstDataset.data
            : [];
        return Math.max(labels.length, values.length) > 0 ? [{ datasetIndex: 0, index: 0 }] : [];
    }
    destroy() {
        this.destroyed = true;
    }
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
function normalizedCanvasDimension(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}
function synchronizedSurfaceGaps(before, after) {
    const beforeByKey = observableSurfaceMap(before);
    const afterByKey = observableSurfaceMap(after);
    const changedKinds = new Set();
    for (const [key, snapshot] of beforeByKey) {
        const next = afterByKey.get(key);
        if (next !== undefined && next !== snapshot)
            changedKinds.add(key.split("\u0000", 1)[0] ?? "");
    }
    const gaps = [];
    for (const kind of ["chart", "result"]) {
        if (changedKinds.has(kind))
            continue;
        const selectors = [...beforeByKey.keys()]
            .filter((key) => key.startsWith(`${kind}\u0000`))
            .map((key) => key.slice(kind.length + 1))
            .filter(Boolean)
            .slice(0, 4);
        if (selectors.length > 0)
            gaps.push(`${kind} ${selectors.join("/")}`);
    }
    return gaps;
}
function observableSurfaceMap(snapshots) {
    const values = new Map();
    for (const snapshot of snapshots) {
        if (!Array.isArray(snapshot) || snapshot.length < 2)
            continue;
        const identity = typeof snapshot[0] === "string" ? snapshot[0] : "";
        const rawKind = typeof snapshot[1] === "string" ? snapshot[1] : "";
        const kind = /^(?:canvas|chart)$/u.test(rawKind) ? "chart" : rawKind;
        if (!identity || !/^(?:chart|metric|result)$/u.test(kind))
            continue;
        values.set(`${kind}\u0000${identity.startsWith("#") ? identity : `#${identity}`}`, JSON.stringify(snapshot));
    }
    return values;
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
function selectInnerMarkup(html, match) {
    const contentStart = (match.index ?? 0) + match[0].length;
    const closeIndex = html.toLowerCase().indexOf("</select>", contentStart);
    return closeIndex < 0 ? "" : html.slice(contentStart, closeIndex);
}
function selectOptions(markup) {
    const options = [];
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
    const unsupportedCapability = unsupportedSmokeCapabilityFromError(error);
    if (unsupportedCapability) {
        warnings.push(`Runtime smoke gate skipped unsupported browser capability ${unsupportedCapability}.`);
        return;
    }
    errors.push(message);
}
function unsupportedSmokeCapabilityFromError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingGlobal = message.match(/^(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined\b/u)?.[1];
    if (missingGlobal && BROWSER_GLOBALS_NOT_SIMULATED.has(missingGlobal))
        return missingGlobal;
    const missingMember = message.match(/(?:^TypeError:\s*|\b)((?:document|navigator|window)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?) is not a function\b/u)?.[1];
    return missingMember && BROWSER_MEMBERS_NOT_SIMULATED.has(missingMember) ? missingMember : undefined;
}
function downgradeExternalScriptGlobalErrors(errors, warnings) {
    for (let index = errors.length - 1; index >= 0; index -= 1) {
        const message = errors[index] ?? "";
        const missingGlobal = message.match(/(?:^|:\s*)(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined\b/u)?.[1];
        if (!missingGlobal)
            continue;
        errors.splice(index, 1);
        warnings.push(`Runtime smoke gate could not evaluate ${missingGlobal} because an external script was not simulated; this observation is advisory.`);
    }
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