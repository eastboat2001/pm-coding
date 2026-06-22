import type { RuntimeRunEventRecord } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import {
	retryStatusFromRunEvent,
	retryStatusText,
	shouldClearRetryStatusForRunEvent,
} from "../src/runtime/run-retry-status.js";

describe("run retry status", () => {
	it("formats retry status from scheduled retry run events", () => {
		const status = retryStatusFromRunEvent(
			createRunEvent({
				type: "agent_retry_scheduled",
				attempt: 2,
				maxAttempts: 5,
				reasonCode: "transient_provider_error",
				delayMs: 1250,
			}),
		);

		expect(status).toEqual({ label: "Retrying request...", attempt: 2, maxAttempts: 5, delayMs: 1250 });
		expect(retryStatusText(status!, (label) => `ZH:${label}`)).toBe(
			"ZH:Retrying request... (2/5, ZH:next attempt in 1.3s)",
		);
	});

	it("clears retry status when normal agent events resume", () => {
		expect(shouldClearRetryStatusForRunEvent(createRunEvent({ type: "agent_retry_scheduled" }))).toBe(false);
		expect(shouldClearRetryStatusForRunEvent(createRunEvent({ type: "agent_start" }))).toBe(true);
	});
});

function createRunEvent(payload: Record<string, unknown>): RuntimeRunEventRecord {
	return {
		eventId: 1,
		runId: "run-1",
		sessionId: "session-1",
		clientId: "client-a",
		seq: 1,
		type: String(payload.type),
		payload,
		createdAt: "2026-06-17T00:00:00.000Z",
	};
}
