import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
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
		id: "mimo-v2.5",
		name: "MiMo V2.5",
		api: "openai-completions",
		provider: "custom-provider:test",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 20000,
	};
}

async function collectEvents(): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const stream = streamOpenAICompletions(
		createModel(),
		{ messages: [{ role: "user", content: "count", timestamp: Date.now() }] },
		{ apiKey: "test-key" },
	);
	for await (const event of stream) events.push(event);
	await stream.result();
	return events;
}

describe("openai-completions unexpected reasoning fields", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("does not emit thinking UI events when reasoning_content arrives without requested reasoning", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-1", choices: [{ index: 0, delta: { reasoning_content: "internal note" } }] },
			{ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "1\n2\n" } }] },
			{
				id: "chatcmpl-1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const events = await collectEvents();
		const terminal = events.at(-1);

		expect(events.some((event) => event.type.startsWith("thinking_"))).toBe(false);
		expect(terminal?.type).toBe("done");
		if (terminal?.type === "done") {
			expect(terminal.message.content).toEqual([{ type: "text", text: "1\n2\n" }]);
		}
	});

	it("demotes reasoning_content to text when it is the only streamed output and reasoning was not requested", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-2", choices: [{ index: 0, delta: { reasoning_content: "final answer in reasoning" } }] },
			{
				id: "chatcmpl-2",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 4,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const events = await collectEvents();
		const terminal = events.at(-1);

		expect(events.some((event) => event.type.startsWith("thinking_"))).toBe(false);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		expect(terminal?.type).toBe("done");
		if (terminal?.type === "done") {
			expect(terminal.message.content).toEqual([{ type: "text", text: "final answer in reasoning" }]);
		}
	});
});
