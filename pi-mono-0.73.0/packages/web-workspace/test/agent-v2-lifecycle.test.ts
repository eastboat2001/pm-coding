import { describe, expect, it, vi } from "vitest";
import { createAgentV2ShutdownDeadline, runAgentV2ShutdownSteps } from "../src/agent-v2-lifecycle.js";

describe("Agent v2 shutdown lifecycle", () => {
	it("shares one deadline so a second step receives only the remaining budget", async () => {
		const deadline = createAgentV2ShutdownDeadline(80);
		const observedRemaining: number[] = [];
		const startedAt = Date.now();
		try {
			const result = await runAgentV2ShutdownSteps(
				[
					{
						step: "worker.execution",
						async run(options) {
							observedRemaining.push(options.deadlineAtMs - Date.now());
							await delay(48);
						},
					},
					{
						step: "langfuse.fetch",
						async run(options) {
							observedRemaining.push(options.deadlineAtMs - Date.now());
							await new Promise<void>(() => undefined);
						},
					},
					{ step: "runtime_store.close", run: () => undefined },
				],
				deadline,
			);
			expect(Date.now() - startedAt).toBeLessThan(160);
			expect(observedRemaining[0]).toBeGreaterThan(55);
			expect(observedRemaining[1]).toBeLessThan(50);
			expect(result).toEqual({ completed: false, timedOutSteps: ["langfuse.fetch"], errors: [] });
		} finally {
			deadline.dispose();
		}
	});

	it("attempts every cleanup and absorbs a rejection that arrives after timeout", async () => {
		const deadline = createAgentV2ShutdownDeadline(15);
		const late = deferred<void>();
		const storeClose = vi.fn();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await runAgentV2ShutdownSteps(
				[
					{ step: "redis.claim_connect", run: () => late.promise },
					{ step: "runtime_store.close", run: storeClose },
				],
				deadline,
			);
			late.reject(new Error("credential=do-not-leak"));
			await delay(0);
			expect(result).toEqual({ completed: false, timedOutSteps: ["redis.claim_connect"], errors: [] });
			expect(storeClose).toHaveBeenCalledTimes(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			deadline.dispose();
		}
	});

	it("uses a fixed sanitized error contract", async () => {
		const deadline = createAgentV2ShutdownDeadline(100);
		try {
			const result = await runAgentV2ShutdownSteps(
				[{ step: "dispatcher.delivery", run: () => Promise.reject(new Error("redis://user:secret@host/key")) }],
				deadline,
			);
			expect(result.errors).toEqual([
				{
					step: "dispatcher.delivery",
					code: "agent_v2.shutdown_step_failed",
					message: "Agent v2 shutdown step failed",
				},
			]);
			expect(JSON.stringify(result)).not.toContain("secret");
		} finally {
			deadline.dispose();
		}
	});
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
