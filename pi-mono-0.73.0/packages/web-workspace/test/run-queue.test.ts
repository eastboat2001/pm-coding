import { describe, expect, it } from "vitest";
import { InMemoryRunQueue } from "../src/run-queue.js";

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
	});
});
