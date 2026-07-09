import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeleteSessionResult, RuntimeSessionDetail, RuntimeSessionRecord } from "@mariozechner/pi-web-workspace";
import * as runClient from "../src/runtime/run-client.js";

const { buildRunRequestHeaders, deleteSession, getSession, listSessions, renameSession } = runClient;

describe("run client", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId), location: { origin: "http://localhost:5173" } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends X-PI-Client-ID on session fetches and rename requests", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				if (String(input).endsWith("/api/pi-sessions")) {
					return jsonResponse({ sessions: [createSessionRecord()] });
				}
				if (String(input).includes("/api/pi-sessions/session-1") && init?.method === "GET") {
					return jsonResponse(createSessionDetail());
				}
				if (String(input).includes("/api/pi-sessions/session-1") && init?.method === "PUT") {
					return jsonResponse(createSessionRecord({ title: "Renamed" }));
				}
				throw new Error(`Unexpected URL ${String(input)}`);
			}),
		);

		await listSessions();
		await getSession("session-1");
		await renameSession("session-1", "Renamed");

		expect(requests).toHaveLength(3);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-sessions");
		expect(requests[1]?.url).toBe("http://localhost:5173/api/pi-sessions/session-1");
		expect(requests[2]?.url).toBe("http://localhost:5173/api/pi-sessions/session-1");
		expect(requests[2]?.init?.body).toBe(JSON.stringify({ title: "Renamed" }));
		for (const request of requests) {
			expect(request.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
		}
		expect(requests[0]?.init?.method).toBe("GET");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[2]?.init?.method).toBe("PUT");
	});

	it("deletes runtime sessions with X-PI-Client-ID", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ deleted: true, sessionId: "session-1" } satisfies DeleteSessionResult);
			}),
		);

		await expect(deleteSession("session-1")).resolves.toEqual({ deleted: true, sessionId: "session-1" });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-sessions/session-1");
		expect(requests[0]?.init?.method).toBe("DELETE");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
	});

	it("preserves lowercase content-type and normalizes tuple-array headers", () => {
		const headers = buildRunRequestHeaders(
			[
				["content-type", "application/merge-patch+json"],
				["X-Test", "1"],
			],
			true,
		);

		expect(headers).toEqual({
			"content-type": "application/merge-patch+json",
			"x-test": "1",
			"X-PI-Client-ID": clientId,
		});
	});

	it("no longer exposes legacy generation run helpers", () => {
		expect(runClient).not.toHaveProperty("startRun");
		expect(runClient).not.toHaveProperty("cancelRun");
		expect(runClient).not.toHaveProperty("listRunEvents");
		expect(runClient).not.toHaveProperty("connectRunEvents");
		expect(runClient).not.toHaveProperty("buildAppPreviewGoalStartRequest");
	});

	it("uses v2 getRun rather than legacy session detail for active-run status settling", () => {
		const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");
		const syncStart = bootstrapSource.indexOf("const syncCurrentRunStatusFromServer");
		const syncEnd = bootstrapSource.indexOf("function reportQueuedRunTimeoutIfNeeded");
		const syncSource = bootstrapSource.slice(syncStart, syncEnd);

		expect(bootstrapSource).toContain("getRun: async (runId: string) =>");
		expect(bootstrapSource).toContain("if (isAgentV2LifecycleRunEvent(event)) {");
		expect(syncSource).toContain("const run = await runClient.getRun(runId);");
		expect(syncSource).not.toContain("const detail = await runClient.getSession(currentSessionId);");
		expect(syncSource).not.toContain("const run = detail.runs.find((candidate) => candidate.runId === runId);");
	});
});

function createStorage(clientId: string): Storage {
	const values = new Map<string, string>([["pi.clientId", clientId]]);
	return {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		key(index) {
			return Array.from(values.keys())[index] ?? null;
		},
		removeItem(key) {
			values.delete(key);
		},
		setItem(key, value) {
			values.set(key, value);
		},
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function createSessionRecord(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
	return {
		sessionId: "session-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		title: "Session",
		model: {},
		thinkingLevel: "high",
		createdAt: "2026-06-09T00:00:00.000Z",
		updatedAt: "2026-06-09T00:00:00.000Z",
		...overrides,
	};
}

function createSessionDetail(): RuntimeSessionDetail {
	return {
		session: createSessionRecord(),
		messages: [],
		runs: [],
	};
}
