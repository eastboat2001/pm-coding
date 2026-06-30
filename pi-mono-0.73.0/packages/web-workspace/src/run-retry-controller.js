import { RetryPolicy } from "./retry-policy.js";
export class RunRetryController {
    options;
    policy;
    sleep;
    constructor(options = {}) {
        this.options = options;
        this.policy = options.policy ?? new RetryPolicy();
        this.sleep = options.sleep ?? sleep;
    }
    async execute(input) {
        let attempt = 0;
        for (;;) {
            try {
                await input.action();
                return;
            }
            catch (error) {
                if (input.signal?.aborted) {
                    throw error;
                }
                const classification = this.policy.classify(error);
                attempt += 1;
                if (!classification.retryable || !this.policy.shouldRetry(attempt + 1)) {
                    await this.writeRetryEvent("retry_exhausted", input.run, attempt, classification.reasonCode, classification.message);
                    throw error;
                }
                const delayMs = this.policy.delayMs(attempt);
                await this.writeRetryEvent("retry_scheduled", input.run, attempt, classification.reasonCode, classification.message, delayMs);
                await this.sleep(delayMs, input.signal);
            }
        }
    }
    async writeRetryEvent(eventType, run, attempt, reasonCode, message, delayMs) {
        await this.options.onRetryEvent?.({
            eventType,
            run,
            attempt,
            maxAttempts: this.policy.maxAttempts,
            reasonCode,
            message,
            delayMs,
        });
        this.options.diagnostics?.writeEvents({
            events: [
                {
                    eventType: `agent.${eventType}`,
                    level: eventType === "retry_exhausted" ? "error" : "warn",
                    category: "agent",
                    sessionId: run.sessionId,
                    traceId: run.sessionId,
                    data: {
                        clientId: run.clientId,
                        runId: run.runId,
                        attempt,
                        maxAttempts: this.policy.maxAttempts,
                        reasonCode,
                        message,
                        delayMs,
                    },
                },
            ],
        });
    }
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Retry cancelled"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(new Error("Retry cancelled"));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
//# sourceMappingURL=run-retry-controller.js.map