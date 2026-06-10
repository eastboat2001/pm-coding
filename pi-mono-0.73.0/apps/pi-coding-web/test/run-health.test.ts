import type { RuntimeRunRecord } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import { createQueuedRunTimeoutDiagnostic } from "../src/runtime/run-health.js";

describe("run health diagnostics", () => {
	it("creates an error diagnostic when a run stays queued past the timeout", () => {
		const run = createRun({ status: "queued", updatedAt: "2026-06-10T00:00:00.000Z" });

		const diagnostic = createQueuedRunTimeoutDiagnostic(run, {
			nowMs: Date.parse("2026-06-10T00:00:12.000Z"),
			timeoutMs: 10_000,
		});

		expect(diagnostic).toMatchObject({
			level: "error",
			category: "agent",
			eventType: "agent.remote_run.queued_timeout",
			data: {
				runId: "run-1",
				sessionId: "session-1",
				status: "queued",
				queuedMs: 12_000,
				message: "Run stayed queued without worker progress; PI worker or Redis may not be running.",
			},
		});
	});

	it("does not report non-queued or recently queued runs", () => {
		expect(
			createQueuedRunTimeoutDiagnostic(createRun({ status: "running" }), {
				nowMs: Date.parse("2026-06-10T00:00:12.000Z"),
				timeoutMs: 10_000,
			}),
		).toBeUndefined();
		expect(
			createQueuedRunTimeoutDiagnostic(createRun({ status: "queued" }), {
				nowMs: Date.parse("2026-06-10T00:00:09.000Z"),
				timeoutMs: 10_000,
			}),
		).toBeUndefined();
	});
});

function createRun(overrides: Partial<RuntimeRunRecord> = {}): RuntimeRunRecord {
	return {
		runId: "run-1",
		sessionId: "session-1",
		clientId: "client-1",
		status: "queued",
		model: {},
		thinkingLevel: "high",
		updatedAt: "2026-06-10T00:00:00.000Z",
		...overrides,
	};
}
