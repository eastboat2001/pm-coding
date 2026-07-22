import { assertAgentV2ToolAllowed, createAgentV2ToolFailure, createAgentV2ToolRegistry, } from "./agent-v2-tool-governance.js";
import { classifyAgentV2ValidationPolicy } from "./agent-v2-validation-policy.js";
import { isProjectEntryConflictMessage, isProjectManifestMissingMessage } from "./project-entry-consistency.js";
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
        : rawErrors.map((message) => classifyStaticValidationFailure(message, input.taskId));
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
            summary: status === "passed" ? "Static validation passed" : "Static validation failed",
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
function classifyStaticValidationFailure(message, taskId) {
    const normalized = message.trim();
    if (normalized.startsWith("Static preview quality gate: ")) {
        return classifyQualityFailure(message, normalized.slice("Static preview quality gate: ".length), taskId);
    }
    if (normalized.startsWith("Static preview smoke gate: ")) {
        return classifySmokeFailure(message, normalized.slice("Static preview smoke gate: ".length), taskId);
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
function classifyQualityFailure(sourceMessage, message, taskId) {
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
        return createFailure({
            code: "static.control_unwired",
            message: `Static validation found a select control that cannot affect rendered data: ${unwiredSelect[1]}.`,
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
            data: { selector: unwiredSelect[1] },
            sourceMessage,
        });
    }
    if (message === "Rendered chart or application data uses Math.random(); interactive results must be deterministic.") {
        return createFailure({
            code: "static.nondeterministic_data",
            message: "Static validation found Math.random() in rendered chart or application data.",
            retryable: true,
            source: "static_quality",
            taskId,
            path: "index.html",
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
function classifySmokeFailure(sourceMessage, message, taskId) {
    const controlNoEffect = message.match(/^Runtime smoke gate: select (#\S+) changed value but did not change rendered metrics, chart data, results, or empty state\.$/);
    if (controlNoEffect) {
        return createFailure({
            code: "static.control_no_effect",
            message: `Static runtime validation found a select control with no observable data effect: ${controlNoEffect[1]}.`,
            retryable: true,
            source: "static_smoke",
            taskId,
            path: "index.html",
            data: { selector: controlNoEffect[1] },
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
function normalizePath(value) {
    return value.replace(/\\/g, "/");
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason ?? new Error("Agent v2 validation was aborted.");
}
//# sourceMappingURL=agent-v2-validation-gate.js.map