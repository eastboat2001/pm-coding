import type { AssistantMessage } from "../../../packages/ai/src/types.js";
import { describe, expect, it } from "vitest";
import { compactProjectToolHistory } from "../src/project-tools/history.js";

function assistantWithProjectFile(content: string, id = "call-1"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{
				type: "toolCall",
				id,
				name: "project_file",
				arguments: {
					command: "create",
					filename: "src/main.js",
					content,
				},
			},
		],
	};
}

function assistantWithProjectFileGet(id = "call-get"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{
				type: "toolCall",
				id,
				name: "project_file",
				arguments: {
					command: "get",
					filename: "src/main.js",
				},
			},
		],
	};
}

describe("compactProjectToolHistory", () => {
	it("compacts old project_file content while preserving the latest tool call", async () => {
		const oldMessage = assistantWithProjectFile("a".repeat(200), "call-old");
		const latestMessage = assistantWithProjectFile("b".repeat(200), "call-latest");

		const compacted = await compactProjectToolHistory([oldMessage, latestMessage], { maxContentChars: 40 });

		expect(compacted[0]).not.toBe(oldMessage);
		expect(compacted[1]).toBe(latestMessage);
		expect((compacted[0] as AssistantMessage).content[0]).toMatchObject({
			type: "toolCall",
			name: "project_file",
			arguments: {
				command: "create",
				filename: "src/main.js",
				content: expect.stringContaining("[project_file content omitted"),
			},
		});
		expect((compacted[1] as AssistantMessage).content[0]).toMatchObject({
			arguments: { content: "b".repeat(200) },
		});
	});

	it("keeps the latest content-bearing project_file call when a later get call exists", async () => {
		const writeMessage = assistantWithProjectFile("a".repeat(200), "call-write");
		const getMessage = assistantWithProjectFileGet("call-get");

		const compacted = await compactProjectToolHistory([writeMessage, getMessage], { maxContentChars: 40 });

		expect((compacted[0] as AssistantMessage).content[0]).toMatchObject({
			type: "toolCall",
			name: "project_file",
			arguments: {
				command: "create",
				filename: "src/main.js",
				content: "a".repeat(200),
			},
		});
		expect(compacted[1]).toBe(getMessage);
	});

	it("does not mutate the original message objects", async () => {
		const oldMessage = assistantWithProjectFile("a".repeat(200));

		await compactProjectToolHistory([oldMessage], { maxContentChars: 40, keepRecentToolCalls: 0 });

		expect(oldMessage.content[0]).toMatchObject({
			arguments: { content: "a".repeat(200) },
		});
	});
});
