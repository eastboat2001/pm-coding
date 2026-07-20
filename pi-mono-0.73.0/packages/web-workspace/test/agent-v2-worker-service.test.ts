import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type {
	AgentV2DiagnosticCommitInput,
	AgentV2DiagnosticCommitResult,
	AgentV2RunRetryCommitInput,
	AgentV2RunRetryCommitResult,
	AgentV2RunTransitionCommitInput,
	AgentV2RunTransitionCommitResult,
} from "../src/agent-v2-durable-store.js";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { createAgentV2ShutdownDeadline } from "../src/agent-v2-lifecycle.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2ActiveRunClaim, AgentV2ClaimedRun, AgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import {
	type AgentV2RunEventRecord,
	type AgentV2RunUpdateResult,
	type AppendAgentV2RunEventInput,
	applyAgentV2RunUpdate,
	buildAgentV2Run,
	type CreateAgentV2RunInput,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2RunStatus } from "../src/agent-v2-types.js";
import {
	type AgentV2WorkerExecution,
	AgentV2WorkerExecutionFailure,
	AgentV2WorkerService,
} from "../src/agent-v2-worker-service.js";

describe("AgentV2WorkerService", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("claims queued v2 runs and drives them to terminal success", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-success");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-success" }]);
		const events = new RecordingEventLog();
		const execution = new SequencedExecution([
			{ status: "task_succeeded", taskId: "implement", diagnosticIds: [] },
			{ status: "complete", diagnosticIds: [] },
		]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:00:00.000Z", "2026-07-08T09:00:01.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-success")).toMatchObject({
			status: "succeeded",
			phase: "delivery",
			workerId: "worker-a",
			startedAt: "2026-07-08T09:00:00.000Z",
			endedAt: "2026-07-08T09:00:01.000Z",
		});
		expect(queue.completeCalls).toEqual([{ clientId: "client-a", runId: "run-success", workerId: "worker-a" }]);
		expect(store.committedEvents).toEqual([
			expect.objectContaining({
				clientId: "client-a",
				runId: "run-success",
				type: "agent_v2.phase_changed",
				payload: expect.objectContaining({
					type: "agent_v2.phase_changed",
					status: "running",
				}),
			}),
			expect.objectContaining({
				clientId: "client-a",
				runId: "run-success",
				type: "agent_v2.phase_changed",
				payload: expect.objectContaining({
					type: "agent_v2.phase_changed",
					status: "succeeded",
					phase: "delivery",
				}),
			}),
		]);
	});

	it("includes the blocking task root cause and retryability in the durable terminal error", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-blocked");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-blocked" }]);
		const execution = new SequencedExecution([
			{
				status: "task_blocked",
				diagnosticIds: [],
				blockingError: {
					code: "agent_v2.validation_failed",
					message: "canvas.getContext is not a function",
					retryable: true,
				},
			},
		]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution,
			workerId: "worker-a",
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-blocked")?.error).toEqual({
			code: "agent_v2.worker_task_blocked",
			message: "Agent v2 task graph is blocked: canvas.getContext is not a function",
			retryable: true,
		});
	});

	it("does not couple durable worker success to the legacy event projection seam", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-projection-isolated");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-projection-isolated" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: {
				append: async () => {
					throw new Error("projection unavailable");
				},
			},
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-projection-isolated")?.status).toBe("succeeded");
		expect(queue.completedClaims).toEqual([expect.objectContaining({ claimToken: "recording-1" })]);
	});

	it("does not complete a claim before the terminal transition commit resolves", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-terminal-commit-pending");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-terminal-commit-pending" }]);
		const terminalCommit = deferred<void>();
		store.holdCommitForStatus("succeeded", terminalCommit.promise);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:00:00.000Z", "2026-07-08T09:00:01.000Z"),
		});

		const processing = worker.processOne();
		await waitFor(() => store.commitCalls.some((input) => input.update.status === "succeeded"));
		expect(queue.completeCalls).toEqual([]);
		terminalCommit.resolve();
		await expect(processing).resolves.toBe(true);
		expect(queue.completedClaims).toEqual([
			expect.objectContaining({ workerId: "worker-a", claimToken: "recording-1" }),
		]);
	});

	it("keeps the exact claim owned when a durable transition commit rejects", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-commit-rejected");
		store.rejectNextCommit = new Error("database password=secret unavailable");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-commit-rejected" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
		});

		await expect(worker.processOne()).rejects.toThrow("Agent v2 durable worker transition commit failed");
		expect(queue.completeCalls).toEqual([]);
		expect(store.getRunSnapshot("client-a", "run-commit-rejected")?.status).toBe("queued");
		expect(store.committedEvents).toEqual([]);
		expect(store.outboxIntentIds).toEqual([]);
	});

	it("does not turn an uncertain terminal commit into a second terminal write or claim completion", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-terminal-commit-rejected");
		store.rejectCommitForStatus("succeeded", new Error("postgres://user:secret@db unavailable"));
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-terminal-commit-rejected" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
		});

		await expect(worker.processOne()).rejects.toThrow("Agent v2 durable worker transition commit failed");
		expect(queue.completeCalls).toEqual([]);
		expect(store.getRunSnapshot("client-a", "run-terminal-commit-rejected")?.status).toBe("running");
		expect(store.commitCalls.map((input) => input.update.status)).toEqual(["running", "succeeded"]);
		expect(JSON.stringify(store.diagnostics)).not.toContain("secret");
	});

	it("backs off repeated empty queue claims", async () => {
		vi.useFakeTimers();
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store: new MemoryWorkerStore(),
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			claimTimeoutMs: 0,
			idleSleepMs: 10,
			maxIdleSleepMs: 80,
		});

		await worker.start();
		await vi.advanceTimersByTimeAsync(150);
		const stopping = worker.stop();
		await vi.runAllTimersAsync();
		await stopping;

		expect(queue.claimCount).toBeLessThanOrEqual(6);
	});

	it("periodically reclaims expired claims discovered after startup", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-expired-after-start");
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			claimTimeoutMs: 0,
			idleSleepMs: 10,
			maxIdleSleepMs: 10,
			expiredClaimRecoveryIntervalMs: 20,
		});

		await worker.start();
		queue.expiredClaims = [
			{
				clientId: "client-a",
				runId: "run-expired-after-start",
				workerId: "worker-crashed",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
		];
		await vi.advanceTimersByTimeAsync(25);
		const stopping = worker.stop();
		await vi.runAllTimersAsync();
		await stopping;

		expect(queue.releaseExpiredClaimsCalls).toBeGreaterThanOrEqual(2);
		expect(queue.enqueuedClaims).toContainEqual({ clientId: "client-a", runId: "run-expired-after-start" });
	});

	it("continues reclaiming expired claims while a run execution is blocked", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-blocking");
		store.createQueuedRun("client-a", "run-expired-during-execution");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-blocking" }]);
		let markExecutionStarted: () => void = () => undefined;
		let releaseExecution: () => void = () => undefined;
		const executionStarted = new Promise<void>((resolve) => {
			markExecutionStarted = resolve;
		});
		const executionReleased = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: {
				executeNextTask: async () => {
					markExecutionStarted();
					await executionReleased;
					return { status: "complete", diagnosticIds: [] };
				},
			},
			workerId: "worker-a",
			claimTimeoutMs: 0,
			idleSleepMs: 10,
			maxIdleSleepMs: 10,
			expiredClaimRecoveryIntervalMs: 20,
		});

		await worker.start();
		await executionStarted;
		queue.expiredClaims = [
			{
				clientId: "client-a",
				runId: "run-expired-during-execution",
				workerId: "worker-crashed",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
		];
		await vi.advanceTimersByTimeAsync(25);

		expect(queue.releaseExpiredClaimsCalls).toBeGreaterThanOrEqual(2);
		expect(queue.enqueuedClaims).toContainEqual({
			clientId: "client-a",
			runId: "run-expired-during-execution",
		});

		releaseExecution();
		await vi.advanceTimersByTimeAsync(1);
		const stopping = worker.stop();
		await vi.runAllTimersAsync();
		await stopping;
	});

	it("stops while an expired-claim recovery call remains stalled", async () => {
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store: new MemoryWorkerStore(),
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			claimTimeoutMs: 0,
			idleSleepMs: 1,
			maxIdleSleepMs: 1,
			expiredClaimRecoveryIntervalMs: 1,
		});

		await worker.start();
		queue.holdReleaseExpiredClaims = true;
		await queue.waitForReleaseExpiredClaimsCalls(2);
		const outcome = await Promise.race([
			worker.stop().then(() => "stopped" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
		]);

		expect(outcome).toBe("stopped");
		expect(queue.closeCount).toBe(1);
	});

	it("bounds a claim connection that ignores shutdown by the shared deadline", async () => {
		class StalledClaimQueue extends RecordingQueue {
			override async claim(): Promise<AgentV2ClaimedRun | undefined> {
				return await new Promise<AgentV2ClaimedRun | undefined>(() => undefined);
			}
		}
		const queue = new StalledClaimQueue();
		const worker = new AgentV2WorkerService({
			store: new MemoryWorkerStore(),
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([]),
			workerId: "worker-a",
		});
		await worker.start();
		await Promise.resolve();
		const deadline = createAgentV2ShutdownDeadline(15);
		try {
			await expect(worker.stop(deadline)).resolves.toEqual({
				completed: false,
				timedOutSteps: ["worker.claim_or_execution"],
				errors: [],
			});
			expect(queue.closeCount).toBe(1);
		} finally {
			deadline.dispose();
		}
	});

	it("bounds execution that ignores abort without completing its claim", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-stalled-shutdown");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-stalled-shutdown" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: { executeNextTask: async () => await new Promise<AgentV2ExecutionStepResult>(() => undefined) },
			workerId: "worker-a",
		});
		await worker.start();
		await waitFor(() => store.getRunSnapshot("client-a", "run-stalled-shutdown")?.status === "running");
		const deadline = createAgentV2ShutdownDeadline(15);
		try {
			await expect(worker.stop(deadline)).resolves.toEqual({
				completed: false,
				timedOutSteps: ["worker.claim_or_execution"],
				errors: [],
			});
			expect(queue.completeCalls).toEqual([]);
			expect(queue.closeCount).toBe(1);
			await waitFor(() => store.getRunSnapshot("client-a", "run-stalled-shutdown")?.status === "interrupted");
		} finally {
			deadline.dispose();
		}
	});

	it("marks a timed-out active claim unsafe before an abort-ignoring execution resolves late", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-late-shutdown");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-late-shutdown" }]);
		const lateExecution = deferred<AgentV2ExecutionStepResult>();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: { executeNextTask: async () => await lateExecution.promise },
			workerId: "worker-a",
		});
		const processing = worker.processOne();
		await waitFor(() => store.getRunSnapshot("client-a", "run-late-shutdown")?.status === "running");
		const deadline = createAgentV2ShutdownDeadline(15);
		try {
			await expect(worker.stop(deadline)).resolves.toMatchObject({
				completed: false,
				timedOutSteps: ["worker.claim_or_execution"],
			});
			lateExecution.resolve({ status: "complete", diagnosticIds: [] });
			await expect(processing).resolves.toBe(true);
			expect(queue.completeCalls).toEqual([]);
			expect(store.getRunSnapshot("client-a", "run-late-shutdown")?.status).toBe("interrupted");
		} finally {
			deadline.dispose();
		}
	});

	it("marks a claim unsafe while its pre-execution durable read resolves after deadline", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-late-pre-read");
		const originalGet = store.getAgentV2Run.bind(store);
		const readStarted = deferred<void>();
		const releaseRead = deferred<void>();
		let firstRead = true;
		store.getAgentV2Run = async (clientId, runId) => {
			if (firstRead) {
				firstRead = false;
				readStarted.resolve();
				await releaseRead.promise;
			}
			return await originalGet(clientId, runId);
		};
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-late-pre-read" }]);
		const execution = new CountingExecution();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution,
			workerId: "worker-a",
		});
		const processing = worker.processOne();
		await readStarted.promise;
		const deadline = createAgentV2ShutdownDeadline(15);
		try {
			await worker.stop(deadline);
			releaseRead.resolve();
			await processing;
			expect(queue.completeCalls).toEqual([]);
			expect(execution.callCount).toBe(0);
			expect(store.getRunSnapshot("client-a", "run-late-pre-read")?.status).toBe("interrupted");
		} finally {
			deadline.dispose();
		}
	});

	it("marks a claim unsafe while its final durable reread resolves after deadline", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-late-final-read");
		const originalGet = store.getAgentV2Run.bind(store);
		const finalReadStarted = deferred<void>();
		const releaseFinalRead = deferred<void>();
		let heldFinalRead = false;
		store.getAgentV2Run = async (clientId, runId) => {
			const snapshot = await originalGet(clientId, runId);
			if (!heldFinalRead && snapshot?.status === "succeeded") {
				heldFinalRead = true;
				finalReadStarted.resolve();
				await releaseFinalRead.promise;
			}
			return snapshot;
		};
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-late-final-read" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
		});
		const processing = worker.processOne();
		await finalReadStarted.promise;
		const deadline = createAgentV2ShutdownDeadline(15);
		try {
			await worker.stop(deadline);
			releaseFinalRead.resolve();
			await processing;
			expect(queue.completeCalls).toEqual([]);
			expect(store.getRunSnapshot("client-a", "run-late-final-read")?.status).toBe("succeeded");
		} finally {
			deadline.dispose();
		}
	});

	it("records a sanitized retryable diagnostic and recovers after reclaim maintenance rejects", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			claimTimeoutMs: 0,
			idleSleepMs: 10,
			maxIdleSleepMs: 10,
			expiredClaimRecoveryIntervalMs: 20,
			now: () => "2026-07-15T00:00:00.000Z",
		});

		await worker.start();
		store.createOwnedActiveRun("client-a", "run-maintenance", "running", "worker-a");
		queue.failNextRequeueExpiredClaims = new Error(
			'WRONGTYPE redis://user:secret@127.0.0.1 queue:active {"authorization":"Bearer secret"}',
		);
		await vi.advanceTimersByTimeAsync(45);
		const stopping = worker.stop();
		await vi.runAllTimersAsync();
		await stopping;

		expect(queue.releaseExpiredClaimsCalls).toBeGreaterThanOrEqual(3);
		expect(queue.completeCalls).toEqual([]);
		expect(store.diagnostics).toEqual([
			expect.objectContaining({
				clientId: "client-a",
				runId: "run-maintenance",
				category: "worker",
				code: "agent_v2.worker_reclaim_failed",
				message: "Agent v2 expired-claim maintenance failed and will be retried.",
				data: expect.objectContaining({ retryable: true, workerId: "worker-a" }),
			}),
		]);
		expect(JSON.stringify(store.diagnostics)).not.toContain("secret");
		expect(JSON.stringify(store.diagnostics)).not.toContain("queue:active");
	});

	it("atomically stores terminal failure state, phase event, and diagnostic", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-failed");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-failed" }]);
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution: new ThrowingExecution(new Error("execution exploded")),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:01:00.000Z", "2026-07-08T09:01:01.000Z", "2026-07-08T09:01:02.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-failed")).toMatchObject({
			status: "failed",
			phase: "failed",
			error: {
				code: "agent_v2.worker_execution_failed",
				message: "execution exploded",
				retryable: false,
			},
		});
		expect(store.diagnostics).toEqual([
			expect.objectContaining({
				code: "agent_v2.worker_execution_failed",
				category: "worker",
				message: "Agent v2 worker recorded a durable terminal failure.",
				runId: "run-failed",
			}),
		]);
		expect(store.committedEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({
						type: "agent_v2.phase_changed",
						status: "failed",
						phase: "failed",
					}),
				}),
			]),
		);
	});

	it("durably requeues a classified retryable execution failure and releases the old claim", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-classified-failure");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-classified-failure" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new ThrowingExecution(
				new AgentV2WorkerExecutionFailure(
					"agent_v2.provider_timeout",
					"The provider timed out after bounded request retries.",
					true,
				),
			),
			workerId: "worker-a",
			queueName: "agent-v2",
			now: timestampSequence("2026-07-08T09:02:00.000Z", "2026-07-08T09:02:01.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-classified-failure")).toMatchObject({
			status: "queued",
			attempt: 2,
			error: {
				code: "agent_v2.provider_timeout",
				message: "The provider timed out after bounded request retries.",
				retryable: true,
				data: expect.objectContaining({ autoRetryScheduled: true, attempt: 2, maxAttempts: 4 }),
			},
		});
		expect(store.diagnostics).toEqual([
			expect.objectContaining({
				code: "agent_v2.run_retry_scheduled",
				data: expect.objectContaining({ failureCode: "agent_v2.provider_timeout", attempt: 2 }),
			}),
		]);
		expect(queue.completedClaims).toHaveLength(1);
		expect(store.retryCommitCalls).toHaveLength(1);
	});

	it("records a terminal failure after the automatic run retry budget is exhausted", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-retry-exhausted");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-retry-exhausted" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new ThrowingExecution(
				new AgentV2WorkerExecutionFailure("agent_v2.provider_timeout", "Provider timed out.", true),
			),
			workerId: "worker-a",
			maxRunAttempts: 1,
			now: timestampSequence("2026-07-08T09:02:10.000Z", "2026-07-08T09:02:11.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-retry-exhausted")).toMatchObject({
			status: "failed",
			attempt: 1,
			error: { code: "agent_v2.provider_timeout", retryable: true },
		});
		expect(store.retryCommitCalls).toEqual([]);
	});

	it("durably retries one unchanged execution CAS conflict without hot-looping", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-task-conflict");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-task-conflict" }]);
		const executeNextTask = vi.fn(async () => ({
			status: "task_conflict" as const,
			taskId: "implement",
			diagnosticIds: [],
		}));
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: { executeNextTask },
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:01:10.000Z", "2026-07-08T09:01:11.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(executeNextTask).toHaveBeenCalledTimes(1);
		expect(store.getRunSnapshot("client-a", "run-task-conflict")).toMatchObject({
			status: "queued",
			attempt: 2,
			error: {
				code: "agent_v2.worker_task_conflict",
				retryable: true,
			},
		});
		expect(queue.completedClaims).toHaveLength(1);
	});

	it("leaves runs cancelled when cancellation already happened before claim processing", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-cancelled-before-claim");
		store.update({
			clientId: "client-a",
			runId: "run-cancelled-before-claim",
			status: "cancelled",
			phase: "cancelled",
			updatedAt: "2026-07-08T09:02:00.000Z",
			endedAt: "2026-07-08T09:02:00.000Z",
		});
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-cancelled-before-claim" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: () => "2026-07-08T09:02:01.000Z",
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-cancelled-before-claim")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			endedAt: "2026-07-08T09:02:00.000Z",
		});
		expect(queue.completeCalls).toEqual([
			{ clientId: "client-a", runId: "run-cancelled-before-claim", workerId: "worker-a" },
		]);
	});

	it("aborts execution when cancellation arrives while a run is running and finishes cancelled", async () => {
		vi.useRealTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-cancel-during-execution");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-cancel-during-execution" }]);
		const execution = new AbortAwareExecution();
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId: "worker-a",
			cancelPollIntervalMs: 5,
			now: timestampSequence("2026-07-08T09:03:00.000Z", "2026-07-08T09:03:01.000Z", "2026-07-08T09:03:02.000Z"),
		});

		setTimeout(() => {
			void queue.requestCancel({ clientId: "client-a", runId: "run-cancel-during-execution" }, "cancel-a");
		}, 10);

		await expect(worker.processOne()).resolves.toBe(true);
		expect(execution.abortCount).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-cancel-during-execution")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
		});
		expect(store.committedEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({ status: "cancelling" }),
				}),
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({ status: "cancelled", phase: "cancelled" }),
				}),
			]),
		);
	});

	it("finishes cancelled when execution returns complete after the run was externally moved to cancelling", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-cancelled-before-finalize");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-cancelled-before-finalize" }]);
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution: new ExternalCancellingExecution(store, "client-a", "run-cancelled-before-finalize"),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:30.000Z", "2026-07-08T09:03:31.000Z", "2026-07-08T09:03:32.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-cancelled-before-finalize")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			endedAt: "2026-07-08T09:03:32.000Z",
		});
		expect(store.committedEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({ status: "running" }),
				}),
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({ status: "cancelled", phase: "cancelled" }),
				}),
			]),
		);
	});

	it("does not let a stale running snapshot finalize succeeded after cancellation wins the store race", async () => {
		const store = new MemoryWorkerStore();
		store.simulateStaleTerminalOverwriteWithoutGuard = true;
		store.createQueuedRun("client-a", "run-stale-final-success");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-stale-final-success" }]);
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution: new StaleFinalReadCancellationExecution(store, "client-a", "run-stale-final-success"),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:33.000Z", "2026-07-08T09:03:34.000Z", "2026-07-08T09:03:35.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-stale-final-success")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			endedAt: "2026-07-08T09:03:35.000Z",
		});
		expect(store.committedEvents).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "agent_v2.phase_changed",
					payload: expect.objectContaining({ status: "succeeded" }),
				}),
			]),
		);
	});

	it("preserves interrupted when a run was externally interrupted before post-step cancel finalization", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-interrupted-before-finalize");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-interrupted-before-finalize" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new ExternalInterruptedExecution(store, queue, "client-a", "run-interrupted-before-finalize"),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:40.000Z", "2026-07-08T09:03:41.000Z", "2026-07-08T09:03:42.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		expect(store.getRunSnapshot("client-a", "run-interrupted-before-finalize")).toMatchObject({
			status: "interrupted",
			endedAt: "2026-07-08T09:03:41.000Z",
		});
	});

	it("preserves interrupted when stop races with a requested cancel", async () => {
		vi.useRealTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-stop-cancel-race");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-stop-cancel-race" }]);
		const execution = new AbortAwareExecution();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution,
			workerId: "worker-a",
			cancelPollIntervalMs: 5,
			now: timestampSequence("2026-07-08T09:03:50.000Z", "2026-07-08T09:03:51.000Z", "2026-07-08T09:03:52.000Z"),
		});

		const processing = worker.processOne();
		await waitFor(() => store.getRunSnapshot("client-a", "run-stop-cancel-race")?.status === "running");
		await queue.requestCancel({ clientId: "client-a", runId: "run-stop-cancel-race" }, "cancel-stop");
		await expect(worker.stop()).resolves.toBeUndefined();
		await expect(processing).resolves.toBe(true);
		expect(execution.abortCount).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-stop-cancel-race")).toMatchObject({
			status: "interrupted",
		});
	});

	it("stop waits for active loop completion before closing the queue", async () => {
		vi.useRealTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-stop-close-order");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-stop-close-order" }], {
			throwOnCompleteAfterClose: true,
		});
		const execution = new DelayedAbortExecution(20);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution,
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:55.000Z", "2026-07-08T09:03:56.000Z"),
		});

		await worker.start();
		await waitFor(() => store.getRunSnapshot("client-a", "run-stop-close-order")?.status === "running");
		await expect(worker.stop()).resolves.toBeUndefined();

		expect(execution.abortCount).toBe(1);
		expect(queue.operations).toEqual(["complete:client-a:run-stop-close-order", "close"]);
		expect(store.getRunSnapshot("client-a", "run-stop-close-order")).toMatchObject({
			status: "interrupted",
		});
	});

	it("stop waits for active direct processOne completion before closing the queue", async () => {
		vi.useRealTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-direct-stop-close-order");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-direct-stop-close-order" }], {
			throwOnCompleteAfterClose: true,
		});
		const execution = new DelayedAbortExecution(20);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution,
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:57.000Z", "2026-07-08T09:03:58.000Z"),
		});

		const processing = worker.processOne();
		await waitFor(() => store.getRunSnapshot("client-a", "run-direct-stop-close-order")?.status === "running");

		await expect(worker.stop()).resolves.toBeUndefined();
		await expect(processing).resolves.toBe(true);

		expect(execution.abortCount).toBe(1);
		expect(queue.operations).toEqual(["complete:client-a:run-direct-stop-close-order", "close"]);
		expect(store.getRunSnapshot("client-a", "run-direct-stop-close-order")).toMatchObject({
			status: "interrupted",
		});
	});

	it("does not emit a cancelling event when the poll cancellation CAS already lost", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-poll-cas-miss");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-poll-cas-miss" }]);
		await queue.requestCancel({ clientId: "client-a", runId: "run-poll-cas-miss" }, "cancel-poll");
		const raceCancelling = (input: Parameters<MemoryWorkerStore["update"]>[0]) => {
			if (input.status === "cancelling") {
				store.forceUpdate({
					clientId: "client-a",
					runId: "run-poll-cas-miss",
					status: "cancelling",
					updatedAt: "2026-07-08T09:03:59.000Z",
				});
				return;
			}
			store.runBeforeNextUpdate(raceCancelling);
		};
		store.runBeforeNextUpdate(raceCancelling);
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:03:58.000Z", "2026-07-08T09:03:59.000Z", "2026-07-08T09:04:00.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const phaseStatuses = store.committedEvents
			.filter((event) => event.type === "agent_v2.phase_changed")
			.map((event) => event.payload.status);
		expect(phaseStatuses).toEqual(["running", "cancelled"]);
	});

	it("does not emit or execute when claiming a queued run loses the running status guard with the same timestamp", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-claim-cas-miss");
		store.runBeforeNextUpdate((input) => {
			if (input.status !== "running") return;
			store.forceUpdate({
				clientId: "client-a",
				runId: "run-claim-cas-miss",
				status: "running",
				phase: "implementation",
				workerId: "worker-race",
				startedAt: "2026-07-08T09:04:10.000Z",
				updatedAt: "2026-07-08T09:04:10.000Z",
			});
		});
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-claim-cas-miss" }]);
		const events = new RecordingEventLog();
		const execution = new CountingExecution();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId: "worker-a",
			now: () => "2026-07-08T09:04:10.000Z",
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(execution.callCount).toBe(0);
		expect(store.committedEvents.filter((event) => event.type === "agent_v2.phase_changed")).toEqual([]);
		expect(store.outboxIntentIds).toEqual([]);
		expect(queue.completeCalls).toEqual([]);
		expect(store.getRunSnapshot("client-a", "run-claim-cas-miss")).toMatchObject({
			status: "running",
			workerId: "worker-race",
			updatedAt: "2026-07-08T09:04:10.000Z",
		});
	});

	it("emits cancelling before cancelled when only a post-step queue cancel key remains", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-post-step-cancel-key");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-post-step-cancel-key" }]);
		const events = new RecordingEventLog();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution: new QueuedCancelDuringExecution(queue, "client-a", "run-post-step-cancel-key"),
			workerId: "worker-a",
			now: timestampSequence(
				"2026-07-08T09:04:01.000Z",
				"2026-07-08T09:04:02.000Z",
				"2026-07-08T09:04:03.000Z",
				"2026-07-08T09:04:05.000Z",
			),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const phaseStatuses = store.committedEvents
			.filter((event) => event.type === "agent_v2.phase_changed")
			.map((event) => event.payload.status);
		expect(phaseStatuses).toEqual(["running", "cancelling", "cancelled"]);
		expect(store.getRunSnapshot("client-a", "run-post-step-cancel-key")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
		});
	});

	it("stop marks owned running and cancelling runs interrupted", async () => {
		const store = new MemoryWorkerStore();
		store.createOwnedActiveRun("client-a", "run-running", "running", "worker-a");
		store.createOwnedActiveRun("client-a", "run-cancelling", "cancelling", "worker-a");
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:04:00.000Z", "2026-07-08T09:04:01.000Z"),
		});

		await worker.start();
		await worker.stop();

		expect(store.getRunSnapshot("client-a", "run-running")).toMatchObject({ status: "interrupted" });
		expect(store.getRunSnapshot("client-a", "run-cancelling")).toMatchObject({ status: "interrupted" });
		expect(queue.closeCount).toBe(1);
	});

	it("recoverOwnedRuns requeues queue claims and interrupts owned active runs", async () => {
		const store = new MemoryWorkerStore();
		store.createOwnedActiveRun("client-a", "run-recover-running", "running", "worker-a");
		store.createOwnedActiveRun("client-a", "run-recover-cancelling", "cancelling", "worker-a");
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:05:00.000Z", "2026-07-08T09:05:01.000Z"),
		});

		await worker.recoverOwnedRuns();

		expect(queue.requeueActiveCalls).toEqual(["worker-a"]);
		expect(store.getRunSnapshot("client-a", "run-recover-running")).toMatchObject({ status: "interrupted" });
		expect(store.getRunSnapshot("client-a", "run-recover-cancelling")).toMatchObject({ status: "interrupted" });
	});

	it("recoverOwnedRuns durably schedules a recent crashed run for its next attempt", async () => {
		const store = new MemoryWorkerStore();
		store.createOwnedActiveRun("client-a", "run-recover-retry", "running", "worker-a");
		const queue = new RecordingQueue();
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([]),
			workerId: "worker-a",
			now: () => "2026-07-08T00:00:03.000Z",
		});

		await worker.recoverOwnedRuns();

		expect(store.getRunSnapshot("client-a", "run-recover-retry")).toMatchObject({
			status: "queued",
			attempt: 2,
			error: { data: expect.objectContaining({ autoRetryScheduled: true }) },
		});
		expect(queue.requeueActiveCalls).toEqual(["worker-a"]);
	});

	it("recoverOwnedRuns reclaims expired claims from other workers and does not overwrite terminal runs", async () => {
		const store = new MemoryWorkerStore();
		store.createOwnedActiveRun("client-a", "run-stale-running", "running", "worker-b");
		store.createQueuedRun("client-a", "run-stale-queued");
		store.createOwnedActiveRun("client-a", "run-terminal", "running", "worker-b");
		store.forceUpdate({
			clientId: "client-a",
			runId: "run-terminal",
			status: "succeeded",
			phase: "delivery",
			endedAt: "2026-07-08T09:06:30.000Z",
			updatedAt: "2026-07-08T09:06:30.000Z",
		});
		const queue = new RecordingQueue();
		queue.expiredClaims = [
			{
				clientId: "client-a",
				runId: "run-stale-running",
				workerId: "worker-b",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
			{
				clientId: "client-a",
				runId: "run-stale-queued",
				workerId: "worker-b",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
			{
				clientId: "client-a",
				runId: "run-terminal",
				workerId: "worker-b",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
		];
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-08T09:06:00.000Z", "2026-07-08T09:06:01.000Z"),
		});

		await worker.recoverOwnedRuns();

		expect(queue.releaseExpiredClaimsCalls).toBe(1);
		expect(queue.enqueuedClaims).toEqual([
			{ clientId: "client-a", runId: "run-stale-running" },
			{ clientId: "client-a", runId: "run-stale-queued" },
			{ clientId: "client-a", runId: "run-terminal" },
		]);
		expect(store.getRunSnapshot("client-a", "run-stale-running")).toMatchObject({ status: "interrupted" });
		expect(store.getRunSnapshot("client-a", "run-stale-queued")).toMatchObject({ status: "queued" });
		expect(store.getRunSnapshot("client-a", "run-terminal")).toMatchObject({ status: "succeeded" });
	});

	it("refreshes the queue lease while executing a claimed run", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-heartbeat");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-heartbeat" }]);
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: {
				executeNextTask: vi.fn(async () => {
					await new Promise((resolve) => {
						setTimeout(resolve, 40);
					});
					return { status: "complete", diagnosticIds: [] } satisfies AgentV2ExecutionStepResult;
				}),
			},
			workerId: "worker-a",
			now: timestampSequence(
				"2026-07-08T09:07:00.000Z",
				"2026-07-08T09:07:01.000Z",
				"2026-07-08T09:07:02.000Z",
				"2026-07-08T09:07:03.000Z",
			),
			leaseHeartbeatIntervalMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(45);
		await expect(processing).resolves.toBe(true);

		expect(queue.renewLeaseCalls.length).toBeGreaterThan(0);
		expect(queue.renewLeaseCalls).toContainEqual({
			clientId: "client-a",
			runId: "run-heartbeat",
			workerId: "worker-a",
		});
	});

	it("serializes lease and cancel control operations without accumulating stalled ticks", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-serial-control");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-serial-control" }]);
		queue.cancelOutcomes.push("stall");
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(40),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:00:00.000Z", "2026-07-15T01:00:01.000Z"),
			cancelPollIntervalMs: 5,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(15);
		queue.releaseStalls();
		await vi.advanceTimersByTimeAsync(40);
		await expect(processing).resolves.toBe(true);

		expect(queue.maxControlCallsInFlight).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-serial-control")).toMatchObject({ status: "interrupted" });
		expect(store.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "agent_v2.worker_cancel_poll_timeout",
				message: "Agent v2 cancellation monitoring timed out; the run was stopped safely.",
			}),
		);
	});

	it("confirms an uncertain renewal and immediately renews before continuing", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-renew-confirmed");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-renew-confirmed" }]);
		queue.renewOutcomes.push({ status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" });
		queue.confirmOutcomes.push("owned");
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(30),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:01:00.000Z", "2026-07-15T01:01:01.000Z", "2026-07-15T01:01:02.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(80);
		await expect(processing).resolves.toBe(true);

		expect(queue.confirmOwnershipCalls).toBeGreaterThan(0);
		expect(queue.renewLeaseCalls.length).toBeGreaterThanOrEqual(2);
		expect(store.getRunSnapshot("client-a", "run-renew-confirmed")).toMatchObject({ status: "succeeded" });
		expect(store.diagnostics).toContainEqual(expect.objectContaining({ code: "agent_v2.worker_lease_uncertain" }));
	});

	it("recovers a rejected renewal through the same bounded ownership confirmation", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-renew-rejected");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-renew-rejected" }]);
		queue.renewOutcomes.push(new Error("redis://user:secret@127.0.0.1/internal token=secret"));
		queue.confirmOutcomes.push("owned");
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(30),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:01:10.000Z", "2026-07-15T01:01:11.000Z", "2026-07-15T01:01:12.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(80);
		await expect(processing).resolves.toBe(true);

		expect(queue.confirmOwnershipCalls).toBeGreaterThan(0);
		expect(store.getRunSnapshot("client-a", "run-renew-rejected")).toMatchObject({ status: "succeeded" });
		const diagnostic = store.diagnostics.find((item) => item.code === "agent_v2.worker_lease_uncertain");
		expect(JSON.stringify(diagnostic)).not.toContain("secret");
		expect(JSON.stringify(diagnostic)).not.toContain("redis://");
	});

	it("fails closed without overlapping work when lease renewal stalls", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-renew-stall");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-renew-stall" }]);
		queue.renewOutcomes.push("stall");
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(40),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:01:20.000Z", "2026-07-15T01:01:21.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(20);
		queue.releaseStalls();
		await vi.advanceTimersByTimeAsync(30);
		await expect(processing).resolves.toBe(true);

		expect(queue.maxControlCallsInFlight).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-renew-stall")).toMatchObject({ status: "interrupted" });
		expect(store.diagnostics).toContainEqual(
			expect.objectContaining({ code: "agent_v2.worker_lease_renew_timeout" }),
		);
	});

	it("fails closed after bounded Redis ownership confirmation remains uncertain", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-uncertain-deadline");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-uncertain-deadline" }]);
		queue.claimLeaseMs = 20;
		queue.renewOutcomes.push({ status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" });
		queue.defaultConfirmOutcome = "uncertain";
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(40),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:02:00.000Z", "2026-07-15T01:02:01.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 5,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(100);
		await expect(processing).resolves.toBe(true);

		expect(queue.confirmOwnershipCalls).toBeGreaterThan(0);
		expect(store.getRunSnapshot("client-a", "run-uncertain-deadline")).toMatchObject({ status: "interrupted" });
		expect(store.diagnostics).toContainEqual(
			expect.objectContaining({ code: "agent_v2.worker_lease_confirmation_timeout" }),
		);
	});

	it("does not start the next execution step while exact ownership remains uncertain", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-uncertain-pauses-next-step");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-uncertain-pauses-next-step" }]);
		queue.renewOutcomes.push({ status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" });
		queue.confirmOutcomes.push("uncertain", "owned");
		const executeNextTask = vi
			.fn<AgentV2WorkerExecution["executeNextTask"]>()
			.mockImplementationOnce(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { status: "task_succeeded", taskId: "first", diagnosticIds: [] };
			})
			.mockResolvedValueOnce({ status: "complete", diagnosticIds: [] });
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: { executeNextTask },
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:02:10.000Z", "2026-07-15T01:02:11.000Z", "2026-07-15T01:02:12.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(20);
		expect(executeNextTask).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30);
		await expect(processing).resolves.toBe(true);
		expect(executeNextTask).toHaveBeenCalledTimes(2);
		expect(store.getRunSnapshot("client-a", "run-uncertain-pauses-next-step")).toMatchObject({
			status: "succeeded",
		});
	});

	it.each([
		["lost", "lost" as const, 30],
		["confirmation timeout", "stall" as const, 7],
	])("aborts in-flight execution before mutation when ownership ends %s", async (_case, confirmation, delayMs) => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", `run-inflight-${_case}`);
		const queue = new ControlledQueue([{ clientId: "client-a", runId: `run-inflight-${_case}` }]);
		queue.claimLeaseMs = 25;
		queue.renewOutcomes.push({ status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" });
		queue.confirmOutcomes.push(confirmation);
		let sentinelMutations = 0;
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: {
				executeNextTask: async ({ signal }) => {
					await abortableDelay(delayMs, signal);
					sentinelMutations += 1;
					return { status: "complete", diagnosticIds: [] };
				},
			},
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:02:20.000Z", "2026-07-15T01:02:21.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(40);
		queue.releaseStalls();
		await expect(processing).resolves.toBe(true);

		expect(sentinelMutations).toBe(0);
		expect(store.getRunSnapshot("client-a", `run-inflight-${_case}`)).toMatchObject({ status: "interrupted" });
		expect(queue.completeCalls).toEqual([]);
	});

	it("retries the same step after uncertain ownership is confirmed and renewed, with one mutation", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-inflight-owned-retry");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-inflight-owned-retry" }]);
		queue.renewOutcomes.push({ status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" });
		queue.confirmOutcomes.push("owned");
		let durableMutations = 0;
		const executeNextTask = vi.fn<AgentV2WorkerExecution["executeNextTask"]>(async ({ signal }) => {
			await abortableDelay(20, signal);
			durableMutations += 1;
			return { status: "complete", diagnosticIds: [] };
		});
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: { executeNextTask },
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:02:30.000Z", "2026-07-15T01:02:31.000Z", "2026-07-15T01:02:32.000Z"),
			cancelPollIntervalMs: 50,
			leaseHeartbeatIntervalMs: 5,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(50);
		await expect(processing).resolves.toBe(true);

		expect(executeNextTask).toHaveBeenCalledTimes(2);
		expect(durableMutations).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-inflight-owned-retry")).toMatchObject({ status: "succeeded" });
		expect(queue.completeCalls).toHaveLength(1);
	});

	it("reconfirms the same claim before a terminal commit and prevents stale success", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-terminal-ownership-gate");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-terminal-ownership-gate" }]);
		queue.defaultConfirmOutcome = "lost";
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:03:00.000Z", "2026-07-15T01:03:01.000Z"),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(queue.confirmOwnershipCalls).toBeGreaterThan(0);
		expect(store.getRunSnapshot("client-a", "run-terminal-ownership-gate")).toMatchObject({ status: "interrupted" });
		expect(store.committedEvents.some((event) => (event.payload as { status?: string }).status === "succeeded")).toBe(
			false,
		);
	});

	it("turns cancellation poll rejection into a sanitized canonical diagnostic", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-cancel-poll-reject");
		const queue = new ControlledQueue([{ clientId: "client-a", runId: "run-cancel-poll-reject" }]);
		queue.cancelOutcomes.push(new Error("redis://user:secret@127.0.0.1/internal claim-token=secret"));
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: delayedComplete(30),
			workerId: "worker-a",
			now: timestampSequence("2026-07-15T01:04:00.000Z", "2026-07-15T01:04:01.000Z"),
			cancelPollIntervalMs: 5,
			leaseHeartbeatIntervalMs: 50,
			controlOperationTimeoutMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(40);
		await expect(processing).resolves.toBe(true);

		expect(store.getRunSnapshot("client-a", "run-cancel-poll-reject")).toMatchObject({ status: "interrupted" });
		const diagnostic = store.diagnostics.find((item) => item.code === "agent_v2.worker_cancel_poll_failed");
		expect(diagnostic).toMatchObject({
			message: "Agent v2 cancellation monitoring failed; the run was stopped safely.",
		});
		expect(JSON.stringify(diagnostic)).not.toContain("secret");
		expect(JSON.stringify(diagnostic)).not.toContain("redis://");
	});

	it("interrupts a run and avoids stale success when lease renewal is lost during execution", async () => {
		vi.useFakeTimers();
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-lease-lost");
		const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-lease-lost" }]);
		queue.failNextRenewLease = true;
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: {
				executeNextTask: async () => {
					await new Promise((resolve) => setTimeout(resolve, 40));
					return { status: "complete", diagnosticIds: [] };
				},
			},
			workerId: "worker-a",
			now: timestampSequence("2026-07-09T01:00:00.000Z", "2026-07-09T01:00:01.000Z"),
			leaseHeartbeatIntervalMs: 10,
		});

		const processing = worker.processOne();
		await vi.advanceTimersByTimeAsync(45);
		await expect(processing).resolves.toBe(true);

		expect(store.getRunSnapshot("client-a", "run-lease-lost")).toMatchObject({
			status: "interrupted",
		});
		expect(queue.completeCalls).toEqual([]);
	});

	it("lets a replacement worker reclaim an expired queued claim after the first worker disappears", async () => {
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-reclaimed-by-replacement");
		const queue = new RecordingQueue();
		queue.expiredClaims = [
			{
				clientId: "client-a",
				runId: "run-reclaimed-by-replacement",
				workerId: "worker-crashed",
				claimedAtMs: 1,
				heartbeatAtMs: 2,
				leaseExpiresAtMs: 3,
			},
		];
		const replacement = new AgentV2WorkerService({
			store,
			queue,
			events: new RecordingEventLog(),
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-replacement",
			now: timestampSequence("2026-07-09T01:01:00.000Z", "2026-07-09T01:01:01.000Z"),
		});

		await replacement.recoverOwnedRuns();
		await expect(replacement.processOne()).resolves.toBe(true);

		expect(queue.enqueuedClaims).toEqual([{ clientId: "client-a", runId: "run-reclaimed-by-replacement" }]);
		expect(store.getRunSnapshot("client-a", "run-reclaimed-by-replacement")).toMatchObject({
			status: "succeeded",
			workerId: "worker-replacement",
		});
	});
});

