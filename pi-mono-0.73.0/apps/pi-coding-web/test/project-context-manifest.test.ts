import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "../../../packages/ai/src/types.js";
import { describe, expect, it } from "vitest";
import {
	appendProjectContextManifest,
	prepareProjectContextMessages,
	resolveProjectContextProviderPayloadBudget,
} from "../src/project-tools/context-manifest.js";

function userMessage(content: string, timestamp = Date.now()): UserMessage {
	return {
		role: "user",
		content,
		timestamp,
	};
}

function assistantWithProjectFile(content: string, id = "call-file"): AssistantMessage {
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

function mockModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "mock",
		baseUrl: "http://localhost/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function projectFileResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_file",
		content: [{ type: "text", text: "rewrite: src/main.js" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function assistantText(content: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [{ type: "text", text: content }],
	};
}

function assistantThinkingOnly(content: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "length",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [{ type: "thinking", thinking: content }],
	};
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

function projectTaskResult(toolCallId = "call-task"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_task",
		content: [
			{
				type: "text",
				text: "Task: preview\nStatus: completed\nPreview URL: http://localhost:5173\nFiles: 3\nProject files:\nsrc/main.js",
			},
		],
		details: {
			task: "preview",
			status: "completed",
			previewUrl: "http://localhost:5173",
			fileCount: 3,
			files: ["src/main.js"],
		},
		isError: false,
		timestamp: Date.now(),
	};
}

describe("appendProjectContextManifest", () => {
	it("derives a smaller provider payload budget from small model context windows and reserves fixed overhead", () => {
		const budget = resolveProjectContextProviderPayloadBudget({
			model: mockModel({ contextWindow: 8_192, maxTokens: 2_048 }),
			systemPrompt: "system ".repeat(200),
			tools: [
				{
					name: "project_file",
					description: "Read and write files. ".repeat(40),
					parameters: { type: "object", properties: { command: { type: "string" } } },
				},
			],
		});

		expect(budget.providerPayloadBudgetChars).toBeLessThan(100_000);
		expect(budget.reservedOutputTokens).toBe(2_048);
		expect(budget.providerPayloadFixedOverheadChars).toBeGreaterThan(1_000);
		expect(budget.providerPayloadMessageBudgetChars).toBeLessThan(budget.providerPayloadBudgetChars);
	});

	it("caps provider payload budget for large context models when configured", () => {
		const budget = resolveProjectContextProviderPayloadBudget({
			model: mockModel({ contextWindow: 1_048_576, maxTokens: 32_768 }),
			thinkingLevel: "high",
			providerPayloadBudgetChars: 85_000,
		});

		expect(budget.providerPayloadBudgetChars).toBe(85_000);
	});

	it("drops thinking-only length assistant messages before replaying context", async () => {
		const latestUser = userMessage("Continue.", 2);
		const prepared = await prepareProjectContextMessages([
			userMessage("Build the app.", 1),
			assistantThinkingOnly("I need to think. ".repeat(4_000)),
			latestUser,
		]);

		expect(prepared).toHaveLength(2);
		expect(prepared.at(-1)).toBe(latestUser);
		expect(JSON.stringify(prepared)).not.toContain("I need to think.");
	});

	it("counts system prompt and tool schema overhead when deciding whether to compact", async () => {
		const latestUser = userMessage("Continue with the current project.", 100);
		const messages: AgentMessage[] = [userMessage("Build the app.", 1)];
		for (let index = 0; index < 3; index++) {
			const id = `call-file-${index}`;
			messages.push(assistantWithProjectFile(`/* file ${index} */\n${"x".repeat(1_100)}`, id));
			messages.push(projectFileResult(id));
			messages.push(assistantText(`Consumed file operation ${index}.`));
		}
		messages.push(latestUser);
		const compactions: unknown[] = [];

		const prepared = await prepareProjectContextMessages(messages, {
			maxContentChars: 10_000,
			keepRecentToolCalls: 3,
			providerPayloadBudgetChars: 6_000,
			providerPayloadFixedOverheadChars: 5_000,
			onCompaction: (summary) => compactions.push(summary),
		});

		expect(prepared.length).toBeLessThan(messages.length);
		expect(prepared.at(-1)).toBe(latestUser);
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			budgetChars: 6_000,
			beforeProviderPayloadChars: expect.any(Number),
			afterProviderPayloadChars: expect.any(Number),
		});
		expect((compactions[0] as { beforeProviderPayloadChars: number }).beforeProviderPayloadChars).toBeGreaterThan(
			6_000,
		);
	});

	it("inserts a compact project manifest before the latest user request without mutating saved messages", () => {
		const initialUser = userMessage("Build a small app.", 1);
		const fileMessage = assistantWithProjectFile("console.log('hello');");
		const taskMessage = assistantWithProjectTask("preview");
		const taskResult = projectTaskResult();
		const latestUser = userMessage("Make the layout denser.", 2);
		const messages: AgentMessage[] = [initialUser, fileMessage, taskMessage, taskResult, latestUser];

		const prepared = appendProjectContextManifest(messages);

		expect(prepared).not.toBe(messages);
		expect(prepared.at(-1)).toBe(latestUser);
		expect(messages).toHaveLength(5);
		const manifest = prepared.at(-2);
		expect(manifest).toMatchObject({ role: "user" });
		expect((manifest as UserMessage).content).toContain("[Project context manifest]");
		expect((manifest as UserMessage).content).toContain("src/main.js");
		expect((manifest as UserMessage).content).toContain("project_task: preview");
		expect((manifest as UserMessage).content).toContain("Preview URL: http://localhost:5173");
		expect((manifest as UserMessage).content).toContain("Call project_file get when full file content is needed.");
	});

	it("does not add a manifest when no project tool history exists", () => {
		const messages: AgentMessage[] = [userMessage("Hello", 1)];

		expect(appendProjectContextManifest(messages)).toBe(messages);
	});

	it("builds the manifest from raw tool history before compacting large file contents", async () => {
		const content = "abc\n".repeat(50);
		const fileMessage = assistantWithProjectFile(content);
		const latestUser = userMessage("Continue.", 2);

		const prepared = await prepareProjectContextMessages([fileMessage, latestUser], {
			maxContentChars: 20,
			keepRecentToolCalls: 0,
		});

		expect((prepared[0] as AssistantMessage).content[0]).toMatchObject({
			arguments: { contentOmitted: true, omittedChars: content.length },
		});
		expect(JSON.stringify(prepared[0])).not.toContain("[project_file content omitted");
		expect((prepared[1] as UserMessage).content).toContain(`${content.length} chars`);
		expect((prepared[1] as UserMessage).content).toContain("hash ");
		expect(prepared[2]).toBe(latestUser);
	});

	it("drops old project tool exchanges when the estimated provider payload exceeds the budget", async () => {
		const latestUser = userMessage("Continue with the current project.", 100);
		const messages: AgentMessage[] = [userMessage("Build the app.", 1)];
		for (let index = 0; index < 8; index++) {
			const id = `call-file-${index}`;
			messages.push(assistantWithProjectFile(`/* file ${index} */\n${"x".repeat(2_000)}`, id));
			messages.push(projectFileResult(id));
			messages.push(assistantText(`Consumed file operation ${index}.`));
		}
		messages.push(latestUser);
		const compactions: unknown[] = [];

		const prepared = await prepareProjectContextMessages(messages, {
			maxContentChars: 10_000,
			keepRecentToolCalls: 8,
			providerPayloadBudgetChars: 3_000,
			onCompaction: (summary) => compactions.push(summary),
		});

		expect(prepared.length).toBeLessThan(messages.length);
		expect(prepared.at(-1)).toBe(latestUser);
		expect(prepared.some((message) => message.role === "user" && String(message.content).includes("[Project context manifest]"))).toBe(
			true,
		);
		expect(JSON.stringify(prepared)).not.toContain("x".repeat(500));
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			reason: "provider_payload_budget_exceeded",
			budgetChars: 3_000,
			droppedMessages: expect.any(Number),
			beforeProviderPayloadChars: expect.any(Number),
			afterProviderPayloadChars: expect.any(Number),
		});
		expect((compactions[0] as { droppedMessages: number }).droppedMessages).toBeGreaterThan(0);
	});
});
