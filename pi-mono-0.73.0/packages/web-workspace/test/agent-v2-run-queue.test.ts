import { describe, expect, it, vi } from "vitest";
import {
	type AgentV2RunQueue,
	type AgentV2RunQueueClearResult,
	createAgentV2RunQueue,
	createRedisAgentV2RunQueue,
} from "../src/agent-v2-run-queue.js";

const redisMock = vi.hoisted(() => ({
	createClient: vi.fn(),
}));

vi.mock("redis", () => ({
	createClient: redisMock.createClient,
}));

describe("InMemoryAgentV2RunQueue", () => {
	it("keeps claim, cancel, lease and cleanup state inside the v2 queue adapter", async () => {
		const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, cancelTtlSeconds: 60, now: () => 1_000 });
		await queue.enqueue({ clientId: "client-a", runId: "run-a" });
		expect(await queue.claim("worker-a", 0)).toEqual({ clientId: "client-a", runId: "run-a" });
		await queue.requestCancel({ clientId: "client-a", runId: "run-a" });
		expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-a" })).toBe(true);
		expect(await queue.renewLease({ clientId: "client-a", runId: "run-a" }, "worker-b")).toBe(false);
		await queue.complete({ clientId: "client-a", runId: "run-a" }, "worker-a");
		expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-a" })).toBe(false);
		expect(await queue.clear()).toEqual({ queueItemsDeleted: 0, activeClaimsDeleted: 0, cancelKeysDeleted: 0 });
	});

	it("uses FIFO ordering and client-scoped identities", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "run-1" });
		await queue.enqueue({ clientId: "client-b", runId: "run-1" });

		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "run-1" });
		await queue.complete({ clientId: "client-a", runId: "run-1" }, "worker-a");
		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-b", runId: "run-1" });
	});

	it("removes queued runs when cancellation is requested before claim", async () => {
		const queue = createAgentV2RunQueue();
		const run = { clientId: "client-a", runId: "run-1" };
		await queue.enqueue(run);
		await queue.requestCancel(run);

		await expect(queue.claim("worker-a", 0)).resolves.toBeUndefined();
		await expect(queue.isCancelRequested(run)).resolves.toBe(true);
	});

	it("rejects incomplete v2 identities for stateful operations", async () => {
		const queue = createAgentV2RunQueue();

		await expect(queue.requestCancel({ clientId: "", runId: "run-1" })).rejects.toThrow(
			"Agent v2 queue identity is missing clientId",
		);
	});

	it("requeues owned active claims after fresh queued work", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "stale" });
		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "stale" });
		await queue.enqueue({ clientId: "client-a", runId: "fresh" });

		await expect(queue.requeueActive("worker-a")).resolves.toBe(1);
		await expect(queue.claim("worker-b", 0)).resolves.toEqual({ clientId: "client-a", runId: "fresh" });
		await expect(queue.claim("worker-b", 0)).resolves.toEqual({ clientId: "client-a", runId: "stale" });
	});

	it("renews only owner leases and releases expired claims for recovery", async () => {
		let now = 1_000;
		const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, now: () => now });
		const run = { clientId: "client-a", runId: "stale" };
		await queue.enqueue(run);
		await queue.claim("worker-a", 0);

		now = 1_050;
		await expect(queue.renewLease(run, "worker-a")).resolves.toBe(true);
		await expect(queue.renewLease(run, "worker-b")).resolves.toBe(false);
		now = 1_149;
		await expect(queue.releaseExpiredClaims()).resolves.toEqual([]);
		now = 1_150;
		await expect(queue.releaseExpiredClaims()).resolves.toEqual([
			expect.objectContaining({ ...run, workerId: "worker-a" }),
		]);
	});

	it("counts and clears queued, active, and cancel state", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "queued" });
		await queue.enqueue({ clientId: "client-a", runId: "active" });
		await queue.claim("worker-a", 0);
		await queue.requestCancel({ clientId: "client-a", runId: "cancelled" });

		await expect(queue.clear()).resolves.toEqual({ queueItemsDeleted: 1, activeClaimsDeleted: 1, cancelKeysDeleted: 1 });
	});

	it("rejects operations after idempotent close", async () => {
		const queue = createAgentV2RunQueue();
		await queue.close();
		await queue.close();

		await expect(queue.enqueue({ clientId: "client-a", runId: "run-1" })).rejects.toThrow("Run queue is closed");
		await expect(queue.clear()).rejects.toThrow("Run queue is closed");
	});
});

describe("RedisAgentV2RunQueue", () => {
	it("clears queue, active claims, and v2 cancel keys with SCAN", async () => {
		const fake = new FakeRedisRunQueueClient();
		fake.queueLengths.set("pi:agent-v2:runs", 3);
		fake.hashLengths.set("pi:agent-v2:runs:active", 1);
		fake.scanResults.push("pi:agent-v2:runs:cancel:run-a", "pi:agent-v2:runs:cancel:run-b");
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.clear()).resolves.toEqual({ queueItemsDeleted: 3, activeClaimsDeleted: 1, cancelKeysDeleted: 2 });
		expect(fake.scanPatterns).toContain("pi:agent-v2:runs:cancel:*");
		expect(fake.delCalls).toEqual([
			["pi:agent-v2:runs"],
			["pi:agent-v2:runs:active"],
			["pi:agent-v2:runs:cancel:run-a", "pi:agent-v2:runs:cancel:run-b"],
		]);
	});
});

class FakeRedisRunQueueClient {
	isOpen = false;
	readonly delCalls: string[][] = [];
	readonly hashLengths = new Map<string, number>();
	readonly queueLengths = new Map<string, number>();
	readonly scanPatterns: string[] = [];
	readonly scanResults: string[] = [];

	async connect(): Promise<void> {
		this.isOpen = true;
	}

	async lLen(key: string): Promise<number> {
		return this.queueLengths.get(key) ?? 0;
	}

	async hLen(key: string): Promise<number> {
		return this.hashLengths.get(key) ?? 0;
	}

	async del(...keysOrBatches: Array<string | string[]>): Promise<number> {
		const keys = keysOrBatches.flat();
		this.delCalls.push(keys);
		return keys.length;
	}

	async *scanIterator(options: { MATCH?: string; COUNT?: number }): AsyncIterable<string> {
		this.scanPatterns.push(options.MATCH ?? "");
		for (const key of this.scanResults) yield key;
	}
}
