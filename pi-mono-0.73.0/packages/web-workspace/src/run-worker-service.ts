import type { ClaimedRun, RunQueue, RunQueueIdentity } from "./run-queue.js";
import {
	RunRetryController,
	type RunRetryControllerEvent,
	type RunRetryControllerOptions,
} from "./run-retry-controller.js";
import type { RuntimeDbStore } from "./runtime-db.js";
import type { JsonObject, RunStatus, RuntimeMessageRecord, RuntimeRunRecord, WorkerAgentInput } from "./types.js";

const DEFAULT_CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_TIMEOUT_MS = 0;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_SLEEP_MS = 100;
const DEFAULT_MAX_SESSION_HISTORY_MESSAGES = 2000;
const DEFAULT_MAX_SESSION_HISTORY_PAYLOAD_BYTES = 64 * 1024 * 1024;
const QUEUE_ERROR_DIAGNOSTIC_THROTTLE_MS = 5000;
const APP_PREVIEW_CONTINUATION_INTERNAL_MARKER = { kind: "app_preview_continuation" };
const ASSISTANT_TAIL_CONTINUATION_PROMPT =
	"Continue from the previous assistant response and complete the original request. Do not repeat completed work; inspect the current project state before making further changes when needed.";

type WorkerDiagnosticLevel = "info" | "warn" | "error";

export interface WorkerAgentEvent extends JsonObject {
	type: string;
	message?: JsonObject;
	messages?: JsonObject[];
}

export interface WorkerAgent {
	subscribe(listener: (event: WorkerAgentEvent) => void): (() => void) | undefined;
	prompt(message: RuntimeMessageRecord | RuntimeMessageRecord[]): Promise<void> | void;
	continue(): Promise<void> | void;
	abort(): void;
	waitForIdle?(): Promise<void> | void;
}

export interface WorkspaceRunWorkerServiceOptions {
	db: RuntimeDbStore;
	queue: RunQueue;
	workerId: string;
	concurrency?: number;
	createAgent(input: WorkerAgentInput): WorkerAgent;
	diagnostics?: RunWorkerDiagnostics;
	goalSupervisor?: { afterRunTerminal(run: RuntimeRunRecord): Promise<void> | void };
	retry?: RunRetryControllerOptions;
	cancelPollIntervalMs?: number;
	claimTimeoutMs?: number;
	heartbeatIntervalMs?: number;
	maxSessionHistoryMessages?: number;
	maxSessionHistoryPayloadBytes?: number;
}

export interface RunWorkerDiagnostics {
	writeEvents(input: { events: JsonObject[] }): JsonObject;
}

export class WorkspaceRunWorkerService {
	private readonly activeAgents = new Set<WorkerAgent>();
	private readonly activeAbortControllers = new Set<AbortController>();
	private readonly activeRuns = new Map<string, RuntimeRunRecord>();
	private readonly cancelPollIntervalMs: number;
	private readonly claimTimeoutMs: number;
	private readonly concurrency: number;
	private readonly db: RuntimeDbStore;
	private readonly diagnostics: RunWorkerDiagnostics | undefined;
	private readonly goalSupervisor: WorkspaceRunWorkerServiceOptions["goalSupervisor"];
	private readonly queue: RunQueue;
	private readonly retryController: RunRetryController;
	private readonly workerId: string;
	private readonly heartbeatIntervalMs: number;
	private readonly maxSessionHistoryMessages: number;
	private readonly maxSessionHistoryPayloadBytes: number;
	private readonly createAgent: (input: WorkerAgentInput) => WorkerAgent;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private loops: Array<Promise<void>> = [];
	private lastQueueErrorDiagnosticAt = 0;
	private running = false;
	private stopping = false;

