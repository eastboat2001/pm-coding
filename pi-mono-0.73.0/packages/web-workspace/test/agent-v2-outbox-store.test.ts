import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import {
	type AgentV2DurableCommitStore,
	type AgentV2StartRunCommitInput,
	agentV2StartReplayFingerprint,
} from "../src/agent-v2-durable-store.js";
import type { AgentV2OutboxStore } from "../src/agent-v2-outbox.js";
import { agentV2OutboxIntentId } from "../src/agent-v2-outbox.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];
const storeFiles = new WeakMap<RuntimeDbStore, string>();

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent v2 durable commit and outbox store", () => {
	it("commits start, immutable inputs, contiguous events and canonical intents atomically", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:00:00.000Z";
		const result = store.commitAgentV2RunStart({
			run: {
				clientId: "client-a",
				runId: "run-a",
				input: { prompt: "build" },
				model: { provider: "test" },
				createdAt,
				updatedAt: createdAt,
			},
			bootstrapVersion: "1",
			bootstrapChecksum: "bootstrap-sha",
			inputBlobs: [
				{
					clientId: "client-a",
					runId: "run-a",
					inputId: "input-a",
					logicalPath: "assets/a.txt",
					mediaType: "text/plain",
					encoding: "utf8",
					bytes: new Uint8Array([97]),
					byteLength: 1,
					checksum: "input-sha",
					createdAt,
				},
			],
			inputReferences: [
				{
					clientId: "client-a",
					runId: "run-a",
					kind: "attachment",
					ordinal: 0,
					inputId: "input-a",
					logicalPath: "assets/a.txt",
					displayName: "a.txt",
					mediaType: "text/plain",
					byteLength: 1,
					checksum: "input-sha",
				},
			],
			readyPhase: "implementation",
			documents: [],
			tasks: [],
			artifacts: [],
			diagnostics: [],
			queueName: "agent-v2",
			createdAt,
		});

		expect(result.replayed).toBe(false);
		expect([result.runCreatedEvent.seq, result.planningReadyEvent.seq]).toEqual([1, 2]);
		expect(result.outboxIntentIds).toEqual([
			agentV2OutboxIntentId("live_event:client-a:run-a:1"),
			agentV2OutboxIntentId("live_event:client-a:run-a:2"),
			agentV2OutboxIntentId("run_enqueue:client-a:run-a:agent-v2"),
		]);
		expect(store.listAgentV2InputReferences("client-a", "run-a")).toHaveLength(1);
		const blob = store.readAgentV2InputBlob("client-a", "run-a", "input-a");
		expect(blob?.bytes).toEqual(new Uint8Array([97]));
		blob?.bytes.fill(0);
		expect(store.readAgentV2InputBlob("client-a", "run-a", "input-a")?.bytes).toEqual(new Uint8Array([97]));

		const replay = store.commitAgentV2RunStart({
			...startReplayInput(createdAt),
		});
		expect(replay.replayed).toBe(true);
		expect(replay.outboxIntentIds).toEqual(result.outboxIntentIds);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toHaveLength(2);
		expect(() =>
			store.commitAgentV2RunStart({
				...startReplayInput(createdAt),
				run: { ...startReplayInput(createdAt).run, input: { prompt: "different" } },
			}),
		).toThrow("replay conflict");
	});

	it("leases in canonical order, recovers expiry, enforces ownership and dead-letters", () => {
		const store = createStore();
		store.commitAgentV2RunStart(startReplayInput("2026-07-13T10:00:00.000Z"));
		const leased = store.leaseAgentV2Outbox({
			ownerId: "owner-a",
			limit: 2,
			now: "2026-07-13T10:00:01.000Z",
			leaseTtlMs: 1000,
		});
		expect(leased).toHaveLength(2);
		expect(leased.map((intent) => intent.attemptCount)).toEqual([1, 1]);
		expect(() =>
			store.markAgentV2OutboxDelivered({
				intentId: leased[0].intentId,
				ownerId: "",
				leaseAttempt: leased[0].attemptCount,
				deliveredAt: "2026-07-13T10:00:01.050Z",
			}),
		).toThrow("ownerId");
		expect(
			store.markAgentV2OutboxDelivered({
				intentId: leased[0].intentId,
				ownerId: "owner-b",
				leaseAttempt: leased[0].attemptCount,
				deliveredAt: "2026-07-13T10:00:01.100Z",
			}),
		).toBe("lease_lost");
		expect(
			store.rescheduleAgentV2Outbox({
				intentId: leased[0].intentId,
				ownerId: "owner-a",
				leaseAttempt: leased[0].attemptCount,
				availableAt: "2026-07-13T10:00:02.000Z",
				errorCode: "dispatch.failed",
				errorMessage: "retry",
				maxAttempts: 1,
				updatedAt: "2026-07-13T10:00:01.200Z",
			}),
		).toBe("dead_letter");
		const recovered = store.leaseAgentV2Outbox({
			ownerId: "owner-b",
			limit: 10,
			now: "2026-07-13T10:00:03.000Z",
			leaseTtlMs: 1000,
		});
		expect(recovered.every((intent) => intent.intentId !== leased[0].intentId)).toBe(true);
		expect(recovered.some((intent) => intent.attemptCount === 2)).toBe(true);
	});

	it("treats semantically identical JSON with different key order as an idempotent replay", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:30:00.000Z";
		const first = startReplayInput(createdAt) as AgentV2StartRunCommitInput;
		first.run.model = { z: 1, a: { y: 2, x: 3 } };
		store.commitAgentV2RunStart(first);
		const replay = startReplayInput(createdAt) as AgentV2StartRunCommitInput;
		replay.run.model = { a: { x: 3, y: 2 }, z: 1 };
		expect(store.commitAgentV2RunStart(replay).replayed).toBe(true);
	});

	it("replays the immutable start contract after run progress and rejects a different queue", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:40:00.000Z";
		const initial = store.commitAgentV2RunStart(startReplayInput(createdAt));
		const current = store.getAgentV2Run("client-a", "run-a");
		if (!current) throw new Error("expected run");
		store.commitAgentV2RunTransition({
			expectedRun: expectedRunState(current),
			update: {
				clientId: "client-a",
				runId: "run-a",
				expectedStatuses: ["queued"],
				status: "running",
				updatedAt: "2026-07-13T10:40:01.000Z",
			},
			event: { type: "run_started", payload: {}, createdAt: "2026-07-13T10:40:01.000Z" },
		});

		const replay = store.commitAgentV2RunStart(startReplayInput(createdAt));
		expect(replay.replayed).toBe(true);
		expect(replay.outboxIntentIds).toEqual(initial.outboxIntentIds);
		expect(replay.outboxIntentIds).not.toContain(agentV2OutboxIntentId("live_event:client-a:run-a:3"));
		expect(() =>
			store.commitAgentV2RunStart({ ...startReplayInput(createdAt), queueName: "different-queue" }),
		).toThrow("replay conflict");
	});

	it("atomically schedules an attempt-keyed durable retry that is unavailable before retryAt", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:50:00.000Z";
		store.commitAgentV2RunStart(startReplayInput(createdAt));
		const initialEnqueue = store.leaseAgentV2Outbox({
			ownerId: "dispatcher-a",
			kinds: ["run_enqueue"],
			limit: 1,
			now: createdAt,
			leaseTtlMs: 30_000,
		})[0]!;
		store.markAgentV2OutboxDelivered({
			intentId: initialEnqueue.intentId,
			ownerId: "dispatcher-a",
			leaseAttempt: initialEnqueue.attemptCount,
			deliveredAt: "2026-07-13T10:50:00.100Z",
		});
		const queued = store.getAgentV2Run("client-a", "run-a")!;
		const startedAt = "2026-07-13T10:50:01.000Z";
		const started = store.commitAgentV2RunTransition({
			expectedRun: expectedRunState(queued),
			update: {
				clientId: "client-a",
				runId: "run-a",
				expectedStatuses: ["queued"],
				status: "running",
				phase: "implementation",
				workerId: "worker-a",
				startedAt,
				updatedAt: startedAt,
			},
			event: { type: "run_started", payload: {}, createdAt: startedAt },
		}).update.run;
		expect(() =>
			store.commitAgentV2RunTransition({
				expectedRun: expectedRunState(started),
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["running"],
					status: "queued",
					updatedAt: "2026-07-13T10:50:01.250Z",
				},
				event: { type: "invalid_retry", payload: {}, createdAt: "2026-07-13T10:50:01.250Z" },
			}),
		).toThrow("commitAgentV2RunRetry");
		const failedTask = store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-a",
			taskId: "implementation",
			kind: "implementation",
			title: "Build app",
			status: "failed",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			error: { code: "provider_timeout", message: "Provider timed out", retryable: true },
			createdAt: startedAt,
			updatedAt: "2026-07-13T10:50:01.500Z",
		});
		expect(store.getAgentV2Run("client-a", "run-a")).toEqual(started);
		expect(store.listAgentV2Tasks("client-a", "run-a")).toEqual([failedTask]);
		const scheduledAt = "2026-07-13T10:50:02.000Z";
		const retryAt = "2026-07-13T10:50:12.000Z";
		const diagnostic = createAgentV2DiagnosticEvent({
			diagnosticId: "retry:run-a:2",
			clientId: "client-a",
			runId: "run-a",
			severity: "warn",
			category: "worker",
			code: "agent_v2.run_retry_scheduled",
			phase: "implementation",
			message: "Retry scheduled",
			data: { retryAt },
			createdAt: scheduledAt,
		});
		const retry = store.commitAgentV2RunRetry({
			clientId: "client-a",
			runId: "run-a",
			expectedRun: expectedRunState(started),
			expectedTasks: [
				{ taskId: failedTask.taskId, status: failedTask.status, updatedAt: failedTask.updatedAt },
			],
			tasks: [
				{
					...failedTask,
					clientId: "client-a",
					runId: "run-a",
					status: "ready",
					error: undefined,
					updatedAt: scheduledAt,
				},
			],
			phase: "implementation",
			nextAttempt: 2,
			maxAttempts: 4,
			retryWindowMs: 15 * 60 * 1_000,
			queueName: "agent-v2",
			retryAt,
			scheduledAt,
			error: { code: "provider_timeout", message: "Provider timed out", retryable: true, data: { retryAt } },
			diagnostic,
		});

		expect(retry.update).toMatchObject({ applied: true, run: { status: "queued", attempt: 2 } });
		expect(retry.update.run.workerId).toBeUndefined();
		expect(store.listAgentV2Tasks("client-a", "run-a")[0]).toMatchObject({
			taskId: "implementation",
			status: "ready",
		});
		expect(store.listAgentV2Tasks("client-a", "run-a")[0]?.error).toBeUndefined();
		expect(retry.outboxIntentIds).toContain(
			agentV2OutboxIntentId("run_enqueue:client-a:run-a:agent-v2:attempt:2"),
		);
		expect(
			store.leaseAgentV2Outbox({
				ownerId: "dispatcher-a",
				kinds: ["run_enqueue"],
				limit: 1,
				now: "2026-07-13T10:50:11.999Z",
				leaseTtlMs: 30_000,
			}),
		).toEqual([]);
		expect(
			store.leaseAgentV2Outbox({
				ownerId: "dispatcher-a",
				kinds: ["run_enqueue"],
				limit: 1,
				now: retryAt,
				leaseTtlMs: 30_000,
			})[0]?.reference,
		).toEqual({ kind: "run_enqueue", queueName: "agent-v2", attempt: 2 });
	});

	it("compares every rich immutable start child and returns its exact intent set", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:45:00.000Z";
		const input = richStartReplayInput(createdAt);
		const fingerprint = agentV2StartReplayFingerprint(input);
		const created = store.commitAgentV2RunStart(input);
		expect(created.runCreatedEvent.payload).toEqual({
			type: "agent_v2.run_created",
			status: "queued",
			phase: "intake",
			attempt: 1,
			at: createdAt,
		});
		const publicEvents = JSON.stringify(store.listAgentV2RunEvents("client-a", "run-a", 0));
		for (const privateValue of ["# Spec", "assets/a.txt", input.bootstrapChecksum, fingerprint]) {
			expect(publicEvents).not.toContain(privateValue);
		}
		expect(readSqliteBootstrapChecksum(store, "client-a", "run-a")).toBe(fingerprint);
		expect(readSqliteBootstrapChecksum(store, "client-a", "run-a")).not.toBe(input.bootstrapChecksum);
		expect(store.commitAgentV2RunStart(richStartReplayInput(createdAt)).outboxIntentIds).toEqual(
			created.outboxIntentIds,
		);
		expect(created.outboxIntentIds).toHaveLength(5);

		const variants: Array<[string, (candidate: ReturnType<typeof richStartReplayInput>) => void]> = [
			[
				"bootstrap",
				(candidate) => {
					candidate.bootstrapChecksum = "different";
				},
			],
			[
				"blob",
				(candidate) => {
					candidate.inputBlobs[0]!.bytes = new Uint8Array([98]);
				},
			],
			[
				"reference",
				(candidate) => {
					candidate.inputReferences[0]!.displayName = "different.txt";
				},
			],
			[
				"document",
				(candidate) => {
					candidate.documents[0]!.contentMarkdown = "# Different";
				},
			],
			[
				"task",
				(candidate) => {
					candidate.tasks[0]!.title = "Different";
				},
			],
			[
				"artifact",
				(candidate) => {
					candidate.artifacts[0]!.checksum = "different";
				},
			],
			[
				"diagnostic",
				(candidate) => {
					candidate.diagnostics[0]!.message = "different";
				},
			],
			[
				"queue",
				(candidate) => {
					candidate.queueName = "different";
				},
			],
		];
		for (const [label, mutate] of variants) {
			const candidate = richStartReplayInput(createdAt);
			mutate(candidate);
			expect(() => store.commitAgentV2RunStart(candidate), label).toThrow("replay conflict");
		}
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toHaveLength(2);
	});

	it("rejects a cross-run transition diagnostic before any dependent write", () => {
		const store = createStore();
		const createdAt = "2026-07-13T10:50:00.000Z";
		store.commitAgentV2RunStart(startReplayInput(createdAt));
		const runB = startReplayInput(createdAt);
		runB.run = { ...runB.run, runId: "run-b" };
		runB.bootstrapChecksum = "bootstrap-run-b";
		runB.inputBlobs = [];
		runB.inputReferences = [];
		store.commitAgentV2RunStart(runB);
		const current = store.getAgentV2Run("client-a", "run-a");
		if (!current) throw new Error("expected run");
		const beforeEvents = store.listAgentV2RunEvents("client-a", "run-a", 0);

		expect(() =>
			store.commitAgentV2RunTransition({
				expectedRun: expectedRunState(current),
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					status: "running",
					updatedAt: "2026-07-13T10:50:01.000Z",
				},
				event: { type: "run_started", payload: {}, createdAt: "2026-07-13T10:50:01.000Z" },
				diagnostic: {
					diagnosticId: "diag-cross-run",
					clientId: "client-a",
					runId: "run-b",
					severity: "error",
					category: "worker",
					code: "runtime.cross_run",
					message: "must rollback",
					data: {},
					createdAt: "2026-07-13T10:50:01.000Z",
				},
			}),
		).toThrow("identity mismatch");
		expect(store.getAgentV2Run("client-a", "run-a")?.status).toBe("queued");
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toEqual(beforeEvents);
		expect(store.listAgentV2Diagnostics("client-a", "run-b")).toEqual([]);
	});

	it("consumes the run revision for event-only execution mutations", () => {
		const store = createStore();
		const createdAt = "2026-07-13T11:00:00.000Z";
		store.commitAgentV2RunStart(startReplayInput(createdAt));
		const current = store.getAgentV2Run("client-a", "run-a");
		if (!current) throw new Error("expected run");
		const expectedRun = expectedRunState(current);
		const input = {
			clientId: "client-a",
			runId: "run-a",
			expectedRun,
			expectedTasks: [],
			updatedAt: "2026-07-13T11:00:01.000Z",
			tasks: [],
			events: [{ type: "execution_progress", payload: {}, createdAt: "2026-07-13T11:00:01.000Z" }],
		};
		expect(store.commitAgentV2ExecutionMutation(input).applied).toBe(true);
		expect(store.getAgentV2Run("client-a", "run-a")?.updatedAt).toBe(input.updatedAt);
		const eventCount = store.listAgentV2RunEvents("client-a", "run-a", 0).length;
		expect(store.commitAgentV2ExecutionMutation(input).applied).toBe(false);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toHaveLength(eventCount);
		expect(
			store.commitAgentV2ExecutionMutation({
				...input,
				expectedRun: expectedRunState(store.getAgentV2Run("client-a", "run-a")!),
				updatedAt: input.updatedAt,
			}).applied,
		).toBe(false);
	});

	it("rejects stale same-owner lease callbacks by generation and expiry", () => {
		const store = createStore();
		store.commitAgentV2RunStart(startReplayInput("2026-07-13T11:10:00.000Z"));
		const first = store.leaseAgentV2Outbox({
			ownerId: "stable-owner",
			limit: 1,
			now: "2026-07-13T11:10:01.000Z",
			leaseTtlMs: 1000,
		})[0]!;
		const second = store.leaseAgentV2Outbox({
			ownerId: "stable-owner",
			limit: 1,
			now: "2026-07-13T11:10:02.000Z",
			leaseTtlMs: 1000,
		})[0]!;
		expect(second.intentId).toBe(first.intentId);
		expect(second.attemptCount).toBe(first.attemptCount + 1);
		expect(
			store.markAgentV2OutboxDelivered({
				intentId: first.intentId,
				ownerId: "stable-owner",
				leaseAttempt: first.attemptCount,
				deliveredAt: "2026-07-13T11:10:02.100Z",
			}),
		).toBe("lease_lost");
		expect(
			store.markAgentV2OutboxDelivered({
				intentId: second.intentId,
				ownerId: "stable-owner",
				leaseAttempt: second.attemptCount,
				deliveredAt: "2026-07-13T11:10:03.000Z",
			}),
		).toBe("lease_lost");
	});

	it("only replays a semantically identical cancel request and result", () => {
		const store = createStore();
		const createdAt = "2026-07-13T11:20:00.000Z";
		store.commitAgentV2RunStart(startReplayInput(createdAt));
		const run = store.getAgentV2Run("client-a", "run-a");
		if (!run) throw new Error("expected run");
		const cancel = {
			clientId: "client-a",
			runId: "run-a",
			expectedStatuses: ["queued"] as const,
			expectedRun: expectedRunState(run),
			queueName: "agent-v2",
			cancelToken: "cancel-token",
			cancelledAt: "2026-07-13T11:20:01.000Z",
			reason: "user request",
		};
		const first = store.commitAgentV2RunCancel(cancel);
		expect(store.commitAgentV2RunCancel(cancel)).toEqual({ ...first, replayed: true });
		expect(() => store.commitAgentV2RunCancel({ ...cancel, reason: "different" })).toThrow("replay conflict");
		expect(() => store.commitAgentV2RunCancel({ ...cancel, cancelledAt: "2026-07-13T11:20:02.000Z" })).toThrow(
			"replay conflict",
		);
	});

	it("rejects complete run ABA mismatch without dependent writes", () => {
		const store = createStore();
		store.commitAgentV2RunStart(startReplayInput("2026-07-13T10:00:00.000Z"));
		const before = store.listAgentV2RunEvents("client-a", "run-a", 0);
		const result = store.commitAgentV2RunTransition({
			expectedRun: {
				status: "queued",
				phase: "implementation",
				attempt: 0,
				workerId: null,
				updatedAt: "stale",
			},
			update: {
				clientId: "client-a",
				runId: "run-a",
				expectedStatuses: ["queued"],
				status: "running",
				updatedAt: "2026-07-13T10:00:02.000Z",
			},
			event: { type: "run_started", payload: {}, createdAt: "2026-07-13T10:00:02.000Z" },
		});
		expect(result.update.applied).toBe(false);
		expect(result.event).toBeUndefined();
		expect(result.outboxIntentIds).toEqual([]);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toEqual(before);
	});

	it("replays an identical diagnostic commit without duplicate event or outbox rows", () => {
		const store = createStore();
		const createdAt = "2026-07-13T11:30:00.000Z";
		store.commitAgentV2RunStart(startReplayInput(createdAt));
		const input = {
			diagnostic: {
				diagnosticId: "diag-a",
				clientId: "client-a",
				runId: "run-a",
				severity: "error" as const,
				category: "validation" as const,
				code: "validation.failed",
				message: "failed",
				data: { z: 1, a: 2 },
				createdAt,
			},
			emitRunEvent: true,
		};
		const first = store.commitAgentV2Diagnostic(input);
		const replay = store.commitAgentV2Diagnostic({
			...input,
			diagnostic: { ...input.diagnostic, data: { a: 2, z: 1 } },
		});
		expect(replay).toEqual(first);
		expect(store.listAgentV2Diagnostics("client-a", "run-a")).toHaveLength(1);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toHaveLength(3);
	});

	it("applies execution mutations only when the complete run and task versions match", () => {
		const store = createStore();
		const createdAt = "2026-07-13T12:00:00.000Z";
		store.commitAgentV2RunStart({
			...startReplayInput(createdAt),
			tasks: [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "task-a",
					kind: "implementation",
					title: "Build",
					status: "ready",
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt,
					updatedAt: createdAt,
				},
			],
		});
		const currentRun = store.getAgentV2Run("client-a", "run-a");
		const currentTask = store.listAgentV2Tasks("client-a", "run-a")[0];
		if (!currentRun || !currentTask) throw new Error("expected start state");
		const expectedRun = {
			status: currentRun.status,
			phase: currentRun.phase,
			attempt: currentRun.attempt,
			workerId: currentRun.workerId ?? null,
			updatedAt: currentRun.updatedAt,
		};
		const updatedAt = "2026-07-13T12:00:01.000Z";
		const first = store.commitAgentV2ExecutionMutation({
			clientId: "client-a",
			runId: "run-a",
			expectedRun,
			expectedTasks: [{ taskId: "task-a", status: currentTask.status, updatedAt: currentTask.updatedAt }],
			updatedAt,
			tasks: [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "task-a",
					kind: "implementation",
					title: "Build",
					status: "running",
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt,
					updatedAt,
				},
			],
			events: [{ type: "task_started", payload: { taskId: "task-a" }, createdAt: updatedAt }],
		});
		expect(first.applied).toBe(true);
		expect(first.tasks[0]?.status).toBe("running");
		const eventCount = store.listAgentV2RunEvents("client-a", "run-a", 0).length;
		const stale = store.commitAgentV2ExecutionMutation({
			clientId: "client-a",
			runId: "run-a",
			expectedRun,
			expectedTasks: [{ taskId: "task-a", status: "ready", updatedAt: createdAt }],
			updatedAt: "2026-07-13T12:00:02.000Z",
			tasks: [],
			events: [{ type: "must_not_write", payload: {}, createdAt: updatedAt }],
		});
		expect(stale.applied).toBe(false);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toHaveLength(eventCount);
		const unsafe = store.commitAgentV2ExecutionMutation({
			clientId: "client-a",
			runId: "run-a",
			expectedRun,
			expectedTasks: [],
			updatedAt: "2026-07-13T12:00:03.000Z",
			tasks: [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "task-b",
					kind: "implementation",
					title: "Unversioned",
					status: "ready",
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt,
					updatedAt,
				},
			],
			events: [],
		});
		expect(unsafe.applied).toBe(false);
		expect(store.listAgentV2Tasks("client-a", "run-a").map((task) => task.taskId)).toEqual(["task-a"]);
	});

	it("creates deterministic tasks only under explicit expected-absent CAS", () => {
		const store = createStore();
		const createdAt = "2026-07-13T12:10:00.000Z";
		store.commitAgentV2RunStart({ ...startReplayInput(createdAt), tasks: [] });
		const run = store.getAgentV2Run("client-a", "run-a");
		if (!run) throw new Error("expected run");
		const task = {
			clientId: "client-a",
			runId: "run-a",
			taskId: "repair:validate:1",
			kind: "repair" as const,
			title: "Repair validation attempt 1",
			status: "pending" as const,
			dependsOn: ["validate"],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-13T12:10:01.000Z",
			updatedAt: "2026-07-13T12:10:01.000Z",
		};
		const input = {
			clientId: "client-a",
			runId: "run-a",
			expectedRun: {
				status: run.status,
				phase: run.phase,
				attempt: run.attempt,
				workerId: run.workerId ?? null,
				updatedAt: run.updatedAt,
			},
			expectedTasks: [{ taskId: task.taskId, absent: true as const }],
			updatedAt: task.updatedAt,
			tasks: [task],
			events: [],
		};

		expect(
			store.commitAgentV2ExecutionMutation({
				...input,
				expectedTasks: [
					{ taskId: task.taskId, absent: true as const },
					{ taskId: task.taskId, status: "pending" as const, updatedAt: task.updatedAt },
				],
			}),
		).toMatchObject({ applied: false });
		expect(store.listAgentV2Tasks("client-a", "run-a")).toEqual([]);
		expect(store.commitAgentV2ExecutionMutation(input).applied).toBe(true);
		const afterFirst = store.listAgentV2Tasks("client-a", "run-a");
		expect(afterFirst.map((candidate) => candidate.taskId)).toEqual([task.taskId]);
		const currentRun = store.getAgentV2Run("client-a", "run-a");
		if (!currentRun) throw new Error("expected current run");
		expect(
			store.commitAgentV2ExecutionMutation({
				...input,
				expectedRun: {
					status: currentRun.status,
					phase: currentRun.phase,
					attempt: currentRun.attempt,
					workerId: currentRun.workerId ?? null,
					updatedAt: currentRun.updatedAt,
				},
				updatedAt: "2026-07-13T12:10:02.000Z",
				tasks: [{ ...task, updatedAt: "2026-07-13T12:10:02.000Z" }],
			}),
		).toMatchObject({ applied: false });
		expect(store.listAgentV2Tasks("client-a", "run-a")).toEqual(afterFirst);
	});

	it("rolls back the complete execution mutation on divergent immutable validation replay", () => {
		const store = createStore();
		const t0 = "2026-07-13T12:20:00.000Z";
		const t1 = "2026-07-13T12:20:01.000Z";
		store.commitAgentV2RunStart({
			...startReplayInput(t0),
			tasks: [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "validate",
					kind: "validation",
					title: "Validate",
					status: "ready",
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt: t0,
					updatedAt: t0,
				},
			],
		});
		const existingValidation = {
			clientId: "client-a",
			runId: "run-a",
			validationId: "static:validate",
			attempt: 1,
			taskId: "validate",
			status: "failed" as const,
			summary: "Static validation failed",
			details: { failureCodes: ["static.loading_visible"] },
			createdAt: t1,
			updatedAt: t1,
		};
		store.appendAgentV2ValidationAttempt(existingValidation);
		const run = store.getAgentV2Run("client-a", "run-a");
		const task = store.listAgentV2Tasks("client-a", "run-a")[0];
		if (!run || !task) throw new Error("expected state");
		const beforeEvents = store.listAgentV2RunEvents("client-a", "run-a", 0);

		expect(() =>
			store.commitAgentV2ExecutionMutation({
				clientId: "client-a",
				runId: "run-a",
				expectedRun: {
					status: run.status,
					phase: run.phase,
					attempt: run.attempt,
					workerId: run.workerId ?? null,
					updatedAt: run.updatedAt,
				},
				expectedTasks: [{ taskId: task.taskId, status: task.status, updatedAt: task.updatedAt }],
				updatedAt: "2026-07-13T12:20:02.000Z",
				tasks: [
					{
						...task,
						clientId: "client-a",
						runId: "run-a",
						status: "succeeded",
						updatedAt: "2026-07-13T12:20:02.000Z",
					},
				],
				validation: { ...existingValidation, summary: "divergent" },
				events: [{ type: "must_not_write", payload: {}, createdAt: "2026-07-13T12:20:02.000Z" }],
			}),
		).toThrow("validation attempt conflict");
		expect(store.getAgentV2Run("client-a", "run-a")).toEqual(run);
		expect(store.listAgentV2Tasks("client-a", "run-a")[0]).toEqual(task);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toEqual(beforeEvents);
		expect(store.listAgentV2Validations("client-a", "run-a")).toEqual([existingValidation]);
	});

	it("rejects malformed, non-canonical, equal, older and historical ABA revisions with zero writes", () => {
		const store = createStore();
		const t0 = "2026-07-13T12:30:00.000Z";
		const t1 = "2026-07-13T12:30:01.000Z";
		store.commitAgentV2RunStart({
			...startReplayInput(t0),
			tasks: [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "task-a",
					kind: "implementation",
					title: "Build",
					status: "ready",
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt: t0,
					updatedAt: t0,
				},
			],
		});
		const initialRun = store.getAgentV2Run("client-a", "run-a")!;
		const initialTask = store.listAgentV2Tasks("client-a", "run-a")[0]!;
		const first = store.commitAgentV2ExecutionMutation({
			clientId: "client-a",
			runId: "run-a",
			expectedRun: expectedRunState(initialRun),
			expectedTasks: [{ taskId: "task-a", status: initialTask.status, updatedAt: t0 }],
			updatedAt: t1,
			tasks: [{ ...initialTask, clientId: "client-a", runId: "run-a", status: "running", updatedAt: t1 }],
			events: [{ type: "task_started", payload: { taskId: "task-a" }, createdAt: t1 }],
		});
		expect(first.applied).toBe(true);
		const currentRun = store.getAgentV2Run("client-a", "run-a")!;
		const currentTask = store.listAgentV2Tasks("client-a", "run-a")[0]!;
		const before = sqliteDurableSnapshot(store, "client-a", "run-a");
		const invalid: Array<{ runRevision: string; taskRevision: string }> = [
			{ runRevision: t1, taskRevision: "2026-07-13T12:30:02.000Z" },
			{ runRevision: "not-a-date", taskRevision: "2026-07-13T12:30:02.000Z" },
			{ runRevision: "2026-07-13T12:30:02Z", taskRevision: "2026-07-13T12:30:02.000Z" },
			{ runRevision: t0, taskRevision: "2026-07-13T12:30:02.000Z" },
			{ runRevision: "2026-07-13T12:30:02.000Z", taskRevision: t1 },
			{ runRevision: "2026-07-13T12:30:02.000Z", taskRevision: "bad-task-revision" },
			{ runRevision: "2026-07-13T12:30:02.000Z", taskRevision: "2026-07-13T12:30:02Z" },
			{ runRevision: "2026-07-13T12:30:02.000Z", taskRevision: t0 },
		];
		for (const candidate of invalid) {
			const result = store.commitAgentV2ExecutionMutation({
				clientId: "client-a",
				runId: "run-a",
				expectedRun: expectedRunState(currentRun),
				expectedTasks: [{ taskId: "task-a", status: currentTask.status, updatedAt: currentTask.updatedAt }],
				updatedAt: candidate.runRevision,
				tasks: [
					{
						...currentTask,
						clientId: "client-a",
						runId: "run-a",
						status: "succeeded",
						updatedAt: candidate.taskRevision,
					},
				],
				artifacts: [
					{
						clientId: "client-a",
						runId: "run-a",
						artifactId: "must-not-write",
						kind: "file",
						path: "blocked.txt",
						mediaType: "text/plain",
						checksum: "blocked",
						version: "1",
						validationStatus: "pending",
						metadataJson: {},
						createdAt: t1,
						updatedAt: candidate.runRevision,
					},
				],
				validation: {
					clientId: "client-a",
					runId: "run-a",
					validationId: "must-not-write",
					attempt: 1,
					status: "failed",
					summary: "blocked",
					details: {},
					createdAt: t1,
					updatedAt: t1,
				},
				diagnostics: [
					{
						diagnosticId: "must-not-write",
						clientId: "client-a",
						runId: "run-a",
						severity: "error",
						category: "worker",
						code: "revision.rejected",
						message: "blocked",
						data: {},
						createdAt: t1,
					},
				],
				events: [{ type: "must_not_write", payload: {}, createdAt: t1 }],
			});
			expect(result.applied, JSON.stringify(candidate)).toBe(false);
			expect(sqliteDurableSnapshot(store, "client-a", "run-a"), JSON.stringify(candidate)).toEqual(before);
		}
		const staleEpoch = store.commitAgentV2ExecutionMutation({
			clientId: "client-a",
			runId: "run-a",
			expectedRun: expectedRunState(initialRun),
			expectedTasks: [{ taskId: "task-a", status: initialTask.status, updatedAt: t0 }],
			updatedAt: "2026-07-13T12:30:03.000Z",
			tasks: [],
			events: [{ type: "must_not_write", payload: {}, createdAt: t1 }],
		});
		expect(staleEpoch.applied).toBe(false);
		expect(sqliteDurableSnapshot(store, "client-a", "run-a")).toEqual(before);
	});

	it("enforces canonical start revisions and monotonic transition/cancel revisions before writes", () => {
		const t0 = "2026-07-13T13:00:00.000Z";
		const invalidBaselines = [
			{ createdAt: "not-a-date", updatedAt: t0 },
			{ createdAt: "2026-07-13T13:00:00Z", updatedAt: t0 },
			{ createdAt: t0, updatedAt: "not-a-date" },
			{ createdAt: t0, updatedAt: "2026-07-13T13:00:00Z" },
			{ createdAt: t0, updatedAt: "2026-07-13T12:59:59.000Z" },
		];
		for (const invalid of invalidBaselines) {
			const runStore = createStore();
			const runInput = startReplayInput(t0);
			runInput.run.createdAt = invalid.createdAt;
			runInput.run.updatedAt = invalid.updatedAt;
			const runBefore = sqliteDurableSnapshot(runStore, "client-a", "run-a");
			expect(() => runStore.commitAgentV2RunStart(runInput)).toThrow("canonical UTC millisecond");
			expect(sqliteDurableSnapshot(runStore, "client-a", "run-a")).toEqual(runBefore);

			const taskStore = createStore();
			const taskInput = startReplayInput(t0) as AgentV2StartRunCommitInput;
			taskInput.tasks = [
				{
					clientId: "client-a",
					runId: "run-a",
					taskId: "task-a",
					kind: "implementation" as const,
					title: "Build",
					status: "ready" as const,
					dependsOn: [],
					acceptanceCriteria: [],
					input: {},
					output: {},
					createdAt: invalid.createdAt,
					updatedAt: invalid.updatedAt,
				},
			];
			const taskBefore = sqliteDurableSnapshot(taskStore, "client-a", "run-a");
			expect(() => taskStore.commitAgentV2RunStart(taskInput)).toThrow("canonical UTC millisecond");
			expect(sqliteDurableSnapshot(taskStore, "client-a", "run-a")).toEqual(taskBefore);
		}

		const store = createStore();
		store.commitAgentV2RunStart(startReplayInput(t0));
		const initial = store.getAgentV2Run("client-a", "run-a")!;
		for (const invalid of [t0, "2026-07-13T12:59:59.000Z", "not-a-date", "2026-07-13T13:00:01Z"]) {
			const before = sqliteDurableSnapshot(store, "client-a", "run-a");
			const result = store.commitAgentV2RunTransition({
				expectedRun: expectedRunState(initial),
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					phase: "validation",
					updatedAt: invalid,
				},
				event: { type: "must_not_write", payload: {}, createdAt: t0 },
			});
			expect(result.update.applied).toBe(false);
			expect(sqliteDurableSnapshot(store, "client-a", "run-a")).toEqual(before);
		}
		const t1 = "2026-07-13T13:00:01.000Z";
		expect(
			store.commitAgentV2RunTransition({
				expectedRun: expectedRunState(initial),
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					phase: "validation",
					updatedAt: t1,
				},
				event: { type: "phase_changed", payload: {}, createdAt: t1 },
			}).update.applied,
		).toBe(true);
		const atT1 = store.getAgentV2Run("client-a", "run-a")!;
		const beforeAba = sqliteDurableSnapshot(store, "client-a", "run-a");
		expect(
			store.commitAgentV2RunTransition({
				expectedRun: expectedRunState(atT1),
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					phase: "implementation",
					updatedAt: t0,
				},
				event: { type: "must_not_write", payload: {}, createdAt: t1 },
			}).update.applied,
		).toBe(false);
		expect(sqliteDurableSnapshot(store, "client-a", "run-a")).toEqual(beforeAba);

		for (const invalid of [t1, t0, "not-a-date", "2026-07-13T13:00:02Z"]) {
			const before = sqliteDurableSnapshot(store, "client-a", "run-a");
			expect(() =>
				store.commitAgentV2RunCancel({
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					expectedRun: expectedRunState(atT1),
					queueName: "agent-v2",
					cancelToken: `invalid-${invalid}`,
					cancelledAt: invalid,
				}),
			).toThrow("compare-and-set conflict");
			expect(sqliteDurableSnapshot(store, "client-a", "run-a")).toEqual(before);
		}
	});
});

