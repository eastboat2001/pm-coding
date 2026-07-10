import { describe, expect, it } from "vitest";
import { runAgentV2CutoverRehearsal } from "../src/worker/cutover-rehearsal.js";

const baseOptions = {
	baseUrl: "http://pi.test",
	clientId: "11111111-1111-4111-8111-111111111111",
	model: { provider: "test", id: "test-model" },
	sleep: async () => undefined,
	timeoutMs: 1_000,
	pollIntervalMs: 1,
};

describe("runAgentV2CutoverRehearsal", () => {
	it("verifies the v2 chain and retired route tombstones", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			fetch: scriptedFetch(requests, [
				json(200, { ok: true }),
				json(200, run("queued")),
				json(200, run("running")),
				json(200, { events: [event(1)] }),
				json(200, run("cancelling")),
				json(200, run("cancelled")),
				json(410, { error: "removed" }),
				json(410, { error: "removed" }),
			]),
		});

		expect(report.ok).toBe(true);
		expect(report.finalStatus).toBe("cancelled");
		expect(report.lastEventSeq).toBe(1);
		expect(report.checks.map((check) => check.name)).toEqual([
			"storage-health",
			"v2-run-start",
			"v2-run-read",
			"v2-event-replay",
			"v2-run-cancel",
			"retired-run-route",
			"retired-session-route",
		]);
		expect(requests.map((request) => request.url)).not.toContain("http://pi.test/api/pi-storage/reset");
		expect(requests.map((request) => request.method)).toEqual([
			"GET",
			"POST",
			"GET",
			"GET",
			"POST",
			"GET",
			"GET",
			"GET",
		]);
	});

	it("reports the last observed status and event sequence when replay times out", async () => {
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			timeoutMs: 0,
			fetch: scriptedFetch([], [
				json(200, { ok: true }),
				json(200, run("queued")),
				json(200, run("running")),
				json(200, { events: [] }),
				json(200, run("cancelling")),
				json(200, run("cancelled")),
				json(410, { error: "removed" }),
				json(410, { error: "removed" }),
			]),
		});

		expect(report.ok).toBe(false);
		expect(report.finalStatus).toBe("cancelled");
		expect(report.lastEventSeq).toBe(0);
		expect(report.checks.find((check) => check.name === "v2-event-replay")).toMatchObject({
			ok: false,
			detail: "Timed out waiting for event replay; last status: running; last event seq: 0.",
		});
		expect(JSON.stringify(report)).not.toContain("test-model");
	});
});

function scriptedFetch(
	requests: Array<{ url: string; method: string }>,
	responses: Response[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		requests.push({ url: String(input), method: init?.method ?? "GET" });
		const response = responses.shift();
		if (!response) throw new Error("Unexpected cutover rehearsal request");
		return response;
	};
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function run(status: string) {
	return { runId: "run-123", status, phase: status, input: {}, model: {} };
}

function event(seq: number) {
	return { seq, type: "agent_v2.phase_changed", payload: {}, createdAt: "2026-07-10T00:00:00.000Z" };
}
