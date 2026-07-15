import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { type AgentV2RunQueue, createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import {
	type AgentV2RunEventRecord,
	type AgentV2RunUpdateResult,
	type AppendAgentV2RunEventInput,
	applyAgentV2RunUpdate,
	buildAgentV2Run,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2RunStatus } from "../src/agent-v2-types.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";
import { createRedisFaultProxy } from "./support/redis-fault-proxy.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("createRedisAgentV2RunQueue integration", () => {
	it("keeps enqueue idempotent and protects exact worker/token ownership", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			const run = { clientId: "client-a", runId: "ownership" };
			await expect(queue.enqueue(run)).resolves.toBe("enqueued");
			await expect(queue.enqueue(run)).resolves.toBe("already_ready");
			const claim = await queue.claim("w1", 1);
			expect(claim).toMatchObject({ ...run, workerId: "w1" });
			expect(claim?.claimToken).toEqual(expect.any(String));
			await expect(queue.enqueue(run)).resolves.toBe("already_active");
			await expect(queue.renewLease({ ...claim!, workerId: "w2" })).resolves.toEqual({ status: "lost" });
			await expect(queue.renewLease({ ...claim!, claimToken: "stale" })).resolves.toEqual({ status: "lost" });
			await expect(queue.complete({ ...claim!, claimToken: "stale" })).resolves.toBe(false);
			await expect(queue.confirmOwnership(claim!, 100)).resolves.toBe("owned");
			await expect(queue.complete(claim!)).resolves.toBe(true);
			await expect(queue.confirmOwnership(claim!, 100)).resolves.toBe("lost");
		});
	});

	it("claims concurrently through independent sockets", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			await queue.enqueue({ clientId: "client-a", runId: "parallel-a" });
			await queue.enqueue({ clientId: "client-a", runId: "parallel-b" });
			const [first, second] = await Promise.all([queue.claim("w1", 1), queue.claim("w2", 1)]);
			expect(new Set([first?.runId, second?.runId])).toEqual(new Set(["parallel-a", "parallel-b"]));
			expect(first?.claimToken).not.toBe(second?.claimToken);
		});
	});

	it("recovers an exact claim after its Redis response is dropped", async () => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: proxy.url, queueName, claimCommandTimeoutMs: 100 });
		try {
			await queue.enqueue({ clientId: "client-a", runId: "response-drop" });
			proxy.dropNextEvalResponse();
			const claim = await queue.claim("w1", 250);
			expect(claim).toMatchObject({ clientId: "client-a", runId: "response-drop", workerId: "w1" });
			await expect(queue.confirmOwnership(claim!, 100)).resolves.toBe("owned");
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await proxy.close();
		}
	});

	it("atomically requeues expired claims exactly once", async () => {
		const queue = createRedisAgentV2RunQueue({
			redisUrl: redisUrl!,
			queueName: uniqueQueueName(),
			claimLeaseTtlMs: 20,
		});
		await usingQueue(queue, async () => {
			await queue.enqueue({ clientId: "client-a", runId: "expired" });
			const claim = await queue.claim("w1", 1);
			const reclaimed = await queue.requeueExpiredClaims(claim!.leaseExpiresAtMs);
			expect(reclaimed).toEqual([expect.objectContaining({ runId: "expired", claimToken: claim!.claimToken })]);
			await expect(queue.requeueExpiredClaims(claim!.leaseExpiresAtMs)).resolves.toEqual([]);
			const next = await queue.claim("w2", 1);
			expect(next).toMatchObject({ runId: "expired", workerId: "w2" });
			expect(next?.claimToken).not.toBe(claim?.claimToken);
		});
	});

	it("quarantines poisoned active records without blocking valid expired reclaim", async () => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName, claimLeaseTtlMs: 20 });
		const inspection = createClient({ url: redisUrl! });
		await inspection.connect();
		try {
			await queue.enqueue({ clientId: "client-a", runId: "valid-expired" });
			const valid = await queue.claim("w1", 1);
			const poisonEntries = new Map([
				[
					'["client-a","missing-expiry"]',
					JSON.stringify({ workerId: "hostile", claimToken: "missing", payload: "redis://user:secret@host" }),
				],
				[
					'["client-a","string-expiry"]',
					JSON.stringify({ workerId: "hostile", claimToken: "string", leaseExpiresAtMs: "0" }),
				],
				['["client-a","huge-expiry"]', '{"workerId":"hostile","claimToken":"huge","leaseExpiresAtMs":1e999}'],
			]);
			await inspection.hSet(`${queueName}:active`, Object.fromEntries(poisonEntries));

			await expect(queue.requeueExpiredClaims(valid!.leaseExpiresAtMs)).resolves.toEqual([
				expect.objectContaining({ runId: "valid-expired", claimToken: valid!.claimToken }),
			]);
			await expect(queue.requeueExpiredClaims(valid!.leaseExpiresAtMs)).resolves.toEqual([]);
			await expect(queue.claim("w2", 1)).resolves.toMatchObject({ runId: "valid-expired", workerId: "w2" });
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
			expect(await inspection.hLen(`${queueName}:active`)).toBe(1);
			expect(await inspection.hGetAll(`${queueName}:invalid-active`)).toEqual({
				'["client-a","missing-expiry"]': "invalid_lease_expiry",
				'["client-a","string-expiry"]': "invalid_lease_expiry",
				'["client-a","huge-expiry"]': "invalid_lease_expiry",
			});
			await queue.clear();
			expect(await inspection.exists(`${queueName}:invalid-active`)).toBe(0);
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
	});

	it("expires and prunes cancellation state", async () => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName, cancelTtlSeconds: 1 });
		const inspection = createClient({ url: redisUrl! });
		await inspection.connect();
		try {
			await expect(queue.requestCancel({ clientId: "client-a", runId: "cancelled" }, "cancel-a")).resolves.toBe(
				"requested",
			);
			const originalExpiry = await inspection.zScore(`${queueName}:cancel`, '["client-a","cancelled"]');
			await expect(queue.requestCancel({ clientId: "client-a", runId: "cancelled" }, "cancel-a")).resolves.toBe(
				"already_requested",
			);
			await expect(queue.requestCancel({ clientId: "client-a", runId: "cancelled" }, "cancel-stale")).resolves.toBe(
				"stale",
			);
			expect(await inspection.zScore(`${queueName}:cancel`, '["client-a","cancelled"]')).toBe(originalExpiry);
			expect(await inspection.ttl(`${queueName}:cancel`)).toBeGreaterThan(0);
			await inspection.zAdd(`${queueName}:cancel`, { score: 1, value: '["client-a","expired"]' });
			await inspection.hSet(`${queueName}:cancel-token`, '["client-a","expired"]', "expired-token");
			await expect(queue.isCancelRequested({ clientId: "client-a", runId: "expired" })).resolves.toBe(false);
			expect(await inspection.zScore(`${queueName}:cancel`, '["client-a","expired"]')).toBeNull();
			expect(await inspection.hGet(`${queueName}:cancel-token`, '["client-a","expired"]')).toBeNull();
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
	});

	it("consumes cancel tokens idempotently for an active claim after response loss", async () => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const queue = createRedisAgentV2RunQueue({ redisUrl: proxy.url, queueName: uniqueQueueName() });
		const run = { clientId: "client-a", runId: "active-cancel-token" };
		try {
			await queue.enqueue(run);
			const claim = await queue.claim("worker-a", 1);
			proxy.dropNextEvalResponse();
			await expect(queue.requestCancel(run, "cancel-active-a")).rejects.toBeDefined();
			await expect(queue.requestCancel(run, "cancel-active-a")).resolves.toBe("already_requested");
			await expect(queue.requestCancel(run, "cancel-active-stale")).resolves.toBe("stale");
			await expect(queue.isCancelRequested(run)).resolves.toBe(true);
			await expect(queue.confirmOwnership(claim!, 100)).resolves.toBe("owned");
			await expect(queue.complete(claim!)).resolves.toBe(true);
			await expect(queue.isCancelRequested(run)).resolves.toBe(false);
			await expect(queue.requestCancel(run, "cancel-active-a")).resolves.toBe("already_requested");
			await expect(queue.requestCancel(run, "cancel-after-complete-stale")).resolves.toBe("stale");
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await proxy.close();
		}
	});

	it("prunes an expired completed token when another cancellation refreshes shared Redis TTL", async () => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName, cancelTtlSeconds: 1 });
		const inspection = createClient({ url: redisUrl! });
		const runA = { clientId: "client-a", runId: "completed-token-a" };
		const runB = { clientId: "client-a", runId: "active-token-b" };
		await inspection.connect();
		try {
			await queue.enqueue(runA);
			const claimA = await queue.claim("worker-a", 1);
			await expect(queue.requestCancel(runA, "cancel-a")).resolves.toBe("requested");
			await expect(queue.complete(claimA!)).resolves.toBe(true);
			await expect(queue.isCancelRequested(runA)).resolves.toBe(false);
			expect(
				await inspection.hExists(`${queueName}:cancel-token`, JSON.stringify([runA.clientId, runA.runId])),
			).toBe(true);

			await new Promise((resolve) => setTimeout(resolve, 600));
			await expect(queue.requestCancel(runB, "cancel-b")).resolves.toBe("requested");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(
				await inspection.hExists(`${queueName}:cancel-token`, JSON.stringify([runA.clientId, runA.runId])),
			).toBe(true);
			await expect(queue.isCancelRequested(runB)).resolves.toBe(true);

			expect(
				await inspection.hExists(`${queueName}:cancel-token`, JSON.stringify([runA.clientId, runA.runId])),
			).toBe(false);
			await expect(queue.isCancelRequested(runA)).resolves.toBe(false);
			await expect(queue.isCancelRequested(runB)).resolves.toBe(true);
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
	});

	it("closes promptly with active claim sockets", async () => {
		const queue = createQueue();
		const claim = queue.claim("w1", 10_000);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await expect(queue.close()).resolves.toBeUndefined();
		await expect(claim).resolves.toBeUndefined();
	});

	it("requeues active claims owned by a worker in Redis", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			await queue.enqueue({ clientId: "client-a", runId: "run-redis-1" });

			const first = await queue.claim("w1", 1);
			expect(first).toMatchObject({ clientId: "client-a", runId: "run-redis-1", workerId: "w1" });
			await expect(queue.requeueActive("w1")).resolves.toBe(1);

			const second = await queue.claim("w2", 1);
			expect(second).toMatchObject({ clientId: "client-a", runId: "run-redis-1", workerId: "w2" });
			await queue.complete(second!);
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});

	it("recovers a queued run after a Redis active claim is reclaimed", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			const store = new MemoryWorkerStore();
			store.createQueuedRun("client-a", "run-redis-queued");

			await queue.enqueue({ clientId: "client-a", runId: "run-redis-queued" });
			await expect(queue.claim("w1", 1)).resolves.toMatchObject({ clientId: "client-a", runId: "run-redis-queued" });

			const worker = new AgentV2WorkerService({
				store,
				queue,
				events: new RecordingEventLog(),
				execution: new CompleteExecution(),
				workerId: "w1",
				now: timestampSequence("2026-07-09T00:00:00.000Z", "2026-07-09T00:00:01.000Z"),
			});

			await worker.recoverOwnedRuns();
			await expect(worker.processOne()).resolves.toBe(true);

			expect(store.getRunSnapshot("client-a", "run-redis-queued")).toMatchObject({ status: "succeeded" });
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});

	it("interrupts a running run and drains its reclaimed Redis active claim", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			const store = new MemoryWorkerStore();
			store.createOwnedActiveRun("client-a", "run-redis-running", "running", "w1");

			await queue.enqueue({ clientId: "client-a", runId: "run-redis-running" });
			await expect(queue.claim("w1", 1)).resolves.toMatchObject({
				clientId: "client-a",
				runId: "run-redis-running",
			});

			const worker = new AgentV2WorkerService({
				store,
				queue,
				events: new RecordingEventLog(),
				execution: {
					executeNextTask: async () => {
						throw new Error("interrupted recovered runs should not execute");
					},
				},
				workerId: "w1",
				now: () => "2026-07-09T00:00:02.000Z",
			});

			await worker.recoverOwnedRuns();
			await expect(worker.processOne()).resolves.toBe(true);

			expect(store.getRunSnapshot("client-a", "run-redis-running")).toMatchObject({ status: "interrupted" });
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});
});

