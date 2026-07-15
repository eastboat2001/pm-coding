import { describe, expect, it, vi } from "vitest";
import { createAgentV2RunQueue, createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";

const redisMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("redis", () => ({ createClient: redisMock.createClient }));

describe("InMemoryAgentV2RunQueue", () => {
	it("honors an aborted readiness ping", async () => {
		const queue = createAgentV2RunQueue();
		const controller = new AbortController();
		controller.abort();
		await expect(queue.ping!(controller.signal)).rejects.toThrow("agent_v2.readiness_aborted");
	});

	it("returns deterministic enqueue states and exact claimed ownership", async () => {
		const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, now: () => 1_000 });
		const run = { clientId: "client-a", runId: "run-a" };
		await expect(queue.enqueue(run)).resolves.toBe("enqueued");
		await expect(queue.enqueue(run)).resolves.toBe("already_ready");
		const claim = await queue.claim("worker-a", 0);
		expect(claim).toMatchObject({ ...run, workerId: "worker-a", leaseExpiresAtMs: 1_100 });
		expect(claim?.claimToken).toEqual(expect.any(String));
		await expect(queue.enqueue(run)).resolves.toBe("already_active");
	});

	it("uses FIFO ordering and client-scoped identities", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "run-1" });
		await queue.enqueue({ clientId: "client-b", runId: "run-1" });
		const first = await queue.claim("worker-a", 0);
		expect(first).toMatchObject({ clientId: "client-a", runId: "run-1" });
		await queue.complete(first!);
		await expect(queue.claim("worker-a", 0)).resolves.toMatchObject({ clientId: "client-b", runId: "run-1" });
	});

	it("rejects stale worker and token mutations", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "run-a" });
		const claim = (await queue.claim("worker-a", 0))!;
		await expect(queue.renewLease({ ...claim, workerId: "worker-b" })).resolves.toEqual({ status: "lost" });
		await expect(queue.renewLease({ ...claim, claimToken: "stale" })).resolves.toEqual({ status: "lost" });
		await expect(queue.complete({ ...claim, claimToken: "stale" })).resolves.toBe(false);
		await expect(queue.confirmOwnership(claim, 1)).resolves.toBe("owned");
		await expect(queue.complete(claim)).resolves.toBe(true);
		await expect(queue.confirmOwnership(claim, 1)).resolves.toBe("lost");
	});

	it("renews and atomically requeues an expired claim once", async () => {
		let now = 1_000;
		const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, now: () => now });
		await queue.enqueue({ clientId: "client-a", runId: "expired" });
		const claim = (await queue.claim("worker-a", 0))!;
		now = 1_050;
		await expect(queue.renewLease(claim)).resolves.toEqual({ status: "renewed", leaseExpiresAtMs: 1_150 });
		await expect(queue.requeueExpiredClaims(1_149)).resolves.toEqual([]);
		await expect(queue.requeueExpiredClaims(1_150)).resolves.toEqual([
			expect.objectContaining({ ...claim, leaseExpiresAtMs: 1_150 }),
		]);
		await expect(queue.requeueExpiredClaims(1_150)).resolves.toEqual([]);
		const next = await queue.claim("worker-b", 0);
		expect(next).toMatchObject({ clientId: "client-a", runId: "expired", workerId: "worker-b" });
		expect(next?.claimToken).not.toBe(claim.claimToken);
	});

	it("treats an expired but unreclaimed claim as lost and never revives it", async () => {
		let now = 1_000;
		const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, now: () => now });
		await queue.enqueue({ clientId: "client-a", runId: "expired-owned" });
		const claim = (await queue.claim("worker-a", 0))!;
		now = claim.leaseExpiresAtMs;

		await expect(queue.confirmOwnership(claim, 1)).resolves.toBe("lost");
		await expect(queue.renewLease(claim)).resolves.toEqual({ status: "lost" });
		await expect(queue.requeueExpiredClaims()).resolves.toEqual([expect.objectContaining(claim)]);
		await expect(queue.claim("worker-b", 0)).resolves.toMatchObject({
			clientId: "client-a",
			runId: "expired-owned",
			workerId: "worker-b",
		});
	});

	it("requeues all claims for one recovering worker without duplicating ready state", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "stale" });
		await queue.claim("worker-a", 0);
		await queue.enqueue({ clientId: "client-a", runId: "fresh" });
		await expect(queue.requeueActive("worker-a")).resolves.toBe(1);
		await expect(queue.claim("worker-b", 0)).resolves.toMatchObject({ runId: "fresh" });
		await expect(queue.claim("worker-b", 0)).resolves.toMatchObject({ runId: "stale" });
	});

	it("removes ready runs on cancellation and expires cancel state", async () => {
		let now = 1_000;
		const queue = createAgentV2RunQueue({ cancelTtlSeconds: 1, now: () => now });
		const run = { clientId: "client-a", runId: "run-a" };
		await queue.enqueue(run);
		await expect(queue.requestCancel(run, "cancel-a")).resolves.toBe("requested");
		now = 1_500;
		await expect(queue.requestCancel(run, "cancel-a")).resolves.toBe("already_requested");
		await expect(queue.requestCancel(run, "stale-token")).resolves.toBe("stale");
		await expect(queue.claim("worker-a", 0)).resolves.toBeUndefined();
		await expect(queue.isCancelRequested(run)).resolves.toBe(true);
		now = 2_000;
		await expect(queue.isCancelRequested(run)).resolves.toBe(false);
	});

	it("counts unique ready, active, and live cancel state", async () => {
		const queue = createAgentV2RunQueue();
		await queue.enqueue({ clientId: "client-a", runId: "ready" });
		await queue.enqueue({ clientId: "client-a", runId: "ready" });
		await queue.enqueue({ clientId: "client-a", runId: "active" });
		await queue.claim("worker-a", 0);
		await queue.requestCancel({ clientId: "client-a", runId: "cancelled" }, "cancel-a");
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 1,
			activeClaimsDeleted: 1,
			cancelKeysDeleted: 1,
		});
	});

	it("rejects invalid identities and operations after idempotent close", async () => {
		const queue = createAgentV2RunQueue();
		await expect(queue.enqueue({ clientId: "", runId: "run-a" })).rejects.toThrow("missing clientId");
		await queue.close();
		await queue.close();
		await expect(queue.clear()).rejects.toThrow("Run queue is closed");
	});
});

