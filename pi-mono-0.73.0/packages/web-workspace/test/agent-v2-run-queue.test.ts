import { describe, expect, it, vi } from "vitest";
import { createAgentV2RunQueue, createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";

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

	it("does not replace an active owner when a duplicate identity is queued", async () => {
		const queue = createAgentV2RunQueue();
		const run = { clientId: "client-a", runId: "run-1" };
		await queue.enqueue(run);
		await queue.enqueue(run);

		await expect(queue.claim("worker-a", 0)).resolves.toEqual(run);
		await expect(queue.claim("worker-b", 0)).resolves.toBeUndefined();
		await expect(queue.renewLease(run, "worker-a")).resolves.toBe(true);
		await expect(queue.renewLease(run, "worker-b")).resolves.toBe(false);
		await queue.complete(run, "worker-a");
		await expect(queue.claim("worker-b", 0)).resolves.toBeUndefined();
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

		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 1,
			activeClaimsDeleted: 1,
			cancelKeysDeleted: 1,
		});
	});

	it("does not count expired cancellation state during clear", async () => {
		let now = 1_000;
		const queue = createAgentV2RunQueue({ cancelTtlSeconds: 1, now: () => now });
		const expired = { clientId: "client-a", runId: "expired" };
		await queue.requestCancel(expired);
		now = 2_000;
		await expect(queue.isCancelRequested(expired)).resolves.toBe(false);
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 0,
			activeClaimsDeleted: 0,
			cancelKeysDeleted: 0,
		});

		const valid = { clientId: "client-a", runId: "valid" };
		await queue.requestCancel(valid);
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 0,
			activeClaimsDeleted: 0,
			cancelKeysDeleted: 1,
		});
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

	it("bounds a stalled Redis claim by the caller deadline", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdClaimEvals = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		const claim = queue.claim("worker-a", 20);
		await fake.waitForClaimCalls(1);
		const outcome = await Promise.race([
			claim.then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
		]);
		fake.resolveClaimEvals();
		await claim;
		await queue.close();

		expect(outcome).toBe("settled");
		expect(fake.disconnectCalls).toBeGreaterThan(0);
	});

	it("bounds a stalled Redis connection by the caller deadline", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdConnect = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		const claim = queue.claim("worker-a", 20);
		await fake.waitForConnect();
		const outcome = await Promise.race([
			claim.then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
		]);
		fake.resolveConnect();
		await claim;
		await queue.close();

		expect(outcome).toBe("settled");
		expect(fake.disconnectCalls).toBeGreaterThan(0);
	});

	it("recovers a claim that committed before its Redis response was lost", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdClaimEvals = true;
		fake.claimCommittedWithoutResponse = '["client-a","run-committed"]';
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.claim("worker-a", 20)).resolves.toEqual({
			clientId: "client-a",
			runId: "run-committed",
		});
		expect(fake.evalCalls.some((call) => call.script.includes("agent-v2-recover-claim-token"))).toBe(true);
		await queue.close();
	});

	it("surfaces a Redis claim error when token recovery does not find a committed claim", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.claimError = new Error("WRONGTYPE claim key");
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.claim("worker-a", 20)).rejects.toThrow("WRONGTYPE claim key");
		expect(fake.evalCalls.some((call) => call.script.includes("agent-v2-recover-claim-token"))).toBe(true);
		await queue.close();
	});

	it("interrupts a stalled claim before waiting during close", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdClaimEvals = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		const claim = queue.claim("worker-a", 10_000);
		await fake.waitForClaimCalls(1);
		const closing = queue.close();
		const outcome = await Promise.race([
			closing.then(() => "closed" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
		]);
		fake.resolveClaimEvals();
		await claim;
		await closing;

		expect(outcome).toBe("closed");
		expect(fake.disconnectCalls).toBeGreaterThan(0);
	});

	it("uses bounded backoff while an empty Redis queue is claimed", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.claim("worker-a", 120)).resolves.toBeUndefined();
		const claimCalls = fake.evalCalls.filter((call) => call.script.includes("agent-v2-claim"));
		expect(claimCalls.length).toBeLessThanOrEqual(4);
		await queue.close();
	});

	it("isolates a timed-out claim connection from lease and cancellation commands", async () => {
		const claimClient = new FakeRedisAgentV2RunQueueClient();
		claimClient.holdClaimEvals = true;
		const commandClient = new FakeRedisAgentV2RunQueueClient();
		redisMock.createClient.mockReturnValueOnce(claimClient).mockReturnValueOnce(commandClient);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });
		const run = { clientId: "client-a", runId: "run-a" };

		const claim = queue.claim("worker-a", 20);
		await claimClient.waitForClaimCalls(1);
		await expect(queue.renewLease(run, "worker-a")).resolves.toBe(false);
		await expect(queue.requestCancel(run)).resolves.toBeUndefined();
		await claim;

		expect(claimClient.disconnectCalls).toBeGreaterThan(0);
		expect(commandClient.disconnectCalls).toBe(0);
		await queue.close();
		expect(commandClient.quitCalls).toBe(1);
	});

	it("clears queue, active claims, and the cancel index in one atomic script", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.clearResult = [3, 1, 2];
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });

		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 3,
			activeClaimsDeleted: 1,
			cancelKeysDeleted: 2,
		});
		expect(fake.evalCalls).toHaveLength(1);
		expect(fake.evalCalls[0].script).toContain("agent-v2-clear");
		expect(fake.evalCalls[0].keys).toEqual([
			"pi:agent-v2:runs",
			"pi:agent-v2:runs:active",
			"pi:agent-v2:runs:cancel",
		]);
	});

	it("uses an expiring cancel index and excludes expired members from clear", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.clearResult = [0, 0, 1];
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });
		const expired = { clientId: "client-a", runId: "expired" };

		await queue.requestCancel(expired);
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 0,
			activeClaimsDeleted: 0,
			cancelKeysDeleted: 1,
		});

		const requestCancelScript = fake.evalCalls.find((call) =>
			call.script.includes("agent-v2-request-cancel"),
		)?.script;
		const clearScript = fake.evalCalls.find((call) => call.script.includes("agent-v2-clear"))?.script;
		expect(requestCancelScript).toContain("ZADD");
		expect(requestCancelScript).toContain("EXPIRE");
		expect(clearScript).toContain("ZREMRANGEBYSCORE");
		expect(clearScript).toContain("ZCARD");
	});

	it("prunes expired cancel members for other identities during normal cancellation traffic", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.cancelMembers.set('["client-a","expired"]', 1_000);
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });
		const valid = { clientId: "client-a", runId: "valid" };

		await queue.requestCancel(valid);
		expect(fake.cancelMembers.has('["client-a","expired"]')).toBe(false);
		expect(fake.cancelMembers.has('["client-a","valid"]')).toBe(true);
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 0,
			activeClaimsDeleted: 0,
			cancelKeysDeleted: 1,
		});

		const requestCancelScript = fake.evalCalls.find((call) =>
			call.script.includes("agent-v2-request-cancel"),
		)?.script;
		expect(requestCancelScript).toContain("ZREMRANGEBYSCORE");
	});

	it("shares one in-flight close promise", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdQuit = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "pi:agent-v2:runs" });
		await queue.clear();

		const first = queue.close();
		const second = queue.close();
		expect(first).toBe(second);
		await fake.waitForQuit();
		expect(fake.quitCalls).toBe(1);

		fake.resolveQuit();
		await Promise.all([first, second]);
	});

	it("forces disconnect when graceful quit stalls behind an active maintenance command", async () => {
		const fake = new FakeRedisAgentV2RunQueueClient();
		fake.holdReleaseExpiredClaimsEvals = true;
		fake.holdQuit = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({
			redisUrl: "redis://example",
			queueName: "pi:agent-v2:runs",
			gracefulCloseTimeoutMs: 20,
		});

		const recovery = queue.releaseExpiredClaims();
		await fake.waitForReleaseExpiredClaimsCalls(1);
		const outcome = await Promise.race([
			queue.close().then(() => "closed" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
		]);

		expect(outcome).toBe("closed");
		expect(fake.disconnectCalls).toBeGreaterThan(0);
		await expect(recovery).resolves.toEqual([]);
	});
});

