import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2RunTransitionCommitResult } from "./agent-v2-durable-store.js";
import type { AgentV2ExecutionStepResult } from "./agent-v2-execution-core.js";
import {
	type AgentV2CloseOptions,
	type AgentV2WorkerStopResult,
	runAgentV2ShutdownSteps,
} from "./agent-v2-lifecycle.js";
import type { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import type { AgentV2ClaimedRun, AgentV2RunQueue, AgentV2RunQueueIdentity } from "./agent-v2-run-queue.js";
import type { AgentV2WorkerStore } from "./agent-v2-runtime-store.js";
import type { AgentV2Phase, AgentV2RunSnapshot, AgentV2RunStatus } from "./agent-v2-types.js";

const DEFAULT_CLAIM_TIMEOUT_MS = 250;
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 50;
const DEFAULT_CONTROL_OPERATION_TIMEOUT_MS = 1_000;
const DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_SLEEP_MS = 25;
const DEFAULT_MAX_IDLE_SLEEP_MS = 1_000;
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_STEPS_PER_RUN = 256;
const OWNERSHIP_CONTROL_ABORT_REASON = Symbol("agent-v2-ownership-control");

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
	controlOperationTimeoutMs?: number;
	expiredClaimRecoveryIntervalMs?: number;
	idleSleepMs?: number;
	maxIdleSleepMs?: number;
	leaseHeartbeatIntervalMs?: number;
	maxStepsPerRun?: number;
}

type AgentV2RunTransitionResult = AgentV2RunTransitionCommitResult["update"];

interface AgentV2ClaimControlDiagnostic {
	code: string;
	message: string;
	retryable: boolean;
}

interface AgentV2ClaimControlSession {
	abortController: AbortController;
	claim: AgentV2ClaimedRun;
	controlAbortController: AbortController;
	controlPromise: Promise<void>;
	currentStepAbortController?: AbortController;
	cancelRequested: boolean;
	ownership: "owned" | "uncertain" | "lost";
	ownershipResolutionPromise?: Promise<boolean>;
	pendingDiagnostics: AgentV2ClaimControlDiagnostic[];
	unsafe: boolean;
}

export class AgentV2WorkerService {
	private readonly activeAbortControllers = new Map<string, AbortController>();
	private readonly activeClaims = new Map<string, AgentV2ClaimedRun>();
	private readonly activeProcessOneCalls = new Set<Promise<void>>();
	private readonly cancelPollIntervalMs: number;
	private readonly claimTimeoutMs: number;
	private readonly concurrency: number;
	private readonly controlOperationTimeoutMs: number;
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
	private readonly unsafeClaimTokens = new Set<string>();
	private readonly workerId: string;

