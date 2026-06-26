import {
	type AssistantMessage,
	type Context,
	type Model,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticClient, summarizeProviderPayload } from "../src/diagnostics/diagnostic-client.js";
import { createLoggedStreamFn } from "../src/diagnostics/model-stream-logger.js";

describe("diagnostic client", () => {
	it("posts queued events with configured request headers", async () => {
		let headers: HeadersInit | undefined;
		const client = createDiagnosticClient({
			headers: () => ({ "X-PI-Client-ID": "550e8400-e29b-41d4-a716-446655440000" }),
			fetch: async (_url, init) => {
				headers = init?.headers;
				return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 200 });
			},
		});

		client.write({ level: "info", category: "system", eventType: "system.test" });
		await client.flush();

		expect(headers).toMatchObject({ "X-PI-Client-ID": "550e8400-e29b-41d4-a716-446655440000" });
	});

	it("redacts sensitive payload fields and summarizes message content", () => {
		const summary = summarizeProviderPayload({
			Authorization: "Bearer secret",
			apiKey: "secret-key",
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: [{ type: "text", text: "hello world" }] },
			],
			tools: [{ name: "project_file" }, { name: "project_task" }],
		});

		expect(summary.Authorization).toBe("[redacted]");
		expect(summary.apiKey).toBe("[redacted]");
		expect(summary.messageCount).toBe(2);
		expect(summary.messages).toEqual([
			{ role: "system", contentSummary: "string:13" },
			{ role: "user", contentSummary: "array:1" },
		]);
		expect(summary.toolCount).toBe(2);
		expect(summary.toolNames).toEqual(["project_file", "project_task"]);
	});

	it("posts queued events without blocking callers", async () => {
		const requests: unknown[] = [];
		const client = createDiagnosticClient({
			fetch: async (_url, init) => {
				requests.push(JSON.parse(String(init?.body || "{}")));
				return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 200 });
			},
		});

		client.write({ level: "info", category: "system", eventType: "system.test", data: { ok: true } });
		await client.flush();

		expect(requests).toEqual([{ events: [{ level: "info", category: "system", eventType: "system.test", data: { ok: true } }] }]);
	});
});

