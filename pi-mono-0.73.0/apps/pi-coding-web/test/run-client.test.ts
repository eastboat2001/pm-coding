import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AppPreviewGoalEventRecord,
	AppPreviewGoalRecord,
	DeleteSessionResult,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
	RuntimeSessionRecord,
	type StartRunRequest,
	StartRunResult,
} from "@mariozechner/pi-web-workspace";
import {
	buildAppPreviewGoalStartRequest,
	buildRunRequestHeaders,
	cancelRun,
	connectRunEvents,
	deleteSession,
	disableAppPreviewGoal,
	enableAppPreviewGoal,
	getAppPreviewGoal,
	getSession,
	listRunEvents,
	listSessions,
	startRun,
	type RunEventConnection,
} from "../src/runtime/run-client.js";

describe("run client", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId), location: { origin: "http://localhost:5173" } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("sends X-PI-Client-ID on run and session fetches", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				if (String(input).endsWith("/api/pi-runs")) {
					return jsonResponse(createStartRunResult());
				}
				if (String(input).endsWith("/api/pi-sessions")) {
					return jsonResponse({ sessions: [createSessionRecord()] });
				}
				if (String(input).includes("/api/pi-sessions/session-1")) {
					return jsonResponse(createSessionDetail());
				}
				if (String(input).endsWith("/cancel")) {
					return jsonResponse(createRunRecord());
				}
				throw new Error(`Unexpected URL ${String(input)}`);
			}),
		);

		await startRun({ message: { text: "hello" } });
		await listSessions();
		await getSession("session-1");
		await cancelRun("run-1");

		expect(requests).toHaveLength(4);
		for (const request of requests) {
			expect(request.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
		}
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[2]?.init?.method).toBe("GET");
		expect(requests[3]?.init?.method).toBe("POST");
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

	it("lists runtime run events with X-PI-Client-ID", async () => {
		const event = createRunEventRecord(7);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ events: [event] });
			}),
		);

		await expect(listRunEvents("run-1", 3)).resolves.toEqual([event]);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs/run-1/events?afterSeq=3");
		expect(requests[0]?.init?.method).toBe("GET");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
	});

	it("enables app preview goals through the run API", async () => {
		const goal = createAppPreviewGoalRecord();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ goal });
			}),
		);

		await expect(enableAppPreviewGoal("session-1", "manual")).resolves.toEqual({ goal });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs/goals/app-preview");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.body).toBe(
			JSON.stringify({ sessionId: "session-1", source: "manual", enabled: true }),
		);
		expect(requests[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/json",
			"X-PI-Client-ID": clientId,
		});
	});

	it("disables app preview goals through the run API", async () => {
		const goal = createAppPreviewGoalRecord({ status: "disabled" });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ goal });
			}),
		);

		await expect(disableAppPreviewGoal("session-1")).resolves.toEqual({ goal });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs/goals/app-preview/disable");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.body).toBe(JSON.stringify({ sessionId: "session-1" }));
		expect(requests[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/json",
			"X-PI-Client-ID": clientId,
		});
	});

	it("gets encoded app preview goal state through the run API", async () => {
		const goal = createAppPreviewGoalRecord({ sessionId: "session with/slash" });
		const event = createAppPreviewGoalEventRecord({ sessionId: goal.sessionId });
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse({ goal, events: [event] });
			}),
		);

		await expect(getAppPreviewGoal("session with/slash")).resolves.toEqual({ goal, events: [event] });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"http://localhost:5173/api/pi-runs/goals/app-preview?sessionId=session%20with%2Fslash",
		);
		expect(requests[0]?.init?.method).toBe("GET");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
	});

	it("builds start-run app preview goal requests only when a source is selected", () => {
		const manualRequest: StartRunRequest = {
			message: { text: "build" },
			appPreviewGoal: buildAppPreviewGoalStartRequest("manual"),
		};

		expect(manualRequest.appPreviewGoal).toEqual({ enabled: true, source: "manual" });
		expect(buildAppPreviewGoalStartRequest(undefined)).toBeUndefined();
	});

	it("passes app preview goal start requests through the start run body", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse(createStartRunResult());
			}),
		);

		await startRun({
			sessionId: "session-1",
			message: { text: "build" },
			appPreviewGoal: buildAppPreviewGoalStartRequest("pm_handoff"),
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.body).toBe(
			JSON.stringify({
				sessionId: "session-1",
				message: { text: "build" },
				appPreviewGoal: { enabled: true, source: "pm_handoff" },
			}),
		);
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

	it("falls back to polling when the run event stream returns JSON", async () => {
		vi.useFakeTimers();
		const events: RuntimeRunEventRecord[] = [createRunEventRecord(1), createRunEventRecord(2)];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return jsonResponse({
				events: requests.length === 1 ? [events[0]] : requests.length === 2 ? [events[1]] : [],
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const received: RuntimeRunEventRecord[] = [];
		const connection: RunEventConnection = connectRunEvents("run-1", 0, (event) => {
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
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs/run-1/events?afterSeq=0&stream=1");
		expect(requests[1]?.url).toBe("http://localhost:5173/api/pi-runs/run-1/events?afterSeq=1");
		for (const request of requests) {
			expect(request.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
			expect(request.init?.method).toBe("GET");
		}
	});

	it("streams run events with X-PI-Client-ID over fetch SSE", async () => {
		vi.useFakeTimers();
		const events = [createRunEventRecord(1), createRunEventRecord(2)];
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return sseResponse(events);
		});
		vi.stubGlobal("fetch", fetchMock);

		const received: RuntimeRunEventRecord[] = [];
		const connection = connectRunEvents("run-1", 0, (event) => {
			received.push(event);
		});

		await vi.waitFor(() => {
			expect(received).toEqual(events);
		});

		connection.close();
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-runs/run-1/events?afterSeq=0&stream=1");
		expect(requests[0]?.init?.headers).toMatchObject({
			accept: "text/event-stream",
			"X-PI-Client-ID": clientId,
		});
		expect(requests[0]?.init?.method).toBe("GET");
		expect(connection.lastSeq).toBe(2);
	});

	it("reports run event connection loss and recovery", async () => {
		vi.useFakeTimers();
		const events = [createRunEventRecord(1)];
		const statusChanges: Array<RunEventConnection["readyState"]> = [];
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(sseResponse(events));
		vi.stubGlobal("fetch", fetchMock);

		const received: RuntimeRunEventRecord[] = [];
		const connection = connectRunEvents(
			"run-1",
			0,
			(event) => {
				received.push(event);
			},
			{
				onStatusChange: (nextConnection) => {
					statusChanges.push(nextConnection.readyState);
				},
			},
		);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		expect(connection.lastError?.message).toBe("Failed to fetch");
		expect(statusChanges).toContain(connection.CONNECTING);

		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => {
			expect(received).toEqual(events);
		});
		expect(statusChanges).toContain(connection.OPEN);

		connection.close();
	});

	it("does not advance the event checkpoint until an async handler resolves", async () => {
		const event = createRunEventRecord(1);
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ events: [event] })));
		let releaseHandler: () => void = () => {};
		const handlerStarted = vi.fn();
		const handlerGate = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});

		const connection = connectRunEvents("run-1", 0, async (_event) => {
			handlerStarted();
			await handlerGate;
		});

		await vi.waitFor(() => {
			expect(handlerStarted).toHaveBeenCalledTimes(1);
		});
		expect(connection.lastSeq).toBe(0);

		releaseHandler();
		await vi.waitFor(() => {
			expect(connection.lastSeq).toBe(1);
		});
		connection.close();
	});

	it("uses low-latency polling while events are flowing and backs off when idle", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				events: fetchMock.mock.calls.length === 1 ? [createRunEventRecord(1)] : [],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const connection = connectRunEvents("run-1", 0, () => {});

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		expect(connection.pollIntervalMs).toBe(150);

		await vi.advanceTimersByTimeAsync(connection.pollIntervalMs);
		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		expect(connection.pollIntervalMs).toBeGreaterThan(150);

		connection.close();
	});

	it("keeps readyState closed and stops delivering events when closed during delivery", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				events: [createRunEventRecord(1), createRunEventRecord(2)],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const received: RuntimeRunEventRecord[] = [];
		let connection: RunEventConnection;
		connection = connectRunEvents("run-1", 0, (event) => {
			received.push(event);
			connection.close();
		});

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
		await vi.advanceTimersByTimeAsync(connection.pollIntervalMs * 2);

		expect(received).toEqual([createRunEventRecord(1)]);
		expect(connection.closed).toBe(true);
		expect(connection.lastSeq).toBe(1);
		expect(connection.readyState).toBe(connection.CLOSED);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

function sseResponse(events: RuntimeRunEventRecord[]): Response {
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

function createSessionRecord(): RuntimeSessionRecord {
	return {
		sessionId: "session-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		title: "Session",
		model: {},
		thinkingLevel: "high",
		createdAt: "2026-06-09T00:00:00.000Z",
		updatedAt: "2026-06-09T00:00:00.000Z",
	};
}

function createRunRecord(): RuntimeRunRecord {
	return {
		runId: "run-1",
		sessionId: "session-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		status: "queued",
		model: {},
		thinkingLevel: "high",
		updatedAt: "2026-06-09T00:00:00.000Z",
	};
}

function createSessionDetail(): RuntimeSessionDetail {
	return {
		session: createSessionRecord(),
		messages: [],
		runs: [createRunRecord()],
	};
}

function createStartRunResult(): StartRunResult {
	return {
		session: createSessionRecord(),
		message: {
			messageId: 1,
			sessionId: "session-1",
			clientId: "550e8400-e29b-41d4-a716-446655440000",
			role: "user",
			payload: { text: "hello" },
			createdAt: "2026-06-09T00:00:00.000Z",
		},
		run: createRunRecord(),
	};
}

function createRunEventRecord(seq: number): RuntimeRunEventRecord {
	return {
		eventId: seq,
		runId: "run-1",
		sessionId: "session-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		seq,
		type: "message",
		payload: { text: `event-${seq}` },
		createdAt: "2026-06-09T00:00:00.000Z",
	};
}

function createAppPreviewGoalRecord(overrides: Partial<AppPreviewGoalRecord> = {}): AppPreviewGoalRecord {
	return {
		goalId: "goal-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		sessionId: "session-1",
		source: "manual",
		status: "active",
		maxContinuationRuns: 3,
		continuationRunsUsed: 1,
		retryAttemptsUsed: 0,
		createdAt: "2026-06-09T00:00:00.000Z",
		updatedAt: "2026-06-09T00:00:00.000Z",
		...overrides,
	};
}

function createAppPreviewGoalEventRecord(
	overrides: Partial<AppPreviewGoalEventRecord> = {},
): AppPreviewGoalEventRecord {
	return {
		eventId: 1,
		goalId: "goal-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		sessionId: "session-1",
		eventType: "goal_started",
		payload: {},
		createdAt: "2026-06-09T00:00:00.000Z",
		...overrides,
	};
}
