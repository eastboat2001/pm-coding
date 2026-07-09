import { describe, expect, it, vi } from "vitest";
import { InMemoryRunQueue, RedisRunQueue } from "../src/run-queue.js";

const redisMock = vi.hoisted(() => ({
	createClient: vi.fn(),
}));

vi.mock("redis", () => ({
	createClient: redisMock.createClient,
}));

describe("InMemoryRunQueue", () => {
	it("claims queued runs and removes completed runs", async () => {
		const queue = new InMemoryRunQueue();

		await queue.enqueue("r1");

		await expect(queue.claim("w1", 10)).resolves.toEqual({ runId: "r1" });
		await queue.complete("r1", "w1");
		await expect(queue.claim("w1", 1)).resolves.toBeUndefined();
	});

	it("tracks requested cancellations", async () => {
		const queue = new InMemoryRunQueue();

		await queue.requestCancel("r1");

		await expect(queue.isCancelRequested("r1")).resolves.toBe(true);
	});

	it("clears cancellation markers when a claimed run completes", async () => {
		const queue = new InMemoryRunQueue();
		const run = { clientId: "client-a", runId: "run-1" };

		await queue.enqueue(run);
		await expect(queue.claim("worker-a", 0)).resolves.toEqual(run);
		await queue.requestCancel(run);

		await queue.complete(run, "worker-a");

		await expect(queue.isCancelRequested(run)).resolves.toBe(false);
	});

	it("clears queued, active, and cancel state", async () => {
		const queue = new InMemoryRunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "run-queued" });
		await queue.enqueue({ clientId: "client-a", runId: "run-active" });
		expect(await queue.claim("worker-a", 0)).toEqual({ clientId: "client-a", runId: "run-queued" });
		await queue.requestCancel({ clientId: "client-a", runId: "run-cancelled" });

		const result = await queue.clear();

		expect(result).toEqual({ queueItemsDeleted: 1, activeClaimsDeleted: 1, cancelKeysDeleted: 1 });
		expect(await queue.claim("worker-a", 0)).toBeUndefined();
		expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-cancelled" })).toBe(false);
	});

	it("removes queued runs when cancellation is requested before claim", async () => {
		const queue = new InMemoryRunQueue();

		await queue.enqueue({ clientId: "client-a", runId: "r1" });
		await queue.requestCancel({ clientId: "client-a", runId: "r1" });

		await expect(queue.claim("w1", 10)).resolves.toBeUndefined();
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: "r1" })).resolves.toBe(true);
	});

	it("uses client and run identity for claims and cancellations", async () => {
		const queue = new InMemoryRunQueue();

		await queue.enqueue({ clientId: "client-a", runId: "r1" });
		await queue.enqueue({ clientId: "client-b", runId: "r1" });

		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-a", runId: "r1" });
		await queue.complete({ clientId: "client-a", runId: "r1" }, "w1");
		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-b", runId: "r1" });
		await queue.requestCancel({ clientId: "client-b", runId: "r1" });

		await expect(queue.isCancelRequested({ clientId: "client-a", runId: "r1" })).resolves.toBe(false);
		await expect(queue.isCancelRequested({ clientId: "client-b", runId: "r1" })).resolves.toBe(true);
	});

	it("requeues active claims owned by a worker", async () => {
		const queue = new InMemoryRunQueue();

		await queue.enqueue({ clientId: "client-a", runId: "r1" });
		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-a", runId: "r1" });

		await expect(queue.requeueActive("w1")).resolves.toBe(1);
		await expect(queue.claim("w2", 10)).resolves.toEqual({ clientId: "client-a", runId: "r1" });
	});

	it("does not prioritize recovered active claims ahead of fresh queued runs", async () => {
		const queue = new InMemoryRunQueue();

		await queue.enqueue({ clientId: "client-a", runId: "stale" });
		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-a", runId: "stale" });
		await queue.enqueue({ clientId: "client-a", runId: "fresh" });

		await expect(queue.requeueActive("w1")).resolves.toBe(1);
		await expect(queue.claim("w2", 10)).resolves.toEqual({ clientId: "client-a", runId: "fresh" });
		await expect(queue.claim("w2", 10)).resolves.toEqual({ clientId: "client-a", runId: "stale" });
	});

	it("renews active claim leases and releases only expired claims", async () => {
		let nowMs = 1_000;
		const queue = new InMemoryRunQueue({
			leaseTtlMs: 100,
			nowMs: () => nowMs,
		});

		await queue.enqueue({ clientId: "client-a", runId: "lease-run" });
		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-a", runId: "lease-run" });

		nowMs = 1_050;
		await expect(queue.renewLease({ clientId: "client-a", runId: "lease-run" }, "w1")).resolves.toBe(true);

		nowMs = 1_120;
		await expect(queue.releaseExpiredClaims()).resolves.toEqual([]);

		nowMs = 1_200;
		await expect(queue.releaseExpiredClaims()).resolves.toEqual([
			expect.objectContaining({
				clientId: "client-a",
				runId: "lease-run",
				workerId: "w1",
			}),
		]);
		await expect(queue.releaseExpiredClaims()).resolves.toEqual([]);
	});

	it("allows another worker to reclaim an expired claim after recovery re-enqueues it", async () => {
		let nowMs = 1_000;
		const queue = new InMemoryRunQueue({
			leaseTtlMs: 100,
			nowMs: () => nowMs,
		});

		await queue.enqueue({ clientId: "client-a", runId: "stale-run" });
		await expect(queue.claim("w1", 10)).resolves.toEqual({ clientId: "client-a", runId: "stale-run" });

		nowMs = 1_150;
		const expired = await queue.releaseExpiredClaims();
		for (const claim of expired) {
			await queue.enqueue({ clientId: claim.clientId!, runId: claim.runId });
		}

		await expect(queue.claim("w2", 10)).resolves.toEqual({ clientId: "client-a", runId: "stale-run" });
	});

	it("rejects operations after close", async () => {
		const queue = new InMemoryRunQueue();

		await queue.close();

		await expect(queue.enqueue("r1")).rejects.toThrow("Run queue is closed");
		await expect(queue.claim("w1", 1)).rejects.toThrow("Run queue is closed");
		await expect(queue.clear()).rejects.toThrow("Run queue is closed");
	});
});

