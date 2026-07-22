import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { runAgentV2ShutdownSteps, } from "./agent-v2-lifecycle.js";
import { phaseForAgentV2Task } from "./agent-v2-state-machine.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
const DEFAULT_CLAIM_TIMEOUT_MS = 250;
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 50;
const DEFAULT_CONTROL_OPERATION_TIMEOUT_MS = 1_000;
const DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_SLEEP_MS = 25;
const DEFAULT_MAX_IDLE_SLEEP_MS = 1_000;
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_STEPS_PER_RUN = 256;
const DEFAULT_MAX_RUN_ATTEMPTS = 4;
const DEFAULT_RUN_RETRY_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_RUN_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const DEFAULT_QUEUE_NAME = "agent-v2-runs";
const MAX_OWNERSHIP_CONFIRMATION_ATTEMPTS = 3;
const OWNERSHIP_CONTROL_ABORT_REASON = Symbol("agent-v2-ownership-control");
export class AgentV2WorkerExecutionFailure extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = "AgentV2WorkerExecutionFailure";
    }
}
export class AgentV2WorkerService {
    activeAbortControllers = new Map();
    activeClaims = new Map();
    activeProcessOneCalls = new Set();
    cancelPollIntervalMs;
    claimTimeoutMs;
    concurrency;
    controlOperationTimeoutMs;
    execution;
    expiredClaimRecoveryIntervalMs;
    idleSleepMs;
    leaseHeartbeatIntervalMs;
    loops = [];
    maintenanceAbortController;
    maintenanceLoop;
    maxStepsPerRun;
    maxRunAttempts;
    maxIdleSleepMs;
    now;
    queue;
    queueName;
    runRetryDelaysMs;
    runRetryWindowMs;
    running = false;
    store;
    stopping = false;
    unsafeClaimTokens = new Set();
    workerId;
    constructor(options) {
        this.store = options.store;
        this.queue = options.queue;
        this.execution = options.execution;
        this.workerId = options.workerId;
        this.now = options.now ?? (() => new Date().toISOString());
        this.concurrency = options.concurrency ?? 1;
        this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
        this.cancelPollIntervalMs = Math.max(1, options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS);
        this.controlOperationTimeoutMs = Math.max(1, options.controlOperationTimeoutMs ?? DEFAULT_CONTROL_OPERATION_TIMEOUT_MS);
        this.expiredClaimRecoveryIntervalMs = Math.max(1, options.expiredClaimRecoveryIntervalMs ?? DEFAULT_EXPIRED_CLAIM_RECOVERY_INTERVAL_MS);
        this.idleSleepMs = options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
        this.maxIdleSleepMs = Math.max(this.idleSleepMs, options.maxIdleSleepMs ?? DEFAULT_MAX_IDLE_SLEEP_MS);
        this.leaseHeartbeatIntervalMs = Math.max(1, options.leaseHeartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS);
        this.maxStepsPerRun = options.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN;
        this.maxRunAttempts = options.maxRunAttempts ?? DEFAULT_MAX_RUN_ATTEMPTS;
        this.runRetryWindowMs = options.runRetryWindowMs ?? DEFAULT_RUN_RETRY_WINDOW_MS;
        this.runRetryDelaysMs = options.runRetryDelaysMs ?? DEFAULT_RUN_RETRY_DELAYS_MS;
        this.queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
        if (!Number.isSafeInteger(this.maxRunAttempts) || this.maxRunAttempts < 1) {
            throw new Error("Agent v2 maxRunAttempts must be a positive integer");
        }
        if (!Number.isSafeInteger(this.runRetryWindowMs) || this.runRetryWindowMs <= 0) {
            throw new Error("Agent v2 runRetryWindowMs must be a positive integer");
        }
        if (!this.queueName.trim())
            throw new Error("Agent v2 queueName is required");
        if (this.runRetryDelaysMs.length === 0 ||
            this.runRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
            throw new Error("Agent v2 runRetryDelaysMs must contain non-negative integers");
        }
    }
    async start() {
        if (this.running)
            return;
        this.stopping = false;
        await this.recoverOwnedRuns();
        this.running = true;
        this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
        this.maintenanceAbortController = new AbortController();
        this.maintenanceLoop = this.runExpiredClaimMaintenance(this.maintenanceAbortController.signal);
    }
    async stop(options) {
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
            for (const claimToken of this.activeClaims.keys())
                this.unsafeClaimTokens.add(claimToken);
        };
        if (options.signal.aborted)
            markActiveClaimsUnsafe();
        else
            options.signal.addEventListener("abort", markActiveClaimsUnsafe, { once: true });
        try {
            const result = await runAgentV2ShutdownSteps([
                {
                    step: "worker.claim_or_execution",
                    run: async () => await Promise.all([
                        ...this.loops,
                        ...this.activeProcessOneCalls,
                        ...(this.maintenanceLoop ? [this.maintenanceLoop] : []),
                    ]),
                    onTimeout: markActiveClaimsUnsafe,
                },
                { step: "worker.durable_interrupt", run: async () => await this.markOwnedRunsInterrupted() },
                { step: "queue.close", run: async (closeOptions) => await this.queue.close(closeOptions) },
            ], options);
            finish();
            return result;
        }
        finally {
            options.signal.removeEventListener("abort", markActiveClaimsUnsafe);
        }
    }
    async processOne() {
        if (this.stopping)
            return false;
        const processing = this.processOneInternal();
        const tracked = processing.then(() => undefined, () => undefined);
        this.activeProcessOneCalls.add(tracked);
        try {
            return await processing;
        }
        finally {
            this.activeProcessOneCalls.delete(tracked);
        }
    }
    async processOneInternal() {
        const claimed = await this.queue.claim(this.workerId, this.claimTimeoutMs);
        if (!claimed)
            return false;
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
            if (run.status !== "queued")
                return true;
            if (run.error?.data?.autoRetryScheduled === true && isRetryWaiting(run, this.now())) {
                safelyCompleteClaim = true;
                return true;
            }
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
            safelyCompleteClaim = durable !== undefined && (isTerminalRun(durable.status) || durable.status === "queued");
            return true;
        }
        finally {
            const ownershipSafeToComplete = !this.unsafeClaimTokens.delete(claimed.claimToken);
            try {
                if (safelyCompleteClaim && ownershipSafeToComplete)
                    await this.queue.complete(claimed);
            }
            finally {
                this.activeClaims.delete(claimed.claimToken);
            }
        }
    }
    async recoverOwnedRuns() {
        await this.recoverOwnedDurableRuns();
        await this.queue.requeueActive(this.workerId);
        await this.recoverExpiredClaims();
    }
    async appendDiagnostic(run, code, message, retryable) {
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
    async cancelRun(run) {
        if (run.status !== "running" && run.status !== "cancelling")
            return;
        const cancelled = await this.transitionRun(run, {
            status: "cancelled",
            phase: "cancelled",
            endedAt: this.now(),
            error: undefined,
            expectedStatuses: ["running", "cancelling"],
        });
        if (!cancelled.applied)
            return;
    }
    async cancelRequestedRun(run) {
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
    async executeClaimedRun(initialRun, claim) {
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
                if (isTerminalRun(current.status))
                    return;
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
                let step;
                try {
                    step = await this.execution.executeNextTask({
                        store: this.store,
                        run: current,
                        workerId: this.workerId,
                        signal: stepAbort.controller.signal,
                    });
                }
                catch (error) {
                    if (!isOwnershipControlAbort(stepAbort.controller.signal))
                        throw error;
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
                }
                finally {
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
                if (isTerminalRun(current.status))
                    return;
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
                    if (current.updatedAt !== executionRevision)
                        continue;
                    const terminal = await this.prepareOwnedTerminal(control, current);
                    if (!terminal)
                        return;
                    await this.failRun(terminal, "agent_v2.worker_task_conflict", "Agent v2 execution lost its durable compare-and-set expectation.", true);
                    return;
                }
                if (step.status === "complete") {
                    const terminal = await this.prepareOwnedTerminal(control, current);
                    if (!terminal)
                        return;
                    await this.succeedRun(terminal);
                    return;
                }
                if (step.status === "task_succeeded" || step.status === "task_failed") {
                    continue;
                }
                if (step.status === "task_blocked") {
                    const terminal = await this.prepareOwnedTerminal(control, current);
                    if (!terminal)
                        return;
                    const rootCause = step.blockingError?.message.trim().slice(0, 1_000);
                    const message = rootCause
                        ? `Agent v2 task graph is blocked: ${rootCause}`
                        : "Agent v2 task graph is blocked.";
                    await this.failRun(terminal, "agent_v2.worker_task_blocked", message, step.blockingError?.retryable ?? false);
                    return;
                }
                if (step.status === "no_task") {
                    const terminal = await this.prepareOwnedTerminal(control, current);
                    if (!terminal)
                        return;
                    await this.failRun(terminal, "agent_v2.worker_no_task", "Agent v2 worker found no runnable task.");
                    return;
                }
            }
            const terminal = await this.prepareOwnedTerminal(control, current);
            if (!terminal)
                return;
            await this.failRun(terminal, "agent_v2.worker_step_limit_exceeded", `Agent v2 worker exceeded ${this.maxStepsPerRun} execution steps without reaching a terminal state.`);
        }
        catch (error) {
            if (error instanceof AgentV2WorkerCommitError) {
                await this.stopClaimControl(control);
                throw error;
            }
            const latest = (await this.store.getAgentV2Run(current.clientId, current.runId)) ?? current;
            if (isTerminalRun(latest.status))
                return;
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
            }
            else {
                const terminal = await this.prepareOwnedTerminal(control, latest);
                if (terminal) {
                    if (error instanceof AgentV2WorkerExecutionFailure) {
                        await this.failRun(terminal, error.code, error.message, error.retryable);
                    }
                    else {
                        await this.failRun(terminal, "agent_v2.worker_execution_failed", errorMessage(error));
                    }
                }
            }
        }
        finally {
            await this.stopClaimControl(control);
            this.activeAbortControllers.delete(key);
        }
    }
    startClaimControl(claim, abortController) {
        const control = {
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
    async runClaimControlLoop(control) {
        const signal = control.controlAbortController.signal;
        let nextCancelAt = Date.now();
        let nextLeaseAt = Date.now() + this.leaseHeartbeatIntervalMs;
        while (!signal.aborted && !control.cancelRequested && !isControlUnsafe(control)) {
            const now = Date.now();
            const waitMs = Math.max(0, Math.min(nextCancelAt, nextLeaseAt) - now);
            if (waitMs > 0)
                await interruptibleSleep(waitMs, signal);
            if (signal.aborted)
                return;
            const tickAt = Date.now();
            if (tickAt >= nextLeaseAt) {
                if (!(await this.monitorLease(control, signal)))
                    return;
                nextLeaseAt = Date.now() + this.leaseHeartbeatIntervalMs;
            }
            if (signal.aborted || isControlUnsafe(control))
                return;
            if (Date.now() >= nextCancelAt) {
                if (!(await this.monitorCancellation(control)))
                    return;
                nextCancelAt = Date.now() + this.cancelPollIntervalMs;
            }
        }
    }
    async monitorLease(control, signal) {
        const renewal = await runBoundedControl(this.queue.renewLease(control.claim), this.controlOperationTimeoutMs);
        if (renewal.kind === "timeout") {
            this.markControlUnsafe(control, "agent_v2.worker_lease_renew_timeout", "Agent v2 lease renewal timed out; the run was stopped safely.");
            return false;
        }
        if (renewal.kind === "rejected") {
            this.addControlDiagnostic(control, "agent_v2.worker_lease_uncertain", "Agent v2 lease renewal was uncertain and required ownership confirmation.", true);
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
        this.addControlDiagnostic(control, "agent_v2.worker_lease_uncertain", "Agent v2 lease renewal was uncertain and required ownership confirmation.", true);
        this.markOwnershipUncertain(control);
        return await this.trackOwnershipResolution(control, signal);
    }
    async trackOwnershipResolution(control, signal) {
        const resolution = this.resolveUncertainOwnership(control, signal);
        control.ownershipResolutionPromise = resolution;
        try {
            return await resolution;
        }
        finally {
            if (control.ownershipResolutionPromise === resolution)
                control.ownershipResolutionPromise = undefined;
        }
    }
    async monitorCancellation(control) {
        const poll = await runBoundedControl(this.queue.isCancelRequested({ clientId: control.claim.clientId, runId: control.claim.runId }), this.controlOperationTimeoutMs);
        if (poll.kind === "timeout") {
            this.markControlUnsafe(control, "agent_v2.worker_cancel_poll_timeout", "Agent v2 cancellation monitoring timed out; the run was stopped safely.");
            return false;
        }
        if (poll.kind === "rejected") {
            this.markControlUnsafe(control, "agent_v2.worker_cancel_poll_failed", "Agent v2 cancellation monitoring failed; the run was stopped safely.");
            return false;
        }
        if (!poll.value)
            return true;
        control.cancelRequested = true;
        control.abortController.abort();
        return false;
    }
    async resolveUncertainOwnership(control, signal) {
        for (let attempt = 1; attempt <= MAX_OWNERSHIP_CONFIRMATION_ATTEMPTS && !signal?.aborted; attempt += 1) {
            const ownership = await runBoundedControl(this.queue.confirmOwnership(control.claim, this.controlOperationTimeoutMs), this.controlOperationTimeoutMs);
            if (ownership.kind === "timeout") {
                this.markControlUnsafe(control, "agent_v2.worker_lease_confirmation_timeout", "Agent v2 lease ownership could not be confirmed before its safety deadline.");
                return false;
            }
            if (ownership.kind === "value" && ownership.value === "lost") {
                this.markLeaseLost(control);
                return false;
            }
            if (ownership.kind === "value" && ownership.value === "owned") {
                const renewal = await runBoundedControl(this.queue.renewLease(control.claim), this.controlOperationTimeoutMs);
                if (renewal.kind === "timeout") {
                    this.markControlUnsafe(control, "agent_v2.worker_lease_renew_timeout", "Agent v2 lease renewal timed out; the run was stopped safely.");
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
            if (attempt < MAX_OWNERSHIP_CONFIRMATION_ATTEMPTS) {
                await interruptibleSleep(25, signal ?? new AbortController().signal);
            }
        }
        if (!signal?.aborted) {
            this.markControlUnsafe(control, "agent_v2.worker_lease_confirmation_timeout", "Agent v2 lease ownership could not be confirmed before its safety deadline.");
        }
        return false;
    }
    async prepareOwnedTerminal(control, run) {
        await this.stopClaimControl(control);
        if (!control.cancelRequested && !isControlUnsafe(control)) {
            await this.monitorCancellation(control);
        }
        await this.flushControlDiagnostics(run, control);
        const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
        if (isTerminalRun(latest.status))
            return undefined;
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
    async finishCancellation(control, run) {
        await this.stopClaimControl(control);
        await this.flushControlDiagnostics(run, control);
        const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
        if (isTerminalRun(latest.status))
            return;
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
    async finishUnsafeControl(control, run) {
        await this.stopClaimControl(control);
        await this.flushControlDiagnostics(run, control);
        const latest = (await this.store.getAgentV2Run(run.clientId, run.runId)) ?? run;
        if (!isTerminalRun(latest.status))
            await this.interruptRun(latest);
    }
    async stopClaimControl(control) {
        control.controlAbortController.abort();
        await control.controlPromise;
    }
    async flushControlDiagnostics(run, control) {
        for (const diagnostic of control.pendingDiagnostics.splice(0)) {
            try {
                await this.appendDiagnostic(run, diagnostic.code, diagnostic.message, diagnostic.retryable);
            }
            catch {
                console.error("[agent_v2.worker_control_diagnostic_failed] Agent v2 worker could not persist a control diagnostic.");
            }
        }
    }
    markControlUnsafe(control, code, message) {
        this.addControlDiagnostic(control, code, message, true);
        control.unsafe = true;
        this.unsafeClaimTokens.add(control.claim.claimToken);
        control.abortController.abort();
    }
    markLeaseLost(control) {
        this.addControlDiagnostic(control, "agent_v2.worker_lease_lost", "Agent v2 worker lost exact claim ownership; the run was interrupted.", true);
        control.ownership = "lost";
        this.unsafeClaimTokens.add(control.claim.claimToken);
        control.abortController.abort();
    }
    markOwnershipUncertain(control) {
        control.ownership = "uncertain";
        control.currentStepAbortController?.abort(OWNERSHIP_CONTROL_ABORT_REASON);
    }
    addControlDiagnostic(control, code, message, retryable) {
        if (control.pendingDiagnostics.some((diagnostic) => diagnostic.code === code))
            return;
        control.pendingDiagnostics.push({ code, message, retryable });
    }
    async scheduleRunRetry(run, code, message) {
        if (run.status !== "running" || run.attempt >= this.maxRunAttempts || !this.store.commitAgentV2RunRetry) {
            return false;
        }
        const scheduledAt = monotonicRevision(this.now(), run.updatedAt);
        const retryDelayIndex = Math.min(run.attempt - 1, this.runRetryDelaysMs.length - 1);
        const retryAt = new Date(Date.parse(scheduledAt) + this.runRetryDelaysMs[retryDelayIndex]).toISOString();
        const retryDeadline = Date.parse(run.startedAt ?? run.createdAt) + this.runRetryWindowMs;
        if (Date.parse(retryAt) > retryDeadline)
            return false;
        const allTasks = this.store.listAgentV2Tasks ? await this.store.listAgentV2Tasks(run.clientId, run.runId) : [];
        const retryableFailedTasks = allTasks.filter((task) => task.status === "failed" &&
            task.error?.retryable === true &&
            // Validation retries use immutable (validationId, attempt) identities.
            // Resetting the same validation task at run level only replays an
            // already-persisted attempt and produces a validation-attempt conflict.
            task.kind !== "validation");
        if ((run.phase === "failed" || code === "agent_v2.worker_task_blocked") && retryableFailedTasks.length === 0) {
            return false;
        }
        const resetTasks = retryableFailedTasks.map((task) => transitionAgentV2Task({ task, status: "ready", now: scheduledAt, output: task.output }));
        const phase = resetTasks[0] ? phaseForAgentV2Task(resetTasks[0], "ready") : run.phase;
        const nextAttempt = run.attempt + 1;
        const diagnostic = createAgentV2DiagnosticEvent({
            diagnosticId: `agent_v2.run_retry_scheduled:${run.runId}:${nextAttempt}`,
            clientId: run.clientId,
            runId: run.runId,
            severity: "warn",
            category: "worker",
            code: "agent_v2.run_retry_scheduled",
            phase,
            message: "Agent v2 scheduled a durable automatic retry.",
            data: {
                failureCode: code,
                failureMessage: message,
                retryAt,
                attempt: nextAttempt,
                maxAttempts: this.maxRunAttempts,
            },
            createdAt: scheduledAt,
        });
        const committed = await this.store.commitAgentV2RunRetry({
            clientId: run.clientId,
            runId: run.runId,
            expectedRun: {
                status: run.status,
                phase: run.phase,
                attempt: run.attempt,
                workerId: run.workerId ?? null,
                updatedAt: run.updatedAt,
            },
            expectedTasks: retryableFailedTasks.map((task) => ({
                taskId: task.taskId,
                status: task.status,
                updatedAt: task.updatedAt,
            })),
            tasks: resetTasks.map((task) => retryTaskInput(run, task)),
            phase,
            nextAttempt,
            maxAttempts: this.maxRunAttempts,
            retryWindowMs: this.runRetryWindowMs,
            queueName: this.queueName,
            retryAt,
            scheduledAt,
            error: {
                code,
                message,
                retryable: true,
                data: {
                    autoRetryScheduled: true,
                    retryAt,
                    attempt: nextAttempt,
                    maxAttempts: this.maxRunAttempts,
                },
            },
            diagnostic,
        });
        return (committed.update.applied ||
            (committed.update.run.status === "queued" && committed.update.run.attempt >= nextAttempt));
    }
    async failRun(run, code, message, retryable = false) {
        if (retryable && (await this.scheduleRunRetry(run, code, message)))
            return;
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
    async interruptRun(run) {
        if (run.status !== "running" && run.status !== "cancelling")
            return;
        const interrupted = await this.transitionRun(run, {
            status: "interrupted",
            endedAt: this.now(),
            error: undefined,
            expectedStatuses: ["running", "cancelling"],
        });
        if (!interrupted.applied)
            return;
    }
    async markOwnedRunsInterrupted() {
        for (const run of await this.store.listAgentV2RunsByWorker(this.workerId)) {
            await this.interruptRun(run);
        }
    }
    async recoverOwnedDurableRuns() {
        for (const run of await this.store.listAgentV2RunsByWorker(this.workerId)) {
            if (run.status === "cancelling") {
                await this.interruptRun(run);
                continue;
            }
            if (await this.scheduleRunRetry(run, "agent_v2.worker_restarted", "Agent v2 worker restarted before the run completed.")) {
                continue;
            }
            await this.interruptRun(run);
        }
    }
    async recoverExpiredClaims(signal) {
        for (const claim of await this.queue.requeueExpiredClaims()) {
            if (signal?.aborted)
                return;
            const run = await this.store.getAgentV2Run(claim.clientId, claim.runId);
            if (signal?.aborted)
                return;
            if (!run) {
                continue;
            }
            if (run.status === "queued")
                continue;
            if (run.status === "running" || run.status === "cancelling") {
                if (run.status === "running" &&
                    (await this.scheduleRunRetry(run, "agent_v2.worker_claim_expired", "Agent v2 worker claim expired before the run completed."))) {
                    continue;
                }
                await this.interruptRun(run);
            }
        }
    }
    async runExpiredClaimMaintenance(signal) {
        while (this.running && !signal.aborted) {
            await interruptibleSleep(this.expiredClaimRecoveryIntervalMs, signal);
            if (!this.running || signal.aborted)
                return;
            let failed = false;
            const recovery = this.recoverExpiredClaims(signal).catch(() => {
                failed = true;
            });
            if (!(await settleOrAbort(recovery, signal)))
                return;
            if (failed)
                await this.recordReclaimMaintenanceFailure();
        }
    }
    async recordReclaimMaintenanceFailure() {
        const code = "agent_v2.worker_reclaim_failed";
        const message = "Agent v2 expired-claim maintenance failed and will be retried.";
        try {
            const runs = await this.store.listAgentV2RunsByWorker(this.workerId);
            if (runs.length === 0) {
                console.error(`[${code}] ${message}`);
                return;
            }
            for (const run of runs)
                await this.appendDiagnostic(run, code, message, true);
        }
        catch {
            console.error(`[${code}] ${message}`);
        }
    }
    async runLoop() {
        let idleSleepMs = this.idleSleepMs;
        while (this.running) {
            const processed = await this.processOne();
            if (processed) {
                idleSleepMs = this.idleSleepMs;
                continue;
            }
            if (!this.running)
                continue;
            await sleep(idleSleepMs);
            idleSleepMs = Math.min(Math.max(1, idleSleepMs * 2), this.maxIdleSleepMs);
        }
    }
    async waitForActiveProcessOneCalls() {
        await Promise.all(this.activeProcessOneCalls);
    }
    async succeedRun(run) {
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
    async transitionRun(run, patch) {
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
        let committed;
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
        }
        catch {
            throw new AgentV2WorkerCommitError();
        }
        return committed.update;
    }
    async finishContendedTerminalWrite(run) {
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
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
function monotonicRevision(candidate, current) {
    const candidateMs = Date.parse(candidate);
    const currentMs = Date.parse(current);
    if (!Number.isFinite(candidateMs) || !Number.isFinite(currentMs)) {
        throw new Error("Agent v2 worker requires canonical timestamp revisions");
    }
    return new Date(Math.max(candidateMs, currentMs + 1)).toISOString();
}
function isTerminalRun(status) {
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}
function isRetryWaiting(run, now) {
    if (run.status !== "queued" || run.error?.data?.autoRetryScheduled !== true)
        return false;
    const retryAt = run.error.data.retryAt;
    return typeof retryAt === "string" && Date.parse(retryAt) > Date.parse(now);
}
function retryTaskInput(run, task) {
    return {
        clientId: run.clientId,
        runId: run.runId,
        taskId: task.taskId,
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        kind: task.kind,
        title: task.title,
        status: task.status,
        dependsOn: task.dependsOn,
        acceptanceCriteria: task.acceptanceCriteria,
        input: task.input,
        output: task.output,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}
function isControlUnsafe(control) {
    return control.unsafe || control.ownership === "lost";
}
function isOwnershipControlAbort(signal) {
    return signal.aborted && signal.reason === OWNERSHIP_CONTROL_ABORT_REASON;
}
function createLinkedAbortController(parent) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parent.reason);
    if (parent.aborted)
        onAbort();
    else
        parent.addEventListener("abort", onAbort, { once: true });
    return {
        controller,
        dispose: () => parent.removeEventListener("abort", onAbort),
    };
}
function runKey(run) {
    return `${run.clientId}:${run.runId}`;
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function interruptibleSleep(ms, signal) {
    if (signal.aborted)
        return Promise.resolve();
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
function settleOrAbort(operation, signal) {
    if (signal.aborted)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (completed) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(completed);
        };
        const onAbort = () => finish(false);
        signal.addEventListener("abort", onAbort, { once: true });
        void operation.then(() => finish(true));
        if (signal.aborted)
            onAbort();
    });
}
function runBoundedControl(operation, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(1, timeoutMs));
        void operation.then((value) => finish({ kind: "value", value }), () => finish({ kind: "rejected" }));
    });
}
//# sourceMappingURL=agent-v2-worker-service.js.map