	constructor(options: AgentV2WorkerServiceOptions) {
		this.store = options.store;
		this.queue = options.queue;
		this.execution = options.execution;
		this.workerId = options.workerId;
		this.now = options.now ?? (() => new Date().toISOString());
		this.concurrency = options.concurrency ?? 1;
		this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
		this.cancelPollIntervalMs = Math.max(1, options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS);
		this.controlOperationTimeoutMs = Math.max(
			1,
			options.controlOperationTimeoutMs ?? DEFAULT_CONTROL_OPERATION_TIMEOUT_MS,
		);
		this.expiredClaimRecoveryIntervalMs = Math.max(
			1,
			options.expiredClaimRecoveryIntervalMs ?? DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS,
		);
		this.idleSleepMs = options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
		this.maxIdleSleepMs = Math.max(this.idleSleepMs, options.maxIdleSleepMs ?? DEFAULT_MAX_IDLE_SLEEP_MS);
		this.leaseHeartbeatIntervalMs = Math.max(
			1,
			options.leaseHeartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
		);
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

	async stop(): Promise<undefined>;
	async stop(options: AgentV2CloseOptions): Promise<AgentV2WorkerStopResult>;
	async stop(options?: AgentV2CloseOptions): Promise<undefined | AgentV2WorkerStopResult> {
		this.stopping = true;
		this.running = false;
		this.maintenanceAbortController?.abort();
		for (const controller of this.activeAbortControllers.values()) {
			controller.abort();
		}
		const finish = () => {
			this.loops = [];
			this.maintenanceAbortController = undefined;
			this.maintenanceLoop = undefined;
		};
		if (!options) {
			await Promise.all([...this.loops, ...(this.maintenanceLoop ? [this.maintenanceLoop] : [])]);
			await this.waitForActiveProcessOneCalls();
			await this.markOwnedRunsInterrupted();
			await this.queue.close();
			finish();
			return;
		}
		const markActiveClaimsUnsafe = () => {
			for (const claimToken of this.activeClaims.keys()) this.unsafeClaimTokens.add(claimToken);
		};
		if (options.signal.aborted) markActiveClaimsUnsafe();
		else options.signal.addEventListener("abort", markActiveClaimsUnsafe, { once: true });
		try {
			const result = await runAgentV2ShutdownSteps(
				[
					{
						step: "worker.claim_or_execution",
						run: async () =>
							await Promise.all([
								...this.loops,
								...this.activeProcessOneCalls,
								...(this.maintenanceLoop ? [this.maintenanceLoop] : []),
							]),
						onTimeout: markActiveClaimsUnsafe,
					},
					{ step: "worker.durable_interrupt", run: async () => await this.markOwnedRunsInterrupted() },
					{ step: "queue.close", run: async (closeOptions) => await this.queue.close(closeOptions) },
				],
				options,
			);
			finish();
			return result;
		} finally {
			options.signal.removeEventListener("abort", markActiveClaimsUnsafe);
		}
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
		this.activeClaims.set(claimed.claimToken, claimed);

		let safelyCompleteClaim = false;
		try {
			const run = await this.store.getAgentV2Run(claimed.clientId, claimed.runId);
			if (!run) {
				safelyCompleteClaim = true;
				return true;
			}
			if (isTerminalRun(run.status)) {
				safelyCompleteClaim = true;
				return true;
			}
			if (run.status !== "queued") return true;

			const running = await this.transitionRun(run, {
				status: "running",
				workerId: this.workerId,
				startedAt: run.startedAt ?? this.now(),
				expectedStatuses: ["queued"],
			});
			if (!running.applied) {
				safelyCompleteClaim = isTerminalRun(running.run.status);
				return true;
			}
			await this.executeClaimedRun(running.run, claimed);
			const durable = await this.store.getAgentV2Run(claimed.clientId, claimed.runId);
			safelyCompleteClaim = durable !== undefined && isTerminalRun(durable.status);
			return true;
		} finally {
			const ownershipSafeToComplete = !this.unsafeClaimTokens.delete(claimed.claimToken);
			try {
				if (safelyCompleteClaim && ownershipSafeToComplete) await this.queue.complete(claimed);
			} finally {
				this.activeClaims.delete(claimed.claimToken);
			}
		}
	}

	async recoverOwnedRuns(): Promise<void> {
		await this.queue.requeueActive(this.workerId);
		await this.markOwnedRunsInterrupted();
		await this.recoverExpiredClaims();
	}

	private async appendDiagnostic(
		run: AgentV2RunSnapshot,
		code: string,
		message: string,
		retryable?: boolean,
	): Promise<void> {
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
				...(retryable === undefined ? {} : { retryable }),
			},
			createdAt: this.now(),
		});
		await this.store.commitAgentV2Diagnostic({ diagnostic, emitRunEvent: true });
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
	}

	private async cancelRequestedRun(run: AgentV2RunSnapshot): Promise<void> {
		let current = run;
		if (current.status === "running") {
			const cancelling = await this.transitionRun(current, {
				status: "cancelling",
				expectedStatuses: ["running"],
			});
			current = cancelling.run;
		}
		await this.cancelRun(current);
	}

	private async executeClaimedRun(initialRun: AgentV2RunSnapshot, claim: AgentV2ClaimedRun): Promise<void> {
		const key = runKey(initialRun);
		const abortController = new AbortController();
		this.activeAbortControllers.set(key, abortController);
		const control = this.startClaimControl(claim, abortController);
		let current = initialRun;

		try {
			for (let steps = 0; steps < this.maxStepsPerRun; steps += 1) {
				if (this.stopping) {
					await this.stopClaimControl(control);
					await this.interruptRun(current);
					return;
				}
				current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
				if (isTerminalRun(current.status)) return;
				await control.ownershipResolutionPromise;
				if (isControlUnsafe(control)) {
					await this.finishUnsafeControl(control, current);
					return;
				}
				if (current.status === "cancelling") {
					control.cancelRequested = true;
					await this.finishCancellation(control, current);
					return;
				}
				if (control.cancelRequested) {
					await this.finishCancellation(control, current);
					return;
				}

				const executionRevision = current.updatedAt;
				const stepAbort = createLinkedAbortController(abortController.signal);
				control.currentStepAbortController = stepAbort.controller;
				let step: AgentV2ExecutionStepResult;
				try {
					step = await this.execution.executeNextTask({
						store: this.store,
						run: current,
						workerId: this.workerId,
						signal: stepAbort.controller.signal,
					});
				} catch (error) {
					if (!isOwnershipControlAbort(stepAbort.controller.signal)) throw error;
					await control.ownershipResolutionPromise;
					current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
					if (isControlUnsafe(control)) {
						await this.finishUnsafeControl(control, current);
						return;
					}
					if (this.stopping) {
						await this.stopClaimControl(control);
						await this.interruptRun(current);
						return;
					}
					if (control.cancelRequested || current.status === "cancelling") {
						control.cancelRequested = true;
						await this.finishCancellation(control, current);
						return;
					}
					steps -= 1;
					continue;
				} finally {
					stepAbort.dispose();
					if (control.currentStepAbortController === stepAbort.controller) {
						control.currentStepAbortController = undefined;
					}
				}
				if (isOwnershipControlAbort(stepAbort.controller.signal)) {
					await control.ownershipResolutionPromise;
					current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
					if (isControlUnsafe(control)) {
						await this.finishUnsafeControl(control, current);
						return;
					}
					steps -= 1;
					continue;
				}

				current = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
				if (isTerminalRun(current.status)) return;
				await control.ownershipResolutionPromise;
				if (isControlUnsafe(control)) {
					await this.finishUnsafeControl(control, current);
					return;
				}
				if (this.stopping) {
					await this.stopClaimControl(control);
					await this.interruptRun(current);
					return;
				}
				if (current.status === "cancelling" || control.cancelRequested) {
					control.cancelRequested = true;
					await this.finishCancellation(control, current);
					return;
				}
				if (step.status === "task_conflict") {
					if (current.updatedAt !== executionRevision) continue;
					const terminal = await this.prepareOwnedTerminal(control, current);
					if (!terminal) return;
					await this.failRun(
						terminal,
						"agent_v2.worker_task_conflict",
						"Agent v2 execution lost its durable compare-and-set expectation.",
						true,
					);
					return;
				}

				if (step.status === "complete") {
					const terminal = await this.prepareOwnedTerminal(control, current);
					if (!terminal) return;
					await this.succeedRun(terminal);
					return;
				}
				if (step.status === "task_succeeded" || step.status === "task_failed") {
					continue;
				}
				if (step.status === "task_blocked") {
					const terminal = await this.prepareOwnedTerminal(control, current);
					if (!terminal) return;
					await this.failRun(terminal, "agent_v2.worker_task_blocked", "Agent v2 task graph is blocked.");
					return;
				}
				if (step.status === "no_task") {
					const terminal = await this.prepareOwnedTerminal(control, current);
					if (!terminal) return;
					await this.failRun(terminal, "agent_v2.worker_no_task", "Agent v2 worker found no runnable task.");
					return;
				}
			}

			const terminal = await this.prepareOwnedTerminal(control, current);
			if (!terminal) return;
			await this.failRun(
				terminal,
				"agent_v2.worker_step_limit_exceeded",
				`Agent v2 worker exceeded ${this.maxStepsPerRun} execution steps without reaching a terminal state.`,
			);
		} catch (error) {
			if (error instanceof AgentV2WorkerCommitError) {
				await this.stopClaimControl(control);
				throw error;
			}
			const latest = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
			if (isTerminalRun(latest.status)) return;
			if (isControlUnsafe(control)) {
				await this.finishUnsafeControl(control, latest);
				return;
			}
			if (this.stopping) {
				await this.stopClaimControl(control);
				await this.interruptRun(latest);
				return;
			}
			if (control.cancelRequested || latest.status === "cancelling") {
				control.cancelRequested = true;
				await this.finishCancellation(control, latest);
			} else {
				const terminal = await this.prepareOwnedTerminal(control, latest);
				if (terminal) await this.failRun(terminal, "agent_v2.worker_execution_failed", errorMessage(error));
			}
		} finally {
			await this.stopClaimControl(control);
			this.activeAbortControllers.delete(key);
		}
	}

	private startClaimControl(claim: AgentV2ClaimedRun, abortController: AbortController): AgentV2ClaimControlSession {
		const control: AgentV2ClaimControlSession = {
			abortController,
			claim: { ...claim },
			controlAbortController: new AbortController(),
			controlPromise: Promise.resolve(),
			currentStepAbortController: undefined,
			cancelRequested: false,
			ownership: "owned",
			ownershipResolutionPromise: undefined,
			pendingDiagnostics: [],
			unsafe: false,
		};
		abortController.signal.addEventListener("abort", () => control.controlAbortController.abort(), { once: true });
		control.controlPromise = this.runClaimControlLoop(control);
		return control;
	}

	private async runClaimControlLoop(control: AgentV2ClaimControlSession): Promise<void> {
		const signal = control.controlAbortController.signal;
		let nextCancelAt = Date.now();
		let nextLeaseAt = Date.now() + this.leaseHeartbeatIntervalMs;
		while (!signal.aborted && !control.cancelRequested && !isControlUnsafe(control)) {
			const now = Date.now();
			const waitMs = Math.max(0, Math.min(nextCancelAt, nextLeaseAt) - now);
			if (waitMs > 0) await interruptibleSleep(waitMs, signal);
			if (signal.aborted) return;

			const tickAt = Date.now();
			if (tickAt >= nextLeaseAt) {
				if (!(await this.monitorLease(control, signal))) return;
				nextLeaseAt = Date.now() + this.leaseHeartbeatIntervalMs;
			}
			if (signal.aborted || isControlUnsafe(control)) return;
			if (Date.now() >= nextCancelAt) {
				if (!(await this.monitorCancellation(control))) return;
				nextCancelAt = Date.now() + this.cancelPollIntervalMs;
			}
		}
	}

	private async monitorLease(control: AgentV2ClaimControlSession, signal: AbortSignal): Promise<boolean> {
		const renewal = await runBoundedControl(this.queue.renewLease(control.claim), this.controlOperationTimeoutMs);
		if (renewal.kind === "timeout") {
			this.markControlUnsafe(
				control,
				"agent_v2.worker_lease_renew_timeout",
				"Agent v2 lease renewal timed out; the run was stopped safely.",
			);
			return false;
		}
		if (renewal.kind === "rejected") {
			this.addControlDiagnostic(
				control,
				"agent_v2.worker_lease_uncertain",
				"Agent v2 lease renewal was uncertain and required ownership confirmation.",
				true,
			);
			this.markOwnershipUncertain(control);
			return await this.trackOwnershipResolution(control, signal);
		}
		if (renewal.value.status === "renewed") {
			control.claim = { ...control.claim, leaseExpiresAtMs: renewal.value.leaseExpiresAtMs };
			control.ownership = "owned";
			return true;
		}
		if (renewal.value.status === "lost") {
			this.markLeaseLost(control);
			return false;
		}
		this.addControlDiagnostic(
			control,
			"agent_v2.worker_lease_uncertain",
			"Agent v2 lease renewal was uncertain and required ownership confirmation.",
			true,
		);
		this.markOwnershipUncertain(control);
		return await this.trackOwnershipResolution(control, signal);
	}

	private async trackOwnershipResolution(control: AgentV2ClaimControlSession, signal: AbortSignal): Promise<boolean> {
		const resolution = this.resolveUncertainOwnership(control, signal);
		control.ownershipResolutionPromise = resolution;
		try {
			return await resolution;
		} finally {
			if (control.ownershipResolutionPromise === resolution) control.ownershipResolutionPromise = undefined;
		}
	}

	private async monitorCancellation(control: AgentV2ClaimControlSession): Promise<boolean> {
		const poll = await runBoundedControl(
			this.queue.isCancelRequested({ clientId: control.claim.clientId, runId: control.claim.runId }),
			this.controlOperationTimeoutMs,
		);
		if (poll.kind === "timeout") {
			this.markControlUnsafe(
				control,
				"agent_v2.worker_cancel_poll_timeout",
				"Agent v2 cancellation monitoring timed out; the run was stopped safely.",
			);
			return false;
		}
		if (poll.kind === "rejected") {
			this.markControlUnsafe(
				control,
				"agent_v2.worker_cancel_poll_failed",
				"Agent v2 cancellation monitoring failed; the run was stopped safely.",
			);
			return false;
		}
		if (!poll.value) return true;
		control.cancelRequested = true;
		control.abortController.abort();
		return false;
	}

	private async resolveUncertainOwnership(
		control: AgentV2ClaimControlSession,
		signal?: AbortSignal,
	): Promise<boolean> {
		while (!signal?.aborted) {
			const remainingMs = control.claim.leaseExpiresAtMs - Date.now();
			if (remainingMs <= 0) {
				this.markControlUnsafe(
					control,
					"agent_v2.worker_lease_confirmation_timeout",
					"Agent v2 lease ownership could not be confirmed before its safety deadline.",
				);
				return false;
			}
			const ownership = await runBoundedControl(
				this.queue.confirmOwnership(control.claim, Math.min(this.controlOperationTimeoutMs, remainingMs)),
				Math.min(this.controlOperationTimeoutMs, remainingMs),
			);
			if (ownership.kind === "timeout") {
				this.markControlUnsafe(
					control,
					"agent_v2.worker_lease_confirmation_timeout",
					"Agent v2 lease ownership could not be confirmed before its safety deadline.",
				);
				return false;
			}
			if (ownership.kind === "value" && ownership.value === "lost") {
				this.markLeaseLost(control);
				return false;
			}
			if (ownership.kind === "value" && ownership.value === "owned") {
				const renewal = await runBoundedControl(
					this.queue.renewLease(control.claim),
					Math.min(this.controlOperationTimeoutMs, remainingMs),
				);
				if (renewal.kind === "timeout") {
					this.markControlUnsafe(
						control,
						"agent_v2.worker_lease_renew_timeout",
						"Agent v2 lease renewal timed out; the run was stopped safely.",
					);
					return false;
				}
				if (renewal.kind === "value" && renewal.value.status === "lost") {
					this.markLeaseLost(control);
					return false;
				}
				if (renewal.kind === "value" && renewal.value.status === "renewed") {
					control.claim = { ...control.claim, leaseExpiresAtMs: renewal.value.leaseExpiresAtMs };
					control.ownership = "owned";
					return true;
				}
			}
			const retryMs = Math.min(25, Math.max(1, control.claim.leaseExpiresAtMs - Date.now()));
			await interruptibleSleep(retryMs, signal ?? new AbortController().signal);
		}
		return false;
	}

	private async prepareOwnedTerminal(
		control: AgentV2ClaimControlSession,
		run: AgentV2RunSnapshot,
	): Promise<AgentV2RunSnapshot | undefined> {
		await this.stopClaimControl(control);
		if (!control.cancelRequested && !isControlUnsafe(control)) {
			await this.monitorCancellation(control);
		}
		await this.flushControlDiagnostics(run, control);
		const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
		if (isTerminalRun(latest.status)) return undefined;
		if (control.cancelRequested || latest.status === "cancelling") {
			control.cancelRequested = true;
			await this.finishCancellation(control, latest);
			return undefined;
		}
		if (isControlUnsafe(control)) {
			await this.interruptRun(latest);
			return undefined;
		}
		control.ownership = "uncertain";
		if (!(await this.resolveUncertainOwnership(control))) {
			await this.flushControlDiagnostics(latest, control);
			await this.interruptRun(latest);
			return undefined;
		}
		await this.flushControlDiagnostics(latest, control);
		return (await this.store.getAgentV2Run(latest.clientId, latest.runId)) ?? latest;
	}

	private async finishCancellation(control: AgentV2ClaimControlSession, run: AgentV2RunSnapshot): Promise<void> {
		await this.stopClaimControl(control);
		await this.flushControlDiagnostics(run, control);
		const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
		if (isTerminalRun(latest.status)) return;
		if (isControlUnsafe(control)) {
			await this.interruptRun(latest);
			return;
		}
		control.ownership = "uncertain";
		if (!(await this.resolveUncertainOwnership(control))) {
			await this.flushControlDiagnostics(latest, control);
			await this.interruptRun(latest);
			return;
		}
		await this.flushControlDiagnostics(latest, control);
		await this.cancelRequestedRun((await this.store.getAgentV2Run(latest.clientId, latest.runId)) ?? latest);
	}

	private async finishUnsafeControl(control: AgentV2ClaimControlSession, run: AgentV2RunSnapshot): Promise<void> {
		await this.stopClaimControl(control);
		await this.flushControlDiagnostics(run, control);
		const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
		if (!isTerminalRun(latest.status)) await this.interruptRun(latest);
	}

	private async stopClaimControl(control: AgentV2ClaimControlSession): Promise<void> {
		control.controlAbortController.abort();
		await control.controlPromise;
	}

	private async flushControlDiagnostics(run: AgentV2RunSnapshot, control: AgentV2ClaimControlSession): Promise<void> {
		for (const diagnostic of control.pendingDiagnostics.splice(0)) {
			try {
				await this.appendDiagnostic(run, diagnostic.code, diagnostic.message, diagnostic.retryable);
			} catch {
				console.error(
					"[agent_v2.worker_control_diagnostic_failed] Agent v2 worker could not persist a control diagnostic.",
				);
			}
		}
	}

	private markControlUnsafe(control: AgentV2ClaimControlSession, code: string, message: string): void {
		this.addControlDiagnostic(control, code, message, true);
		control.unsafe = true;
		this.unsafeClaimTokens.add(control.claim.claimToken);
		control.abortController.abort();
	}

	private markLeaseLost(control: AgentV2ClaimControlSession): void {
		this.addControlDiagnostic(
			control,
			"agent_v2.worker_lease_lost",
			"Agent v2 worker lost exact claim ownership; the run was interrupted.",
			true,
		);
		control.ownership = "lost";
		this.unsafeClaimTokens.add(control.claim.claimToken);
		control.abortController.abort();
	}

	private markOwnershipUncertain(control: AgentV2ClaimControlSession): void {
		control.ownership = "uncertain";
		control.currentStepAbortController?.abort(OWNERSHIP_CONTROL_ABORT_REASON);
	}

	private addControlDiagnostic(
		control: AgentV2ClaimControlSession,
		code: string,
		message: string,
		retryable: boolean,
	): void {
		if (control.pendingDiagnostics.some((diagnostic) => diagnostic.code === code)) return;
		control.pendingDiagnostics.push({ code, message, retryable });
	}

	private async failRun(run: AgentV2RunSnapshot, code: string, message: string, retryable = false): Promise<void> {
		const failed = await this.transitionRun(run, {
			status: "failed",
			phase: "failed",
			endedAt: this.now(),
			error: {
				code,
				message,
				retryable,
			},
			expectedStatuses: ["running"],
			diagnostic: {
				code,
				message: "Agent v2 worker recorded a durable terminal failure.",
				retryable,
			},
		});
		if (!failed.applied) {
			await this.finishContendedTerminalWrite(failed.run);
			return;
		}
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
	}

	private async markOwnedRunsInterrupted(): Promise<void> {
		for (const run of await this.store.listAgentV2RunsByWorker(this.workerId)) {
			await this.interruptRun(run);
		}
	}

	private async recoverExpiredClaims(signal?: AbortSignal): Promise<void> {
		for (const claim of await this.queue.requeueExpiredClaims()) {
			if (signal?.aborted) return;
			const run = await this.store.getAgentV2Run(claim.clientId, claim.runId);
			if (signal?.aborted) return;
			if (!run) {
				continue;
			}
			if (run.status === "queued") continue;
			if (run.status === "running" || run.status === "cancelling") {
				await this.interruptRun(run);
			}
		}
	}

	private async runExpiredClaimMaintenance(signal: AbortSignal): Promise<void> {
		while (this.running && !signal.aborted) {
			await interruptibleSleep(this.expiredClaimRecoveryIntervalMs, signal);
			if (!this.running || signal.aborted) return;
			let failed = false;
			const recovery = this.recoverExpiredClaims(signal).catch(() => {
				failed = true;
			});
			if (!(await settleOrAbort(recovery, signal))) return;
			if (failed) await this.recordReclaimMaintenanceFailure();
		}
	}

	private async recordReclaimMaintenanceFailure(): Promise<void> {
		const code = "agent_v2.worker_reclaim_failed";
		const message = "Agent v2 expired-claim maintenance failed and will be retried.";
		try {
			const runs = await this.store.listAgentV2RunsByWorker(this.workerId);
			if (runs.length === 0) {
				console.error(`[${code}] ${message}`);
				return;
			}
			for (const run of runs) await this.appendDiagnostic(run, code, message, true);
		} catch {
			console.error(`[${code}] ${message}`);
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
			diagnostic?: { code: string; message: string; retryable: boolean };
		},
	): Promise<AgentV2RunTransitionResult> {
		const updatedAt = monotonicRevision(this.now(), run.updatedAt);
		const nextPhase = patch.phase ?? run.phase;
		const diagnostic = patch.diagnostic
			? createAgentV2DiagnosticEvent({
					diagnosticId: `${patch.diagnostic.code}:${run.runId}:${randomUUID()}`,
					clientId: run.clientId,
					runId: run.runId,
					severity: "error",
					category: "worker",
					code: patch.diagnostic.code,
					phase: nextPhase,
					message: patch.diagnostic.message,
					data: {
						status: patch.status,
						workerId: this.workerId,
						retryable: patch.diagnostic.retryable,
					},
					createdAt: updatedAt,
				})
			: undefined;
		let committed: AgentV2RunTransitionCommitResult;
		try {
			committed = await this.store.commitAgentV2RunTransition({
				update: {
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
				},
				expectedRun: {
					status: run.status,
					phase: run.phase,
					attempt: run.attempt,
					workerId: run.workerId ?? null,
					updatedAt: run.updatedAt,
				},
				event: {
					type: "agent_v2.phase_changed",
					payload: {
						type: "agent_v2.phase_changed",
						phase: nextPhase,
						status: patch.status,
						attempt: run.attempt,
						at: updatedAt,
					},
					createdAt: updatedAt,
				},
				...(diagnostic ? { diagnostic } : {}),
			});
		} catch {
			throw new AgentV2WorkerCommitError();
		}
		return committed.update;
	}

	private async finishContendedTerminalWrite(run: AgentV2RunSnapshot): Promise<void> {
		if (run.status === "cancelling") {
			await this.cancelRun(run);
		}
	}
}