class MemoryWorkerStore {
	readonly diagnostics: AgentV2DiagnosticEvent[] = [];
	readonly commitCalls: AgentV2RunTransitionCommitInput[] = [];
	readonly committedEvents: AgentV2RunEventRecord[] = [];
	readonly outboxIntentIds: string[] = [];
	readonly retryCommitCalls: AgentV2RunRetryCommitInput[] = [];
	rejectNextCommit: Error | undefined;
	simulateStaleTerminalOverwriteWithoutGuard = false;
	private readonly beforeUpdateCallbacks: Array<(input: Parameters<MemoryWorkerStore["update"]>[0]) => void> = [];
	private readonly commitGates = new Map<AgentV2RunStatus, Promise<void>>();
	private readonly commitRejections = new Map<AgentV2RunStatus, Error>();
	private readonly runs = new Map<string, AgentV2RunSnapshot>();
	private readonly staleReads = new Map<string, AgentV2RunSnapshot[]>();

	async createAgentV2Run(input: CreateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		const run = buildAgentV2Run(input);
		this.runs.set(runKey(run.clientId, run.runId), run);
		return run;
	}

	createQueuedRun(clientId: string, runId: string): AgentV2RunSnapshot {
		const run = buildAgentV2Run({
			clientId,
			runId,
			input: { objective: `objective:${runId}` },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		this.runs.set(runKey(clientId, runId), run);
		return run;
	}

	createOwnedActiveRun(
		clientId: string,
		runId: string,
		status: Extract<AgentV2RunStatus, "running" | "cancelling">,
		workerId: string,
	): void {
		this.createQueuedRun(clientId, runId);
		this.update({
			clientId,
			runId,
			status: "running",
			phase: "implementation",
			workerId,
			updatedAt: "2026-07-08T00:00:01.000Z",
			startedAt: "2026-07-08T00:00:01.000Z",
		});
		if (status === "cancelling") {
			this.update({
				clientId,
				runId,
				status: "cancelling",
				updatedAt: "2026-07-08T00:00:02.000Z",
			});
		}
	}

	getRunSnapshot(clientId: string, runId: string): AgentV2RunSnapshot | undefined {
		return this.runs.get(runKey(clientId, runId));
	}

	returnStaleSnapshotOnNextRead(snapshot: AgentV2RunSnapshot): void {
		const key = runKey(snapshot.clientId, snapshot.runId);
		const snapshots = this.staleReads.get(key) ?? [];
		snapshots.push(snapshot);
		this.staleReads.set(key, snapshots);
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		const key = runKey(clientId, runId);
		const staleSnapshots = this.staleReads.get(key);
		const staleSnapshot = staleSnapshots?.shift();
		if (staleSnapshots?.length === 0) this.staleReads.delete(key);
		if (staleSnapshot) return staleSnapshot;
		return this.getRunSnapshot(clientId, runId);
	}

	runBeforeNextUpdate(callback: (input: Parameters<MemoryWorkerStore["update"]>[0]) => void): void {
		this.beforeUpdateCallbacks.push(callback);
	}

	forceUpdate(input: Omit<Parameters<MemoryWorkerStore["update"]>[0], "expectedStatuses">): AgentV2RunSnapshot {
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return next;
	}

	update(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		attempt?: number;
		workerId?: string;
		updatedAt?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		expectedStatuses?: readonly AgentV2RunStatus[];
	}): AgentV2RunSnapshot {
		return this.updateWithResult(input).run;
	}

	updateWithResult(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		attempt?: number;
		workerId?: string;
		updatedAt?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		expectedStatuses?: readonly AgentV2RunStatus[];
	}): AgentV2RunUpdateResult {
		const beforeUpdate = this.beforeUpdateCallbacks.shift();
		beforeUpdate?.(input);
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
			return { run: current, applied: false };
		}
		if (
			this.simulateStaleTerminalOverwriteWithoutGuard &&
			!input.expectedStatuses &&
			current.status === "cancelling" &&
			(input.status === "succeeded" || input.status === "failed")
		) {
			const staleRunning = { ...current, status: "running" as const };
			const next = applyAgentV2RunUpdate(staleRunning, input);
			this.runs.set(runKey(input.clientId, input.runId), next);
			return { run: next, applied: true };
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return { run: next, applied: true };
	}

