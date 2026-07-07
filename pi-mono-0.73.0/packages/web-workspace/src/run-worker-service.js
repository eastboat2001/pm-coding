import { InMemoryRunEventBus } from "./run-event-bus.js";
import { RunEventSink } from "./run-event-sink.js";
import { RunRetryController, } from "./run-retry-controller.js";
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_TIMEOUT_MS = 0;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_SLEEP_MS = 100;
const DEFAULT_MAX_AGENT_TOOL_EXECUTIONS = 240;
const DEFAULT_MAX_AGENT_TURNS = 80;
const DEFAULT_MAX_SESSION_HISTORY_MESSAGES = 2000;
const DEFAULT_MAX_SESSION_HISTORY_PAYLOAD_BYTES = 64 * 1024 * 1024;
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
    runEventSink;
    retryController;
    workerId;
    heartbeatIntervalMs;
    maxAgentTurns;
    maxAgentToolExecutions;
    maxSessionHistoryMessages;
    maxSessionHistoryPayloadBytes;
    createAgent;
    heartbeatTimer;
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
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.maxAgentTurns = options.maxAgentTurns ?? DEFAULT_MAX_AGENT_TURNS;
        this.maxAgentToolExecutions = options.maxAgentToolExecutions ?? DEFAULT_MAX_AGENT_TOOL_EXECUTIONS;
        this.maxSessionHistoryMessages = options.maxSessionHistoryMessages ?? DEFAULT_MAX_SESSION_HISTORY_MESSAGES;
        this.maxSessionHistoryPayloadBytes =
            options.maxSessionHistoryPayloadBytes ?? DEFAULT_MAX_SESSION_HISTORY_PAYLOAD_BYTES;
        this.diagnostics = options.diagnostics;
        this.goalSupervisor = options.goalSupervisor;
        this.runEventSink = options.runEventSink ?? new RunEventSink({ store: this.db, bus: new InMemoryRunEventBus() });
        const onRetryEvent = options.retry?.onRetryEvent;
        this.retryController = new RunRetryController({
            ...options.retry,
            diagnostics: options.retry?.diagnostics ?? options.diagnostics,
            onRetryEvent: async (event) => {
                try {
                    await this.persistRetryEvent(event);
                }
                catch (error) {
                    this.writeDiagnostic("worker_retry_event_persist_failed", event.run, error);
                    throw error;
                }
                await onRetryEvent?.(event);
            },
        });
    }
    async markOwnedRunningRunsInterrupted() {
        for (const run of await this.db.listRunningRunsByWorker(this.workerId)) {
            await this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
        }
    }
    async recoverOwnedRuns() {
        const recoveredCount = await this.queue.requeueActive(this.workerId);
        this.writeWorkerLifecycleDiagnostic("system.worker.recovered_active_runs", "info", {
            recoveredCount,
        });
        await this.markOwnedRunningRunsInterrupted();
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
        this.writeWorkerLifecycleDiagnostic("worker.queue.claimed", "info", {
            clientId: claimed.clientId ?? null,
            runId: claimed.runId,
        });
        if (!claimed.clientId) {
            await this.completeClaim(claimed);
            return true;
        }
        const runIdentity = { clientId: claimed.clientId, runId: claimed.runId };
        let run = await this.db.getRun(claimed.clientId, claimed.runId);
        let cancelRequested = false;
        let runGuard;
        try {
            if (!run) {
                this.writeDiscardedClaimDiagnostic(claimed, "missing_runtime_run");
                return true;
            }
            if (run.status !== "queued") {
                this.writeDiscardedClaimDiagnostic(claimed, "status_not_queued", run.status);
                return true;
            }
            const session = await this.db.getSession(run.clientId, run.sessionId);
            if (!session)
                throw new Error("Runtime session not found");
            await this.assertSessionHistoryWithinLimits(run);
            const messages = await this.db.listMessages(run.clientId, run.sessionId);
            const activeRun = await this.db.updateRunStatus(run.runId, run.clientId, "running", {
                workerId: this.workerId,
            });
            run = activeRun;
            const abortController = new AbortController();
            this.activeAbortControllers.add(abortController);
            this.activeRuns.set(activeRunKey(activeRun), activeRun);
            let activeAgent;
            runGuard = this.createRunGuard(activeRun, abortController, () => activeAgent);
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
                        let flushPromise = Promise.resolve();
                        let flushError;
                        let flushing = false;
                        let flushTargetCount = 0;
                        const flushAttemptEvents = () => {
                            if (flushing)
                                return flushPromise;
                            flushing = true;
                            const drain = () => {
                                while (persistedEventCount < flushTargetCount) {
                                    const event = attemptEvents[persistedEventCount];
                                    const persisted = this.persistAgentEvent(activeRun, event);
                                    if (isPromiseLike(persisted)) {
                                        return persisted.then(() => {
                                            persistedEventCount += 1;
                                            return drain();
                                        });
                                    }
                                    persistedEventCount += 1;
                                }
                            };
                            const finish = () => {
                                flushing = false;
                            };
                            try {
                                const drained = drain();
                                if (isPromiseLike(drained)) {
                                    flushPromise = drained.finally(finish);
                                    return flushPromise;
                                }
                                finish();
                            }
                            catch (error) {
                                finish();
                                throw error;
                            }
                        };
                        const queueFlushAttemptEvents = () => {
                            flushTargetCount = Math.max(flushTargetCount, attemptEvents.length);
                            const flushed = flushAttemptEvents();
                            if (isPromiseLike(flushed)) {
                                flushPromise = flushed.catch((error) => {
                                    flushError ??= error;
                                });
                            }
                        };
                        const flushAllAttemptEvents = async () => {
                            flushTargetCount = attemptEvents.length;
                            const flushed = flushAttemptEvents();
                            if (isPromiseLike(flushed)) {
                                await flushed;
                            }
                            await flushPromise;
                            if (flushError)
                                throw flushError;
                        };
                        try {
                            activeAgent = agent;
                            this.activeAgents.add(agent);
                            unsubscribe = agent.subscribe((event) => {
                                attemptEvents.push(event);
                                runGuard?.observe(event);
                                if (shouldFlushAttemptEvents(event) ||
                                    (persistedEventCount > 0 && !isAssistantFailureMarkerEvent(event))) {
                                    queueFlushAttemptEvents();
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
                                await flushPromise;
                                if (flushError)
                                    throw flushError;
                                if (persistedEventCount > 0 || attemptHasNonReplayableSideEffects(attemptEvents)) {
                                    await flushAllAttemptEvents();
                                    throw new NonRetryableAgentAttemptError(errorMessage(error));
                                }
                                throw error;
                            }
                            await flushPromise;
                            if (flushError)
                                throw flushError;
                            const assistantError = assistantErrorMessageFromEvents(attemptEvents);
                            if (assistantError) {
                                if (attemptHasNonReplayableSideEffects(attemptEvents)) {
                                    await flushAllAttemptEvents();
                                    throw new NonRetryableAgentAttemptError(assistantError);
                                }
                                throw new Error(assistantError);
                            }
                            await flushAllAttemptEvents();
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
                const current = await this.db.getRun(activeRun.clientId, activeRun.runId);
                if (current && isTerminalStatus(current.status)) {
                    return true;
                }
                if (this.stopping) {
                    await this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "interrupted");
                }
                else if (cancelRequested || (await this.safeIsCancelRequested(activeRun))) {
                    await this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "cancelled");
                }
                else if (runGuard.failure) {
                    await this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "failed", {
                        error: runGuard.failure.message,
                    });
                }
                else {
                    await this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "completed");
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
                const current = await this.db.getRun(run.clientId, run.runId);
                if (current && isTerminalStatus(current.status)) {
                    return true;
                }
                if (cancelRequested || (await this.safeIsCancelRequested(run))) {
                    await this.db.updateRunStatus(run.runId, run.clientId, "cancelled");
                }
                else if (this.stopping || isQueueClosedError(error)) {
                    await this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
                }
                else if (runGuard?.failure) {
                    await this.db.updateRunStatus(run.runId, run.clientId, "failed", {
                        error: runGuard.failure.message,
                    });
                }
                else {
                    await this.db.updateRunStatus(run.runId, run.clientId, "failed", { error: errorMessage(error) });
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
        try {
            await this.recoverOwnedRuns();
            this.running = true;
            this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
            this.startHeartbeat();
            this.writeWorkerLifecycleDiagnostic("system.worker.started", "info", {
                concurrency: this.concurrency,
            });
        }
        catch (error) {
            this.running = false;
            this.loops = [];
            this.writeWorkerLifecycleDiagnostic("system.worker.service_start_failed", "error", {
                message: errorMessage(error),
                hint: "The worker service failed during startup recovery or run-loop initialization.",
            });
            throw error;
        }
    }
    async stop() {
        this.stopping = true;
        this.running = false;
        this.stopHeartbeat();
        for (const run of this.activeRuns.values()) {
            const current = await this.db.getRun(run.clientId, run.runId);
            if (current?.status === "running" || current?.status === "cancelling") {
                await this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
            }
        }
        await this.markOwnedRunningRunsInterrupted();
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
        const current = await this.db.getRun(run.clientId, run.runId);
        if (!current || !isTerminalStatus(current.status))
            return;
        try {
            await this.goalSupervisor?.afterRunTerminal(current);
        }
        catch (error) {
            this.writeDiagnostic("worker_goal_supervisor_failed", current, error);
        }
    }
    persistAgentEvent(run, event) {
        return this.runEventSink.persistAgentEvent(run, event);
    }
    persistRetryEvent(event) {
        if (event.eventType !== "retry_scheduled")
            return;
        const type = "agent_retry_scheduled";
        return this.runEventSink.persistAgentEvent(event.run, {
            type,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            reasonCode: event.reasonCode,
            message: event.message,
            ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
        });
    }
    async pollCancellation(run, agent, abortController, onCancel) {
        if (!(await this.queue.isCancelRequested(run)))
            return;
        onCancel();
        abortController.abort();
        agent?.abort();
        const current = await this.db.getRun(run.clientId, run.runId);
        if (current?.status === "running") {
            await this.db.updateRunStatus(run.runId, run.clientId, "cancelling");
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
        this.writeDiagnosticEvents([
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
        ]);
    }
    writeQueueDiagnostic(eventType, error) {
        const now = Date.now();
        if (now - this.lastQueueErrorDiagnosticAt < QUEUE_ERROR_DIAGNOSTIC_THROTTLE_MS) {
            return;
        }
        this.lastQueueErrorDiagnosticAt = now;
        this.writeDiagnosticEvents([
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
        ]);
    }
    writeDiscardedClaimDiagnostic(claimed, reason, status) {
        this.writeWorkerLifecycleDiagnostic("worker.queue.discarded_claim", "warn", {
            clientId: claimed.clientId ?? null,
            runId: claimed.runId,
            reason,
            ...(status ? { status } : {}),
        });
    }
    async assertSessionHistoryWithinLimits(run) {
        const stats = await this.db.getSessionMessageStats(run.clientId, run.sessionId);
        const tooManyMessages = stats.messageCount > this.maxSessionHistoryMessages;
        const tooManyPayloadBytes = stats.totalPayloadBytes > this.maxSessionHistoryPayloadBytes;
        if (!tooManyMessages && !tooManyPayloadBytes)
            return;
        this.writeDiagnosticEvents([
            {
                eventType: "worker_session_history_too_large",
                level: "error",
                category: "agent",
                sessionId: run.sessionId,
                traceId: run.sessionId,
                data: {
                    clientId: run.clientId,
                    runId: run.runId,
                    workerId: this.workerId,
                    messageCount: stats.messageCount,
                    totalPayloadBytes: stats.totalPayloadBytes,
                    largestPayloadBytes: stats.largestPayloadBytes,
                    maxMessages: this.maxSessionHistoryMessages,
                    maxPayloadBytes: this.maxSessionHistoryPayloadBytes,
                },
            },
        ]);
        throw new Error(`Session history is too large to load safely: ${stats.messageCount} messages, ${stats.totalPayloadBytes} payload bytes.`);
    }
    createRunGuard(run, abortController, activeAgent) {
        let turns = 0;
        let toolExecutions = 0;
        let failure;
        const fail = (nextFailure) => {
            if (failure)
                return;
            failure = nextFailure;
            this.writeDiagnosticEvents([
                {
                    level: "error",
                    category: "agent",
                    eventType: "worker.run_guard_limit_exceeded",
                    sessionId: run.sessionId,
                    traceId: run.sessionId,
                    data: {
                        clientId: run.clientId,
                        sessionId: run.sessionId,
                        runId: run.runId,
                        workerId: this.workerId,
                        limit: nextFailure.limit,
                        max: nextFailure.max,
                        observed: nextFailure.observed,
                        message: nextFailure.message,
                    },
                },
            ]);
            activeAgent()?.abort();
            abortController.abort();
        };
        return {
            get failure() {
                return failure;
            },
            observe: (event) => {
                if (failure)
                    return;
                if (event.type === "turn_end") {
                    turns += 1;
                    if (this.maxAgentTurns > 0 && turns > this.maxAgentTurns) {
                        fail({
                            limit: "max_agent_turns",
                            max: this.maxAgentTurns,
                            observed: turns,
                            message: `Run guard exceeded max agent turns (${turns} > ${this.maxAgentTurns}).`,
                        });
                    }
                }
                if (event.type === "tool_execution_start") {
                    toolExecutions += 1;
                    if (this.maxAgentToolExecutions > 0 && toolExecutions > this.maxAgentToolExecutions) {
                        fail({
                            limit: "max_agent_tool_executions",
                            max: this.maxAgentToolExecutions,
                            observed: toolExecutions,
                            message: `Run guard exceeded max agent tool executions (${toolExecutions} > ${this.maxAgentToolExecutions}).`,
                        });
                    }
                }
            },
        };
    }
    writeWorkerLifecycleDiagnostic(eventType, level, data) {
        this.writeDiagnosticEvents([
            {
                eventType,
                level,
                category: "system",
                data: {
                    workerId: this.workerId,
                    ...data,
                },
            },
        ]);
    }
    writeDiagnosticEvents(events) {
        try {
            this.diagnostics?.writeEvents({ events });
        }
        catch {
            // Diagnostics must not interrupt worker run processing.
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        if (this.heartbeatIntervalMs <= 0)
            return;
        this.heartbeatTimer = setInterval(() => {
            this.writeWorkerLifecycleDiagnostic("system.worker.heartbeat", "info", {
                concurrency: this.concurrency,
                activeRuns: this.activeRuns.size,
            });
        }, this.heartbeatIntervalMs);
    }
    stopHeartbeat() {
        if (!this.heartbeatTimer)
            return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isPromiseLike(value) {
    return typeof value?.then === "function";
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=run-worker-service.js.map