describe("RedisAgentV2RunQueue", () => {
	it("pings Redis through the shared command connection", async () => {
		const fake = new FakeRedisClient();
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "queue" });
		await expect(queue.ping!(new AbortController().signal)).resolves.toBeUndefined();
		expect(fake.pingCalls).toBe(1);
		await queue.close();
	});

	it("starts the work deadline only after the dedicated socket connects", async () => {
		const fake = new FakeRedisClient();
		fake.connectDelayMs = 25;
		fake.claimResult = claimJson("worker-a", "token-a");
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "queue" });
		const startedAt = Date.now();
		await expect(queue.claim("worker-a", 1)).resolves.toMatchObject({ runId: "run-a", workerId: "worker-a" });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
		expect(fake.evalCalls[0]?.keys).toEqual(["queue", "queue:ready", "queue:active"]);
	});

	it("uses one client per concurrent claim", async () => {
		const firstClient = new FakeRedisClient();
		const secondClient = new FakeRedisClient();
		firstClient.holdClaim = true;
		secondClient.holdClaim = true;
		firstClient.claimResult = claimJson("worker-a", "token-a");
		secondClient.claimResult = claimJson("worker-b", "token-b");
		redisMock.createClient.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "queue" });
		const first = queue.claim("worker-a", 20);
		const second = queue.claim("worker-b", 20);
		await Promise.all([firstClient.waitForEval(), secondClient.waitForEval()]);
		expect(firstClient.evalCalls).toHaveLength(1);
		expect(secondClient.evalCalls).toHaveLength(1);
		firstClient.release();
		secondClient.release();
		await Promise.all([first, second]);
		await queue.close();
		expect(firstClient.disconnectCalls).toBeGreaterThan(0);
		expect(secondClient.disconnectCalls).toBeGreaterThan(0);
	});

	it("returns uncertain ownership on a bounded command timeout", async () => {
		const fake = new FakeRedisClient();
		fake.holdAll = true;
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "queue" });
		await expect(queue.confirmOwnership(sampleClaim(), 5)).resolves.toBe("uncertain");
		fake.release();
		await queue.close();
	});

	it("sanitizes uncertain renewal failures", async () => {
		const fake = new FakeRedisClient();
		fake.evalError = new Error("redis://user:secret@example internal payload");
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({ redisUrl: "redis://example", queueName: "queue" });
		await expect(queue.renewLease(sampleClaim())).resolves.toEqual({
			status: "uncertain",
			errorCode: "agent_v2.redis_lease_uncertain",
		});
		await queue.close();
	});

	it("shares one close promise and bounds a stalled command client quit", async () => {
		const fake = new FakeRedisClient();
		fake.holdQuit = true;
		fake.clearResult = [1, 2, 3];
		redisMock.createClient.mockReturnValueOnce(fake);
		const queue = createRedisAgentV2RunQueue({
			redisUrl: "redis://example",
			queueName: "queue",
			gracefulCloseTimeoutMs: 5,
		});
		await expect(queue.clear()).resolves.toEqual({
			queueItemsDeleted: 1,
			activeClaimsDeleted: 2,
			cancelKeysDeleted: 3,
		});
		const first = queue.close();
		const second = queue.close();
		expect(first).toBe(second);
		await first;
		expect(fake.disconnectCalls).toBe(1);
	});
});

