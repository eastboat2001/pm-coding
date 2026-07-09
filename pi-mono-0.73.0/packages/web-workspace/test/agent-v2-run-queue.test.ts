import { describe, expect, test } from "vitest";
import {
	type AgentV2RunQueueClearResult,
	type AgentV2RunQueueIdentity,
	createAgentV2RunQueue,
} from "../src/agent-v2-run-queue.js";
import { InMemoryRunQueue } from "../src/run-queue.js";
import type { RunQueue } from "../src/run-queue.js";

describe("AgentV2RunQueue", () => {
	test("claims only structured v2 identities", async () => {
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());

		await queue.enqueue({ clientId: "client-a", runId: "run-1" });

		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "run-1" });
	});

	test("rejects legacy raw string queue claims", async () => {
		const base = new InMemoryRunQueue();
		await base.enqueue("legacy-run");
		const queue = createAgentV2RunQueue(base);

		await expect(queue.claim("worker-a", 0)).rejects.toThrow("Agent v2 queue claim is missing clientId");
	});

	test("uses cancel key through the wrapped queue", async () => {
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const run = { clientId: "client-a", runId: "run-1" };

		await queue.enqueue(run);
		await queue.requestCancel(run);

		await expect(queue.isCancelRequested(run)).resolves.toBe(true);
		await expect(queue.claim("worker-a", 0)).resolves.toBeUndefined();
	});

	test("delegates clear to the wrapped queue", async () => {
		const result: AgentV2RunQueueClearResult = {
			queueItemsDeleted: 4,
			activeClaimsDeleted: 3,
			cancelKeysDeleted: 2,
		};
		const base = new ClearOnlyRunQueue(result);
		const queue = createAgentV2RunQueue(base);

		await expect(queue.clear()).resolves.toEqual(result);
		expect(base.clearCalls).toBe(1);
	});
});

class ClearOnlyRunQueue implements RunQueue {
	clearCalls = 0;

	constructor(private readonly result: AgentV2RunQueueClearResult) {}

	async enqueue(_run: AgentV2RunQueueIdentity | string): Promise<void> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async claim(): Promise<undefined> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async complete(): Promise<void> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async requeueActive(): Promise<number> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async renewLease(): Promise<boolean> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async releaseExpiredClaims(): Promise<[]> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async requestCancel(): Promise<void> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async isCancelRequested(): Promise<boolean> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}

	async clear(): Promise<AgentV2RunQueueClearResult> {
		this.clearCalls += 1;
		return this.result;
	}

	async close(): Promise<void> {
		throw new Error("wrapper must delegate clear without inferring queue keys");
	}
}
