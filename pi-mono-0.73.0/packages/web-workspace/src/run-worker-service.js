import { RunRetryController, } from "./run-retry-controller.js";
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_TIMEOUT_MS = 0;
const DEFAULT_IDLE_SLEEP_MS = 100;
const QUEUE_ERROR_DIAGNOSTIC_THROTTLE_MS = 5000;
const APP_PREVIEW_CONTINUATION_INTERNAL_MARKER = { kind: "app_preview_continuation" };
const ASSISTANT_TAIL_CONTINUATION_PROMPT = "Continue from the previous assistant response and complete the original request. Do not repeat completed work; inspect the current project state before making further changes when needed.";
export class WorkspaceRunWorkerService {
    activeAgents = new Set();
    activeAbortControllers = new Set();
    activeRuns = new Map();
    cancelPollIntervalMs;
    claimTimeoutMs;
    concurrency;
    db;
    diagnostics;
    goalSupervisor;
    queue;
    retryController;
    workerId;
    createAgent;
    loops = [];
    lastQueueErrorDiagnosticAt = 0;
    running = false;
    stopping = false;
    constructor(options) {
        this.db = options.db;
        this.queue = options.queue;
        this.workerId = options.workerId;
        this.concurrency = options.concurrency ?? 1;
        this.createAgent = options.createAgent;
        this.cancelPollIntervalMs = options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
        this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
        this.diagnostics = options.diagnostics;
        this.goalSupervisor = options.goalSupervisor;
        const onRetryEvent = options.retry?.onRetryEvent;
        this.retryController = new RunRetryController({
            ...options.retry,
            diagnostics: options.retry?.diagnostics ?? options.diagnostics,
            onRetryEvent: (event) => {
                this.persistRetryEvent(event);
                onRetryEvent?.(event);
            },
        });
    }
    markOwnedRunningRunsInterrupted() {
        for (const run of this.db.listRunningRunsByWorker(this.workerId)) {
            this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
        }
    }
    async recoverOwnedRuns() {
        await this.queue.requeueActive(this.workerId);
        this.markOwnedRunningRunsInterrupted();
    }
    async processOne() {
        let claimed;
        try {
            claimed = await this.queue.claim(this.workerId, this.claimTimeoutMs);
        }
        catch (error) {
            if (this.stopping && isQueueClosedError(error))
                return false;
            throw error;
        }
        if (!claimed)
            return false;
        if (!claimed.clientId) {
            await this.completeClaim(claimed);
            return true;
        }
        const runIdentity = { clientId: claimed.clientId, runId: claimed.runId };
        const messageEndKeys = new Set();
        let run = this.db.getRun(claimed.clientId, claimed.runId);
        let cancelRequested = false;
        try {
            if (!run || run.status !== "queued")
                return true;
            const session = this.db.getSession(run.clientId, run.sessionId);
            if (!session)
                throw new Error("Runtime session not found");
            const messages = this.db.listMessages(run.clientId, run.sessionId);
            const activeRun = this.db.updateRunStatus(run.runId, run.clientId, "running", { workerId: this.workerId });
            run = activeRun;
            const abortController = new AbortController();
            this.activeAbortControllers.add(abortController);
            this.activeRuns.set(activeRunKey(activeRun), activeRun);
            let activeAgent;
            const cancelPoll = setInterval(() => {
                void this.pollCancellation(activeRun, activeAgent, abortController, () => {
                    cancelRequested = true;
                }).catch((error) => {
                    if (this.stopping && isQueueClosedError(error))
                        return;
                    this.writeDiagnostic("worker_cancel_poll_failed", activeRun, error);
                });
            }, this.cancelPollIntervalMs);
            try {
                await this.retryController.execute({
                    run: activeRun,
                    signal: abortController.signal,
                    action: async () => {
                        const agent = this.createAgent({
                            run: activeRun,
                            session,
                            messages,
                            model: activeRun.model,
                            thinkingLevel: activeRun.thinkingLevel,
                            signal: abortController.signal,
                        });
                        const attemptEvents = [];
                        let persistedEventCount = 0;
                        let unsubscribe;
                        const flushAttemptEvents = () => {
                            while (persistedEventCount < attemptEvents.length) {
                                const event = attemptEvents[persistedEventCount];
                                this.persistAgentEvent(activeRun, event, messageEndKeys);
                                persistedEventCount += 1;
                            }
                        };
                        try {
                            activeAgent = agent;
                            this.activeAgents.add(agent);
                            unsubscribe = agent.subscribe((event) => {
                                attemptEvents.push(event);
                                if (persistedEventCount > 0 || shouldFlushAttemptEvents(event)) {
                                    flushAttemptEvents();
                                }
                            });
                            const tailMessage = messages.at(-1);
                            try {
                                if (tailMessage && isUserPromptRole(tailMessage.role)) {
                                    await agent.prompt(tailMessage);
                                }
                                else if (tailMessage?.role === "assistant") {
                                    await agent.prompt(createAssistantTailContinuationPrompt(activeRun));
                                }
                                else {
                                    await agent.continue();
                                }
                                await agent.waitForIdle?.();
                            }
                            catch (error) {
                                if (persistedEventCount > 0) {
                                    flushAttemptEvents();
                                    throw new NonRetryableAgentAttemptError(errorMessage(error));
                                }
                                throw error;
                            }
                            const assistantError = assistantErrorMessageFromEvents(attemptEvents);
                            if (assistantError) {
                                if (persistedEventCount > 0 || attemptHasNonReplayableSideEffects(attemptEvents)) {
                                    flushAttemptEvents();
                                    throw new NonRetryableAgentAttemptError(assistantError);
                                }
                                throw new Error(assistantError);
                            }
                            flushAttemptEvents();
                        }
                        finally {
                            if (unsubscribe)
                                unsubscribe();
                            this.activeAgents.delete(agent);
                            if (activeAgent === agent)
                                activeAgent = undefined;
                        }
                    },
                });
                const current = this.db.getRun(activeRun.clientId, activeRun.runId);
                if (current && isTerminalStatus(current.status)) {
                    return true;
                }
                if (this.stopping) {
                    this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "interrupted");
                }
                else if (cancelRequested || (await this.safeIsCancelRequested(activeRun))) {
                    this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "cancelled");
                }
                else {
                    this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "completed");
                }
            }
            finally {
                clearInterval(cancelPoll);
                this.activeAbortControllers.delete(abortController);
                this.activeRuns.delete(activeRunKey(activeRun));
            }
            return true;
        }
        catch (error) {
            if (run) {
                const current = this.db.getRun(run.clientId, run.runId);
                if (current && isTerminalStatus(current.status)) {
                    return true;
                }
                if (cancelRequested || (await this.safeIsCancelRequested(run))) {
                    this.db.updateRunStatus(run.runId, run.clientId, "cancelled");
                }
                else if (this.stopping || isQueueClosedError(error)) {
                    this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
                }
                else {
                    this.db.updateRunStatus(run.runId, run.clientId, "failed", { error: errorMessage(error) });
                    this.writeDiagnostic("worker_run_failed", run, error);
                }
            }
            return true;
        }
        finally {
            if (run)
                await this.notifyGoalSupervisor(run);
            await this.completeClaim(runIdentity);
        }
    }
    async start() {
        if (this.running)
            return;
        this.stopping = false;
        await this.recoverOwnedRuns();
        this.running = true;
        this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
    }
    async stop() {
        this.stopping = true;
        this.running = false;
        for (const run of this.activeRuns.values()) {
            const current = this.db.getRun(run.clientId, run.runId);
            if (current?.status === "running" || current?.status === "cancelling") {
                this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
            }
        }
        this.markOwnedRunningRunsInterrupted();
        for (const abortController of this.activeAbortControllers)
            abortController.abort();
        for (const agent of this.activeAgents)
            agent.abort();
        await this.queue.close();
        await Promise.all(this.loops);
        this.loops = [];
    }
    async completeClaim(run) {
        try {
            await this.queue.complete(run, this.workerId);
        }
        catch (error) {
            if (this.stopping && isQueueClosedError(error))
                return;
            throw error;
        }
    }
    async notifyGoalSupervisor(run) {
        const current = this.db.getRun(run.clientId, run.runId);
        if (!current || !isTerminalStatus(current.status))
            return;
        try {
            await this.goalSupervisor?.afterRunTerminal(current);
        }
        catch (error) {
            this.writeDiagnostic("worker_goal_supervisor_failed", current, error);
        }
    }
    persistAgentEvent(run, event, messageEndKeys) {
        this.db.appendRunEvent({
            clientId: run.clientId,
            sessionId: run.sessionId,
            runId: run.runId,
            type: event.type,
            payload: event,
        });
        const message = event.type === "message_end" ? runtimeMessageFromEvent(run, event.message) : undefined;
        if (message && this.shouldAppendMessage(message, messageEndKeys)) {
            this.db.appendMessage({
                clientId: run.clientId,
                sessionId: run.sessionId,
                role: message.role,
                payload: message.payload,
            });
        }
    }
    persistRetryEvent(event) {
        if (event.eventType !== "retry_scheduled")
            return;
        const type = "agent_retry_scheduled";
        this.db.appendRunEvent({
            clientId: event.run.clientId,
            sessionId: event.run.sessionId,
            runId: event.run.runId,
            type,
            payload: {
                type,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                reasonCode: event.reasonCode,
                ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
            },
        });
    }
    shouldAppendMessage(message, messageEndKeys) {
        if (isUserPromptRole(message.role))
            return false;
        const key = messageKey(message);
        if (messageEndKeys.has(key))
            return false;
        messageEndKeys.add(key);
        return true;
    }
    async pollCancellation(run, agent, abortController, onCancel) {
        if (!(await this.queue.isCancelRequested(run)))
            return;
        onCancel();
        abortController.abort();
        agent?.abort();
        const current = this.db.getRun(run.clientId, run.runId);
        if (current?.status === "running") {
            this.db.updateRunStatus(run.runId, run.clientId, "cancelling");
        }
    }
    async runLoop() {
        while (this.running) {
            try {
                const processed = await this.processOne();
                if (!processed)
                    await sleep(DEFAULT_IDLE_SLEEP_MS);
            }
            catch (error) {
                if (this.stopping && isQueueClosedError(error))
                    return;
                this.writeQueueDiagnostic("worker.queue.claim.error", error);
                await sleep(DEFAULT_IDLE_SLEEP_MS);
            }
        }
    }
    async safeIsCancelRequested(run) {
        try {
            return await this.queue.isCancelRequested(run);
        }
        catch (error) {
            if (this.stopping && isQueueClosedError(error))
                return false;
            throw error;
        }
    }
    writeDiagnostic(eventType, run, error) {
        this.diagnostics?.writeEvents({
            events: [
                {
                    eventType,
                    level: "error",
                    category: "agent",
                    sessionId: run.sessionId,
                    traceId: run.sessionId,
                    data: {
                        clientId: run.clientId,
                        runId: run.runId,
                        workerId: this.workerId,
                        message: errorMessage(error),
                    },
                },
            ],
        });
    }
    writeQueueDiagnostic(eventType, error) {
        const now = Date.now();
        if (now - this.lastQueueErrorDiagnosticAt < QUEUE_ERROR_DIAGNOSTIC_THROTTLE_MS) {
            return;
        }
        this.lastQueueErrorDiagnosticAt = now;
        this.diagnostics?.writeEvents({
            events: [
                {
                    eventType,
                    level: "error",
                    category: "system",
                    data: {
                        workerId: this.workerId,
                        message: errorMessage(error),
                        hint: "Redis may be unavailable or the run queue connection may be broken.",
                    },
                },
            ],
        });
    }
}
class NonRetryableAgentAttemptError extends Error {
    code = "PI_NON_RETRYABLE";
    retryable = false;
    constructor(assistantError) {
        super(`Agent attempt failed after non-replayable side effects: ${assistantError}`);
        this.name = "NonRetryableAgentAttemptError";
    }
}
function activeRunKey(run) {
    return JSON.stringify([run.clientId, run.runId]);
}
function isQueueClosedError(error) {
    return error instanceof Error && error.message === "Run queue is closed";
}
function isTerminalStatus(status) {
    return status === "cancelled" || status === "completed" || status === "failed" || status === "interrupted";
}
function isUserPromptRole(role) {
    return role === "user" || role === "user-with-attachments";
}
function createAssistantTailContinuationPrompt(run) {
    return {
        messageId: 0,
        sessionId: run.sessionId,
        clientId: run.clientId,
        role: "user",
        payload: {
            content: ASSISTANT_TAIL_CONTINUATION_PROMPT,
            piInternal: APP_PREVIEW_CONTINUATION_INTERNAL_MARKER,
        },
        createdAt: new Date().toISOString(),
    };
}
function attemptHasNonReplayableSideEffects(events) {
    for (const event of events) {
        if (event.type.startsWith("tool_execution_"))
            return true;
        if (event.type === "message_end" && isNonReplayableSideEffectMessage(event.message))
            return true;
        if (event.messages?.some((message) => isNonReplayableSideEffectMessage(message)))
            return true;
    }
    return false;
}
function shouldFlushAttemptEvents(event) {
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
        return !isAssistantFailureMarkerEvent(event) && !isReplayablePromptEvent(event);
    }
    if (event.type.startsWith("tool_execution_"))
        return true;
    if (event.type === "agent_end")
        return !event.messages?.some((message) => isAssistantFailureMarker(message));
    return false;
}
function isReplayablePromptEvent(event) {
    return isReplayablePromptMessage(event.message);
}
function isReplayablePromptMessage(message) {
    const role = typeof message?.role === "string" ? message.role : undefined;
    return role ? isUserPromptRole(role) : false;
}
function isAssistantFailureMarkerEvent(event) {
    if (isAssistantFailureMarker(event.message))
        return true;
    return event.messages?.some((message) => isAssistantFailureMarker(message)) ?? false;
}
function isNonReplayableSideEffectMessage(message) {
    if (!message)
        return false;
    const role = typeof message?.role === "string" ? message.role : undefined;
    if (!role)
        return false;
    if (role === "user" || role === "user-with-attachments")
        return false;
    if (role === "toolResult")
        return true;
    if (role === "assistant")
        return !isAssistantFailureMarker(message);
    return true;
}
function isAssistantFailureMarker(message) {
    if (!message)
        return false;
    if (assistantErrorMessageFromMessage(message))
        return true;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    return stopReason === "error";
}
function assistantErrorMessageFromEvents(events) {
    for (const event of events) {
        const messageError = assistantErrorMessageFromMessage(event.message);
        if (messageError)
            return messageError;
        for (const message of event.messages ?? []) {
            const listMessageError = assistantErrorMessageFromMessage(message);
            if (listMessageError)
                return listMessageError;
        }
    }
    return undefined;
}
function assistantErrorMessageFromMessage(message) {
    if (!message)
        return undefined;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role && role !== "assistant")
        return undefined;
    const errorMessage = message.errorMessage;
    if (typeof errorMessage === "string" && errorMessage.length > 0)
        return errorMessage;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    return stopReason === "error" ? "assistant stopped with error" : undefined;
}
function messageKey(message) {
    return JSON.stringify([message.role, message.payload]);
}
function runtimeMessageFromEvent(run, message) {
    if (!message)
        return undefined;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (!role)
        return undefined;
    const payload = isJsonObject(message.payload) ? message.payload : message;
    return {
        messageId: typeof message.messageId === "number" ? message.messageId : 0,
        sessionId: run.sessionId,
        clientId: run.clientId,
        role,
        payload,
        createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    };
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=run-worker-service.js.map