	constructor(options: WorkspaceRunWorkerServiceOptions) {
		this.db = options.db;
		this.queue = options.queue;
		this.workerId = options.workerId;
		this.concurrency = options.concurrency ?? 1;
		this.createAgent = options.createAgent;
		this.cancelPollIntervalMs = options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
		this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.maxSessionHistoryMessages = options.maxSessionHistoryMessages ?? DEFAULT_MAX_SESSION_HISTORY_MESSAGES;
		this.maxSessionHistoryPayloadBytes =
			options.maxSessionHistoryPayloadBytes ?? DEFAULT_MAX_SESSION_HISTORY_PAYLOAD_BYTES;
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

	markOwnedRunningRunsInterrupted(): void {
		for (const run of this.db.listRunningRunsByWorker(this.workerId)) {
			this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
		}
	}

	async recoverOwnedRuns(): Promise<void> {
		const recoveredCount = await this.queue.requeueActive(this.workerId);
		this.writeWorkerLifecycleDiagnostic("system.worker.recovered_active_runs", "info", {
			recoveredCount,
		});
		this.markOwnedRunningRunsInterrupted();
	}

	async processOne(): Promise<boolean> {
		let claimed: ClaimedRun | undefined;
		try {
			claimed = await this.queue.claim(this.workerId, this.claimTimeoutMs);
		} catch (error) {
			if (this.stopping && isQueueClosedError(error)) return false;
			throw error;
		}
		if (!claimed) return false;
		this.writeWorkerLifecycleDiagnostic("worker.queue.claimed", "info", {
			clientId: claimed.clientId ?? null,
			runId: claimed.runId,
		});
		if (!claimed.clientId) {
			await this.completeClaim(claimed);
			return true;
		}

		const runIdentity = { clientId: claimed.clientId, runId: claimed.runId };
		const messageEndKeys = new Set<string>();
		let run = this.db.getRun(claimed.clientId, claimed.runId);
		let cancelRequested = false;
		try {
			if (!run) {
				this.writeDiscardedClaimDiagnostic(claimed, "missing_runtime_run");
				return true;
			}
			if (run.status !== "queued") {
				this.writeDiscardedClaimDiagnostic(claimed, "status_not_queued", run.status);
				return true;
			}

			const session = this.db.getSession(run.clientId, run.sessionId);
			if (!session) throw new Error("Runtime session not found");
			this.assertSessionHistoryWithinLimits(run);
			const messages = this.db.listMessages(run.clientId, run.sessionId);
			const activeRun = this.db.updateRunStatus(run.runId, run.clientId, "running", { workerId: this.workerId });
			run = activeRun;

			const abortController = new AbortController();
			this.activeAbortControllers.add(abortController);
			this.activeRuns.set(activeRunKey(activeRun), activeRun);

			let activeAgent: WorkerAgent | undefined;
			const cancelPoll = setInterval(() => {
				void this.pollCancellation(activeRun, activeAgent, abortController, () => {
					cancelRequested = true;
				}).catch((error) => {
					if (this.stopping && isQueueClosedError(error)) return;
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
						const attemptEvents: WorkerAgentEvent[] = [];
						let persistedEventCount = 0;
						let unsubscribe: (() => void) | undefined;
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
								if (
									shouldFlushAttemptEvents(event) ||
									(persistedEventCount > 0 && !isAssistantFailureMarkerEvent(event))
								) {
									flushAttemptEvents();
								}
							});
							const tailMessage = messages.at(-1);
							try {
								if (tailMessage && isUserPromptRole(tailMessage.role)) {
									await agent.prompt(tailMessage);
								} else if (tailMessage?.role === "assistant") {
									await agent.prompt(createAssistantTailContinuationPrompt(activeRun));
								} else {
									await agent.continue();
								}
								await agent.waitForIdle?.();
							} catch (error) {
								if (persistedEventCount > 0) {
									flushAttemptEvents();
									throw new NonRetryableAgentAttemptError(errorMessage(error));
								}
								throw error;
							}
							const assistantError = assistantErrorMessageFromEvents(attemptEvents);
							if (assistantError) {
								if (attemptHasNonReplayableSideEffects(attemptEvents)) {
									flushAttemptEvents();
									throw new NonRetryableAgentAttemptError(assistantError);
								}
								throw new Error(assistantError);
							}
							flushAttemptEvents();
						} finally {
							if (unsubscribe) unsubscribe();
							this.activeAgents.delete(agent);
							if (activeAgent === agent) activeAgent = undefined;
						}
					},
				});
				const current = this.db.getRun(activeRun.clientId, activeRun.runId);
				if (current && isTerminalStatus(current.status)) {
					return true;
				}
				if (this.stopping) {
					this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "interrupted");
				} else if (cancelRequested || (await this.safeIsCancelRequested(activeRun))) {
					this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "cancelled");
				} else {
					this.db.updateRunStatus(activeRun.runId, activeRun.clientId, "completed");
				}
			} finally {
				clearInterval(cancelPoll);
				this.activeAbortControllers.delete(abortController);
				this.activeRuns.delete(activeRunKey(activeRun));
			}
			return true;
		} catch (error) {
			if (run) {
				const current = this.db.getRun(run.clientId, run.runId);
				if (current && isTerminalStatus(current.status)) {
					return true;
				}
				if (cancelRequested || (await this.safeIsCancelRequested(run))) {
					this.db.updateRunStatus(run.runId, run.clientId, "cancelled");
				} else if (this.stopping || isQueueClosedError(error)) {
					this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
				} else {
					this.db.updateRunStatus(run.runId, run.clientId, "failed", { error: errorMessage(error) });
					this.writeDiagnostic("worker_run_failed", run, error);
				}
			}
			return true;
		} finally {
			if (run) await this.notifyGoalSupervisor(run);
			await this.completeClaim(runIdentity);
		}
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopping = false;
		try {
			await this.recoverOwnedRuns();
			this.running = true;
			this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
			this.startHeartbeat();
			this.writeWorkerLifecycleDiagnostic("system.worker.started", "info", {
				concurrency: this.concurrency,
			});
		} catch (error) {
			this.running = false;
			this.loops = [];
			this.writeWorkerLifecycleDiagnostic("system.worker.service_start_failed", "error", {
				message: errorMessage(error),
				hint: "The worker service failed during startup recovery or run-loop initialization.",
			});
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.running = false;
		this.stopHeartbeat();
		for (const run of this.activeRuns.values()) {
			const current = this.db.getRun(run.clientId, run.runId);
			if (current?.status === "running" || current?.status === "cancelling") {
				this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
			}
		}
		this.markOwnedRunningRunsInterrupted();
		for (const abortController of this.activeAbortControllers) abortController.abort();
		for (const agent of this.activeAgents) agent.abort();
		await this.queue.close();
		await Promise.all(this.loops);
		this.loops = [];
	}

	private async completeClaim(run: RunQueueIdentity | ClaimedRun): Promise<void> {
		try {
			await this.queue.complete(run, this.workerId);
		} catch (error) {
			if (this.stopping && isQueueClosedError(error)) return;
			throw error;
		}
	}

	private async notifyGoalSupervisor(run: RuntimeRunRecord): Promise<void> {
		const current = this.db.getRun(run.clientId, run.runId);
		if (!current || !isTerminalStatus(current.status)) return;
		try {
			await this.goalSupervisor?.afterRunTerminal(current);
		} catch (error) {
			this.writeDiagnostic("worker_goal_supervisor_failed", current, error);
		}
	}

	private persistAgentEvent(run: RuntimeRunRecord, event: WorkerAgentEvent, messageEndKeys: Set<string>): void {
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

	private persistRetryEvent(event: RunRetryControllerEvent): void {
		if (event.eventType !== "retry_scheduled") return;
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
				message: event.message,
				...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
			},
		});
	}

	private shouldAppendMessage(message: RuntimeMessageRecord, messageEndKeys: Set<string>): boolean {
		if (isUserPromptRole(message.role)) return false;
		const key = messageKey(message);
		if (messageEndKeys.has(key)) return false;
		messageEndKeys.add(key);
		return true;
	}

	private async pollCancellation(
		run: RuntimeRunRecord,
		agent: WorkerAgent | undefined,
		abortController: AbortController,
		onCancel: () => void,
	): Promise<void> {
		if (!(await this.queue.isCancelRequested(run))) return;
		onCancel();
		abortController.abort();
		agent?.abort();
		const current = this.db.getRun(run.clientId, run.runId);
		if (current?.status === "running") {
			this.db.updateRunStatus(run.runId, run.clientId, "cancelling");
		}
	}

	private async runLoop(): Promise<void> {
		while (this.running) {
			try {
				const processed = await this.processOne();
				if (!processed) await sleep(DEFAULT_IDLE_SLEEP_MS);
			} catch (error) {
				if (this.stopping && isQueueClosedError(error)) return;
				this.writeQueueDiagnostic("worker.queue.claim.error", error);
				await sleep(DEFAULT_IDLE_SLEEP_MS);
			}
		}
	}

	private async safeIsCancelRequested(run: RunQueueIdentity): Promise<boolean> {
		try {
			return await this.queue.isCancelRequested(run);
		} catch (error) {
			if (this.stopping && isQueueClosedError(error)) return false;
			throw error;
		}
	}

	private writeDiagnostic(eventType: string, run: RuntimeRunRecord, error: unknown): void {
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

	private writeQueueDiagnostic(eventType: string, error: unknown): void {
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

	private writeDiscardedClaimDiagnostic(claimed: ClaimedRun, reason: string, status?: string): void {
		this.writeWorkerLifecycleDiagnostic("worker.queue.discarded_claim", "warn", {
			clientId: claimed.clientId ?? null,
			runId: claimed.runId,
			reason,
			...(status ? { status } : {}),
		});
	}

	private assertSessionHistoryWithinLimits(run: RuntimeRunRecord): void {
		const stats = this.db.getSessionMessageStats(run.clientId, run.sessionId);
		const tooManyMessages = stats.messageCount > this.maxSessionHistoryMessages;
		const tooManyPayloadBytes = stats.totalPayloadBytes > this.maxSessionHistoryPayloadBytes;
		if (!tooManyMessages && !tooManyPayloadBytes) return;

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
		throw new Error(
			`Session history is too large to load safely: ${stats.messageCount} messages, ${stats.totalPayloadBytes} payload bytes.`,
		);
	}

	private writeWorkerLifecycleDiagnostic(eventType: string, level: WorkerDiagnosticLevel, data: JsonObject): void {
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

	private writeDiagnosticEvents(events: JsonObject[]): void {
		try {
			this.diagnostics?.writeEvents({ events });
		} catch {
			// Diagnostics must not interrupt worker run processing.
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		if (this.heartbeatIntervalMs <= 0) return;
		this.heartbeatTimer = setInterval(() => {
			this.writeWorkerLifecycleDiagnostic("system.worker.heartbeat", "info", {
				concurrency: this.concurrency,
				activeRuns: this.activeRuns.size,
			});
		}, this.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (!this.heartbeatTimer) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}
}

class NonRetryableAgentAttemptError extends Error {
	readonly code = "PI_NON_RETRYABLE";
	readonly retryable = false;

	constructor(assistantError: string) {
		super(`Agent attempt failed after non-replayable side effects: ${assistantError}`);
		this.name = "NonRetryableAgentAttemptError";
	}
}

function activeRunKey(run: RunQueueIdentity): string {
	return JSON.stringify([run.clientId, run.runId]);
}

function isQueueClosedError(error: unknown): boolean {
	return error instanceof Error && error.message === "Run queue is closed";
}

function isTerminalStatus(status: RunStatus): boolean {
	return status === "cancelled" || status === "completed" || status === "failed" || status === "interrupted";
}

function isUserPromptRole(role: string): boolean {
	return role === "user" || role === "user-with-attachments";
}

function createAssistantTailContinuationPrompt(run: RuntimeRunRecord): RuntimeMessageRecord {
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

function attemptHasNonReplayableSideEffects(events: WorkerAgentEvent[]): boolean {
	for (const event of events) {
		if (event.type.startsWith("tool_execution_")) return true;
		if (event.type === "message_end" && isNonReplayableSideEffectMessage(event.message)) return true;
		if (event.messages?.some((message) => isNonReplayableSideEffectMessage(message))) return true;
	}
	return false;
}

function shouldFlushAttemptEvents(event: WorkerAgentEvent): boolean {
	if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
		return !isAssistantFailureMarkerEvent(event) && !isReplayablePromptEvent(event);
	}
	if (event.type.startsWith("tool_execution_")) return true;
	if (event.type === "agent_end") return !event.messages?.some((message) => isAssistantFailureMarker(message));
	return false;
}

function isReplayablePromptEvent(event: WorkerAgentEvent): boolean {
	return isReplayablePromptMessage(event.message);
}

function isReplayablePromptMessage(message: JsonObject | undefined): boolean {
	const role = typeof message?.role === "string" ? message.role : undefined;
	return role ? isUserPromptRole(role) : false;
}

function isAssistantFailureMarkerEvent(event: WorkerAgentEvent): boolean {
	if (isAssistantFailureMarker(event.message)) return true;
	return event.messages?.some((message) => isAssistantFailureMarker(message)) ?? false;
}

function isNonReplayableSideEffectMessage(message: JsonObject | undefined): boolean {
	if (!message) return false;
	const role = typeof message?.role === "string" ? message.role : undefined;
	if (!role) return false;
	if (role === "user" || role === "user-with-attachments") return false;
	if (role === "toolResult") return true;
	if (role === "assistant") return !isAssistantFailureMarker(message);
	return true;
}

function isAssistantFailureMarker(message: JsonObject | undefined): boolean {
	if (!message) return false;
	if (assistantErrorMessageFromMessage(message)) return true;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return stopReason === "error";
}

function assistantErrorMessageFromEvents(events: WorkerAgentEvent[]): string | undefined {
	for (const event of events) {
		const messageError = assistantErrorMessageFromMessage(event.message);
		if (messageError) return messageError;
		for (const message of event.messages ?? []) {
			const listMessageError = assistantErrorMessageFromMessage(message);
			if (listMessageError) return listMessageError;
		}
	}
	return undefined;
}

function assistantErrorMessageFromMessage(message: JsonObject | undefined): string | undefined {
	if (!message) return undefined;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (role && role !== "assistant") return undefined;
	const errorMessage = message.errorMessage;
	if (typeof errorMessage === "string" && errorMessage.length > 0) return errorMessage;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return stopReason === "error" ? "assistant stopped with error" : undefined;
}

function messageKey(message: RuntimeMessageRecord): string {
	return JSON.stringify([message.role, message.payload]);
}

function runtimeMessageFromEvent(
	run: RuntimeRunRecord,
	message: JsonObject | undefined,
): RuntimeMessageRecord | undefined {
	if (!message) return undefined;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (!role) return undefined;
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

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
