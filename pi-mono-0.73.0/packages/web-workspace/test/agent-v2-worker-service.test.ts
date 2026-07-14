import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2ActiveRunClaim, AgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import {
	type AgentV2RunEventRecord,
	type AgentV2RunUpdateResult,
	type AppendAgentV2RunEventInput,
	applyAgentV2RunUpdate,
	buildAgentV2Run,
	type CreateAgentV2RunInput,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2RunStatus } from "../src/agent-v2-types.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";

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
		expect(events.appendCalls).toEqual([
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

	it("stores terminal failures as v2 errors and emits diagnostic events", async () => {
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
				message: "execution exploded",
				runId: "run-failed",
			}),
		]);
		expect(events.appendCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "agent_v2.diagnostic_recorded",
					payload: expect.objectContaining({
						type: "agent_v2.diagnostic_recorded",
						code: "agent_v2.worker_execution_failed",
						message: "execution exploded",
					}),
				}),
			]),
		);
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
			void queue.requestCancel({ clientId: "client-a", runId: "run-cancel-during-execution" });
		}, 10);

		await expect(worker.processOne()).resolves.toBe(true);
		expect(execution.abortCount).toBe(1);
		expect(store.getRunSnapshot("client-a", "run-cancel-during-execution")).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
		});
		expect(events.appendCalls).toEqual(
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
		expect(events.appendCalls).toEqual(
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
		expect(events.appendCalls).not.toEqual(
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
		await queue.requestCancel({ clientId: "client-a", runId: "run-stop-cancel-race" });
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
		await queue.requestCancel({ clientId: "client-a", runId: "run-poll-cas-miss" });
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

		const phaseStatuses = events.appendCalls
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
		expect(events.appendCalls.filter((event) => event.type === "agent_v2.phase_changed")).toEqual([]);
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

		const phaseStatuses = events.appendCalls
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
		expect(queue.enqueuedClaims).toEqual([{ clientId: "client-a", runId: "run-stale-queued" }]);
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
		expect(queue.completeCalls).toEqual([{ clientId: "client-a", runId: "run-lease-lost", workerId: "worker-a" }]);
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
	simulateStaleTerminalOverwriteWithoutGuard = false;
	private readonly beforeUpdateCallbacks: Array<(input: Parameters<MemoryWorkerStore["update"]>[0]) => void> = [];
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
	readonly enqueuedClaims: Array<{ clientId: string; runId: string }> = [];
	readonly operations: string[] = [];
	readonly requeueActiveCalls: string[] = [];
	readonly renewLeaseCalls: Array<{ clientId: string; runId: string; workerId: string }> = [];
	expiredClaims: AgentV2ActiveRunClaim[] = [];
	failNextRenewLease = false;
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

	async enqueue(run: { clientId: string; runId: string }): Promise<void> {
		this.enqueuedClaims.push(run);
		this.claims.push(run);
	}

	async claim(): Promise<{ clientId: string; runId: string } | undefined> {
		this.claimCount += 1;
		return this.claims.shift();
	}

	async complete(run: { clientId: string; runId: string }, workerId: string): Promise<void> {
		if (this.closed && this.options.throwOnCompleteAfterClose) {
			throw new Error("Run queue is closed");
		}
		this.operations.push(`complete:${run.clientId}:${run.runId}`);
		this.completeCalls.push({ ...run, workerId });
	}

	async requeueActive(workerId: string): Promise<number> {
		this.requeueActiveCalls.push(workerId);
		return 2;
	}

	async renewLease(run: { clientId: string; runId: string }, workerId: string): Promise<boolean> {
		this.renewLeaseCalls.push({ ...run, workerId });
		if (this.failNextRenewLease) {
			this.failNextRenewLease = false;
			return false;
		}
		return true;
	}

	async releaseExpiredClaims(): Promise<AgentV2ActiveRunClaim[]> {
		this.releaseExpiredClaimsCalls += 1;
		if (this.holdReleaseExpiredClaims) return await new Promise<AgentV2ActiveRunClaim[]>(() => undefined);
		const expired = [...this.expiredClaims];
		this.expiredClaims = [];
		return expired;
	}

	async requestCancel(run: { clientId: string; runId: string }): Promise<void> {
		this.cancelRequested.add(runKey(run.clientId, run.runId));
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
		await this.queue.requestCancel({ clientId: this.clientId, runId: this.runId });
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
		await this.queue.requestCancel({ clientId: this.clientId, runId: this.runId });
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
