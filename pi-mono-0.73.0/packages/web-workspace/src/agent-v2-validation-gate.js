import { inspectAgentV2BlueprintQuality, } from "./agent-v2-blueprint-quality-gate.js";
import { assertAgentV2ToolAllowed, createAgentV2ToolFailure, createAgentV2ToolRegistry, } from "./agent-v2-tool-governance.js";
import { classifyAgentV2ValidationPolicy } from "./agent-v2-validation-policy.js";
import { isProjectEntryConflictMessage, isProjectManifestMissingMessage } from "./project-entry-consistency.js";
import { executableMathRandomCallIndex } from "./static-preview-quality-gate.js";
import { createWorkspaceTaskService } from "./workspace-task-factory.js";
const REPAIRABLE_BUILD_POLICY_MESSAGES = new Set([
    "Build manifest could not be inspected.",
    "Project npm configuration is not allowed.",
    "Unsupported package-manager lockfile.",
    "Package manifest is missing or invalid.",
    "Package scripts must be an object.",
    "Package manifest requires a string build script.",
    "Package manifest contains a forbidden lifecycle script.",
    "Dependencies require package-lock.json.",
    "Only npm packageManager declarations are allowed.",
    "Dependency declarations must be objects.",
    "Package manifest contains an unsupported dependency specification.",
    "Package lock is invalid.",
    "Package lock contains a disallowed resolved URL.",
]);
const EXPLICIT_DETERMINISM_REQUIREMENT_PATTERN = /(?:\b(?:deterministic|reproducible|repeatable|seeded|fixed\s+(?:initial|seed|sequence|level|spawn|speed|position|demo\s+data|mock\s+data|fixture\s+data)|same\s+(?:after|across)\s+(?:refresh|reload)|stable\s+(?:mock|demo|fixture|sample)\s+data|no\s+(?:unseeded\s+)?random(?:ness)?|without\s+(?:unseeded\s+)?random(?:ness)?)\b|确定性|可复现|刷新后.{0,24}(?:一致|相同|不变|复现)|固定(?:的)?(?:初始|种子|序列|关卡|球速|食物序列|砖块布局|演示数据|模拟数据)|(?:无种子|未播种)(?:的)?随机|不(?:允许|得|能)?使用.{0,8}随机)/iu;
const DEFERRED_DETERMINISM_REQUIREMENT_PATTERN = /(?:optional|future|nice to have|if approved|tbd|可选|后续|待定|确认后)/iu;
const EXECUTABLE_PROJECT_SOURCE_PATTERN = /\.(?:html?|js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/iu;
export async function runAgentV2StaticValidationGate(input) {
    const tasks = input.tasks ?? createWorkspaceTaskService(input.config);
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    assertAgentV2ToolAllowed(registry, "validation.static_quality", "validation");
    assertAgentV2ToolAllowed(registry, "validation.static_smoke", "validation");
    throwIfAborted(input.signal);
    const initialTaskResult = await tasks.run({
        clientId: input.context.clientId,
        sessionId: input.context.sessionId,
        title: input.context.title,
        task: "validate",
    }, undefined, input.signal);
    const initialRawErrors = rawErrorsFor(initialTaskResult);
    let buildResult;
    let taskResult = initialTaskResult;
    const hasEntryConflict = initialRawErrors.some(isProjectEntryConflictMessage);
    if (!hasEntryConflict &&
        (initialTaskResult.hasPackageJson === true || initialRawErrors.some(isBuildRequiredMessage))) {
        assertAgentV2ToolAllowed(registry, "validation.static_build", "validation");
        throwIfAborted(input.signal);
        buildResult = await tasks.run({
            clientId: input.context.clientId,
            sessionId: input.context.sessionId,
            title: input.context.title,
            task: "build_static",
        }, undefined, input.signal);
        if (buildResult.status === "failed") {
            taskResult = buildResult;
        }
        else {
            throwIfAborted(input.signal);
            taskResult = await tasks.run({
                clientId: input.context.clientId,
                sessionId: input.context.sessionId,
                title: input.context.title,
                task: "validate",
            }, undefined, input.signal);
        }
    }
    const rawErrors = rawErrorsFor(taskResult);
    const failures = taskResult.task === "build_static" && taskResult.status === "failed"
        ? [classifyBuildRunnerFailure(taskResult, input.taskId)]
        : rawErrors.map((message) => classifyStaticValidationFailure(message, input.taskId, input.projectSources ?? [], input.productBlueprint));
    const explicitDeterminismFailure = classifyExplicitDeterminismFailure({
        blueprint: input.productBlueprint,
        projectSources: input.projectSources ?? [],
        taskId: input.taskId,
    });
    if (explicitDeterminismFailure && !failures.some((failure) => failure.code === "static.nondeterministic_data")) {
        failures.push(explicitDeterminismFailure);
    }
    if (taskResult.status !== "failed" || failures.every((failure) => !failure.blocking)) {
        for (const issue of inspectAgentV2BlueprintQuality({
            blueprint: input.productBlueprint,
            sources: input.projectSources ?? [],
        })) {
            failures.push(createFailure({
                code: issue.code,
                message: issue.message,
                retryable: true,
                source: "static_quality",
                taskId: input.taskId,
                path: issue.path,
                data: issue.data,
            }));
        }
    }
    if (failures.length === 0 && taskResult.status === "failed") {
        failures.push(createFailure({
            code: "static.validation_failed",
            message: "Static validation failed.",
            retryable: true,
            source: "static_validate",
            taskId: input.taskId,
        }));
    }
    const blockingFailures = failures.filter((failure) => failure.blocking);
    const status = blockingFailures.length === 0 ? "passed" : "failed";
    const summary = status === "failed"
        ? "Static validation failed"
        : failures.length > 0
            ? `Static validation passed with ${failures.length} advisory finding${failures.length === 1 ? "" : "s"}`
            : "Static validation passed";
    return {
        status,
        failures,
        validation: {
            clientId: input.context.clientId,
            runId: input.runId,
            validationId: `static:${input.taskId}`,
            attempt: 1,
            taskId: input.taskId,
            status,
            summary,
            details: {
                failureCount: failures.length,
                blockingFailureCount: blockingFailures.length,
                failureCodes: [...new Set(failures.map((failure) => failure.code))].sort(),
                retryableFailureCount: failures.filter((failure) => failure.retryable).length,
                usedBuildStep: buildResult !== undefined,
                warningCount: rawWarningsFor(taskResult).length,
                warnings: rawWarningsFor(taskResult)
                    .slice(0, 16)
                    .map((warning) => warning.slice(0, 1_000)),
            },
            createdAt: input.now,
            updatedAt: input.now,
        },
        rawResult: taskResult,
    };
}
function classifyExplicitDeterminismFailure(input) {
    const requirement = input.blueprint?.items.find((item) => !DEFERRED_DETERMINISM_REQUIREMENT_PATTERN.test(item.text) &&
        EXPLICIT_DETERMINISM_REQUIREMENT_PATTERN.test(item.text));
    if (!requirement)
        return undefined;
    const randomEvidence = executableRandomEvidence(input.projectSources);
    if (!randomEvidence)
        return undefined;
    const requirementEvidence = `${requirement.sourcePath}:${requirement.line} ${requirement.text}`.slice(0, 1_000);
    return createFailure({
        code: "static.nondeterministic_data",
        message: "Static validation found unseeded Math.random() despite an explicit deterministic or reproducible product requirement.",
        retryable: true,
        source: "static_quality",
        taskId: input.taskId,
        path: randomEvidence.path,
        data: {
            highConfidence: true,
            requirementKind: "explicit_determinism",
            blueprintItemId: requirement.id,
            blueprintEvidence: requirementEvidence,
            sourceEvidence: `${randomEvidence.path}:${randomEvidence.line} Math.random()`,
        },
        blocking: true,
        sourceMessage: `${randomEvidence.path}:${randomEvidence.line} uses Math.random(); ${requirementEvidence}`,
    });
}
function executableRandomEvidence(projectSources) {
    for (const source of projectSources) {
        if (!EXECUTABLE_PROJECT_SOURCE_PATTERN.test(source.path))
            continue;
        if (/\.html?$/iu.test(source.path)) {
            const executableHtml = source.content.replace(/<!--[\s\S]*?-->/gu, (comment) => " ".repeat(comment.length));
            const randomIndex = executableMathRandomCallIndex(executableHtml);
            if (randomIndex !== undefined) {
                return { path: normalizePath(source.path), line: sourceLineAt(source.content, randomIndex) };
            }
            continue;
        }
        const randomIndex = executableMathRandomCallIndex(source.content);
        if (randomIndex === undefined)
            continue;
        return { path: normalizePath(source.path), line: sourceLineAt(source.content, randomIndex) };
    }
    return undefined;
}
function sourceLineAt(source, index) {
    return source.slice(0, Math.max(0, index)).split(/\r?\n/u).length;
}
function rawErrorsFor(result) {
    return Array.isArray(result.errors) ? result.errors.map(String) : [];
}
function rawWarningsFor(result) {
    return Array.isArray(result.warnings) ? result.warnings.map(String) : [];
}
function isBuildRequiredMessage(message) {
    return /^Static preview found a build source entry at .+?\. Run build_static before preview so PI can serve browser-ready dist\/build output\.$/.test(message.trim());
}
function classifyBuildRunnerFailure(result, taskId) {
    const code = result.failureCode ?? "build.execution_failed";
    const sourceMessage = rawErrorsFor(result)[0] ?? "Static build failed.";
    if (isProjectManifestMissingMessage(sourceMessage)) {
        return missingBuildManifestFailure(sourceMessage, taskId);
    }
    return createFailure({
        code,
        message: sourceMessage,
        retryable: isBuildFailureRepairable(code, sourceMessage),
        source: "static_validate",
        taskId,
        sourceMessage,
    });
}
function isBuildFailureRepairable(code, message) {
    if (code === "build.config_missing" || code === "build.output_escape")
        return false;
    if (code !== "build.policy_rejected")
        return true;
    return (REPAIRABLE_BUILD_POLICY_MESSAGES.has(message) ||
        isProjectEntryConflictMessage(message) ||
        isProjectManifestMissingMessage(message));
}
function classifyStaticValidationFailure(message, taskId, projectSources, productBlueprint) {
    const normalized = message.trim();
    if (normalized.startsWith("Static preview quality gate: ")) {
        return classifyQualityFailure(message, normalized.slice("Static preview quality gate: ".length), taskId, projectSources, productBlueprint);
    }
    if (normalized.startsWith("Static preview smoke gate: ")) {
        return classifySmokeFailure(message, normalized.slice("Static preview smoke gate: ".length), taskId, projectSources, productBlueprint);
    }
    if (normalized === "Project workspace is empty.") {
        return createFailure({
            code: "static.workspace_empty",
            message: "Workspace has no project files to validate.",
            retryable: true,
            source: "static_validate",
            taskId,
            sourceMessage: message,
        });
    }
    if (isProjectEntryConflictMessage(normalized)) {
        const entries = normalized
            .match(/entries are unreferenced: (.+?)\. Keep one authoritative implementation/)?.[1]
            ?.split(", ")
            .map(normalizePath)
            .filter(Boolean);
        return createFailure({
            code: "static.project_entry_conflict",
            message: "The project contains a standalone inline application and a separate unreferenced source implementation. Keep exactly one authoritative implementation and preview its build output.",
            retryable: true,
            source: "static_validate",
            taskId,
            path: "index.html",
            data: { sourceEntries: entries ?? [] },
            sourceMessage: message,
        });
    }
    if (isProjectManifestMissingMessage(normalized)) {
        return missingBuildManifestFailure(message, taskId);
    }
    const buildRequired = normalized.match(/^Static preview found a build source entry at (.+?)\. Run build_static before preview so PI can serve browser-ready dist\/build output\.$/);
    if (buildRequired?.[1]) {
        return createFailure({
            code: "static.preview_build_required",
            message: `Static validation requires built browser output before preview checks can run (found ${normalizePath(buildRequired[1])}).`,
            retryable: false,
            source: "preview",
            taskId,
            path: normalizePath(buildRequired[1]),
            data: { detectedPath: normalizePath(buildRequired[1]) },
            sourceMessage: message,
        });
    }
    if (normalized.includes("requires an index.html in the project root, dist, build, or public") ||
        normalized.includes("no index.html was found in the project root, dist, build, or public")) {
        return createFailure({
            code: "static.preview_missing_entry",
            message: "Static validation requires a browser-ready index.html in the project root, dist, build, or public.",
            retryable: true,
            source: "preview",
            taskId,
            path: "index.html",
            sourceMessage: message,
        });
    }
    return createFailure({
        code: "static.validation_failed",
        message: "Static validation failed.",
        retryable: true,
        source: "static_validate",
        taskId,
        sourceMessage: message,
    });
}
function missingBuildManifestFailure(sourceMessage, taskId) {
    const sourceEntry = sourceMessage
        .match(/project contains build source (.+?), but package\.json is missing/)?.[1]
        ?.trim();
    return createFailure({
        code: "static.build_manifest_missing",
        message: "The project uses a build-only source entry but has no package.json. Add a complete build manifest and lockfile for the existing source implementation, or convert it to one dependency-free browser application.",
        retryable: true,
        source: "static_validate",
        taskId,
        path: "package.json",
        data: { ...(sourceEntry ? { sourceEntry: normalizePath(sourceEntry) } : {}) },
        sourceMessage,
    });
}
function classifyQualityFailure(sourceMessage, message, taskId, projectSources, productBlueprint) {
    const canvasFailure = classifyCanvasQualityFailure(sourceMessage, message, taskId);
    if (canvasFailure)
        return canvasFailure;
    if (message.startsWith("Chart.js uses maintainAspectRatio:false without a bounded chart or canvas height.")) {
        const affected = message.match(/Affected canvases: (.+)\.$/)?.[1] ?? "";
        return createFailure({
            code: "static.canvas_layout_unbounded",
            message: "Static validation found a responsive Chart.js canvas without a bounded layout container.",
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
            data: {
                canvasIds: affected
                    .split(",")
                    .map((value) => value.trim().replace(/^#/, ""))
                    .filter(Boolean),
            },
            sourceMessage,
        });
    }
    const selectorMismatch = message.match(/^JavaScript selector (#\S+) in (.+) does not match any HTML id\.$/);
    if (selectorMismatch) {
        return createFailure({
            code: "static.selector_missing",
            message: `Static validation found a selector without a matching HTML id: ${selectorMismatch[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: scriptPath(selectorMismatch[2]),
            data: { selector: selectorMismatch[1], scripts: selectorMismatch[2].split(", ").map(normalizePath) },
            sourceMessage,
        });
    }
    const loadingVisible = message.match(/^Visible loading placeholder (#\S+) is not controlled by local JavaScript\.$/);
    if (loadingVisible) {
        return createFailure({
            code: "static.loading_visible",
            message: `Static validation found a visible loading placeholder that is never cleared: ${loadingVisible[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
            data: { selector: loadingVisible[1] },
            sourceMessage,
        });
    }
    const metricPlaceholder = message.match(/^Metric placeholder (#\S+) starts as "--" but local JavaScript never updates it\.$/);
    if (metricPlaceholder) {
        return createFailure({
            code: "static.metric_placeholder",
            message: `Static validation found a metric placeholder left at its bootstrap value: ${metricPlaceholder[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
            data: { selector: metricPlaceholder[1] },
            sourceMessage,
        });
    }
    const unwiredSelect = message.match(/^Select control (#\S+) is never referenced by local JavaScript and cannot affect rendered data\.$/);
    if (unwiredSelect) {
        const highConfidence = blueprintRequiresAllChartsFilterScope(productBlueprint, unwiredSelect[1], projectSources);
        return createFailure({
            code: "static.control_unwired",
            message: `Static validation found a select control that cannot affect rendered data: ${unwiredSelect[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
            data: {
                selector: unwiredSelect[1],
                highConfidence,
                ...(highConfidence
                    ? {
                        sourceEvidence: "The PM Product Blueprint explicitly scopes this exact filter to all charts/visuals, but project source never references the control.",
                    }
                    : {}),
            },
            blocking: highConfidence,
            sourceMessage,
        });
    }
    const unusedFilterValue = message.match(/^static\.filter_value_unused: Select (#\S+) reads its value into ([A-Za-z_$][\w$]*) but never uses that value\. Evidence: (.+):(\d+) (.+)$/u);
    if (unusedFilterValue) {
        const detectedPath = normalizePath(unusedFilterValue[3]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a filter value that is read but cannot affect rendered data: ${unusedFilterValue[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: unusedFilterValue[1],
                variable: unusedFilterValue[2],
                sourceEvidence: `${detectedPath}:${unusedFilterValue[4]} ${unusedFilterValue[5]}`,
            },
            sourceMessage,
        });
    }
    const inertDelegatedFilter = message.match(/^static\.filter_value_unused: Select (#\S+) updates (this\.filters\.[A-Za-z_$][\w$]*), but getFilteredData\(\) returns this\.dataset unchanged and the redraw subscriber does not consume filter arguments\. Evidence: (.+):(\d+) (.+)$/u);
    if (inertDelegatedFilter) {
        const detectedPath = normalizePath(inertDelegatedFilter[3]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a delegated filter whose shared data getter returns the unfiltered dataset: ${inertDelegatedFilter[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: inertDelegatedFilter[1],
                statePath: inertDelegatedFilter[2],
                sharedDataGetter: "getFilteredData",
                sourceEvidence: `${detectedPath}:${inertDelegatedFilter[4]} ${inertDelegatedFilter[5]}`,
            },
            sourceMessage,
        });
    }
    const unusedFilterState = message.match(/^static\.filter_value_unused: Select (#\S+) writes ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?: [^,]+)?, but rendered-data code never reads that filter property\. Evidence: (.+):(\d+) (.+)$/u);
    if (unusedFilterState) {
        const detectedPath = normalizePath(unusedFilterState[3]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a filter state property that cannot affect rendered data: ${unusedFilterState[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: unusedFilterState[1],
                statePath: unusedFilterState[2],
                sourceEvidence: `${detectedPath}:${unusedFilterState[4]} ${unusedFilterState[5]}`,
            },
            sourceMessage,
        });
    }
    const filterStateKeyMismatch = message.match(/^static\.filter_state_key_mismatch: .+ Controls: (.+?)\. Evidence: (.+)$/u);
    if (filterStateKeyMismatch) {
        const controls = (filterStateKeyMismatch[1] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const selector = controls[0]?.match(/^(#[^=]+)/u)?.[1];
        return createFailure({
            code: "static.filter_state_key_mismatch",
            message: "Static validation found a shared select handler that writes hyphenated control values to nonexistent render-state keys.",
            retryable: true,
            source: "static_quality",
            taskId,
            path: sourceEvidencePath(filterStateKeyMismatch[2]) ?? "index.html",
            data: {
                ...(selector ? { selector } : {}),
                controls,
                sourceEvidence: filterStateKeyMismatch[2],
            },
            sourceMessage,
        });
    }
    const resetOnlyFilter = message.match(/^static\.filter_value_unused: Select (#\S+) is only reset and is never read by an applicable filter handler\. Evidence: (.+):(\d+) (.+)$/u);
    if (resetOnlyFilter) {
        const detectedPath = normalizePath(resetOnlyFilter[2]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a filter control that is resettable but cannot affect rendered data: ${resetOnlyFilter[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: resetOnlyFilter[1],
                resetOnly: true,
                sourceEvidence: `${detectedPath}:${resetOnlyFilter[3]} ${resetOnlyFilter[4]}`,
            },
            sourceMessage,
        });
    }
    const genericHandlerUnusedFilter = message.match(/^static\.filter_value_unused: Select (#\S+) is bound through a generic change handler, but its value is never read by rendered-data code\. Evidence: (.+):(\d+) (.+)$/u);
    if (genericHandlerUnusedFilter) {
        const detectedPath = normalizePath(genericHandlerUnusedFilter[2]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a generically bound filter whose mapped state cannot affect rendered data: ${genericHandlerUnusedFilter[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: genericHandlerUnusedFilter[1],
                genericHandler: true,
                sourceEvidence: `${detectedPath}:${genericHandlerUnusedFilter[3]} ${genericHandlerUnusedFilter[4]}`,
            },
            sourceMessage,
        });
    }
    const omittedBindingMapFilter = message.match(/^static\.filter_value_unused: Select (#\S+) is omitted from the explicit filter binding map and cannot update declared (state\.filters\.[A-Za-z_$][\w$]*)\. Evidence: (.+):(\d+) (.+)$/u);
    if (omittedBindingMapFilter) {
        const detectedPath = normalizePath(omittedBindingMapFilter[3]);
        return createFailure({
            code: "static.filter_value_unused",
            message: `Static validation found a source-backed filter omitted from its sibling binding map: ${omittedBindingMapFilter[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: detectedPath,
            data: {
                selector: omittedBindingMapFilter[1],
                statePath: omittedBindingMapFilter[2],
                bindingMapOmission: true,
                sourceEvidence: `${detectedPath}:${omittedBindingMapFilter[4]} ${omittedBindingMapFilter[5]}`,
            },
            sourceMessage,
        });
    }
    if (message.startsWith("static.nondeterministic_data: ")) {
        const sourceEvidence = message.match(/\. Evidence: (.+)$/u)?.[1]?.trim();
        const highConfidence = message.includes(" Context: dashboard-first-render.");
        return createFailure({
            code: "static.nondeterministic_data",
            message: "Static validation found Math.random() in rendered chart or application data.",
            retryable: true,
            source: "static_quality",
            taskId,
            path: sourceEvidencePath(sourceEvidence) ?? "index.html",
            data: { highConfidence, ...(sourceEvidence ? { sourceEvidence } : {}) },
            blocking: highConfidence,
            sourceMessage,
        });
    }
    const horizontalOverflow = message.match(/^static\.page_horizontal_overflow: .+ (?:Grid|Target): (.+?)\. (?:Canvases: (.+?)\. )?Evidence: (.+)$/u);
    if (horizontalOverflow) {
        const canvasIds = (horizontalOverflow[2] ?? "")
            .split(",")
            .map((value) => value.trim().replace(/^#/, ""))
            .filter(Boolean);
        return createFailure({
            code: "static.page_horizontal_overflow",
            message: "Static validation found source-proven intrinsic content that can force the page beyond the viewport.",
            retryable: true,
            source: "static_quality",
            taskId,
            path: sourceEvidencePath(horizontalOverflow[3]) ?? "index.html",
            data: {
                selector: horizontalOverflow[1],
                canvasIds,
                sourceEvidence: horizontalOverflow[3],
            },
            sourceMessage,
        });
    }
    const localScriptMissing = message.match(/^Local script (.+) could not be read by the static quality gate\.$/);
    if (localScriptMissing?.[1]) {
        return createFailure({
            code: "static.local_script_missing",
            message: `Static validation could not read a local script referenced by the app shell: ${normalizePath(localScriptMissing[1])}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: normalizePath(localScriptMissing[1]),
            sourceMessage,
        });
    }
    return createFailure({
        code: "static.validation_failed",
        message: `Static quality validation failed: ${message}`,
        retryable: true,
        source: "static_quality",
        taskId,
        path: "index.html",
        sourceMessage,
    });
}
function classifyCanvasQualityFailure(sourceMessage, message, taskId) {
    const code = message.match(/^(static\.(?:canvas_css_bitmap_mismatch|canvas_layout_unbounded|canvas_resize_unhandled|svg_coordinate_space_mismatch)):/u)?.[1];
    if (!code)
        return undefined;
    const canvasIds = (message.match(/ Canvases: (.+?)\. Evidence:/u)?.[1] ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^#/, ""))
        .filter(Boolean);
    const svgId = message.match(/ chart SVG #(\S+) fills/u)?.[1];
    const sourceEvidence = message.match(/\. Evidence: (.+)$/u)?.[1]?.trim();
    const detectedPath = sourceEvidencePath(sourceEvidence);
    const descriptions = {
        "static.canvas_css_bitmap_mismatch": "Static validation found chart canvas bitmap dimensions scaled for DPR without explicit CSS display dimensions.",
        "static.canvas_layout_unbounded": "Static validation found a chart canvas without a dedicated bounded drawing viewport.",
        "static.canvas_resize_unhandled": "Static validation found a responsive chart canvas with no ResizeObserver or resize redraw handler.",
        "static.svg_coordinate_space_mismatch": "Static validation found a responsive chart SVG whose drawing coordinate height conflicts with its bounded CSS viewport.",
    };
    return createFailure({
        code,
        message: descriptions[code] ?? "Static validation found an invalid responsive chart canvas layout.",
        retryable: true,
        source: "static_quality",
        taskId,
        path: detectedPath ?? "index.html",
        data: {
            canvasIds,
            ...(svgId ? { selector: `#${svgId}` } : {}),
            ...(sourceEvidence ? { sourceEvidence } : {}),
        },
        sourceMessage,
    });
}
function classifySmokeFailure(sourceMessage, message, taskId, projectSources, productBlueprint) {
    const invalidRenderedData = message.match(/^Runtime smoke gate: dashboard data surface (\S+) rendered invalid token (undefined|NaN) (.+?)\. Evidence: (.+)$/u);
    if (invalidRenderedData) {
        const selector = invalidRenderedData[1] ?? "[data-surface]";
        const token = invalidRenderedData[2] ?? "undefined";
        const phase = invalidRenderedData[3] ?? "during rendering";
        const renderedEvidence = invalidRenderedData[4]?.trim();
        return createFailure({
            code: "static.invalid_rendered_data",
            message: `Static runtime validation found invalid ${token} data in ${selector} ${phase}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: "index.html",
            data: {
                selector,
                token,
                highConfidence: true,
                ...(renderedEvidence ? { sourceEvidence: `Rendered evidence: ${renderedEvidence}` } : {}),
            },
            blocking: true,
            sourceMessage,
        });
    }
    const defaultFilterInconsistent = message.match(/^Runtime smoke gate: applying unchanged default filters replaced representative KPI data with an empty result(?:; (.+):(\d+) filter predicate reads missing fixture field ([A-Za-z_$][\w$]*))?\.$/);
    if (defaultFilterInconsistent) {
        const detectedPath = defaultFilterInconsistent[1] ? normalizePath(defaultFilterInconsistent[1]) : "index.html";
        const sourceEvidence = defaultFilterInconsistent[1]
            ? `${detectedPath}:${defaultFilterInconsistent[2]} missing fixture field ${defaultFilterInconsistent[3]}`
            : undefined;
        return createFailure({
            code: "static.default_filter_inconsistent",
            message: "Static runtime validation found that applying the unchanged default filters replaces representative dashboard data with an empty result.",
            retryable: true,
            source: "static_smoke",
            taskId,
            path: detectedPath,
            data: {
                selector: "button, [type=submit]",
                highConfidence: Boolean(defaultFilterInconsistent[3]),
                ...(defaultFilterInconsistent[3] ? { field: defaultFilterInconsistent[3] } : {}),
                ...(sourceEvidence ? { sourceEvidence } : {}),
            },
            sourceMessage,
        });
    }
    const emptyStateChartMismatch = message.match(/^Runtime smoke gate: dashboard rendered explicit empty state in (\S+) while chart surfaces (.+?) still contained data (after .+)\.$/u);
    if (emptyStateChartMismatch) {
        const emptySelector = emptyStateChartMismatch[1] ?? "[data-result]";
        const chartSelectors = (emptyStateChartMismatch[2] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const phase = emptyStateChartMismatch[3] ?? "after filter interaction";
        const triggeringSelector = /\bselect\s+(#\S+)\s+changed\b/u.exec(phase)?.[1];
        const highConfidence = Boolean(triggeringSelector &&
            blueprintRequiresAllChartsFilterScope(productBlueprint, triggeringSelector, projectSources));
        return createFailure({
            code: "static.filter_empty_state_inconsistent",
            message: `Static runtime validation found stale chart data while ${emptySelector} and KPI metrics showed an empty result ${phase}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: "index.html",
            data: {
                selector: emptySelector,
                chartSelectors,
                highConfidence,
                sourceEvidence: `Empty result ${emptySelector}; non-empty charts ${chartSelectors.join(", ")} ${phase}.${highConfidence ? " Product Blueprint explicitly scopes filters to all charts." : " Product Blueprint does not prove that these charts share the filter scope."}`,
            },
            blocking: highConfidence,
            sourceMessage,
        });
    }
    const controlNoEffect = message.match(/^Runtime smoke gate: (deterministic fixture )?select (#\S+) changed value but did not change rendered metrics, chart data, results, or empty state\.$/);
    const partialDashboardUpdate = message.match(/^Runtime smoke gate: deterministic global select (#\S+) changed some dashboard data but left synchronized surfaces unchanged: (.+)\.$/u);
    if (partialDashboardUpdate) {
        const selector = partialDashboardUpdate[1] ?? "select";
        const unchangedSurfaces = partialDashboardUpdate[2] ?? "dashboard result";
        const binding = controlBindingSource(selector, projectSources);
        const highConfidence = blueprintRequiresAllChartsFilterScope(productBlueprint, selector, projectSources);
        return createFailure({
            code: "static.filter_partial_update",
            message: `Static runtime validation found a global dashboard filter that updated only part of the synchronized view: ${selector}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: binding?.path ?? "index.html",
            data: {
                selector,
                unchangedSurfaces,
                highConfidence,
                sourceEvidence: binding?.evidence ??
                    `${selector} left ${unchangedSurfaces} unchanged after a deterministic option change.${highConfidence ? " Product Blueprint explicitly scopes filters to all charts." : " Product Blueprint does not prove an all-surface scope."}`,
            },
            blocking: highConfidence,
            sourceMessage,
        });
    }
    if (controlNoEffect) {
        const highConfidence = Boolean(controlNoEffect[1]);
        const selector = controlNoEffect[2] ?? "select";
        const binding = controlBindingSource(selector, projectSources);
        return createFailure({
            code: "static.control_no_effect",
            message: `Static runtime validation found a select control with no observable data effect: ${selector}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: binding?.path ?? "index.html",
            data: {
                selector,
                highConfidence,
                ...(binding ? { sourceEvidence: binding.evidence } : {}),
            },
            blocking: highConfidence,
            sourceMessage,
        });
    }
    const loadingVisible = message.match(/^Runtime smoke gate: loading element (#\S+) remained visible after startup\.$/);
    if (loadingVisible) {
        return createFailure({
            code: "static.loading_visible",
            message: `Static runtime validation found a loading placeholder still visible after startup: ${loadingVisible[1]}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: "index.html",
            data: { selector: loadingVisible[1] },
            sourceMessage,
        });
    }
    const metricPlaceholder = message.match(/^Runtime smoke gate: metric placeholder (#\S+) still shows "--" after startup\.$/);
    if (metricPlaceholder) {
        return createFailure({
            code: "static.metric_placeholder",
            message: `Static runtime validation found a metric placeholder still using its bootstrap value: ${metricPlaceholder[1]}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: "index.html",
            data: { selector: metricPlaceholder[1] },
            sourceMessage,
        });
    }
    const localScriptMissing = message.match(/^Runtime smoke gate could not read local script (.+)\.$/);
    if (localScriptMissing?.[1]) {
        return createFailure({
            code: "static.local_script_missing",
            message: `Static runtime validation could not read a local script: ${normalizePath(localScriptMissing[1])}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: normalizePath(localScriptMissing[1]),
            sourceMessage,
        });
    }
    const localAssetMissing = message.match(/^Runtime smoke gate could not authorize local asset (.+)\.$/);
    if (localAssetMissing?.[1]) {
        return createFailure({
            code: "static.local_asset_missing",
            message: `Static runtime validation could not read a referenced local asset: ${normalizePath(localAssetMissing[1])}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: normalizePath(localAssetMissing[1]),
            data: { sourceEvidence: `index.html references missing local asset ${normalizePath(localAssetMissing[1])}.` },
            blocking: true,
            sourceMessage,
        });
    }
    if (message.startsWith("Runtime smoke gate: ") &&
        (message.includes("failed during") ||
            message.includes("handler failed") ||
            message.includes("timer callback failed") ||
            message.includes("console.error was called") ||
            message.includes("timer queue exceeded"))) {
        return createFailure({
            code: "static.script_error",
            message: collapseSmokeMessage(message),
            retryable: true,
            source: "static_smoke",
            taskId,
            sourceMessage,
        });
    }
    return createFailure({
        code: "static.script_error",
        message: collapseSmokeMessage(message),
        retryable: true,
        source: "static_smoke",
        taskId,
        sourceMessage,
    });
}
function blueprintRequiresAllChartsFilterScope(blueprint, selector, projectSources) {
    if (!blueprint || blueprint.sourceDocuments.length === 0)
        return false;
    const identity = normalizeControlIdentity(selector, projectSources);
    if (!identity)
        return false;
    return blueprint.items.some((item) => {
        const columns = item.text.split("|").map((column) => column.trim());
        if (!columns.some((column) => /^(?:all\s+charts?|all\s+visuals?|所有图表|全部图表)$/iu.test(column))) {
            return false;
        }
        const filterName = normalizeControlText(columns[0] ?? "");
        if (!filterName)
            return false;
        const tokens = filterName.split(" ").filter((token) => token.length >= 2);
        return tokens.length > 0 && tokens.every((token) => identity.includes(token));
    });
}
function normalizeControlIdentity(selector, projectSources) {
    const id = selector.startsWith("#") ? selector.slice(1) : "";
    const fragments = [selector];
    if (id) {
        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        for (const source of projectSources) {
            const tag = new RegExp(String.raw `<select\b(?=[^>]*\bid\s*=\s*(["'])${escapedId}\1)([^>]*)>`, "iu").exec(source.content);
            if (tag) {
                fragments.push(tag[2] ?? "");
                const prefix = source.content.slice(Math.max(0, (tag.index ?? 0) - 600), tag.index ?? 0);
                fragments.push(prefix.match(/<label\b[^>]*>([^<>]*)$/iu)?.[1] ?? "");
            }
            fragments.push(new RegExp(String.raw `<label\b[^>]*\bfor\s*=\s*(["'])${escapedId}\1[^>]*>([\s\S]{0,300}?)<\/label>`, "iu").exec(source.content)?.[2] ?? "");
        }
    }
    return normalizeControlText(fragments.join(" "));
}
function normalizeControlText(value) {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/<[^>]+>/gu, " ")
        .replace(/(?:^|\s)(?:filter|select|control|dropdown)(?:\s|$)/gu, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}
function controlBindingSource(selector, projectSources) {
    const id = /^#([A-Za-z][\w:.-]*)$/u.exec(selector)?.[1];
    if (!id)
        return undefined;
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const directBinding = new RegExp(String.raw `(?:getElementById\(\s*['"\x60]${escapedId}['"\x60]\s*\)|querySelector(?:All)?\(\s*['"\x60]#${escapedId}['"\x60]\s*\))`, "u");
    const candidates = projectSources
        .flatMap((source) => {
        const match = directBinding.exec(source.content) ?? delegatedSelectBinding(source.content, id);
        if (!match)
            return [];
        const line = source.content.slice(0, match.index).split(/\r?\n/u).length;
        return [{ path: normalizePath(source.path), line, delegated: !directBinding.test(source.content) }];
    })
        .sort((left, right) => {
        const leftHtml = /\.html?$/iu.test(left.path) ? 1 : 0;
        const rightHtml = /\.html?$/iu.test(right.path) ? 1 : 0;
        return leftHtml - rightHtml || left.path.localeCompare(right.path);
    });
    const candidate = candidates[0];
    return candidate
        ? {
            path: candidate.path,
            evidence: `${candidate.path}:${candidate.line} ${candidate.delegated ? "delegates a select change branch for" : "binds"} ${selector}; deterministic interaction left dashboard data unchanged.`,
        }
        : undefined;
}
function delegatedSelectBinding(source, id) {
    const dynamicCollectionBinding = dynamicSelectCollectionBinding(source, id);
    if (dynamicCollectionBinding)
        return dynamicCollectionBinding;
    // Generated dashboards often attach one change listener to every select and
    // dispatch by event.target.id. Requiring both the delegated listener shape and
    // an exact id branch keeps this attribution narrow while giving repair the
    // browser script (and checksum) that actually owns the inert data path.
    const selectsCollection = /querySelectorAll\s*\(\s*(["'`])[^"'`]*\bselect\b[^"'`]*\1\s*\)/iu.test(source) ||
        /getElementsByTagName\s*\(\s*(["'`])select\1\s*\)/iu.test(source);
    const changeListener = /addEventListener\s*\(\s*(["'`])(?:change|input)\1/iu.test(source) || /on(?:change|input)\s*=/iu.test(source);
    const dynamicTargetId = /(?:target|currentTarget)\s*\.\s*id\b/iu.test(source);
    const hasDelegatedSelectListener = selectsCollection && changeListener && dynamicTargetId;
    if (!hasDelegatedSelectListener)
        return null;
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = new RegExp(String.raw `(["'\x60])${escapedId}\1`, "u").exec(source);
    if (!literal)
        return null;
    const preceding = source.slice(Math.max(0, literal.index - 160), literal.index);
    return /(?:\bid\s*(?:===|==|!==|!=)\s*|\bcase\s+|[,{]\s*)$/u.test(preceding) ? literal : null;
}
function dynamicSelectCollectionBinding(source, id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const declaration of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]{1,2048}?)\]\s*;/gu)) {
        const collection = declaration[1];
        const items = declaration[2] ?? "";
        if (!collection || !new RegExp(`(['"\\x60])${escapedId}\\1`, "u").test(items))
            continue;
        const escapedCollection = collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        for (const loop of source.matchAll(new RegExp(String.raw `\b${escapedCollection}\s*\.\s*forEach\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\{([\s\S]{1,8192}?)\}\s*\)`, "gu"))) {
            const parameter = loop[1];
            if (!parameter)
                continue;
            const escapedParameter = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const body = loop[2] ?? "";
            if (!new RegExp(String.raw `getElementById\(\s*${escapedParameter}\s*\)`, "u").test(body) ||
                !/\.\s*addEventListener\s*\(\s*(['"\x60])(?:change|input)\1/u.test(body) ||
                !/(?:target|currentTarget)\s*\.\s*value\b|\b[A-Za-z_$][\w$]*\s*\.\s*value\b/u.test(body)) {
                continue;
            }
            const literal = new RegExp(`(['"\\x60])${escapedId}\\1`, "u").exec(source);
            if (literal)
                return literal;
        }
    }
    return null;
}
function createFailure(input) {
    return {
        ...createAgentV2ToolFailure({
            code: input.code,
            message: input.message,
            retryable: input.retryable,
            phase: "validation",
            taskId: input.taskId,
            path: input.path,
            data: {
                ...(input.data ?? {}),
                ...(input.sourceMessage ? { sourceMessage: input.sourceMessage } : {}),
            },
        }),
        source: input.source,
        ...classifyAgentV2ValidationPolicy({
            code: input.code,
            source: input.source,
            retryable: input.retryable,
            path: input.path,
            data: input.data,
            blocking: input.blocking,
        }),
    };
}
function collapseSmokeMessage(message) {
    if (message.startsWith("Runtime smoke gate: ")) {
        return `Static runtime validation failed during startup: ${message.slice("Runtime smoke gate: ".length)}`;
    }
    return `Static runtime validation failed during startup: ${message}`;
}
function scriptPath(value) {
    const [first] = value.split(", ");
    return first ? normalizePath(first) : undefined;
}
function sourceEvidencePath(value) {
    if (!value)
        return undefined;
    const path = /^(.*?):\d+(?:\s|$)/u.exec(value)?.[1]?.trim();
    if (!path || path.startsWith("inline script "))
        return undefined;
    return normalizePath(path);
}
function normalizePath(value) {
    return value.replace(/\\/g, "/");
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason ?? new Error("Agent v2 validation was aborted.");
}
//# sourceMappingURL=agent-v2-validation-gate.js.map