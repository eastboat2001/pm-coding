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
            },
        ];
    }
    return input.failures.map((failure) => repairActionForFailure(input.taskId, failure));
}
function repairActionForFailure(taskId, failure) {
    const targetPath = normalizeRepairTargetPath(failure.path);
    if (!failure.retryable) {
        return {
            actionId: `repair:${taskId}:${failure.code}:block`,
            taskId,
            type: "block_task",
            retryable: false,
            reason: failure.message,
            targetPath,
            validationCode: failure.code,
        };
    }
    return {
        actionId: `repair:${taskId}:${failure.code}:${targetPath ?? "run"}`,
        taskId,
        type: targetPath ? "file_patch" : "rerun_validation",
        retryable: true,
        reason: reasonForFailure(failure),
        targetPath,
        validationCode: failure.code,
    };
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