	async updateAgentV2Run(input: Parameters<MemoryWorkerStore["update"]>[0]): Promise<AgentV2RunSnapshot> {
		return this.update(input);
	}

	async updateAgentV2RunWithResult(
		input: Parameters<MemoryWorkerStore["update"]>[0],
	): Promise<AgentV2RunUpdateResult> {
		return this.updateWithResult(input);
	}

	holdCommitForStatus(status: AgentV2RunStatus, gate: Promise<void>): void {
		this.commitGates.set(status, gate);
	}

	rejectCommitForStatus(status: AgentV2RunStatus, error: Error): void {
		this.commitRejections.set(status, error);
	}

	async commitAgentV2RunTransition(input: AgentV2RunTransitionCommitInput): Promise<AgentV2RunTransitionCommitResult> {
		this.commitCalls.push(input);
		const rejection = this.rejectNextCommit;
		this.rejectNextCommit = undefined;
		if (rejection) throw rejection;
		const statusRejection = input.update.status ? this.commitRejections.get(input.update.status) : undefined;
		if (statusRejection) {
			this.commitRejections.delete(input.update.status as AgentV2RunStatus);
			throw statusRejection;
		}
		const gate = input.update.status ? this.commitGates.get(input.update.status) : undefined;
		if (gate) {
			this.commitGates.delete(input.update.status as AgentV2RunStatus);
			await gate;
		}
		const current = this.getRunSnapshot(input.update.clientId, input.update.runId);
		if (!current) throw new Error(`Missing run ${input.update.clientId}/${input.update.runId}`);
		const expected = input.expectedRun;
		if (
			current.status !== expected.status ||
			current.phase !== expected.phase ||
			current.attempt !== expected.attempt ||
			(current.workerId ?? null) !== expected.workerId ||
			current.updatedAt !== expected.updatedAt
		) {
			return { update: { run: current, applied: false }, outboxIntentIds: [] };
		}
		const update = this.updateWithResult(input.update);
		if (!update.applied) return { update, outboxIntentIds: [] };
		const event: AgentV2RunEventRecord = {
			clientId: update.run.clientId,
			runId: update.run.runId,
			seq: this.committedEvents.length + 1,
			type: String(input.event.type),
			payload: input.event.payload as Record<string, unknown>,
			createdAt: typeof input.event.createdAt === "string" ? input.event.createdAt : update.run.updatedAt,
		};
		this.committedEvents.push(event);
		const outboxIntentId = `live:${event.runId}:${event.seq}`;
		this.outboxIntentIds.push(outboxIntentId);
		if (input.diagnostic) this.diagnostics.push(input.diagnostic);
		return { update, event, outboxIntentIds: [outboxIntentId] };
	}

