import { describe, expect, test } from "vitest";
import { createAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import { InMemoryRunQueue } from "../src/run-queue.js";

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
});