function createStore(): RuntimeDbStore & AgentV2DurableCommitStore & AgentV2OutboxStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-outbox-"));
	roots.push(root);
	const dbFile = join(root, "runtime.db");
	const store = new RuntimeDbStore(dbFile);
	storeFiles.set(store, dbFile);
	stores.push(store);
	store.ensureAgentV2Schema();
	return store;
}

function readSqliteBootstrapChecksum(store: RuntimeDbStore, clientId: string, runId: string): string | undefined {
	const db = new DatabaseSync(storeFiles.get(store)!);
	try {
		return (
			db
				.prepare("SELECT bootstrap_checksum FROM agent_v2_bootstraps WHERE client_id=? AND run_id=?")
				.get(clientId, runId) as { bootstrap_checksum?: string } | undefined
		)?.bootstrap_checksum;
	} finally {
		db.close();
	}
}

function sqliteDurableSnapshot(store: RuntimeDbStore, clientId: string, runId: string) {
	const db = new DatabaseSync(storeFiles.get(store)!);
	try {
		const count = (table: string): number =>
			Number(
				(
					db
						.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE client_id=? AND run_id=?`)
						.get(clientId, runId) as {
						count: number | bigint;
					}
				).count,
			);
		return {
			run: store.getAgentV2Run(clientId, runId),
			tasks: store.listAgentV2Tasks(clientId, runId),
			artifacts: store.listAgentV2Artifacts(clientId, runId),
			validations: store.listAgentV2Validations(clientId, runId),
			diagnostics: store.listAgentV2Diagnostics(clientId, runId),
			events: store.listAgentV2RunEvents(clientId, runId, 0),
			outboxCount: count("agent_v2_outbox"),
			bootstrapCount: count("agent_v2_bootstraps"),
		};
	} finally {
		db.close();
	}
}

function startReplayInput(createdAt: string) {
	return {
		run: {
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "build" },
			model: { provider: "test" },
			createdAt,
			updatedAt: createdAt,
		},
		bootstrapVersion: "1",
		bootstrapChecksum: "bootstrap-sha",
		inputBlobs: [
			{
				clientId: "client-a",
				runId: "run-a",
				inputId: "input-a",
				logicalPath: "assets/a.txt",
				mediaType: "text/plain",
				encoding: "utf8" as const,
				bytes: new Uint8Array([97]),
				byteLength: 1,
				checksum: "input-sha",
				createdAt,
			},
		],
		inputReferences: [
			{
				clientId: "client-a",
				runId: "run-a",
				kind: "attachment" as const,
				ordinal: 0,
				inputId: "input-a",
				logicalPath: "assets/a.txt",
				displayName: "a.txt",
				mediaType: "text/plain",
				byteLength: 1,
				checksum: "input-sha",
			},
		],
		readyPhase: "implementation" as const,
		documents: [],
		tasks: [],
		artifacts: [],
		diagnostics: [],
		queueName: "agent-v2",
		createdAt,
	};
}

function richStartReplayInput(createdAt: string) {
	return {
		...startReplayInput(createdAt),
		documents: [
			{
				clientId: "client-a",
				runId: "run-a",
				documentId: "spec",
				kind: "spec" as const,
				version: "v1",
				contentMarkdown: "# Spec",
				contentJson: {
					kind: "spec" as const,
					title: "Spec",
					objective: "Build",
					summary: "Summary",
					scope: [],
					goals: [],
					nonGoals: [],
					assumptions: [],
					requirements: [],
					capabilityBoundaries: [],
					acceptanceCriteria: [],
					platformContract: {
						runtime: "web",
						framework: "vite",
						deliveryMode: "static_app" as const,
						entrypoints: ["src/main.ts"],
						deliverables: ["dist"],
						constraints: [],
					},
				},
				createdAt,
				updatedAt: createdAt,
			},
		],
		tasks: [
			{
				clientId: "client-a",
				runId: "run-a",
				taskId: "task-a",
				kind: "implementation" as const,
				title: "Build",
				status: "ready" as const,
				dependsOn: [],
				acceptanceCriteria: [],
				input: {},
				output: {},
				createdAt,
				updatedAt: createdAt,
			},
		],
		artifacts: [
			{
				clientId: "client-a",
				runId: "run-a",
				artifactId: "artifact-a",
				kind: "file",
				path: "src/main.ts",
				mediaType: "text/typescript",
				checksum: "artifact-sha",
				version: "v1",
				validationStatus: "pending",
				metadataJson: {},
				createdAt,
				updatedAt: createdAt,
			},
		],
		diagnostics: [
			{
				diagnosticId: "diag-start",
				clientId: "client-a",
				runId: "run-a",
				severity: "warn" as const,
				category: "task_graph" as const,
				code: "task_graph.waiting",
				message: "waiting",
				data: {},
				createdAt,
			},
		],
	};
}

function expectedRunState(run: NonNullable<ReturnType<RuntimeDbStore["getAgentV2Run"]>>) {
	return {
		status: run.status,
		phase: run.phase,
		attempt: run.attempt,
		workerId: run.workerId ?? null,
		updatedAt: run.updatedAt,
	};
}