	async commitAgentV2RunRetry(input: AgentV2RunRetryCommitInput): Promise<AgentV2RunRetryCommitResult> {
		this.retryCommitCalls.push(input);
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		const expected = input.expectedRun;
		if (
			current.status !== expected.status ||
			current.phase !== expected.phase ||
			current.attempt !== expected.attempt ||
			(current.workerId ?? null) !== expected.workerId ||
			current.updatedAt !== expected.updatedAt ||
			input.expectedTasks.length > 0 ||
			input.tasks.length > 0
		) {
			return { update: { run: current, applied: false }, outboxIntentIds: [] };
		}
		const update = this.updateWithResult({
			clientId: input.clientId,
			runId: input.runId,
			status: "queued",
			expectedStatuses: ["running"],
			phase: input.phase,
			attempt: input.nextAttempt,
			updatedAt: input.scheduledAt,
			error: input.error,
		});
		if (!update.applied) return { update, outboxIntentIds: [] };
		this.diagnostics.push(input.diagnostic);
		const event: AgentV2RunEventRecord = {
			clientId: input.clientId,
			runId: input.runId,
			seq: this.committedEvents.length + 1,
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: input.phase,
				status: "queued",
				attempt: input.nextAttempt,
				at: input.scheduledAt,
			},
			createdAt: input.scheduledAt,
		};
		this.committedEvents.push(event);
		const outboxIntentIds = [
			`live:${input.runId}:${event.seq}`,
			`diagnostic:${input.diagnostic.diagnosticId}`,
			`enqueue:${input.runId}:${input.nextAttempt}`,
		];
		this.outboxIntentIds.push(...outboxIntentIds);
		return { update, event, outboxIntentIds };
	}

	async commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): Promise<AgentV2DiagnosticCommitResult> {
		this.diagnostics.push(input.diagnostic);
		let event: AgentV2RunEventRecord | undefined;
		const outboxIntentIds = [`diagnostic:${input.diagnostic.diagnosticId}`];
		if (input.emitRunEvent) {
			event = {
				clientId: input.diagnostic.clientId,
				runId: input.diagnostic.runId,
				seq: this.committedEvents.length + 1,
				type: "agent_v2.diagnostic_recorded",
				payload: {
					type: "agent_v2.diagnostic_recorded",
					diagnosticId: input.diagnostic.diagnosticId,
					severity: input.diagnostic.severity,
					code: input.diagnostic.code,
					message: input.diagnostic.message,
					at: input.diagnostic.createdAt,
				},
				createdAt: input.diagnostic.createdAt,
			};
			this.committedEvents.push(event);
			outboxIntentIds.push(`live:${event.runId}:${event.seq}`);
		}
		this.outboxIntentIds.push(...outboxIntentIds);
		return { diagnostic: input.diagnostic, ...(event ? { event } : {}), outboxIntentIds };
	}

	async listAgentV2RunsByWorker(workerId: string): Promise<AgentV2RunSnapshot[]> {
		return [...this.runs.values()].filter(
			(run) => run.workerId === workerId && (run.status === "running" || run.status === "cancelling"),
		);
	}

	async listAgentV2Runs(clientId: string): Promise<AgentV2RunSnapshot[]> {
		return [...this.runs.values()].filter((run) => run.clientId === clientId);
	}

	async appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): Promise<AgentV2DiagnosticEvent> {
		this.diagnostics.push(input);
		return input;
	}
}

