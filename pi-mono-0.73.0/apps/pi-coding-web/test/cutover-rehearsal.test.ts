import { describe, expect, it } from "vitest";
import {
	runAgentV2CutoverRehearsal,
	runAgentV2CutoverRehearsalCommand,
} from "../src/worker/cutover-rehearsal.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const baseOptions = {
	baseUrl: "http://pi.test",
	clientId,
	model: { provider: "test", id: "test-model" },
	sleep: async () => undefined,
	timeoutMs: 1_000,
	pollIntervalMs: 1,
};

describe("runAgentV2CutoverRehearsal", () => {
	it("verifies the v2 chain and retired route tombstones with the expected HTTP contract", async () => {
		const requests: RequestRecord[] = [];
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			fetch: scriptedFetch(requests, successfulCutoverResponses()),
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
		expect(requests.map((request) => request.url)).toEqual([
			"http://pi.test/api/pi-storage/status",
			"http://pi.test/api/agent-v2/runs/start",
			"http://pi.test/api/agent-v2/runs/run-123",
			"http://pi.test/api/agent-v2/runs/run-123/events?afterSeq=0",
			"http://pi.test/api/agent-v2/runs/run-123/cancel",
			"http://pi.test/api/agent-v2/runs/run-123",
			"http://pi.test/api/runs",
			"http://pi.test/api/pi-sessions",
		]);
		expect(requests.every((request) => request.clientId === clientId && request.signal !== undefined)).toBe(true);
		expect(requests.every((request) => !request.signal?.aborted)).toBe(true);
		expect(JSON.parse(requests[1].body ?? "{}")).toMatchObject({
			input: { prompt: "Production cutover rehearsal. Do not create project files." },
			model: { provider: "test", id: "test-model" },
		});
		expect(requests.map((request) => request.url)).not.toContain("http://pi.test/api/pi-storage/reset");
	});

	it("reports the last observed status and event sequence when the shared deadline expires", async () => {
		let now = 0;
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			timeoutMs: 1,
			now: () => now,
			sleep: async () => {
				now = 2;
			},
			fetch: scriptedFetch([], [
				json(200, { ok: true }),
				json(200, run("queued")),
				json(200, run("running")),
				json(200, { events: [] }),
			]),
		});

		expect(report.ok).toBe(false);
		expect(report.finalStatus).toBe("running");
		expect(report.lastEventSeq).toBe(0);
		expect(report.checks.find((check) => check.name === "v2-event-replay")).toMatchObject({
			ok: false,
			detail: "Timed out waiting for event replay; last status: running; last event seq: 0.",
		});
	});

	it("settles a fetch that ignores abort signals at the shared deadline", async () => {
		const signals: AbortSignal[] = [];
		const startedAt = Date.now();
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			timeoutMs: 20,
			fetch: async (_input, init) => {
				signals.push(init?.signal as AbortSignal);
				return await new Promise<Response>(() => undefined);
			},
		});

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(report.ok).toBe(false);
		expect(report.checks[0]).toEqual({ name: "storage-health", ok: false, detail: "Request timed out." });
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(true);
	});

	it("settles a response body that never completes at the shared deadline", async () => {
		const startedAt = Date.now();
		const hangingBodyResponse = {
			ok: true,
			status: 200,
			json: async () => await new Promise<unknown>(() => undefined),
		} as Response;
		const report = await runAgentV2CutoverRehearsal({
			...baseOptions,
			timeoutMs: 20,
			fetch: async () => hangingBodyResponse,
		});

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(report.ok).toBe(false);
		expect(report.checks[1]).toEqual({ name: "v2-run-start", ok: false, detail: "Request timed out." });
	});

	it("redacts network errors and HTTP response bodies from reports", async () => {
		const secret = "cutover-secret-sentinel";
		const networkReport = await runAgentV2CutoverRehearsal({
			...baseOptions,
			fetch: async () => {
				throw new Error(secret);
			},
		});
		const httpReport = await runAgentV2CutoverRehearsal({
			...baseOptions,
			fetch: async () => json(503, { error: secret }),
		});

		expect(JSON.stringify(networkReport)).not.toContain(secret);
		expect(JSON.stringify(httpReport)).not.toContain(secret);
	});
});

describe("runAgentV2CutoverRehearsalCommand", () => {
	it("writes exactly one JSON report and returns zero for a successful rehearsal", async () => {
		const output: string[] = [];
		const exitCode = await runAgentV2CutoverRehearsalCommand({
			env: cutoverEnvironment(),
			output: (line) => output.push(line),
			fetch: scriptedFetch([], successfulCutoverResponses()),
			sleep: async () => undefined,
		});

		expect(exitCode).toBe(0);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toMatchObject({ ok: true });
	});

	it("writes one redacted structured configuration report and returns one", async () => {
		const secret = "cutover-secret-sentinel";
		const output: string[] = [];
		const exitCode = await runAgentV2CutoverRehearsalCommand({
			env: { PI_CUTOVER_MODEL_ID: secret },
			output: (line) => output.push(line),
		});

		expect(exitCode).toBe(1);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toMatchObject({ ok: false, checks: [{ name: "storage-health", ok: false }] });
		expect(output[0]).not.toContain(secret);
	});
});

type RequestRecord = { url: string; method: string; clientId: string | null; body?: string; signal?: AbortSignal };

function scriptedFetch(
	requests: RequestRecord[],
	responses: Response[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			clientId: new Headers(init?.headers).get("X-PI-Client-ID"),
			body: typeof init?.body === "string" ? init.body : undefined,
			signal: init?.signal ?? undefined,
		});
		const response = responses.shift();
		if (!response) throw new Error("Unexpected cutover rehearsal request");
		return response;
	};
}

function successfulCutoverResponses(): Response[] {
	return [
		json(200, { ok: true }),
		json(200, run("queued")),
		json(200, run("running")),
		json(200, { events: [event(1)] }),
		json(200, run("cancelling")),
		json(200, run("cancelled")),
		json(410, { error: "removed" }),
		json(410, { error: "removed" }),
	];
}

function cutoverEnvironment(): NodeJS.ProcessEnv {
	return {
		PI_CUTOVER_BASE_URL: "http://pi.test",
		PI_CUTOVER_CLIENT_ID: clientId,
		PI_CUTOVER_MODEL_PROVIDER: "test",
		PI_CUTOVER_MODEL_ID: "test-model",
		PI_CUTOVER_TIMEOUT_MS: "1000",
		PI_CUTOVER_POLL_INTERVAL_MS: "1",
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
