import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

interface CapturedParams {
	stream?: boolean;
	tools?: unknown[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const completion = {
						id: "chatcmpl-test",
						choices: [
							{
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									content: "",
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: {
												name: "project_file",
												arguments: '{"command":"list"}',
											},
										},
									],
								},
							},
						],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							prompt_tokens_details: { cached_tokens: 0 },
						},
					};
					const promise = Promise.resolve(completion) as Promise<typeof completion> & {
						withResponse: () => Promise<{
							data: typeof completion;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: completion,
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
		compat: {
			useNonStreamingToolCalls: true,
		},
	};
}

describe("openai-completions non-streaming tool calls", () => {
	it("uses non-streaming requests and parses complete tool calls when compat enables it", async () => {
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

		expect(mockState.lastParams?.stream).toBe(false);
		expect(mockState.lastParams?.tools).toHaveLength(1);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: "call-1",
				name: "project_file",
				arguments: { command: "list" },
			},
		]);
	});
});
