import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticClient, DiagnosticData, DiagnosticEvent } from "../src/diagnostics/diagnostic-client.js";
import { createLoggedStreamFn } from "../src/diagnostics/model-stream-logger.js";

describe("model stream logger", () => {
	it("records a context budget diagnostic before provider streaming starts", async () => {
		const diagnostics = new RecordingDiagnosticClient();
		const model = createModel();
		const taskArguments = {
			task: "preview",
			notes: "inspect generated app output",
		};
		const context: Context = {
			systemPrompt: "System instructions for PI.",
			tools: [
				{
					name: "project_task",
					description: "Run a project task",
					parameters: Type.Object({ task: Type.String() }),
				},
			],
			messages: [
				{
					role: "user",
					content: "Build a dashboard.",
					timestamp: 1,
				},
				{
					...createAssistantMessage(),
					timestamp: 2,
					content: [
						{
							type: "toolCall",
							id: "task-call",
							name: "project_task",
							arguments: taskArguments,
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "task-call",
					toolName: "project_task",
					content: [{ type: "text", text: `Task: preview\nStatus: completed\nLogs:\n${"log ".repeat(40)}` }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const loggedStreamFn = createLoggedStreamFn(
			async (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			diagnostics,
			() => ({ sessionId: "session-1", traceId: "session-1" }),
			() => ({ streamIdleTimeoutMs: 120_000 }),
		);

		const output = await loggedStreamFn(model, context);
		for await (const event of output) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(diagnostics.events.map((event) => event.eventType)).toEqual([
			"provider.request.start",
			"model.context_budget",
			"model.stream.summary",
		]);
		expect(diagnostics.events).toContainEqual(
			expect.objectContaining({
				eventType: "model.context_budget",
				provider: model.provider,
				model: model.id,
				data: expect.objectContaining({
					messageCount: 3,
					toolCount: 1,
					systemPromptChars: context.systemPrompt?.length,
					assistantToolCalls: expect.objectContaining({
						count: 1,
						argumentChars: JSON.stringify(taskArguments).length,
					}),
					toolResults: expect.objectContaining({
						count: 1,
						chars: expect.any(Number),
						byToolName: expect.arrayContaining([
							expect.objectContaining({ toolName: "project_task", count: 1 }),
						]),
					}),
					largeItems: expect.arrayContaining([
						expect.objectContaining({ kind: "toolResult", label: "project_task" }),
					]),
				}) satisfies DiagnosticData,
			}),
		);
	});

	it("records model stream event gaps and streamed tool call argument volume", async () => {
		vi.useFakeTimers();
		const diagnostics = new RecordingDiagnosticClient();
		const model = createModel();
		const toolCallDelta = "{\"content\":\"large\"}";
		try {
			const loggedStreamFn = createLoggedStreamFn(
				async (_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
					const stream = createAssistantMessageEventStream();
					const message = createAssistantMessage();
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "call-1",
						name: "project_file",
						arguments: { filename: "src/main.js" },
					};
					message.content = [toolCall];
					setTimeout(() => {
						stream.push({ type: "start", partial: message });
					}, 100);
					setTimeout(() => {
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					}, 200);
					setTimeout(() => {
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: toolCallDelta,
							partial: message,
						});
					}, 10_200);
					setTimeout(() => {
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
						stream.push({ type: "done", reason: "toolUse", message });
					}, 10_300);
					return stream;
				},
				diagnostics,
				() => ({ sessionId: "session-1", traceId: "session-1" }),
				() => ({ streamIdleTimeoutMs: 120_000 }),
			);

			const output = await loggedStreamFn(model, { messages: [] });
			const consumeStream = (async () => {
				for await (const event of output) {
					if (event.type === "done" || event.type === "error") return;
				}
			})();

			await vi.advanceTimersByTimeAsync(10_500);
			await consumeStream;

			expect(diagnostics.events).toContainEqual(
				expect.objectContaining({
					eventType: "model.stream.summary",
					provider: model.provider,
					model: model.id,
					data: expect.objectContaining({
						firstEventLatencyMs: 100,
						maxEventGapMs: 10_000,
						maxEventGapAfterEventType: "toolcall_start",
						maxEventGapBeforeEventType: "toolcall_delta",
						toolCallDeltaCount: 1,
						toolCallArgumentChars: toolCallDelta.length,
					}) satisfies DiagnosticData,
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps provider maxTokens without exceeding explicit or model limits", async () => {
		const diagnostics = new RecordingDiagnosticClient();
		const observedMaxTokens: Array<number | undefined> = [];
		const loggedStreamFn = createLoggedStreamFn(
			async (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				observedMaxTokens.push(options?.maxTokens);
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			diagnostics,
			() => ({ sessionId: "session-1", traceId: "session-1" }),
			() => ({ maxOutputTokens: 12_000, streamIdleTimeoutMs: 120_000 }),
		);

		await consume(loggedStreamFn(createModel({ maxTokens: 32_768 }), { messages: [] }, { maxTokens: 20_000 }));
		await consume(loggedStreamFn(createModel({ maxTokens: 4_096 }), { messages: [] }));

		expect(observedMaxTokens).toEqual([12_000, 4_096]);
	});

	it("keeps enough maxTokens headroom for high reasoning requests", async () => {
		const diagnostics = new RecordingDiagnosticClient();
		const observedMaxTokens: Array<number | undefined> = [];
		const loggedStreamFn = createLoggedStreamFn(
			async (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				observedMaxTokens.push(options?.maxTokens);
				const stream = createAssistantMessageEventStream();
				const message = createAssistantMessage();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			diagnostics,
			() => ({ sessionId: "session-1", traceId: "session-1" }),
			() => ({ maxOutputTokens: 12_000, streamIdleTimeoutMs: 120_000 }),
		);

		await consume(loggedStreamFn(createModel({ maxTokens: 32_768, reasoning: true }), { messages: [] }, { reasoning: "high" }));
		await consume(loggedStreamFn(createModel({ maxTokens: 32_768, reasoning: true }), { messages: [] }, { reasoning: "medium" }));

		expect(observedMaxTokens).toEqual([20_480, 12_288]);
	});
});

class RecordingDiagnosticClient implements DiagnosticClient {
	readonly events: DiagnosticEvent[] = [];

	write(event: DiagnosticEvent): void {
		this.events.push(event);
	}

	writeMany(events: DiagnosticEvent[]): void {
		this.events.push(...events);
	}

	async flush(): Promise<void> {}
}

async function consume(
	streamOrPromise: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<void> {
	const stream = await streamOrPromise;
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") return;
	}
}

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "Test Provider",
		baseUrl: "http://127.0.0.1:8000/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
		...overrides,
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "Test Provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}