class RecordingQueue implements AgentV2RunQueue {
	readonly completeCalls: Array<{ clientId: string; runId: string; workerId: string }> = [];
	readonly completedClaims: AgentV2ClaimedRun[] = [];
	readonly enqueuedClaims: Array<{ clientId: string; runId: string }> = [];
	readonly operations: string[] = [];
	readonly requeueActiveCalls: string[] = [];
	readonly renewLeaseCalls: Array<{ clientId: string; runId: string; workerId: string }> = [];
	expiredClaims: Array<Omit<AgentV2ActiveRunClaim, "claimToken"> & { claimToken?: string }> = [];
	failNextRenewLease = false;
	failNextRequeueExpiredClaims: Error | undefined;
	holdReleaseExpiredClaims = false;
	releaseExpiredClaimsCalls = 0;
	private readonly cancelRequested = new Set<string>();
	private closed = false;
	closeCount = 0;
	claimCount = 0;

	constructor(
		private readonly claims: Array<{ clientId: string; runId: string }> = [],
		private readonly options: { throwOnCompleteAfterClose?: boolean } = {},
	) {}

	async enqueue(run: { clientId: string; runId: string }): Promise<"enqueued"> {
		this.enqueuedClaims.push(run);
		this.claims.push(run);
		return "enqueued";
	}

