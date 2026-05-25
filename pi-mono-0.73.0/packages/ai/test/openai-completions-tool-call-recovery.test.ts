import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	text: '<tool_call>{"name":"project_file","arguments":{"command":"list"}}</tool_call>',
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: { content: mockState.text } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-completions"> {
	return {
		id: "custom-qwen",
		name: "Custom Qwen",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

describe("openai-completions text tool-call recovery", () => {
	it("turns tagged text tool calls into toolCall blocks", async () => {
		const message = await streamOpenAICompletions(
			createModel(),
			{
				messages: [{ role: "user", content: "list files", timestamp: Date.now() }],
				tools: [
					{
						name: "project_file",
						description: "Project file",
						parameters: Type.Object({ command: Type.Literal("list") }),
					},
				],
			},
			{ apiKey: "test-key" },
		).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: expect.stringMatching(/^call_extracted_/),
				name: "project_file",
				arguments: { command: "list" },
			},
		]);
	});
});
