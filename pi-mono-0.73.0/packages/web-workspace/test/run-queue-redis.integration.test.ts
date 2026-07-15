import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it, vi } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2DiagnosticCommitInput, AgentV2RunTransitionCommitInput } from "../src/agent-v2-durable-store.js";
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
			await new Promise((resolve) => setTimeout(resolve, 30));
			const reclaimed = await queue.requeueExpiredClaims();
			expect(reclaimed).toEqual([expect.objectContaining({ runId: "expired", claimToken: claim!.claimToken })]);
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([]);
			const next = await queue.claim("w2", 1);
			expect(next).toMatchObject({ runId: "expired", workerId: "w2" });
			expect(next?.claimToken).not.toBe(claim?.claimToken);
		});
	});

	it.each([
		["far behind", -10 * 365 * 24 * 60 * 60 * 1_000],
		["far ahead", 10 * 365 * 24 * 60 * 60 * 1_000],
	])("uses Redis time for claim, renew, reclaim, and cancel when the worker clock is %s", async (_label, skewMs) => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({
			redisUrl: redisUrl!,
			queueName,
			claimLeaseTtlMs: 40,
			cancelTtlSeconds: 1,
		});
		const inspection = createClient({ url: redisUrl! });
		await inspection.connect();
		const realDateNow = Date.now.bind(Date);
		const workerClock = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + skewMs);
		try {
			const run = { clientId: "client-a", runId: `clock-skew:${skewMs}` };
			const beforeClaimMs = await redisNowMs(inspection);
			await queue.enqueue(run);
			const claim = (await queue.claim("worker-skewed", 1))!;
			const afterClaimMs = await redisNowMs(inspection);
			expect(claim.leaseExpiresAtMs).toBeGreaterThanOrEqual(beforeClaimMs + 40);
			expect(claim.leaseExpiresAtMs).toBeLessThanOrEqual(afterClaimMs + 40);
			await expect(queue.confirmOwnership(claim, 100)).resolves.toBe("owned");

			const beforeRenewMs = await redisNowMs(inspection);
			const renewal = await queue.renewLease(claim);
			const afterRenewMs = await redisNowMs(inspection);
			expect(renewal).toMatchObject({ status: "renewed" });
			if (renewal.status !== "renewed") throw new Error("Expected a renewed Redis lease");
			expect(renewal.leaseExpiresAtMs).toBeGreaterThanOrEqual(beforeRenewMs + 40);
			expect(renewal.leaseExpiresAtMs).toBeLessThanOrEqual(afterRenewMs + 40);

			const beforeCancelMs = await redisNowMs(inspection);
			await expect(queue.requestCancel(run, `cancel:${skewMs}`)).resolves.toBe("requested");
			const cancelExpiry = await inspection.zScore(`${queueName}:cancel`, JSON.stringify([run.clientId, run.runId]));
			const afterCancelMs = await redisNowMs(inspection);
			expect(cancelExpiry).not.toBeNull();
			expect(cancelExpiry!).toBeGreaterThanOrEqual(beforeCancelMs + 1_000);
			expect(cancelExpiry!).toBeLessThanOrEqual(afterCancelMs + 1_000);
			await expect(queue.isCancelRequested(run)).resolves.toBe(true);

			await new Promise((resolve) => setTimeout(resolve, 60));
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([
				expect.objectContaining({
					clientId: claim.clientId,
					runId: claim.runId,
					workerId: claim.workerId,
					claimToken: claim.claimToken,
				}),
			]);
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([]);
		} finally {
			workerClock.mockRestore();
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
	});

	it("does not confirm or renew an expired unreclaimed claim", async () => {
		const queue = createRedisAgentV2RunQueue({
			redisUrl: redisUrl!,
			queueName: uniqueQueueName(),
			claimLeaseTtlMs: 20,
		});
		await usingQueue(queue, async () => {
			await queue.enqueue({ clientId: "client-a", runId: "expired-unreclaimed" });
			const claim = (await queue.claim("w1", 1))!;
			await new Promise((resolve) => setTimeout(resolve, 30));

			await expect(queue.confirmOwnership(claim, 100)).resolves.toBe("lost");
			await expect(queue.renewLease(claim)).resolves.toEqual({ status: "lost" });
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([expect.objectContaining(claim)]);
			await expect(queue.claim("w2", 1)).resolves.toMatchObject({ runId: "expired-unreclaimed", workerId: "w2" });
		});
	});

	it("recovers a dropped renew response by confirming the exact token, then renewing", async () => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const queue = createRedisAgentV2RunQueue({
			redisUrl: proxy.url,
			queueName: uniqueQueueName(),
			claimLeaseTtlMs: 1_000,
		});
		try {
			await queue.enqueue({ clientId: "client-a", runId: "renew-response-drop" });
			const claim = (await queue.claim("w1", 1))!;
			proxy.dropNextEvalResponse();

			await expect(queue.renewLease(claim)).resolves.toEqual({
				status: "uncertain",
				errorCode: "agent_v2.redis_lease_uncertain",
			});
			await expect(queue.confirmOwnership(claim, 100)).resolves.toBe("owned");
			await expect(queue.renewLease(claim)).resolves.toMatchObject({ status: "renewed" });
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await proxy.close();
		}
	});

	it("reports lost after another token replaces the active claim", async () => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName, claimLeaseTtlMs: 1_000 });
		const inspection = createClient({ url: redisUrl! });
		await inspection.connect();
		try {
			await queue.enqueue({ clientId: "client-a", runId: "token-replaced" });
			const claim = (await queue.claim("w1", 1))!;
			await inspection.hSet(
				`${queueName}:active`,
				JSON.stringify([claim.clientId, claim.runId]),
				JSON.stringify({ ...claim, workerId: "w2", claimToken: "replacement" }),
			);

			await expect(queue.confirmOwnership(claim, 100)).resolves.toBe("lost");
			await expect(queue.renewLease(claim)).resolves.toEqual({ status: "lost" });
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
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

			await new Promise((resolve) => setTimeout(resolve, 30));
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([
				expect.objectContaining({ runId: "valid-expired", claimToken: valid!.claimToken }),
			]);
			await expect(queue.requeueExpiredClaims()).resolves.toEqual([]);
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

	it.each([
		["far behind", -10 * 365 * 24 * 60 * 60 * 1_000],
		["far ahead", 10 * 365 * 24 * 60 * 60 * 1_000],
	])("lets a %s worker confirm and renew after a real Redis renew response is dropped", async (_label, skewMs) => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const runId = `run-worker-renew-drop:${skewMs}`;
		const queue = createRedisAgentV2RunQueue({
			redisUrl: proxy.url,
			queueName: uniqueQueueName(),
			claimLeaseTtlMs: 1_000,
		});
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", runId);
		const realDateNow = Date.now.bind(Date);
		const workerClock = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + skewMs);
		try {
			await queue.enqueue({ clientId: "client-a", runId });
			let dropRenewResponse = true;
			const workerQueue = withRenewHook(queue, () => {
				if (!dropRenewResponse) return;
				dropRenewResponse = false;
				proxy.dropNextEvalResponse();
			});
			const worker = new AgentV2WorkerService({
				store,
				queue: workerQueue,
				events: new RecordingEventLog(),
				execution: {
					executeNextTask: async () => {
						await new Promise((resolve) => setTimeout(resolve, 30));
						return { status: "complete", diagnosticIds: [] };
					},
				},
				workerId: "w1",
				now: timestampSequence("2026-07-15T02:00:00.000Z", "2026-07-15T02:00:01.000Z", "2026-07-15T02:00:02.000Z"),
				leaseHeartbeatIntervalMs: 5,
				cancelPollIntervalMs: 50,
				controlOperationTimeoutMs: 100,
			});

			await expect(worker.processOne()).resolves.toBe(true);
			expect(store.getRunSnapshot("client-a", runId)).toMatchObject({ status: "succeeded" });
			expect(store.diagnostics).toContainEqual(expect.objectContaining({ code: "agent_v2.worker_lease_uncertain" }));
		} finally {
			workerClock.mockRestore();
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await proxy.close();
		}
	});

	it("interrupts the worker when a real Redis active claim is replaced by another token", async () => {
		const queueName = uniqueQueueName();
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName, claimLeaseTtlMs: 1_000 });
		const inspection = createClient({ url: redisUrl! });
		const store = new MemoryWorkerStore();
		store.createQueuedRun("client-a", "run-worker-token-replaced");
		await inspection.connect();
		try {
			await queue.enqueue({ clientId: "client-a", runId: "run-worker-token-replaced" });
			const worker = new AgentV2WorkerService({
				store,
				queue,
				events: new RecordingEventLog(),
				execution: {
					executeNextTask: async () => {
						const active = await inspection.hGetAll(`${queueName}:active`);
						const [field, raw] = Object.entries(active)[0]!;
						await inspection.hSet(
							`${queueName}:active`,
							field,
							JSON.stringify({ ...JSON.parse(raw), workerId: "w2", claimToken: "replacement" }),
						);
						await new Promise((resolve) => setTimeout(resolve, 20));
						return { status: "complete", diagnosticIds: [] };
					},
				},
				workerId: "w1",
				now: timestampSequence("2026-07-15T02:01:00.000Z", "2026-07-15T02:01:01.000Z"),
				leaseHeartbeatIntervalMs: 5,
				cancelPollIntervalMs: 50,
				controlOperationTimeoutMs: 100,
			});

			await expect(worker.processOne()).resolves.toBe(true);
			expect(store.getRunSnapshot("client-a", "run-worker-token-replaced")).toMatchObject({ status: "interrupted" });
			expect(store.diagnostics).toContainEqual(expect.objectContaining({ code: "agent_v2.worker_lease_lost" }));
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			await inspection.quit();
		}
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

