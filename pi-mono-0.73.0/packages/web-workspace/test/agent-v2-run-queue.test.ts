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
	it("claims through one atomic script without replacing an existing owner", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.claimResults.push('["client-a","run-a"]', undefined);
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "run-a" });
		await expect(queue.claim("worker-b", 0)).resolves.toBeUndefined();

		expect(fake.evalCalls).toHaveLength(2);
		expect(fake.evalCalls[0].script).toContain("agent-v2-claim");
		expect(fake.evalCalls[0].script).toContain("HEXISTS");
		expect(fake.evalCalls[1].arguments).toContain("worker-b");
	});

	it("lets concurrent bounded claims wait independently", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdClaimEvals = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		const first = queue.claim("worker-a", 50);
		const second = queue.claim("worker-b", 50);
		await fake.waitForClaimCalls(2);
		expect(fake.maxConcurrentClaimEvals).toBe(2);

		fake.resolveClaimEvals();
		await queue.close();
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
	});

	it("clears queue, active claims, and the cancel index in one atomic script", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.clearResult = [3, 1, 2];
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.clear()).resolves.toEqual({ queueItemsDeleted: 3, activeClaimsDeleted: 1, cancelKeysDeleted: 2 });
		expect(fake.evalCalls).toHaveLength(1);
		expect(fake.evalCalls[0].script).toContain("agent-v2-clear");
		expect(fake.evalCalls[0].keys).toEqual([
			"pi:agent-v2:runs",
			"pi:agent-v2:runs:active",
			"pi:agent-v2:runs:cancel",
		]);
	});

	it("shares one in-flight close promise", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdQuit = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });
		await queue.claim("worker-a", 0);

		const first = queue.close();
		const second = queue.close();
		expect(first).toBe(second);
		await fake.waitForQuit();
		expect(fake.quitCalls).toBe(1);

		fake.resolveQuit();
		await Promise.all([first, second]);
	});
});

class FakeRedisAgentV2RunQueueClient {
	isOpen = false;
	clearResult: [number, number, number] = [0, 0, 0];
	claimResults: Array<string | undefined> = [];
	evalCalls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
	holdClaimEvals = false;
	holdQuit = false;
	maxConcurrentClaimEvals = 0;
	quitCalls = 0;
	private activeClaimEvals = 0;
	private readonly claimEvalResolvers: Array<() => void> = [];
	private quitResolver: (() => void) | undefined;

	async connect(): Promise<void> {
		this.isOpen = true;
	}

	async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
		this.evalCalls.push({ script, keys: options.keys, arguments: options.arguments });
		if (script.includes("agent-v2-claim")) {
			this.activeClaimEvals += 1;
			this.maxConcurrentClaimEvals = Math.max(this.maxConcurrentClaimEvals, this.activeClaimEvals);
			if (this.holdClaimEvals) {
				await new Promise<void>((resolve) => this.claimEvalResolvers.push(resolve));
			}
			this.activeClaimEvals -= 1;
			return this.claimResults.shift();
		}
		if (script.includes("agent-v2-clear")) return this.clearResult;
		return 0;
	}

	async quit(): Promise<void> {
		this.quitCalls += 1;
		if (this.holdQuit) await new Promise<void>((resolve) => (this.quitResolver = resolve));
		this.isOpen = false;
	}

	async waitForClaimCalls(count: number): Promise<void> {
		while (this.evalCalls.filter((call) => call.script.includes("agent-v2-claim")).length < count) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	async waitForQuit(): Promise<void> {
		while (this.quitCalls === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	resolveClaimEvals(): void {
		for (const resolve of this.claimEvalResolvers.splice(0)) resolve();
	}

	resolveQuit(): void {
		this.quitResolver?.();
	}
}
