import type { ClaimedRun, RunQueue, RunQueueIdentity } from "./run-queue.js";
import type { RuntimeDbStore } from "./runtime-db.js";
import type { JsonObject, RunStatus, RuntimeMessageRecord, RuntimeRunRecord, WorkerAgentInput } from "./types.js";

const DEFAULT_CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_TIMEOUT_MS = 0;
const DEFAULT_IDLE_SLEEP_MS = 100;
const QUEUE_ERROR_DIAGNOSTIC_THROTTLE_MS = 5000;

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
	cancelPollIntervalMs?: number;
	claimTimeoutMs?: number;
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
	private readonly queue: RunQueue;
	private readonly workerId: string;
	private readonly createAgent: (input: WorkerAgentInput) => WorkerAgent;
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
		this.diagnostics = options.diagnostics;
	}

	markOwnedRunningRunsInterrupted(): void {
		for (const run of this.db.listRunningRunsByWorker(this.workerId)) {
			this.db.updateRunStatus(run.runId, run.clientId, "interrupted");
		}
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
		if (!claimed.clientId) {
			await this.completeClaim(claimed);
			return true;
		}

		const runIdentity = { clientId: claimed.clientId, runId: claimed.runId };
		const messageEndKeys = new Set<string>();
		let run = this.db.getRun(claimed.clientId, claimed.runId);
		let cancelRequested = false;
		try {
			if (!run || run.status !== "queued") return true;

			const session = this.db.getSession(run.clientId, run.sessionId);
			if (!session) throw new Error("Runtime session not found");
			const messages = this.db.listMessages(run.clientId, run.sessionId);
			const activeRun = this.db.updateRunStatus(run.runId, run.clientId, "running", { workerId: this.workerId });
			run = activeRun;

			const abortController = new AbortController();
			const agent = this.createAgent({
				run: activeRun,
				session,
				messages,
				model: activeRun.model,
				thinkingLevel: activeRun.thinkingLevel,
				signal: abortController.signal,
			});
			this.activeAgents.add(agent);
			this.activeAbortControllers.add(abortController);
			this.activeRuns.set(activeRunKey(activeRun), activeRun);

			const unsubscribe = agent.subscribe((event) => {
				this.persistAgentEvent(activeRun, event, messageEndKeys);
			});
			const cancelPoll = setInterval(() => {
				void this.pollCancellation(activeRun, agent, abortController, () => {
					cancelRequested = true;
				}).catch((error) => {
					if (this.stopping && isQueueClosedError(error)) return;
					this.writeDiagnostic("worker_cancel_poll_failed", activeRun, error);
				});
			}, this.cancelPollIntervalMs);

			try {
				const tailMessage = messages.at(-1);
				if (tailMessage && isUserPromptRole(tailMessage.role)) {
					await agent.prompt(tailMessage);
				} else {
					await agent.continue();
				}
				await agent.waitForIdle?.();
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
				if (unsubscribe) unsubscribe();
				this.activeAgents.delete(agent);
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
			await this.completeClaim(runIdentity);
		}
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopping = false;
		this.running = true;
		this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.running = false;
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

	private shouldAppendMessage(message: RuntimeMessageRecord, messageEndKeys: Set<string>): boolean {
		if (isUserPromptRole(message.role)) return false;
		const key = messageKey(message);
		if (messageEndKeys.has(key)) return false;
		messageEndKeys.add(key);
		return true;
	}

	private async pollCancellation(
		run: RuntimeRunRecord,
		agent: WorkerAgent,
		abortController: AbortController,
		onCancel: () => void,
	): Promise<void> {
		if (!(await this.queue.isCancelRequested(run))) return;
		onCancel();
		abortController.abort();
		agent.abort();
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

	private writeQueueDiagnostic(eventType: string, error: unknown): void {
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
