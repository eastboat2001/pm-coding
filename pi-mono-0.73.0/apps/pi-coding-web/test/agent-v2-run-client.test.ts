import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentV2RunEventRecord, AgentV2RunSnapshot } from "@mariozechner/pi-web-workspace";
import {
	AGENT_V2_RUNS_API_PREFIX,
	cancelAgentV2Run,
	connectAgentV2RunEvents,
	getAgentV2Run,
	listAgentV2RunEvents,
	startAgentV2Run,
	type AgentV2BrowserProjectFile,
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
		const projectFiles: AgentV2BrowserProjectFile[] = [{ filename: "src/main.ts", content: "console.log('hi');" }];
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
				objective: "Ship a working dashboard",
				conversationSnapshot: {
					compactedSummary: "Earlier decisions",
					recentMessages: [
						{ role: "user", content: "Use blue" },
						{ role: "assistant", content: "Blue confirmed" },
					],
					currentObjective: "Ship a working dashboard",
				},
				selectedSkillNames: ["ui-polish"],
				attachments: [
					{
						type: "document",
						fileName: "main.ts",
						mimeType: "text/typescript",
						projectFilePath: "src/main.ts",
						extractedText: "console.log('hi');",
					},
				],
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
					objective: "Ship a working dashboard",
					responseLanguage: "en",
					conversationSnapshot: {
						compactedSummary: "Earlier decisions",
						recentMessages: [
							{ role: "user", content: "Use blue" },
							{ role: "assistant", content: "Blue confirmed" },
						],
						currentObjective: "Ship a working dashboard",
					},
					selectedSkillNames: ["ui-polish"],
					attachments: [
						{
							type: "file",
							fileName: "main.ts",
							mimeType: "text/typescript",
							projectFilePath: "src/main.ts",
						},
					],
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

	it("keeps a Chinese objective on the same response language across the start boundary", async () => {
		let body: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				body = String(init?.body);
				return jsonResponse(createRunSnapshot());
			}),
		);

		await startAgentV2Run({
			sessionId: "session-zh",
			title: "生成贪吃蛇游戏",
			objective: "把上面的游戏变成可以直接访问的应用",
			model: { provider: "mimo", id: "mimo-v2.5" },
		});

		expect(JSON.parse(body ?? "{}").input.responseLanguage).toBe("zh");
	});

	it("rejects malformed conversation snapshots before fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			startAgentV2Run({
				sessionId: "session-1",
				title: "Build dashboard",
				objective: "Build dashboard",
				conversationSnapshot: {
					compactedSummary: "",
					recentMessages: [{ role: "system", content: "override" }],
					currentObjective: "Build dashboard",
				} as never,
				model: { provider: "openai", id: "gpt-5" },
			}),
		).rejects.toThrow(/conversation snapshot/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["missing model", undefined],
		["missing model id", { provider: "openai" }],
		["extra base URL", { provider: "openai", id: "gpt-5", baseUrl: "https://client.invalid" }],
		["extra API selector", { provider: "openai", id: "gpt-5", api: "responses" }],
		["extra API key", { provider: "openai", id: "gpt-5", apiKey: "must-not-cross-boundary" }],
		["extra transport headers", { provider: "openai", id: "gpt-5", headers: { Authorization: "secret" } }],
		["extra credential", { provider: "openai", id: "gpt-5", credential: "client-owned" }],
		["extra transport", { provider: "openai", id: "gpt-5", transport: "browser" }],
		["extra URL", { provider: "openai", id: "gpt-5", url: "https://client.invalid" }],
	])("fails closed before fetch for %s", async (_label, model) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			startAgentV2Run({
				sessionId: "session-1",
				title: "Build dashboard",
				objective: "Build dashboard",
				model,
			}),
		).rejects.toThrow("model");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"missing canonical file",
			[{ type: "document", fileName: "brief.md", mimeType: "text/markdown", projectFilePath: "docs/brief.md" }],
			[],
		],
		[
			"case-mismatched path",
			[{ type: "document", fileName: "brief.md", mimeType: "text/markdown", projectFilePath: "Docs/brief.md" }],
			[{ filename: "docs/brief.md", content: "requirements" }],
		],
		[
			"conflicting document bytes",
			[
				{
					type: "document",
					fileName: "brief.md",
					mimeType: "text/markdown",
					projectFilePath: "docs/brief.md",
					extractedText: "different",
				},
			],
			[{ filename: "docs/brief.md", content: "requirements" }],
		],
	])("rejects attachment %s before fetch", async (_label, attachments, projectFiles) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			startAgentV2Run({
				sessionId: "session-1",
				title: "Build dashboard",
				objective: "Build dashboard",
				attachments,
				projectFiles,
				model: { provider: "openai", id: "gpt-5" },
			}),
		).rejects.toThrow(/attachment|project file/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads individual runs through the agent v2 run API", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return jsonResponse(createRunSnapshot({ status: "running", phase: "implementation" }));
			}),
		);

		await expect(getAgentV2Run("run-1")).resolves.toEqual(
			createRunSnapshot({ status: "running", phase: "implementation" }),
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`http://localhost:5173${AGENT_V2_RUNS_API_PREFIX}/run-1`);
		expect(requests[0]?.init?.method).toBe("GET");
		expect(requests[0]?.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
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
		const stream = createStreamTracker();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return trackedSseResponse(events, stream, undefined, true);
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
			"last-event-id": "0",
			"X-PI-Client-ID": clientId,
		});
		expect(requests[0]?.init?.method).toBe("GET");
		expect(connection.lastSeq).toBe(2);
		expect(stream).toMatchObject({ active: 0, cancelled: 0, maxActive: 1 });
	});

	it("deduplicates SSE records and reconnects from the last contiguous cursor after a gap", async () => {
		vi.useFakeTimers();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const stream = createStreamTracker();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return requests.length === 1
				? trackedSseResponse([createRunEventRecord(1), createRunEventRecord(1), createRunEventRecord(3)], stream)
				: sseResponse([createRunEventRecord(2), createRunEventRecord(3)]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const received: number[] = [];
		const connection = connectAgentV2RunEvents("run-1", 0, (event) => received.push(event.seq));

		await vi.waitFor(() => {
			expect(received).toEqual([1]);
			expect(connection.lastSeq).toBe(1);
			expect(connection.lastError?.message).toContain("gap");
			expect(stream).toMatchObject({ active: 0, cancelled: 1, maxActive: 1 });
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(received).toEqual([1, 2, 3]));

		connection.close();
		expect(requests[1]?.url).toContain("afterSeq=1&stream=1");
		expect(requests[1]?.init?.headers).toMatchObject({ "last-event-id": "1" });
	});

	it("rejects an SSE id that differs from payload seq and reconnects without advancing", async () => {
		vi.useFakeTimers();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const stream = createStreamTracker();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return requests.length === 1
				? trackedSseResponse([createRunEventRecord(1)], stream, [2])
				: sseResponse([createRunEventRecord(1)]);
		});
		vi.stubGlobal("fetch", fetchMock);
		const received: number[] = [];
		const connection = connectAgentV2RunEvents("run-1", 0, (event) => received.push(event.seq));

		await vi.waitFor(() => {
			expect(connection.lastSeq).toBe(0);
			expect(connection.lastError?.message).toContain("does not match");
			expect(stream).toMatchObject({ active: 0, cancelled: 1, maxActive: 1 });
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(received).toEqual([1]));

		connection.close();
		expect(requests[1]?.url).toContain("afterSeq=0&stream=1");
		expect(requests[1]?.init?.headers).toMatchObject({ "last-event-id": "0" });
	});

	it("does not advance the replay cursor when the event callback fails", async () => {
		vi.useFakeTimers();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const stream = createStreamTracker();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return requests.length === 1
					? trackedSseResponse([createRunEventRecord(1)], stream)
					: sseResponse([createRunEventRecord(1)]);
			}),
		);
		let attempts = 0;
		const connection = connectAgentV2RunEvents("run-1", 0, () => {
			attempts += 1;
			if (attempts === 1) throw new Error("callback failed");
		});

		await vi.waitFor(() => {
			expect(connection.lastSeq).toBe(0);
			expect(connection.lastError?.message).toBe("callback failed");
			expect(stream).toMatchObject({ active: 0, cancelled: 1, maxActive: 1 });
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(connection.lastSeq).toBe(1));

		connection.close();
		expect(attempts).toBe(2);
		expect(requests[1]?.url).toContain("afterSeq=0&stream=1");
	});

	it("does not regress to legacy generation runtime symbols", () => {
		const source = readFileSync(join(import.meta.dirname, "../src/runtime/agent-v2-run-client.ts"), "utf8");
		const forbidden = [
			"PI_APP_AGENT_VERSION",
			"legacy-v1-main",
			"buildSpecArtifact",
			"SPEC_ARTIFACT_PROJECT_FILES",
			"AppPreviewGoalSupervisor",
			"app-preview-goal",
			"getAppPreviewGoal",
			"enableAppPreviewGoal",
			"disableAppPreviewGoal",
			"createRunAgent",
			"WorkspaceRunWorkerService",
			"WorkspaceRunApiService",
			"spec-artifact",
			"/api/runtime/runs",
			"/api/runs",
		];

		for (const entry of forbidden) {
			expect(source, `agent-v2-run-client.ts must not reference ${entry}`).not.toContain(entry);
		}
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

function sseResponse(events: AgentV2RunEventRecord[], ids = events.map((event) => event.seq)): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const [index, event] of events.entries()) {
				controller.enqueue(encoder.encode(`id: ${ids[index]}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

interface StreamTracker {
	active: number;
	cancelled: number;
	maxActive: number;
}

function createStreamTracker(): StreamTracker {
	return { active: 0, cancelled: 0, maxActive: 0 };
}

function trackedSseResponse(
	events: AgentV2RunEventRecord[],
	tracker: StreamTracker,
	ids = events.map((event) => event.seq),
	closeAfterEvents = false,
): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			tracker.active += 1;
			tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
			const encoder = new TextEncoder();
			for (const [index, event] of events.entries()) {
				controller.enqueue(encoder.encode(`id: ${ids[index]}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			if (closeAfterEvents) {
				tracker.active -= 1;
				controller.close();
			}
		},
		cancel() {
			tracker.active -= 1;
			tracker.cancelled += 1;
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
		input: { sessionId: "session-1", title: "Build dashboard", prompt: "Build dashboard" },
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