function withRenewHook(queue: AgentV2RunQueue, onRenew: () => void): AgentV2RunQueue {
	return new Proxy(queue, {
		get(target, property) {
			if (property === "renewLease") {
				return async (claim: Parameters<AgentV2RunQueue["renewLease"]>[0]) => {
					onRenew();
					return await target.renewLease(claim);
				};
			}
			const value = target[property as keyof AgentV2RunQueue];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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

	async commitAgentV2RunTransition(input: AgentV2RunTransitionCommitInput) {
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
		const update = await this.updateAgentV2RunWithResult(input.update);
		if (input.diagnostic && update.applied) this.diagnostics.push(input.diagnostic);
		return {
			update,
			...(update.applied
				? {
						event: {
							clientId: update.run.clientId,
							runId: update.run.runId,
							seq: 1,
							type: String(input.event.type),
							payload: input.event.payload as Record<string, unknown>,
							createdAt:
								typeof input.event.createdAt === "string" ? input.event.createdAt : update.run.updatedAt,
						},
						outboxIntentIds: [`live:${update.run.runId}`],
					}
				: { outboxIntentIds: [] }),
		};
	}

	async commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput) {
		this.diagnostics.push(input.diagnostic);
		return { diagnostic: input.diagnostic, outboxIntentIds: [`diagnostic:${input.diagnostic.diagnosticId}`] };
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

async function redisNowMs(client: ReturnType<typeof createClient>): Promise<number> {
	const reply = await client.sendCommand(["TIME"]);
	if (!Array.isArray(reply) || reply.length !== 2) throw new Error("Redis TIME returned an invalid response");
	return Number(reply[0]) * 1_000 + Math.floor(Number(reply[1]) / 1_000);
}
