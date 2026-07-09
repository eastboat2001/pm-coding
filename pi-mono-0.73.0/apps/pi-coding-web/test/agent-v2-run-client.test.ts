import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentV2RunEventRecord, AgentV2RunSnapshot, StartRunProjectFile } from "@mariozechner/pi-web-workspace";
import {
	AGENT_V2_RUNS_API_PREFIX,
	cancelAgentV2Run,
	connectAgentV2RunEvents,
	listAgentV2RunEvents,
	startAgentV2Run,
	type AgentV2RunEventConnection,
} from "../src/runtime/agent-v2-run-client.js";

describe("agent v2 run client", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId), location: { origin: "http://localhost:5173" } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("posts generation starts to the agent v2 run API", async () => {
		const projectFiles: StartRunProjectFile[] = [{ filename: "src/main.ts", content: "console.log('hi');" }];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse(createRunSnapshot());
			}),
		);

		await expect(
			startAgentV2Run({
				sessionId: "session-1",
				title: "Build dashboard",
				message: { role: "user", content: "build it" },
				attachments: [{ id: "attachment-1" }],
				projectFiles,
				model: { provider: "openai", id: "gpt-5" },
			}),
		).resolves.toEqual(createRunSnapshot());

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/start`);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.body).toBe(
			JSON.stringify({
				input: {
					sessionId: "session-1",
					title: "Build dashboard",
					message: { role: "user", content: "build it" },
					attachments: [{ id: "attachment-1" }],
					projectFiles,
				},
				model: { provider: "openai", id: "gpt-5" },
			}),
		);
		expect(requests[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/json",
			"X-PI-Client-ID": clientId,
		});
	});

	it("cancels runs through the agent v2 run API", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse(createRunSnapshot({ status: "cancelling" }));
			}),
		);

		await expect(cancelAgentV2Run("run-1")).resolves.toEqual(createRunSnapshot({ status: "cancelling" }));

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1/cancel`);
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
	});

	it("lists agent v2 run events with X-PI-Client-ID", async () => {
		const event = createRunEventRecord(7);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ events: [event] });
			}),
		);

		await expect(listAgentV2RunEvents("run-1", 3)).resolves.toEqual([event]);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1/events?afterSeq=3`);
		expect(requests[0]?.init?.method).toBe("GET");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
	});

	it("falls back to polling when the agent v2 event stream returns JSON", async () => {
		vi.useFakeTimers();
		const events: AgentV2RunEventRecord[] = [createRunEventRecord(1), createRunEventRecord(2)];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return jsonResponse({
				events: requests.length === 1 ? [events[0]] : requests.length === 2 ? [events[1]] : [],
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const received: AgentV2RunEventRecord[] = [];
		const connection: AgentV2RunEventConnection = connectAgentV2RunEvents("run-1", 0, (event) => {
			received.push(event);
		});

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await vi.advanceTimersByTimeAsync(connection.pollIntervalMs);
		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		connection.close();
		await vi.advanceTimersByTimeAsync(connection.pollIntervalMs * 2);

		expect(received).toEqual(events);
		expect(connection.closed).toBe(true);
		expect(connection.lastSeq).toBe(2);
		expect(connection.readyState).toBe(2);
		expect(requests[0]?.url).toBe(
			`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1/events?afterSeq=0&stream=1`,
		);
		expect(requests[1]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1/events?afterSeq=1`);
	});

	it("streams agent v2 run events with X-PI-Client-ID over fetch SSE", async () => {
		vi.useFakeTimers();
		const events = [createRunEventRecord(1), createRunEventRecord(2)];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return sseResponse(events);
		});
		vi.stubGlobal("fetch", fetchMock);

		const received: AgentV2RunEventRecord[] = [];
		const connection = connectAgentV2RunEvents("run-1", 0, (event) => {
			received.push(event);
		});

		await vi.waitFor(() => {
			expect(received).toEqual(events);
		});

		connection.close();
		expect(requests[0]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1/events?afterSeq=0&stream=1`);
		expect(requests[0]?.init?.headers).toMatchObject({
			accept: "text/event-stream",
			"X-PI-Client-ID": clientId,
		});
		expect(requests[0]?.init?.method).toBe("GET");
		expect(connection.lastSeq).toBe(2);
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

function sseResponse(events: AgentV2RunEventRecord[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function createRunSnapshot(overrides: Partial<AgentV2RunSnapshot> = {}): AgentV2RunSnapshot {
	return {
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		runId: "run-1",
		status: "queued",
		phase: "intake",
		attempt: 1,
		input: { sessionId: "session-1", title: "Build dashboard" },
		model: {},
		createdAt: "2026-06-09T00:00:00.000Z",
		updatedAt: "2026-06-09T00:00:00.000Z",
		...overrides,
	};
}

function createRunEventRecord(seq: number): AgentV2RunEventRecord {
	return {
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		runId: "run-1",
		seq,
		type: "agent_v2.phase_changed",
		payload: { type: "agent_v2.phase_changed", phase: "implementation", at: `2026-06-09T00:00:0${seq}.000Z` },
		createdAt: `2026-06-09T00:00:0${seq}.000Z`,
	};
}
