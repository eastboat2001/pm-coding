import { describe, expect, it, vi } from "vitest";
import { AgentV2Readiness, AgentV2ReadinessGate } from "../src/agent-v2-readiness.js";

describe("agent v2 readiness", () => {
	it("reports every dependency and sanitizes failures", async () => {
		const report = await new AgentV2Readiness([
			{ name: "store", check: vi.fn(async () => undefined) },
			{
				name: "queue",
				check: vi.fn(async () => {
					throw new Error("redis://user:secret@internal:6379/private-key");
				}),
			},
		]).check({ signal: new AbortController().signal, checkedAt: "2026-07-15T00:00:00.000Z" });

		expect(report).toEqual({
			ready: false,
			checkedAt: "2026-07-15T00:00:00.000Z",
			dependencies: [
				{ name: "store", ready: true },
				{
					name: "queue",
					ready: false,
					code: "agent_v2.readiness_dependency_failed",
					message: "Agent v2 dependency queue is unavailable.",
				},
			],
		});
		expect(JSON.stringify(report)).not.toContain("secret");
	});

	it("coalesces concurrent checks, caches success for at most the configured ttl, and recovers after failure", async () => {
		let now = 1_000;
		let ready = true;
		const check = vi.fn(async () => {
			if (!ready) throw new Error("unavailable");
		});
		const gate = new AgentV2ReadinessGate(new AgentV2Readiness([{ name: "store", check }]), {
			now: () => now,
			successTtlMs: 1_000,
		});
		const signal = new AbortController().signal;

		const [first, concurrent] = await Promise.all([gate.check(signal), gate.check(signal)]);
		expect(first.ready).toBe(true);
		expect(concurrent).toBe(first);
		expect(check).toHaveBeenCalledTimes(1);

		now = 1_999;
		expect((await gate.check(signal)).ready).toBe(true);
		expect(check).toHaveBeenCalledTimes(1);

		now = 2_001;
		ready = false;
		expect((await gate.check(signal)).ready).toBe(false);
		expect(check).toHaveBeenCalledTimes(2);

		ready = true;
		expect((await gate.check(signal)).ready).toBe(true);
		expect(check).toHaveBeenCalledTimes(3);
	});

	it("does not start a dependency after the signal is aborted", async () => {
		const check = vi.fn(async () => undefined);
		const controller = new AbortController();
		controller.abort();

		const report = await new AgentV2Readiness([{ name: "store", check }]).check({
			signal: controller.signal,
			checkedAt: "2026-07-15T00:00:00.000Z",
		});

		expect(report.ready).toBe(false);
		expect(check).not.toHaveBeenCalled();
		expect(report.dependencies[0]).toMatchObject({
			name: "store",
			ready: false,
			code: "agent_v2.readiness_aborted",
		});
	});

	it("times out an unresponsive dependency with a child signal, clears in-flight state, and recovers", async () => {
		vi.useFakeTimers();
		try {
			let shouldHang = true;
			let dependencySignal: AbortSignal | undefined;
			let rejectHungCheck: ((reason?: unknown) => void) | undefined;
			const check = vi.fn((signal: AbortSignal) => {
				dependencySignal = signal;
				return shouldHang
					? new Promise<void>((_resolve, reject) => {
							rejectHungCheck = reject;
						})
					: Promise.resolve();
			});
			const readiness = new AgentV2Readiness([{ name: "store", check }], { timeoutMs: 25 });
			const gate = new AgentV2ReadinessGate(readiness, { successTtlMs: 0 });
			const parent = new AbortController();

			const first = gate.check(parent.signal);
			await vi.advanceTimersByTimeAsync(25);
			await expect(first).resolves.toMatchObject({
				ready: false,
				dependencies: [
					{
						name: "store",
						ready: false,
						code: "agent_v2.readiness_timeout",
						message: "Agent v2 dependency store readiness check timed out.",
					},
				],
			});
			expect(dependencySignal).not.toBe(parent.signal);
			expect(dependencySignal?.aborted).toBe(true);
			rejectHungCheck?.(new Error("late secret dependency rejection"));
			await Promise.resolve();

			shouldHang = false;
			await expect(gate.check(parent.signal, { force: true })).resolves.toMatchObject({ ready: true });
			expect(check).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("links each dependency child signal to parent cancellation", async () => {
		let dependencySignal: AbortSignal | undefined;
		const parent = new AbortController();
		const checking = new AgentV2Readiness(
			[
				{
					name: "store",
					check(signal) {
						dependencySignal = signal;
						return new Promise<void>(() => undefined);
					},
				},
			],
			{ timeoutMs: 10_000 },
		).check({ signal: parent.signal, checkedAt: "2026-07-15T00:00:00.000Z" });

		await Promise.resolve();
		parent.abort();
		await expect(checking).resolves.toMatchObject({
			ready: false,
			dependencies: [{ code: "agent_v2.readiness_aborted" }],
		});
		expect(dependencySignal).not.toBe(parent.signal);
		expect(dependencySignal?.aborted).toBe(true);
	});
});
