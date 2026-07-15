import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentV2OutboxStore } from "../src/agent-v2-outbox.js";
import { type AgentV2OutboxDeliveryAdapter, AgentV2OutboxDispatcher } from "../src/agent-v2-outbox-dispatcher.js";
import { RedisAgentV2RunEventBus, type RedisAgentV2RunEventBusClient } from "../src/agent-v2-run-event-bus.js";
import { createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { createRedisFaultProxy } from "./support/redis-fault-proxy.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describeRedis("AgentV2OutboxDispatcher Redis integration", () => {
	it("recovers idempotently after Redis applied enqueue but its response was lost", async () => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const queueName = `pi:test:outbox:${randomUUID()}`;
		const queue = createRedisAgentV2RunQueue({ redisUrl: proxy.url, queueName });
		const store = createStore();
		const time = { value: "2026-07-15T00:00:01.000Z" };
		commitStart(store, queueName, "enqueue-loss");
		const adapter: AgentV2OutboxDeliveryAdapter<"run_enqueue"> = {
			kind: "run_enqueue",
			async deliver(intent) {
				await queue.enqueue({ clientId: intent.clientId, runId: intent.runId });
			},
		};
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [adapter],
			now: () => time.value,
			retryDelayMs: 1,
		});
		try {
			proxy.dropNextEvalResponse();
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 })).resolves.toMatchObject({
				leased: 1,
				retried: 1,
			});
			time.value = "2026-07-15T00:00:02.000Z";
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 })).resolves.toMatchObject({
				leased: 1,
				delivered: 1,
			});
			await expect(queue.claim("worker-a", 1)).resolves.toMatchObject({ runId: "enqueue-loss" });
			await expect(queue.claim("worker-b", 1)).resolves.toBeUndefined();
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			store.close();
			await proxy.close();
		}
	});

	it("replays cancel delivery after response loss without making the run executable", async () => {
		const proxy = await createRedisFaultProxy(redisUrl!);
		const queueName = `pi:test:outbox:${randomUUID()}`;
		const queue = createRedisAgentV2RunQueue({ redisUrl: proxy.url, queueName });
		const store = createStore();
		const time = { value: "2026-07-15T00:00:01.000Z" };
		commitStart(store, queueName, "cancel-loss");
		const run = store.getAgentV2Run("client-a", "cancel-loss")!;
		store.commitAgentV2RunCancel({
			clientId: run.clientId,
			runId: run.runId,
			expectedStatuses: ["queued"],
			expectedRun: {
				status: run.status,
				phase: run.phase,
				attempt: run.attempt,
				workerId: null,
				updatedAt: run.updatedAt,
			},
			queueName,
			cancelToken: "cancel-token-a",
			cancelledAt: "2026-07-15T00:00:00.001Z",
		});
		await queue.enqueue({ clientId: "client-a", runId: "cancel-loss" });
		const adapter: AgentV2OutboxDeliveryAdapter<"run_cancel"> = {
			kind: "run_cancel",
			async deliver(intent) {
				await queue.requestCancel({ clientId: intent.clientId, runId: intent.runId }, intent.reference.cancelToken);
			},
		};
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [adapter],
			now: () => time.value,
			retryDelayMs: 1,
		});
		try {
			proxy.dropNextEvalResponse();
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 })).resolves.toMatchObject({
				retried: 1,
			});
			time.value = "2026-07-15T00:00:02.000Z";
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 })).resolves.toMatchObject({
				delivered: 1,
			});
			await expect(
				queue.requestCancel({ clientId: "client-a", runId: "cancel-loss" }, "different-token"),
			).resolves.toBe("stale");
			await expect(queue.isCancelRequested({ clientId: "client-a", runId: "cancel-loss" })).resolves.toBe(true);
			await expect(queue.claim("worker-a", 1)).resolves.toBeUndefined();
		} finally {
			try {
				await queue.clear();
			} catch {}
			await queue.close();
			store.close();
			await proxy.close();
		}
	});

	it("reschedules while Redis is unavailable and projects after Redis recovers", async () => {
		const queueName = `pi:test:outbox:${randomUUID()}`;
		const store = createStore();
		const time = { value: "2026-07-15T00:00:01.000Z" };
		const runId = `redis-recovery-${randomUUID()}`;
		commitStart(store, queueName, runId);
		const unavailable = new RedisAgentV2RunEventBus({
			redisUrl: "redis://127.0.0.1:1",
			createClient: () =>
				createClient({
					url: "redis://127.0.0.1:1",
					socket: { reconnectStrategy: false },
				}) as RedisAgentV2RunEventBusClient,
		});
		const healthy = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, ttlSeconds: 60 });
		let bus = unavailable;
		const adapter: AgentV2OutboxDeliveryAdapter<"live_event"> = {
			kind: "live_event",
			async deliver(intent) {
				const [event] = store
					.listAgentV2RunEvents(intent.clientId, intent.runId, intent.reference.eventSeq - 1)
					.filter((candidate) => candidate.seq === intent.reference.eventSeq);
				if (!event) throw new Error("missing canonical event");
				await bus.project(event);
			},
		};
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [adapter],
			now: () => time.value,
			retryDelayMs: 1,
		});
		try {
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 1 })).resolves.toMatchObject({
				leased: 1,
				retried: 1,
			});
			bus = healthy;
			time.value = "2026-07-15T00:00:02.000Z";
			await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 1 })).resolves.toMatchObject({
				leased: 1,
				delivered: 1,
			});
			await expect(healthy.read({ clientId: "client-a", runId, afterSeq: 0, blockMs: 1 })).resolves.toHaveLength(1);
		} finally {
			await unavailable.close();
			await healthy.purge({ clientId: "client-a", runId });
			await healthy.close();
			store.close();
		}
	});
});

function createStore(): RuntimeDbStore & AgentV2OutboxStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-outbox-redis-"));
	roots.push(root);
	const store = new RuntimeDbStore(join(root, "runtime.db"));
	store.ensureAgentV2Schema();
	return store;
}

function commitStart(store: RuntimeDbStore, queueName: string, runId: string): void {
	const createdAt = "2026-07-15T00:00:00.000Z";
	store.commitAgentV2RunStart({
		run: {
			clientId: "client-a",
			runId,
			input: { prompt: "build" },
			model: { provider: "test" },
			createdAt,
			updatedAt: createdAt,
		},
		bootstrapVersion: "1",
		bootstrapChecksum: `checksum-${runId}`,
		inputBlobs: [],
		inputReferences: [],
		readyPhase: "implementation",
		documents: [],
		tasks: [],
		artifacts: [],
		diagnostics: [],
		queueName,
		createdAt,
	});
}