function sampleClaim() {
	return {
		clientId: "client-a",
		runId: "run-a",
		workerId: "worker-a",
		claimToken: "token-a",
		leaseExpiresAtMs: 2_000,
	};
}

function claimJson(workerId: string, claimToken: string): string {
	return JSON.stringify({ ...sampleClaim(), workerId, claimToken });
}

class FakeRedisClient {
	isOpen = false;
	connectDelayMs = 0;
	claimResult: unknown;
	clearResult: unknown;
	evalError: Error | undefined;
	holdAll = false;
	holdClaim = false;
	holdQuit = false;
	disconnectCalls = 0;
	pingCalls = 0;
	readonly evalCalls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
	private readonly resolvers: Array<() => void> = [];
	private evalStarted = false;

	on(): this {
		return this;
	}

	async connect(): Promise<void> {
		this.isOpen = true;
		if (this.connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
	}

	async ping(): Promise<string> {
		this.pingCalls += 1;
		return "PONG";
	}

	async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
		this.evalCalls.push({ script, keys: options.keys, arguments: options.arguments });
		this.evalStarted = true;
		if (this.evalError) throw this.evalError;
		if (this.holdAll || (this.holdClaim && script.includes("agent-v2-claim"))) {
			await new Promise<void>((resolve) => this.resolvers.push(resolve));
		}
		if (script.includes("agent-v2-claim")) return this.claimResult;
		if (script.includes("agent-v2-clear")) return this.clearResult;
		return 0;
	}

	async quit(): Promise<void> {
		if (this.holdQuit) await new Promise<void>((resolve) => this.resolvers.push(resolve));
		this.isOpen = false;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
		this.isOpen = false;
		this.release();
	}

	async waitForEval(): Promise<void> {
		while (!this.evalStarted) await new Promise((resolve) => setTimeout(resolve, 0));
	}

	release(): void {
		for (const resolve of this.resolvers.splice(0)) resolve();
	}
}