	async claim(workerId: string): Promise<AgentV2ClaimedRun | undefined> {
		this.claimCount += 1;
		const run = this.claims.shift();
		return run
			? { ...run, workerId, claimToken: `recording-${this.claimCount}`, leaseExpiresAtMs: Date.now() + 30_000 }
			: undefined;
	}

	async complete(claim: AgentV2ClaimedRun): Promise<boolean> {
		if (this.closed && this.options.throwOnCompleteAfterClose) {
			throw new Error("Run queue is closed");
		}
		this.operations.push(`complete:${claim.clientId}:${claim.runId}`);
		this.completeCalls.push({ clientId: claim.clientId, runId: claim.runId, workerId: claim.workerId });
		this.completedClaims.push(claim);
		return true;
	}

	async confirmOwnership(): ReturnType<AgentV2RunQueue["confirmOwnership"]> {
		return "owned";
	}

	async requeueActive(workerId: string): Promise<number> {
		this.requeueActiveCalls.push(workerId);
		return 2;
	}

	async renewLease(claim: AgentV2ClaimedRun): ReturnType<AgentV2RunQueue["renewLease"]> {
		this.renewLeaseCalls.push({ clientId: claim.clientId, runId: claim.runId, workerId: claim.workerId });
		if (this.failNextRenewLease) {
			this.failNextRenewLease = false;
			return { status: "lost" as const };
		}
		return { status: "renewed" as const, leaseExpiresAtMs: claim.leaseExpiresAtMs + 30_000 };
	}