class FakeRedisAgentV2RunQueueClient {
	isOpen = false;
	cancelMembers = new Map<string, number>();
	clearResult: [number, number, number] | undefined;
	claimResults: Array<string | undefined> = [];
	claimCommittedWithoutResponse: string | undefined;
	claimError: Error | undefined;
	evalCalls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
	holdClaimEvals = false;
	holdConnect = false;
	holdQuit = false;
	holdReleaseExpiredClaimsEvals = false;
	disconnectCalls = 0;
	maxConcurrentClaimEvals = 0;
	quitCalls = 0;
	private activeClaimEvals = 0;
	private readonly claimEvalResolvers: Array<() => void> = [];
	private readonly releaseExpiredClaimsEvalResolvers: Array<() => void> = [];
	private readonly committedClaims = new Map<string, string>();
	private connectResolver: (() => void) | undefined;
	private connectStarted = false;
	private quitResolver: (() => void) | undefined;

	async connect(): Promise<void> {
		this.isOpen = true;
		this.connectStarted = true;
		if (this.holdConnect) {
			await new Promise<void>((resolve) => {
				this.connectResolver = resolve;
			});
		}
	}

	async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
		this.evalCalls.push({ script, keys: options.keys, arguments: options.arguments });
		if (script.includes("agent-v2-claim")) {
			if (this.claimError) throw this.claimError;
			this.activeClaimEvals += 1;
			this.maxConcurrentClaimEvals = Math.max(this.maxConcurrentClaimEvals, this.activeClaimEvals);
			if (this.holdClaimEvals) {
				if (this.claimCommittedWithoutResponse) {
					this.committedClaims.set(options.arguments[4], this.claimCommittedWithoutResponse);
				}
				await new Promise<void>((resolve) => this.claimEvalResolvers.push(resolve));
			}
			this.activeClaimEvals -= 1;
			if (this.claimCommittedWithoutResponse) return undefined;
			return this.claimResults.shift();
		}
		if (script.includes("agent-v2-recover-claim-token")) {
			return this.committedClaims.get(options.arguments[0]);
		}
		if (script.includes("local reclaimed = {}")) {
			if (this.holdReleaseExpiredClaimsEvals) {
				await new Promise<void>((resolve) => this.releaseExpiredClaimsEvalResolvers.push(resolve));
			}
			return [];
		}
		if (script.includes("agent-v2-request-cancel")) {
			this.pruneExpiredCancelMembers(Number(options.arguments[3]));
			this.cancelMembers.set(options.arguments[0], Number(options.arguments[1]));
			return 0;
		}
		if (script.includes("agent-v2-check-cancel")) {
			this.pruneExpiredCancelMembers(Number(options.arguments[1]));
			return this.cancelMembers.has(options.arguments[0]) ? 1 : 0;
		}
		if (script.includes("agent-v2-clear")) {
			this.pruneExpiredCancelMembers(Number(options.arguments[0]));
			return this.clearResult ?? [0, 0, this.cancelMembers.size];
		}
		return 0;
	}

	async quit(): Promise<void> {
		this.quitCalls += 1;
		if (this.holdQuit) {
			await new Promise<void>((resolve) => {
				this.quitResolver = resolve;
			});
		}
		this.isOpen = false;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
		this.isOpen = false;
		this.resolveClaimEvals();
		this.resolveReleaseExpiredClaimsEvals();
		this.resolveConnect();
	}

	async waitForClaimCalls(count: number): Promise<void> {
		while (this.evalCalls.filter((call) => call.script.includes("agent-v2-claim")).length < count) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	async waitForConnect(): Promise<void> {
		while (!this.connectStarted) await new Promise((resolve) => setTimeout(resolve, 0));
	}

	async waitForReleaseExpiredClaimsCalls(count: number): Promise<void> {
		while (this.evalCalls.filter((call) => call.script.includes("local reclaimed = {}")).length < count) {
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

	resolveConnect(): void {
		this.holdConnect = false;
		this.connectResolver?.();
		this.connectResolver = undefined;
	}

	resolveReleaseExpiredClaimsEvals(): void {
		for (const resolve of this.releaseExpiredClaimsEvalResolvers.splice(0)) resolve();
	}

	resolveQuit(): void {
		this.quitResolver?.();
	}

	private pruneExpiredCancelMembers(now: number): void {
		for (const [identity, expiresAt] of this.cancelMembers) {
			if (expiresAt <= now) this.cancelMembers.delete(identity);
		}
	}
}
