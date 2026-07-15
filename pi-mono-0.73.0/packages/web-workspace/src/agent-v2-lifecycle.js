const SHUTDOWN_ERROR_CODE = "agent_v2.shutdown_step_failed";
const SHUTDOWN_ERROR_MESSAGE = "Agent v2 shutdown step failed";
export function createAgentV2ShutdownDeadline(timeoutMs, now = Date.now) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
        throw new Error("Agent v2 shutdown timeout must be non-negative");
    const controller = new AbortController();
    const deadlineAtMs = now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(SHUTDOWN_ERROR_CODE), Math.max(0, timeoutMs));
    timer.unref?.();
    return {
        signal: controller.signal,
        deadlineAtMs,
        dispose() {
            clearTimeout(timer);
        },
    };
}
export function remainingAgentV2ShutdownMs(options, now = Date.now) {
    return Math.max(0, options.deadlineAtMs - now());
}
export async function runAgentV2ShutdownSteps(steps, options) {
    const timedOutSteps = [];
    const errors = [];
    for (const step of steps) {
        const outcome = await settleShutdownStep(step, options);
        if (outcome.kind === "timeout") {
            step.onTimeout?.();
            timedOutSteps.push(step.step);
        }
        else if (outcome.kind === "error") {
            errors.push({ step: step.step, code: SHUTDOWN_ERROR_CODE, message: SHUTDOWN_ERROR_MESSAGE });
        }
        else if (isAgentV2WorkerStopResult(outcome.value)) {
            timedOutSteps.push(...outcome.value.timedOutSteps);
            errors.push(...outcome.value.errors);
        }
    }
    return {
        completed: timedOutSteps.length === 0 && errors.length === 0,
        timedOutSteps,
        errors,
    };
}
async function settleShutdownStep(step, options) {
    let settled = false;
    let invoked;
    try {
        invoked = step.run(options);
    }
    catch {
        return { kind: "error" };
    }
    const operation = Promise.resolve(invoked).then((value) => {
        settled = true;
        return { kind: "completed", value };
    }, () => {
        settled = true;
        return { kind: "error" };
    });
    // Always invoke every cleanup. Once the shared deadline has elapsed, allow an
    // immediately-settling cleanup a small microtask turn to finish, but never start a new timeout.
    if (options.signal.aborted || remainingAgentV2ShutdownMs(options) === 0) {
        for (let turn = 0; turn < 8 && !settled; turn += 1)
            await Promise.resolve();
        return settled ? await operation : { kind: "timeout" };
    }
    let removeAbortListener = () => undefined;
    const deadline = new Promise((resolve) => {
        const onAbort = () => resolve({ kind: "timeout" });
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal.removeEventListener("abort", onAbort);
    });
    try {
        return await Promise.race([operation, deadline]);
    }
    finally {
        removeAbortListener();
    }
}
function isAgentV2WorkerStopResult(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.completed === "boolean" &&
        Array.isArray(candidate.timedOutSteps) &&
        Array.isArray(candidate.errors));
}
//# sourceMappingURL=agent-v2-lifecycle.js.map