describe("RedisRunQueue", () => {
	it("clears queue, active claims, and cancel keys with SCAN", async () => {
		const fake = new FakeRedisRunQueueClient();
		fake.queueLengths.set("pi:agent-v2:runs", 3);
		fake.hashLengths.set("pi:agent-v2:runs:active", 1);
		fake.scanResults.push("pi:agent-v2:runs:cancel:run-a", "pi:agent-v2:runs:cancel:run-b");
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = new RedisRunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		const result = await queue.clear();

		expect(fake.scanPatterns).toContain("pi:agent-v2:runs:cancel:*");
		expect(fake.usedKeysCommand).toBe(false);
		expect(result).toEqual({ queueItemsDeleted: 3, activeClaimsDeleted: 1, cancelKeysDeleted: 2 });
		expect(fake.delCalls).toEqual([
			["pi:agent-v2:runs"],
			["pi:agent-v2:runs:active"],
			["pi:agent-v2:runs:cancel:run-a", "pi:agent-v2:runs:cancel:run-b"],
		]);
	});

	it("rejects clear after close", async () => {
		const fake = new FakeRedisRunQueueClient();
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = new RedisRunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await queue.close();

		await expect(queue.clear()).rejects.toThrow("Run queue is closed");
	});
});

class FakeRedisRunQueueClient {
	isOpen = false;
	readonly delCalls: string[][] = [];
	readonly hashLengths = new Map<string, number>();
	readonly queueLengths = new Map<string, number>();
	readonly scanPatterns: string[] = [];
	readonly scanResults: string[] = [];
	usedKeysCommand = false;

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
		for (const key of this.scanResults) {
			yield key;
		}
	}

	async keys(_pattern: string): Promise<string[]> {
		this.usedKeysCommand = true;
		return [];
	}
}