	async requeueExpiredClaims(): Promise<AgentV2ClaimedRun[]> {
		this.releaseExpiredClaimsCalls += 1;
		if (this.failNextRequeueExpiredClaims) {
			const error = this.failNextRequeueExpiredClaims;
			this.failNextRequeueExpiredClaims = undefined;
			throw error;
		}
		if (this.holdReleaseExpiredClaims) return await new Promise<AgentV2ClaimedRun[]>(() => undefined);
		const expired = this.expiredClaims.map((claim, index) => ({
			clientId: claim.clientId,
			runId: claim.runId,
			workerId: claim.workerId,
			claimToken: claim.claimToken ?? `expired-${index}`,
			leaseExpiresAtMs: claim.leaseExpiresAtMs,
		}));
		for (const claim of expired) {
			const identity = { clientId: claim.clientId, runId: claim.runId };
			this.enqueuedClaims.push(identity);
			this.claims.push(identity);
		}
		this.expiredClaims = [];
		return expired;
	}

	async requestCancel(run: { clientId: string; runId: string }, cancelToken: string): Promise<"requested"> {
		this.cancelRequested.add(runKey(run.clientId, run.runId));
		void cancelToken;
		return "requested";
	}

	async isCancelRequested(run: { clientId: string; runId: string }): Promise<boolean> {
		return this.cancelRequested.has(runKey(run.clientId, run.runId));
	}