describe("model stream logger", () => {
	it("summarizes stream text, thinking, tool calls, and response status", async () => {
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const client = createDiagnosticClient({
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body || "{}")) as { events?: Array<{ eventType: string; data?: Record<string, unknown> }> };
				events.push(...(body.events ?? []));
				return new Response(JSON.stringify({ accepted: body.events?.length ?? 0, dropped: 0 }), { status: 200 });
			},
		});
		const baseStream = createAssistantMessageEventStream();
		const model = createModel();
		const streamFn = createLoggedStreamFn(
			async (_model, _context, options) => {
				await options?.onPayload?.({ apiKey: "secret", messages: [{ role: "user", content: "hi" }] }, model);
				await options?.onResponse?.({ status: 200, headers: { "x-request-id": "upstream" } }, model);
				queueMicrotask(() => {
					const partial = createAssistantMessage();
					baseStream.push({ type: "start", partial });
					baseStream.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial });
					baseStream.push({ type: "text_delta", contentIndex: 1, delta: "answer", partial });
					baseStream.push({
						type: "toolcall_end",
						contentIndex: 2,
						toolCall: { type: "toolCall", id: "tool-1", name: "project_file", arguments: {} },
						partial,
					});
					baseStream.push({ type: "done", reason: "stop", message: partial });
				});
				return baseStream;
			},
			client,
			() => ({ sessionId: "session-1", traceId: "trace-1" }),
		);

		const result = await (await streamFn(model, createContext())).result();
		await client.flush();

		expect(result.stopReason).toBe("stop");
		expect(events.map((event) => event.eventType)).toContain("provider.payload");
		expect(events.map((event) => event.eventType)).toContain("provider.response");
		const summary = events.find((event) => event.eventType === "model.stream.summary");
		expect(summary?.data?.textChars).toBe(6);
		expect(summary?.data?.thinkingChars).toBe(5);
		expect(summary?.data?.toolCallCount).toBe(1);
	});

	it("records readable input and output snapshots when model IO snapshots are enabled", async () => {
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const client = createDiagnosticClient({
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body || "{}")) as {
					events?: Array<{ eventType: string; data?: Record<string, unknown> }>;
				};
				events.push(...(body.events ?? []));
				return new Response(JSON.stringify({ accepted: body.events?.length ?? 0, dropped: 0 }), { status: 200 });
			},
		});
		const baseStream = createAssistantMessageEventStream();
		const model = createModel();
		const streamFn = createLoggedStreamFn(
			async (_model, _context, options) => {
				await options?.onPayload?.({ messages: [{ role: "user", content: "payload prompt text" }] }, model);
				queueMicrotask(() => {
					const partial = createAssistantMessage();
					baseStream.push({ type: "start", partial });
					baseStream.push({ type: "thinking_delta", contentIndex: 0, delta: "thinking details", partial });
					baseStream.push({ type: "text_delta", contentIndex: 1, delta: "final answer", partial });
					baseStream.push({
						type: "toolcall_end",
						contentIndex: 2,
						toolCall: { type: "toolCall", id: "tool-1", name: "project_file", arguments: { filename: "index.html" } },
						partial,
					});
					baseStream.push({ type: "done", reason: "stop", message: partial });
				});
				return baseStream;
			},
			client,
			() => ({ sessionId: "session-io", traceId: "trace-io" }),
			() => ({
				promptSnapshotLoggingEnabled: true,
				promptSnapshotMaxChars: 2000,
				modelOutputSnapshotLoggingEnabled: true,
				modelOutputSnapshotMaxChars: 2000,
			}),
		);

		await (await streamFn(model, createContext())).result();
		await client.flush();

		const summary = events.find((event) => event.eventType === "model.stream.summary");
		expect(JSON.stringify(summary?.data?.inputSnapshot)).toContain("payload prompt text");
		expect(JSON.stringify(summary?.data?.outputSnapshot)).toContain("final answer");
		expect(JSON.stringify(summary?.data?.outputSnapshot)).toContain("thinking details");
		expect(JSON.stringify(summary?.data?.outputSnapshot)).toContain("project_file");
	});

	it("records prompt snapshots, provider payload snapshots, and raw stream events when enabled", async () => {
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const client = createDiagnosticClient({
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body || "{}")) as { events?: Array<{ eventType: string; data?: Record<string, unknown> }> };
				events.push(...(body.events ?? []));
				return new Response(JSON.stringify({ accepted: body.events?.length ?? 0, dropped: 0 }), { status: 200 });
			},
		});
		const baseStream = createAssistantMessageEventStream();
		const model = createModel();
		const streamFn = createLoggedStreamFn(
			async (_model, _context, options) => {
				await options?.onPayload?.(
					{
						messages: [{ role: "user", content: "payload prompt text" }],
						tools: [{ name: "project_file" }],
						apiKey: "secret",
					},
					model,
				);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				await options?.onChunk?.({ id: "chunk-1", choices: [{ delta: { reasoning_content: "provider chunk" } }], apiKey: "secret" }, model);
				queueMicrotask(() => {
					const partial = createAssistantMessage();
					baseStream.push({ type: "start", partial });
					baseStream.push({ type: "thinking_delta", contentIndex: 0, delta: "raw thinking chunk", partial });
					baseStream.push({ type: "text_delta", contentIndex: 1, delta: "raw answer chunk", partial });
					baseStream.push({ type: "done", reason: "stop", message: partial });
				});
				return baseStream;
			},
			client,
			() => ({ sessionId: "session-raw", traceId: "trace-raw" }),
			() => ({
				promptSnapshotLoggingEnabled: true,
				promptSnapshotMaxChars: 120,
				rawProviderLoggingEnabled: true,
				rawProviderLogMaxChars: 80,
			}),
		);

		await (await streamFn(model, { systemPrompt: "system prompt text", ...createContext() })).result();
		await client.flush();

		const eventTypes = events.map((event) => event.eventType);
		expect(eventTypes).toContain("model.prompt.snapshot");
		expect(eventTypes).toContain("provider.payload.snapshot");
		expect(eventTypes).toContain("provider.raw_chunk");
		expect(eventTypes).toContain("model.stream.raw_event");
		const payloadSnapshot = events.find((event) => event.eventType === "provider.payload.snapshot");
		expect(payloadSnapshot?.data?.payloadChars).toBeGreaterThan(0);
		expect(JSON.stringify(payloadSnapshot?.data)).toContain("[redacted]");
		const rawChunk = events.find((event) => event.eventType === "provider.raw_chunk");
		expect(JSON.stringify(rawChunk?.data)).toContain("provider chunk");
		expect(JSON.stringify(rawChunk?.data)).toContain("[redacted]");
		const rawEvents = events.filter((event) => event.eventType === "model.stream.raw_event");
		expect(rawEvents.some((event) => event.data?.type === "thinking_delta")).toBe(true);
		expect(rawEvents.some((event) => event.data?.type === "text_delta")).toBe(true);
	});

	it("ends a stalled model stream after the configured idle timeout", async () => {
		vi.useFakeTimers();
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const client = createDiagnosticClient({
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body || "{}")) as {
					events?: Array<{ eventType: string; data?: Record<string, unknown> }>;
				};
				events.push(...(body.events ?? []));
				return new Response(JSON.stringify({ accepted: body.events?.length ?? 0, dropped: 0 }), { status: 200 });
			},
		});
		const baseStream = createAssistantMessageEventStream();
		const model = createModel();
		const streamFn = createLoggedStreamFn(
			async () => baseStream,
			client,
			() => ({ sessionId: "session-stalled", traceId: "trace-stalled" }),
			() => ({ streamIdleTimeoutMs: 25 }),
		);

		const resultPromise = (await streamFn(model, createContext())).result();
		await vi.advanceTimersByTimeAsync(25);
		const result = await resultPromise;
		await client.flush();
		vi.useRealTimers();

		expect(result.errorMessage).toContain("Model stream stalled for 25ms without events");
		const summary = events.find((event) => event.eventType === "model.stream.summary");
		expect(summary?.data?.stopReason).toBe("error");
		expect(summary?.data?.errorMessage).toContain("Model stream stalled");
	});
});

function createContext(): Context {
	return { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
}

function createModel(): Model<"openai-completions"> {
	return {
		id: "local-model",
		name: "Local Model",
		api: "openai-completions",
		provider: "Local vLLM",
		baseUrl: "http://localhost:8000/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "Local vLLM",
		model: "local-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
