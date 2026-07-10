import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2ExecutionStepResult } from "./agent-v2-execution-core.js";
import type { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import type { AgentV2RunQueue, AgentV2RunQueueIdentity } from "./agent-v2-run-queue.js";
import type { AgentV2WorkerStore } from "./agent-v2-runtime-store.js";
import type { AgentV2RunUpdateResult } from "./agent-v2-store.js";
import type { AgentV2Phase, AgentV2RunSnapshot, AgentV2RunStatus } from "./agent-v2-types.js";

const DEFAULT_CLAIM_TIMEOUT_MS = 250;
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 50;
const DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_SLEEP_MS = 25;
const DEFAULT_MAX_IDLE_SLEEP_MS = 1_000;
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_STEPS_PER_RUN = 256;

export type { AgentV2WorkerStore } from "./agent-v2-runtime-store.js";

export interface AgentV2WorkerExecutionInput {
	store: AgentV2WorkerStore;
	run: AgentV2RunSnapshot;
	workerId: string;
	signal: AbortSignal;
}

export interface AgentV2WorkerExecution {
	executeNextTask(input: AgentV2WorkerExecutionInput): Promise<AgentV2ExecutionStepResult>;
}

export interface AgentV2WorkerServiceOptions {
	store: AgentV2WorkerStore;
	queue: AgentV2RunQueue;
	events: Pick<AgentV2RunEventLog, "append">;
	execution: AgentV2WorkerExecution;
	workerId: string;
	now?: () => string;
	concurrency?: number;
	claimTimeoutMs?: number;
	cancelPollIntervalMs?: number;
	expiredClaimRecoveryIntervalMs?: number;
	idleSleepMs?: number;
	maxIdleSleepMs?: number;
	leaseHeartbeatIntervalMs?: number;
	maxStepsPerRun?: number;
}

type AgentV2RunTransitionResult = AgentV2RunUpdateResult;

export class AgentV2WorkerService {
	private readonly activeAbortControllers = new Map<string, AbortController>();
	private readonly activeProcessOneCalls = new Set<Promise<void>>();
	private readonly cancelPollIntervalMs: number;
	private readonly claimTimeoutMs: number;
	private readonly concurrency: number;
	private readonly events: Pick<AgentV2RunEventLog, "append">;
	private readonly execution: AgentV2WorkerExecution;
	private readonly expiredClaimRecoveryIntervalMs: number;
	private readonly idleSleepMs: number;
	private readonly leaseHeartbeatIntervalMs: number;
	private loops: Array<Promise<void>> = [];
	private maintenanceAbortController: AbortController | undefined;
	private maintenanceLoop: Promise<void> | undefined;
	private readonly maxStepsPerRun: number;
	private readonly maxIdleSleepMs: number;
	private readonly now: () => string;
	private readonly queue: AgentV2RunQueue;
	private running = false;
	private readonly store: AgentV2WorkerStore;
	private stopping = false;
	private readonly workerId: string;

	constructor(options: AgentV2WorkerServiceOptions) {
		this.store = options.store;
		this.queue = options.queue;
		this.events = options.events;
		this.execution = options.execution;
		this.workerId = options.workerId;
		this.now = options.now ?? (() => new Date().toISOString());
		this.concurrency = options.concurrency ?? 1;
		this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
		this.cancelPollIntervalMs = options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
		this.expiredClaimRecoveryIntervalMs = Math.max(
			1,
			options.expiredClaimRecoveryIntervalMs ?? DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS,
		);
		this.idleSleepMs = options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
		this.maxIdleSleepMs = Math.max(this.idleSleepMs, options.maxIdleSleepMs ?? DEFAULT_MAX_IDLE_SLEEP_MS);
		this.leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS;
		this.maxStepsPerRun = options.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopping = false;
		await this.recoverOwnedRuns();
		this.running = true;
		this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
		this.maintenanceAbortController = new AbortController();
		this.maintenanceLoop = this.runExpiredClaimMaintenance(this.maintenanceAbortController.signal);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.running = false;
		this.maintenanceAbortController?.abort();
		for (const controller of this.activeAbortControllers.values()) {
			controller.abort();
		}
		await Promise.all([...this.loops, ...(this.maintenanceLoop ? [this.maintenanceLoop] : [])]);
		await this.waitForActiveProcessOneCalls();
		await this.markOwnedRunsInterrupted();
		await this.queue.close();
		this.loops = [];
		this.maintenanceAbortController = undefined;
		this.maintenanceLoop = undefined;
	}

	async processOne(): Promise<boolean> {
		if (this.stopping) return false;
		const processing = this.processOneInternal();
		const tracked = processing.then(
			() => undefined,
			() => undefined,
		);
		this.activeProcessOneCalls.add(tracked);
		try {
			return await processing;
		} finally {
			this.activeProcessOneCalls.delete(tracked);
		}
	}

	private async processOneInternal(): Promise<boolean> {
		const claimed = await this.queue.claim(this.workerId, this.claimTimeoutMs);
		if (!claimed) return false;

		try {
			const run = await this.store.getAgentV2Run(claimed.clientId, claimed.runId);
			if (!run) return true;
			if (isTerminalRun(run.status) || run.status !== "queued") return true;

			const running = await this.transitionRun(run, {
				status: "running",
				workerId: this.workerId,
				startedAt: run.startedAt ?? this.now(),
				expectedStatuses: ["queued"],
			});
			if (!running.applied) return true;
			await this.appendPhaseEvent(running.run, "running");
			await this.executeClaimedRun(running.run);
			return true;
		} finally {
			await this.queue.complete(claimed, this.workerId);
		}
	}

	async recoverOwnedRuns(): Promise<void> {
		await this.queue.requeueActive(this.workerId);
		await this.markOwnedRunsInterrupted();
		await this.recoverExpiredClaims();
	}

	private async appendDiagnostic(run: AgentV2RunSnapshot, code: string, message: string): Promise<void> {
		const diagnostic = createAgentV2DiagnosticEvent({
			diagnosticId: `${code}:${run.runId}:${randomUUID()}`,
			clientId: run.clientId,
			runId: run.runId,
			severity: "error",
			category: "worker",
			code,
			phase: run.phase,
			message,
			data: {
				status: run.status,
				workerId: this.workerId,
			},
			createdAt: this.now(),
		});
		await this.store.appendAgentV2Diagnostic(diagnostic);
		await this.events.append({
			clientId: run.clientId,
			runId: run.runId,
			type: "agent_v2.diagnostic_recorded",
			payload: {
				type: "agent_v2.diagnostic_recorded",
				diagnosticId: diagnostic.diagnosticId,
				severity: diagnostic.severity,
				code: diagnostic.code,
				message: diagnostic.message,
				at: diagnostic.createdAt,
			},
			createdAt: diagnostic.createdAt,
		});
	}

	private async appendPhaseEvent(run: AgentV2RunSnapshot, status: AgentV2RunStatus): Promise<void> {
		await this.events.append({
			clientId: run.clientId,
			runId: run.runId,
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: run.phase,
				status,
				attempt: run.attempt,
				at: run.updatedAt,
			},
			createdAt: run.updatedAt,
		});
	}

	private async cancelRun(run: AgentV2RunSnapshot): Promise<void> {
		if (run.status !== "running" && run.status !== "cancelling") return;
		const cancelled = await this.transitionRun(run, {
			status: "cancelled",
			phase: "cancelled",
			endedAt: this.now(),
			error: undefined,
			expectedStatuses: ["running", "cancelling"],
		});
		if (!cancelled.applied) return;
		await this.appendPhaseEvent(cancelled.run, cancelled.run.status);
	}

	private async cancelRequestedRun(run: AgentV2RunSnapshot): Promise<void> {
		let current = run;
		if (current.status === "running") {
			const cancelling = await this.transitionRun(current, {
				status: "cancelling",
				expectedStatuses: ["running"],
			});
			current = cancelling.run;
			if (cancelling.applied) {
				await this.appendPhaseEvent(current, current.status);
			}
		}
		await this.cancelRun(current);
	}

	private async executeClaimedRun(initialRun: AgentV2RunSnapshot): Promise<void> {
		const key = runKey(initialRun);
		const abortController = new AbortController();
		this.activeAbortControllers.set(key, abortController);

		let current = initialRun;
		let cancelRequested = false;
		let leaseLost = false;
		const cancelPoll = setInterval(() => {
			void this.pollCancellation(current, abortController).then((wasRequested) => {
				cancelRequested ||= wasRequested;
			});
		}, this.cancelPollIntervalMs);
		const leaseHeartbeat = setInterval(() => {
			void this.queue
				.renewLease({ clientId: initialRun.clientId, runId: initialRun.runId }, this.workerId)
				.then((refreshed) => {
					if (refreshed || leaseLost) return;
					leaseLost = true;
					abortController.abort();
				});
		}, this.leaseHeartbeatIntervalMs);

		try {
			for (let steps = 0; steps < this.maxStepsPerRun; steps += 1) {
				if (this.stopping) {
					await this.interruptRun(current);
					return;
				}
				current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
				if (isTerminalRun(current.status)) return;
				if (leaseLost) {
					await this.interruptRun(current);
					return;
				}
				if (current.status === "cancelling") {
					await this.cancelRun(current);
					return;
				}
				cancelRequested ||= await this.pollCancellation(current, abortController);
				if (cancelRequested) {
					current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
					if (isTerminalRun(current.status)) return;
					if (this.stopping) {
						await this.interruptRun(current);
						return;
					}
					await this.cancelRequestedRun(current);
					return;
				}

				const step = await this.execution.executeNextTask({
					store: this.store,
					run: current,
					workerId: this.workerId,
					signal: abortController.signal,
				});

				current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
				if (isTerminalRun(current.status)) return;
				if (leaseLost) {
					await this.interruptRun(current);
					return;
				}
				if (this.stopping) {
					await this.interruptRun(current);
					return;
				}
				const queueCancelRequested = await this.queue.isCancelRequested({
					clientId: current.clientId,
					runId: current.runId,
				});
				if (current.status === "cancelling" || queueCancelRequested) {
					await this.cancelRequestedRun(current);
					return;
				}

				if (step.status === "complete") {
					await this.succeedRun(current);
					return;
				}
				if (step.status === "task_succeeded" || step.status === "task_failed") {
					continue;
				}
				if (step.status === "task_blocked") {
					await this.failRun(current, "agent_v2.worker_task_blocked", "Agent v2 task graph is blocked.");
					return;
				}
				if (step.status === "no_task") {
					await this.failRun(current, "agent_v2.worker_no_task", "Agent v2 worker found no runnable task.");
					return;
				}
			}

			await this.failRun(
				current,
				"agent_v2.worker_step_limit_exceeded",
				`Agent v2 worker exceeded ${this.maxStepsPerRun} execution steps without reaching a terminal state.`,
			);
		} catch (error) {
			const latest = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
			if (isTerminalRun(latest.status)) return;
			if (leaseLost) {
				await this.interruptRun(latest);
				return;
			}
			if (this.stopping) {
				await this.interruptRun(latest);
				return;
			}
			cancelRequested ||= latest.status === "cancelling";
			const aborted = abortController.signal.aborted;
			cancelRequested ||=
				aborted && (await this.queue.isCancelRequested({ clientId: latest.clientId, runId: latest.runId }));
			if (cancelRequested) {
				await this.cancelRequestedRun(latest);
			} else {
				await this.failRun(latest, "agent_v2.worker_execution_failed", errorMessage(error));
			}
		} finally {
			clearInterval(cancelPoll);
			clearInterval(leaseHeartbeat);
			this.activeAbortControllers.delete(key);
		}
	}

	private async failRun(run: AgentV2RunSnapshot, code: string, message: string): Promise<void> {
		const failed = await this.transitionRun(run, {
			status: "failed",
			phase: "failed",
			endedAt: this.now(),
			error: {
				code,
				message,
				retryable: false,
			},
			expectedStatuses: ["running"],
		});
		if (!failed.applied) {
			await this.finishContendedTerminalWrite(failed.run);
			return;
		}
		await this.appendDiagnostic(failed.run, code, message);
		await this.appendPhaseEvent(failed.run, failed.run.status);
	}

	private async interruptRun(run: AgentV2RunSnapshot): Promise<void> {
		if (run.status !== "running" && run.status !== "cancelling") return;
		const interrupted = await this.transitionRun(run, {
			status: "interrupted",
			endedAt: this.now(),
			error: undefined,
			expectedStatuses: ["running", "cancelling"],
		});
		if (!interrupted.applied) return;
		await this.appendPhaseEvent(interrupted.run, interrupted.run.status);
	}

	private async markOwnedRunsInterrupted(): Promise<void> {
		for (const run of await this.store.listAgentV2RunsByWorker(this.workerId)) {
			await this.interruptRun(run);
		}
	}

	private async recoverExpiredClaims(signal?: AbortSignal): Promise<void> {
		for (const claim of await this.queue.releaseExpiredClaims()) {
			if (signal?.aborted) return;
			const run = await this.store.getAgentV2Run(claim.clientId, claim.runId);
			if (signal?.aborted) return;
			if (!run) {
				continue;
			}
			if (run.status === "queued") {
				await this.queue.enqueue({ clientId: claim.clientId, runId: claim.runId });
				continue;
			}
			if (run.status === "running" || run.status === "cancelling") {
				await this.interruptRun(run);
			}
		}
	}

	private async pollCancellation(run: AgentV2RunSnapshot, abortController: AbortController): Promise<boolean> {
		const requested = await this.queue.isCancelRequested({ clientId: run.clientId, runId: run.runId });
		if (!requested) return false;

		const latest = await this.store.getAgentV2Run(run.clientId, run.runId);
		if (latest?.status === "running") {
			const cancelling = await this.transitionRun(latest, { status: "cancelling", expectedStatuses: ["running"] });
			if (cancelling.applied) {
				await this.appendPhaseEvent(cancelling.run, cancelling.run.status);
			}
		}
		abortController.abort();
		return true;
	}

	private async runExpiredClaimMaintenance(signal: AbortSignal): Promise<void> {
		while (this.running && !signal.aborted) {
			await interruptibleSleep(this.expiredClaimRecoveryIntervalMs, signal);
			if (!this.running || signal.aborted) return;
			const recovery = this.recoverExpiredClaims(signal).catch(() => undefined);
			if (!(await settleOrAbort(recovery, signal))) return;
		}
	}

	private async runLoop(): Promise<void> {
		let idleSleepMs = this.idleSleepMs;
		while (this.running) {
			const processed = await this.processOne();
			if (processed) {
				idleSleepMs = this.idleSleepMs;
				continue;
			}
			if (!this.running) continue;
			await sleep(idleSleepMs);
			idleSleepMs = Math.min(Math.max(1, idleSleepMs * 2), this.maxIdleSleepMs);
		}
	}

	private async waitForActiveProcessOneCalls(): Promise<void> {
		await Promise.all(this.activeProcessOneCalls);
	}

	private async succeedRun(run: AgentV2RunSnapshot): Promise<void> {
		const succeeded = await this.transitionRun(run, {
			status: "succeeded",
			phase: "delivery",
			endedAt: this.now(),
			error: undefined,
			expectedStatuses: ["running"],
		});
		if (!succeeded.applied) {
			await this.finishContendedTerminalWrite(succeeded.run);
			return;
		}
		await this.appendPhaseEvent(succeeded.run, succeeded.run.status);
	}

	private async transitionRun(
		run: AgentV2RunSnapshot,
		patch: {
			status: AgentV2RunStatus;
			phase?: AgentV2Phase;
			workerId?: string;
			startedAt?: string;
			endedAt?: string;
			error?: AgentV2RunSnapshot["error"];
			expectedStatuses?: readonly AgentV2RunStatus[];
		},
	): Promise<AgentV2RunTransitionResult> {
		const updatedAt = this.now();
		return await this.store.updateAgentV2RunWithResult({
			clientId: run.clientId,
			runId: run.runId,
			status: patch.status,
			...(patch.phase !== undefined ? { phase: patch.phase } : {}),
			...(patch.workerId !== undefined ? { workerId: patch.workerId } : {}),
			...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
			...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
			...(patch.error !== undefined ? { error: patch.error } : {}),
			...(patch.expectedStatuses !== undefined ? { expectedStatuses: patch.expectedStatuses } : {}),
			updatedAt,
		});
	}

	private async finishContendedTerminalWrite(run: AgentV2RunSnapshot): Promise<void> {
		if (run.status === "cancelling") {
			await this.cancelRun(run);
		}
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function isTerminalRun(status: AgentV2RunStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function runKey(run: AgentV2RunQueueIdentity): string {
	return `${run.clientId}:${run.runId}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function settleOrAbort(operation: Promise<void>, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (completed: boolean) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		const onAbort = () => finish(false);
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(() => finish(true));
		if (signal.aborted) onAbort();
	});
}
