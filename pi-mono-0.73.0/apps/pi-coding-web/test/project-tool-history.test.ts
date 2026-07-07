import type { AssistantMessage, ToolResultMessage } from "../../../packages/ai/src/types.js";
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

function assistantWithProjectFileGetNamed(filename: string, id = "call-get"): AssistantMessage {
	const message = assistantWithProjectFileGet(id);
	(message.content[0] as { arguments: Record<string, unknown> }).arguments.filename = filename;
	return message;
}

function assistantWithProjectTask(task: string, id = "call-task"): AssistantMessage {
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
				name: "project_task",
				arguments: { task },
			},
		],
	};
}

function assistantWithSkillLoad(name = "frontend-design", id = "call-skill-load"): AssistantMessage {
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
				name: "skill_load",
				arguments: { name },
			},
		],
	};
}

function assistantWithSkillResource(name = "frontend-design", path = "references/design.md", id = "call-skill-resource"): AssistantMessage {
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
				name: "skill_resource",
				arguments: { name, path },
			},
		],
	};
}

function projectFileGetResult(content: string, toolCallId = "call-get"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_file",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
	};
}

function projectTaskResult(content: string, toolCallId = "call-task"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_task",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
	};
}

function skillResult(content: string, toolCallId: string, toolName = "skill_load"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
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
				contentOmitted: true,
				omittedChars: 200,
			},
		});
		expect(((compacted[0] as AssistantMessage).content[0] as { arguments: Record<string, unknown> }).arguments).not.toHaveProperty(
			"content",
		);
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

	it("compacts extremely large latest project_file content so one rewrite does not dominate the next request", async () => {
		const latestMessage = assistantWithProjectFile("x".repeat(15_000), "call-latest");

		const compacted = await compactProjectToolHistory([latestMessage]);

		expect(compacted[0]).not.toBe(latestMessage);
		expect((compacted[0] as AssistantMessage).content[0]).toMatchObject({
			type: "toolCall",
			name: "project_file",
			arguments: {
				command: "create",
				filename: "src/main.js",
				contentOmitted: true,
				omittedChars: 15_000,
			},
		});
		expect(JSON.stringify(compacted[0])).not.toContain("[project_file content omitted");
	});

	it("does not mutate the original message objects", async () => {
		const oldMessage = assistantWithProjectFile("a".repeat(200));

		await compactProjectToolHistory([oldMessage], { maxContentChars: 40, keepRecentToolCalls: 0 });

		expect(oldMessage.content[0]).toMatchObject({
			arguments: { content: "a".repeat(200) },
		});
	});

	it("keeps project_file get results until a later assistant message has consumed them", async () => {
		const getMessage = assistantWithProjectFileGet("call-get");
		const getResult = projectFileGetResult("source ".repeat(40), "call-get");

		const compacted = await compactProjectToolHistory([getMessage, getResult], { maxContentChars: 40 });

		expect(compacted[1]).toBe(getResult);
	});

	it("compacts consumed project_file get results so large documents do not repeat in every model request", async () => {
		const getMessage = assistantWithProjectFileGet("call-get");
		const getResult = projectFileGetResult("source ".repeat(40), "call-get");
		const laterAssistant = assistantWithProjectFile("updated file", "call-write");

		const compacted = await compactProjectToolHistory([getMessage, getResult, laterAssistant], {
			maxContentChars: 40,
			maxProjectFileGetResultChars: 40,
		});

		expect(compacted[0]).toBe(getMessage);
		expect(compacted[1]).not.toBe(getResult);
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Project file content omitted from compacted history"),
		});
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("src/main.js"),
		});
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("Call project_file get"),
		});
		expect(compacted[2]).toBe(laterAssistant);
	});

	it("preserves consumed project_file get results for medium source documents so specs are not reread repeatedly", async () => {
		const getMessage = assistantWithProjectFileGetNamed("docs/Requirements Document-20260611-022831-597996.md", "call-get");
		const sourceDocument = "Requirement detail line\n".repeat(300);
		const getResult = projectFileGetResult(sourceDocument, "call-get");
		const laterAssistant = assistantWithProjectFile("updated file", "call-write");

		const compacted = await compactProjectToolHistory([getMessage, getResult, laterAssistant], {
			maxContentChars: 40,
		});

		expect(compacted[1]).toBe(getResult);
		expect(((compacted[1] as ToolResultMessage).content[0] as { text: string }).text).toBe(sourceDocument);
		expect(JSON.stringify(compacted)).not.toContain("Project file content omitted from compacted history");
	});

	it("keeps project_task results until a later assistant message has consumed them", async () => {
		const taskMessage = assistantWithProjectTask("preview", "call-task");
		const taskResult = projectTaskResult("Task: preview\nStatus: completed\nLogs:\n".concat("log ".repeat(40)));

		const compacted = await compactProjectToolHistory([taskMessage, taskResult], { maxContentChars: 40 });

		expect(compacted[1]).toBe(taskResult);
	});

	it("compacts consumed project_task logs so old previews do not dominate later model requests", async () => {
		const taskMessage = assistantWithProjectTask("preview", "call-task");
		const taskResult = projectTaskResult("Task: preview\nStatus: completed\nLogs:\n".concat("log ".repeat(40)));
		const laterAssistant = assistantWithProjectFile("updated file", "call-write");

		const compacted = await compactProjectToolHistory([taskMessage, taskResult, laterAssistant], {
			maxContentChars: 40,
		});

		expect(compacted[0]).toBe(taskMessage);
		expect(compacted[1]).not.toBe(taskResult);
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("[project_task result omitted"),
		});
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("preview"),
		});
		expect(compacted[2]).toBe(laterAssistant);
	});

	it("compacts consumed skill_load results so repeated skill instructions do not dominate later model requests", async () => {
		const skillMessage = assistantWithSkillLoad("frontend-design", "call-skill-load");
		const skillLoadResult = skillResult("Skill: frontend-design\n".concat("instruction ".repeat(40)), "call-skill-load");
		const laterAssistant = assistantWithProjectFile("updated file", "call-write");

		const compacted = await compactProjectToolHistory([skillMessage, skillLoadResult, laterAssistant], {
			maxContentChars: 40,
		});

		expect(compacted[0]).toBe(skillMessage);
		expect(compacted[1]).not.toBe(skillLoadResult);
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("[skill_load result omitted"),
		});
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("frontend-design"),
		});
		expect(compacted[2]).toBe(laterAssistant);
	});

	it("compacts consumed skill_resource results while preserving the skill resource identity", async () => {
		const resourceMessage = assistantWithSkillResource("frontend-design", "references/design.md", "call-skill-resource");
		const resourceResult = skillResult("Design guidance\n".concat("detail ".repeat(40)), "call-skill-resource", "skill_resource");
		const laterAssistant = assistantWithProjectFile("updated file", "call-write");

		const compacted = await compactProjectToolHistory([resourceMessage, resourceResult, laterAssistant], {
			maxContentChars: 40,
		});

		expect(compacted[0]).toBe(resourceMessage);
		expect(compacted[1]).not.toBe(resourceResult);
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("[skill_resource result omitted"),
		});
		expect((compacted[1] as ToolResultMessage).content[0]).toMatchObject({
			text: expect.stringContaining("frontend-design/references/design.md"),
		});
		expect(compacted[2]).toBe(laterAssistant);
	});
});