function createQueue(): AgentV2RunQueue {
	return createRedisAgentV2RunQueue({
		redisUrl: redisUrl!,
		queueName: uniqueQueueName(),
	});
}

function uniqueQueueName(): string {
	return `pi:test:agent-v2:runs:${Date.now()}:${randomUUID()}`;
}

async function usingQueue(queue: AgentV2RunQueue, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} finally {
		try {
			await queue.clear();
		} catch {}
		await queue.close();
	}
}

class MemoryWorkerStore {
	readonly diagnostics: AgentV2DiagnosticEvent[] = [];
	private readonly runs = new Map<string, AgentV2RunSnapshot>();

	createQueuedRun(clientId: string, runId: string): AgentV2RunSnapshot {
		const run = buildAgentV2Run({
			clientId,
			runId,
			input: { prompt: `prompt:${runId}`, sessionId: `session:${runId}`, title: runId },
			model: { provider: "test" },
			createdAt: "2026-07-09T00:00:00.000Z",
			updatedAt: "2026-07-09T00:00:00.000Z",
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
		this.applyForcedUpdate({
			clientId,
			runId,
			status: "running",
			phase: "implementation",
			workerId,
			startedAt: "2026-07-09T00:00:00.000Z",
			updatedAt: "2026-07-09T00:00:00.000Z",
		});
		if (status === "cancelling") {
			this.applyForcedUpdate({
				clientId,
				runId,
				status: "cancelling",
				updatedAt: "2026-07-09T00:00:01.000Z",
			});
		}
	}

	getRunSnapshot(clientId: string, runId: string): AgentV2RunSnapshot | undefined {
		return this.runs.get(runKey(clientId, runId));
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		return this.getRunSnapshot(clientId, runId);
	}

	async updateAgentV2Run(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		updatedAt?: string;
	}): Promise<AgentV2RunSnapshot> {
		return this.applyForcedUpdate(input);
	}

	async updateAgentV2RunWithResult(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		expectedStatuses?: readonly AgentV2RunStatus[];
		updatedAt?: string;
	}): Promise<AgentV2RunUpdateResult> {
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
			return { run: current, applied: false };
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return { run: next, applied: true };
	}

	async listAgentV2RunsByWorker(workerId: string): Promise<AgentV2RunSnapshot[]> {
		return [...this.runs.values()].filter(
			(run) => run.workerId === workerId && (run.status === "running" || run.status === "cancelling"),
		);
	}

	async appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): Promise<AgentV2DiagnosticEvent> {
		this.diagnostics.push(input);
		return input;
	}

	private applyForcedUpdate(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		updatedAt?: string;
	}): AgentV2RunSnapshot {
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return next;
	}
}

class RecordingEventLog implements Pick<AgentV2RunEventLog, "append"> {
	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: 1,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-09T00:00:00.000Z",
		};
	}
}

class CompleteExecution {
	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		return { status: "complete", diagnosticIds: [] };
	}
}

function runKey(clientId: string, runId: string): string {
	return `${clientId}:${runId}`;
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => {
		const value = timestamps[index] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
		index += 1;
		return value;
	};
}
