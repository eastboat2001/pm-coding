import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { loadStorageConfig, type JsonObject, type WorkerAgentInput } from "@mariozechner/pi-web-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { createRunAgent } from "../src/worker/main.js";

describe("worker runtime diagnostics", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = undefined;
	});

	it("wraps worker model streams with provider diagnostics", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-diagnostics-"));
		const diagnostics = new RecordingDiagnostics();
		const input = createWorkerInput();
		const model = input.model as Model<any>;
		const agent = createRunAgent(input, {
			config: loadStorageConfig(dir),
			diagnostics,
			skills: { load: () => ({ name: "unused", content: "unused" }) },
			promptSkills: [],
			defaultSkills: [],
			streamFn: async (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
				await options?.onPayload?.({ messages: [{ role: "user", content: "hello" }] }, model);
				await options?.onResponse?.({ status: 200, headers: { "x-request-id": "worker-upstream" } }, model);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt(input.messages.at(-1)!);

		expect(diagnostics.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.request.start",
					provider: "Test Provider",
					model: "test-model",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.payload",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.response",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "model.stream.summary",
					data: expect.objectContaining({ textChars: 4 }),
				}),
			]),
		);
	});
});

class RecordingDiagnostics {
	events: JsonObject[] = [];

	writeEvents(input: { events: JsonObject[] }): JsonObject {
		this.events.push(...input.events);
		return { accepted: input.events.length, dropped: 0 };
	}
}

function createWorkerInput(): WorkerAgentInput {
	return {
		run: {
			runId: "run-1",
			clientId: "client-a",
			sessionId: "session-1",
			status: "running",
			model: createModel(),
			thinkingLevel: "medium",
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
		},
		session: {
			sessionId: "session-1",
			clientId: "client-a",
			title: "Diagnostics",
			model: createModel(),
			thinkingLevel: "medium",
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
		},
		messages: [
			{
				messageId: 1,
				clientId: "client-a",
				sessionId: "session-1",
				role: "user",
				payload: { content: "hello" },
				createdAt: "2026-06-11T00:00:00.000Z",
			},
		],
		model: createModel(),
		thinkingLevel: "medium",
		signal: new AbortController().signal,
	};
}

function createModel(): Model<"openai-completions"> {
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
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