	async clear(): Promise<{ queueItemsDeleted: number; activeClaimsDeleted: number; cancelKeysDeleted: number }> {
		return { queueItemsDeleted: 0, activeClaimsDeleted: 0, cancelKeysDeleted: 0 };
	}

	async close(): Promise<void> {
		this.closed = true;
		this.closeCount += 1;
		this.operations.push("close");
	}

	async waitForReleaseExpiredClaimsCalls(count: number): Promise<void> {
		while (this.releaseExpiredClaimsCalls < count) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
}

type ControlledRenewOutcome = Awaited<ReturnType<AgentV2RunQueue["renewLease"]>> | Error | "stall";
type ControlledConfirmOutcome = Awaited<ReturnType<AgentV2RunQueue["confirmOwnership"]>> | Error | "stall";
type ControlledCancelOutcome = boolean | Error | "stall";

class ControlledQueue extends RecordingQueue {
	claimLeaseMs = 30_000;
	confirmOwnershipCalls = 0;
	controlCallsInFlight = 0;
	defaultConfirmOutcome: ControlledConfirmOutcome = "owned";
	maxControlCallsInFlight = 0;
	readonly cancelOutcomes: ControlledCancelOutcome[] = [];
	readonly confirmOutcomes: ControlledConfirmOutcome[] = [];
	readonly renewOutcomes: ControlledRenewOutcome[] = [];
	private readonly stallResolvers: Array<() => void> = [];

	override async claim(workerId: string): Promise<AgentV2ClaimedRun | undefined> {
		const claim = await super.claim(workerId);
		return claim ? { ...claim, leaseExpiresAtMs: Date.now() + this.claimLeaseMs } : undefined;
	}

	override async confirmOwnership(): Promise<"owned" | "lost" | "uncertain"> {
		this.confirmOwnershipCalls += 1;
		return await this.controlled(this.confirmOutcomes.shift() ?? this.defaultConfirmOutcome);
	}

	override async renewLease(claim: AgentV2ClaimedRun) {
		this.renewLeaseCalls.push({ clientId: claim.clientId, runId: claim.runId, workerId: claim.workerId });
		return await this.controlled(
			this.renewOutcomes.shift() ?? { status: "renewed" as const, leaseExpiresAtMs: Date.now() + this.claimLeaseMs },
		);
	}

	override async isCancelRequested(): Promise<boolean> {
		return await this.controlled(this.cancelOutcomes.shift() ?? false);
	}

	releaseStalls(): void {
		for (const resolve of this.stallResolvers.splice(0)) resolve();
	}

	private async controlled<T>(outcome: T | Error | "stall"): Promise<T> {
		this.controlCallsInFlight += 1;
		this.maxControlCallsInFlight = Math.max(this.maxControlCallsInFlight, this.controlCallsInFlight);
		try {
			if (outcome === "stall") await new Promise<void>((resolve) => this.stallResolvers.push(resolve));
			if (outcome instanceof Error) throw outcome;
			return (outcome === "stall" ? false : outcome) as T;
		} finally {
			this.controlCallsInFlight -= 1;
		}
	}
}

function delayedComplete(delayMs: number): AgentV2WorkerExecution {
	return {
		executeNextTask: async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return { status: "complete", diagnosticIds: [] };
		},
	};
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

class RecordingEventLog implements Pick<AgentV2RunEventLog, "append"> {
	readonly appendCalls: AppendAgentV2RunEventInput[] = [];

	async append(input: AppendAgentV2RunEventInput) {
		this.appendCalls.push(input);
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: this.appendCalls.length,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		};
	}

	async list(): Promise<AgentV2RunEventRecord[]> {
		return [];
	}
}

class SequencedExecution {
	private index = 0;

	constructor(private readonly steps: AgentV2ExecutionStepResult[]) {}

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		return this.steps[this.index++] ?? { status: "complete", diagnosticIds: [] };
	}
}

class CountingExecution {
	callCount = 0;

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		this.callCount += 1;
		return { status: "complete", diagnosticIds: [] };
	}
}

class ThrowingExecution {
	constructor(private readonly error: Error) {}

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		throw this.error;
	}
}

class AbortAwareExecution {
	abortCount = 0;

	async executeNextTask(input: { signal: AbortSignal }): Promise<AgentV2ExecutionStepResult> {
		return await new Promise<AgentV2ExecutionStepResult>((_, reject) => {
			input.signal.addEventListener(
				"abort",
				() => {
					this.abortCount += 1;
					reject(new Error("execution aborted"));
				},
				{ once: true },
			);
		});
	}
}

class DelayedAbortExecution {
	abortCount = 0;

	constructor(private readonly delayMs: number) {}

	async executeNextTask(input: { signal: AbortSignal }): Promise<AgentV2ExecutionStepResult> {
		return await new Promise<AgentV2ExecutionStepResult>((_, reject) => {
			input.signal.addEventListener(
				"abort",
				() => {
					this.abortCount += 1;
					setTimeout(() => reject(new Error("execution aborted")), this.delayMs);
				},
				{ once: true },
			);
		});
	}
}

class ExternalCancellingExecution {
	constructor(
		private readonly store: MemoryWorkerStore,
		private readonly clientId: string,
		private readonly runId: string,
	) {}

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		await this.store.updateAgentV2Run({
			clientId: this.clientId,
			runId: this.runId,
			status: "cancelling",
			updatedAt: "2026-07-08T09:03:31.000Z",
		});
		return { status: "complete", diagnosticIds: [] };
	}
}

class StaleFinalReadCancellationExecution {
	constructor(
		private readonly store: MemoryWorkerStore,
		private readonly clientId: string,
		private readonly runId: string,
	) {}

	async executeNextTask(input: { run: AgentV2RunSnapshot }): Promise<AgentV2ExecutionStepResult> {
		await this.store.updateAgentV2Run({
			clientId: this.clientId,
			runId: this.runId,
			status: "cancelling",
			updatedAt: "2026-07-08T09:03:34.000Z",
		});
		this.store.returnStaleSnapshotOnNextRead(input.run);
		return { status: "complete", diagnosticIds: [] };
	}
}

class ExternalInterruptedExecution {
	constructor(
		private readonly store: MemoryWorkerStore,
		private readonly queue: RecordingQueue,
		private readonly clientId: string,
		private readonly runId: string,
	) {}

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		await this.queue.requestCancel({ clientId: this.clientId, runId: this.runId }, "cancel-race");
		await this.store.updateAgentV2Run({
			clientId: this.clientId,
			runId: this.runId,
			status: "interrupted",
			updatedAt: "2026-07-08T09:03:41.000Z",
			endedAt: "2026-07-08T09:03:41.000Z",
		});
		return { status: "complete", diagnosticIds: [] };
	}
}

class QueuedCancelDuringExecution {
	constructor(
		private readonly queue: RecordingQueue,
		private readonly clientId: string,
		private readonly runId: string,
	) {}

	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		await this.queue.requestCancel({ clientId: this.clientId, runId: this.runId }, "cancel-cas");
		return { status: "complete", diagnosticIds: [] };
	}
}

function runKey(clientId: string, runId: string): string {
	return `${clientId}:${runId}`;
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => {
		const value = timestamps[index] ?? timestamps[timestamps.length - 1] ?? "2026-07-08T00:00:00.000Z";
		index += 1;
		return value;
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
