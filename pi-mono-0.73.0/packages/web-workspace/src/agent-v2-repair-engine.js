export function planAgentV2RepairActions(input) {
    if (input.attempt >= input.maxAttempts) {
        return [
            {
                actionId: `repair:${input.taskId}:max_attempts`,
                taskId: input.taskId,
                type: "block_task",
                retryable: false,
                reason: `Repair attempts exhausted (${input.attempt}/${input.maxAttempts}).`,
                validationCode: "repair.max_attempts_exceeded",
                validationFingerprint: "repair:max_attempts",
            },
        ];
    }
    const uniqueFailures = [
        ...new Map(input.failures.filter((failure) => failure.blocking).map((failure) => [failure.fingerprint, failure])).values(),
    ];
    return uniqueFailures.map((failure) => repairActionForFailure(input.taskId, failure, input.attempt, input.previousFingerprintAttempts?.[failure.fingerprint] ?? 0));
}
function repairActionForFailure(taskId, failure, attempt, previousFingerprintAttempts) {
    const targetPath = normalizeRepairTargetPath(failure.path);
    const fingerprintAttempts = previousFingerprintAttempts + 1;
    if (!failure.retryable ||
        attempt > failure.repairBudget.maxAttempts ||
        fingerprintAttempts > failure.repairBudget.maxSameFingerprintAttempts) {
        return {
            actionId: `repair:${taskId}:${failure.code}:block`,
            taskId,
            type: "block_task",
            retryable: false,
            reason: !failure.retryable
                ? failure.message
                : `Repair budget exhausted for ${failure.code} (${fingerprintAttempts} identical findings).`,
            targetPath,
            validationCode: failure.code,
            validationFingerprint: failure.fingerprint,
        };
    }
    const type = requiresFullRegeneration(failure.code)
        ? "regenerate_app"
        : targetPath || !isTransientRevalidationFailure(failure.code)
            ? "file_patch"
            : "rerun_validation";
    return {
        actionId: `repair:${taskId}:${failure.code}:${targetPath ?? "run"}`,
        taskId,
        type,
        retryable: true,
        reason: reasonForFailure(failure),
        targetPath,
        validationCode: failure.code,
        validationFingerprint: failure.fingerprint,
    };
}
function requiresFullRegeneration(code) {
    return code === "static.workspace_empty" || code === "static.preview_missing_entry";
}
function isTransientRevalidationFailure(code) {
    return /(?:^|\.)(?:timeout|network|rate_limit|server_error|temporarily_unavailable|unavailable)$/u.test(code);
}
function reasonForFailure(failure) {
    if (failure.code === "static.loading_visible") {
        return "Visible loading state must be hidden or resolved before delivery.";
    }
    if (failure.code === "static.metric_placeholder") {
        return "Metric placeholders must be replaced with rendered values or an explicit empty state.";
    }
    if (failure.code === "static.script_error") {
        return "Client script errors must be fixed before delivery.";
    }
    if (failure.code === "static.canvas_layout_unbounded") {
        return "Responsive charts must use dedicated position:relative containers with bounded heights before delivery.";
    }
    if (failure.code === "static.control_unwired") {
        return "Every visible select must read its selected value and use it to deterministically change KPIs, charts, tables, or an explicit empty state.";
    }
    if (failure.code === "static.control_no_effect") {
        return "The select handler must use its selected value to change numeric metrics, chart datasets, result content, or an explicit empty state; redrawing identical data is not sufficient.";
    }
    if (failure.code === "static.nondeterministic_data") {
        return "Replace Math.random() in rendered data with stable source-backed or seeded fixture data.";
    }
    return failure.message;
}
function normalizeRepairTargetPath(path) {
    if (!path) {
        return undefined;
    }
    const normalized = path
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^(?:\.\/)+/, "");
    return normalized || undefined;
}
//# sourceMappingURL=agent-v2-repair-engine.js.map