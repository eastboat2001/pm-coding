import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

interface AnthropicPayload {
	messages: Array<{
		role: string;
		content: string | Array<Record<string, unknown>>;
		reasoning_content?: string;
	}>;
}

const customAnthropicModel: Model<"anthropic-messages"> = {
	id: "mimo-v2.5",
	name: "mimo-v2.5",
	api: "anthropic-messages",
	provider: "Custom Anthropic Compatible",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const officialAnthropicModel: Model<"anthropic-messages"> = {
	...customAnthropicModel,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
};

const mimoDeepSeekReplayModel: Model<"anthropic-messages"> = {
	...customAnthropicModel,
	compat: {
		reasoningReplayFormat: "deepseek-reasoning-content",
	},
};

function replayContext(): Context {
	return {
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "Custom Anthropic Compatible",
				model: "mimo-v2.5",
				content: [
					{ type: "thinking", thinking: "legacy thinking without signature" },
					{ type: "text", text: "visible answer" },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

async function capturePayload(model: Model<"anthropic-messages">): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const s = streamSimple(model, replayContext(), {
		apiKey: "fake-key",
		reasoning: "high",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			return payload;
		},
	});

	await s.result();
	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

describe("Anthropic-compatible thinking replay", () => {
	it("keeps unsigned thinking as text by default for custom Anthropic-compatible providers", async () => {
		const payload = await capturePayload(customAnthropicModel);

		expect(payload.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "legacy thinking without signature" },
				{ type: "text", text: "visible answer" },
			],
		});
	});

	it("replays reasoning_content for MiMo/DeepSeek-style Anthropic-compatible providers", async () => {
		const payload = await capturePayload(mimoDeepSeekReplayModel);

		expect(payload.messages[1]).toEqual({
			role: "assistant",
			reasoning_content: "legacy thinking without signature",
			content: [
				{ type: "thinking", thinking: "legacy thinking without signature", signature: "" },
				{ type: "text", text: "visible answer" },
			],
		});
	});

	it("adds fallback reasoning_content to replayed assistant tool messages for MiMo/DeepSeek-style providers", async () => {
		let capturedPayload: AnthropicPayload | undefined;
		const s = streamSimple(
			mimoDeepSeekReplayModel,
			{
				messages: [
					{ role: "user", content: "first", timestamp: 1 },
					{
						role: "assistant",
						api: "anthropic-messages",
						provider: "Custom Anthropic Compatible",
						model: "mimo-v2.5",
						content: [
							{
								type: "toolCall",
								id: "toolu_test",
								name: "lookup",
								arguments: { query: "x" },
							},
						],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "toolu_test",
						toolName: "lookup",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "continue", timestamp: 4 },
				],
			},
			{
				apiKey: "fake-key",
				reasoning: "high",
				onPayload: (payload) => {
					capturedPayload = payload as AnthropicPayload;
					return payload;
				},
			},
		);

		await s.result();
		if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");

		expect(capturedPayload.messages[1].reasoning_content).toBe(
			"Reasoning content was not stored for this tool call.",
		);
		expect(capturedPayload.messages[1].content[0]).toEqual({
			type: "thinking",
			thinking: "Reasoning content was not stored for this tool call.",
			signature: "",
		});
	});

	it("keeps unsigned thinking as text for official Anthropic", async () => {
		const payload = await capturePayload(officialAnthropicModel);

		expect(payload.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "legacy thinking without signature" },
				{ type: "text", text: "visible answer" },
			],
		});
	});
});