class AgentV2WorkerCommitError extends Error {
	constructor() {
		super("Agent v2 durable worker transition commit failed");
		this.name = "AgentV2WorkerCommitError";
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function monotonicRevision(candidate: string, current: string): string {
	const candidateMs = Date.parse(candidate);
	const currentMs = Date.parse(current);
	if (!Number.isFinite(candidateMs) || !Number.isFinite(currentMs)) {
		throw new Error("Agent v2 worker requires canonical timestamp revisions");
	}
	return new Date(Math.max(candidateMs, currentMs + 1)).toISOString();
}

function isTerminalRun(status: AgentV2RunStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function isControlUnsafe(control: AgentV2ClaimControlSession): boolean {
	return control.unsafe || control.ownership === "lost";
}

function isOwnershipControlAbort(signal: AbortSignal): boolean {
	return signal.aborted && signal.reason === OWNERSHIP_CONTROL_ABORT_REASON;
}

function createLinkedAbortController(parent: AbortSignal): {
	controller: AbortController;
	dispose: () => void;
} {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent.reason);
	if (parent.aborted) onAbort();
	else parent.addEventListener("abort", onAbort, { once: true });
	return {
		controller,
		dispose: () => parent.removeEventListener("abort", onAbort),
	};
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

type BoundedControlResult<T> = { kind: "value"; value: T } | { kind: "rejected" } | { kind: "timeout" };

function runBoundedControl<T>(operation: Promise<T>, timeoutMs: number): Promise<BoundedControlResult<T>> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: BoundedControlResult<T>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, timeoutMs));
		void operation.then(
			(value) => finish({ kind: "value", value }),
			() => finish({ kind: "rejected" }),
		);
	});
}
