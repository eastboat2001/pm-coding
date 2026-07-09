import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { planCapabilities } from "../src/runtime/capability-planner.js";
import { prepareContextPacket } from "../src/runtime/context-orchestrator.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantWithProjectFile(filename: string, content: string, id = "call-file"): AssistantMessage {
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
					command: "rewrite",
					filename,
					content,
				},
			},
		],
	};
}

function assistantWithProjectFileRead(filename: string, id: string): AssistantMessage {
	return {
		...assistantWithProjectFile(filename, "", id),
		content: [
			{
				type: "toolCall",
				id,
				name: "project_file",
				arguments: {
					command: "get",
					filename,
				},
			},
		],
	};
}

function projectFileResult(toolCallId = "call-file", text = "rewrite: src/main.js"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_file",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
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

function projectTaskResult(
	toolCallId = "call-task",
	details: Record<string, unknown> = {},
	text = "Task: validate\nStatus: failed",
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "project_task",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

function assistantText(text: string): AssistantMessage {
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
		content: [{ type: "text", text }],
	};
}

function latestUserText(messages: AgentMessage[]): string {
	const latestUser = [...messages]
		.reverse()
		.find((message) => (message as { role?: string }).role === "user") as
		| { content?: Array<{ type?: string; text?: string }> }
		| undefined;
	return latestUser?.content?.map((block) => block.text || "").join("\n") || "";
}

describe("prepareContextPacket", () => {
	it("injects objective, requirements, active files, capability decision, and next step", async () => {
		const prompt = "Build a full-stack React app with backend APIs, PostgreSQL persistence, and auth.";
		const messages = [
			userMessage("Create the first version."),
			assistantWithProjectFile("src/main.js", "console.log('hello');"),
			projectFileResult(),
			userMessage(prompt),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const result = await prepareContextPacket(messages, {
			capabilityPlan,
			providerPayloadBudgetChars: 20_000,
		});
		const packetText = latestUserText(result.messages);

		expect(packetText).toContain("[Context packet]");
		expect(packetText).toContain("current_objective: Build a full-stack React app");
		expect(packetText).toContain("backend APIs");
		expect(packetText).toContain("PostgreSQL persistence");
		expect(packetText).toContain("src/main.js");
		expect(packetText).toContain("delivery_mode=static_simulation");
		expect(packetText).toContain("next_best_step:");
		expect(result.packet.currentObjective).toContain("full-stack React app");
		expect(result.packet.activeFileSet).toContain("src/main.js");
		expect(result.decision.retained.currentObjective).toBe(true);
	});

	it("keeps the context packet when provider-budget pruning drops older project history", async () => {
		const prompt = "Continue the full-stack dashboard with API persistence and auth.";
		const messages = [
			userMessage("Initial objective."),
			assistantWithProjectFile("src/main.js", "x".repeat(12_000)),
			projectFileResult("call-file", "rewrite: src/main.js\n" + "x".repeat(12_000)),
			assistantText("Prepared the first static dashboard draft."),
			userMessage(prompt),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const compactions: unknown[] = [];

		const result = await prepareContextPacket(messages, {
			capabilityPlan,
			providerPayloadBudgetChars: 1_000,
			onCompaction: (summary) => compactions.push(summary),
		});
		const packetText = latestUserText(result.messages);

		expect(compactions.length).toBeGreaterThan(0);
		expect(packetText).toContain("[Context packet]");
		expect(packetText).toContain("current_objective: Continue the full-stack dashboard");
		expect(packetText).toContain("active_file_set:");
		expect(packetText).toContain("src/main.js");
		expect(result.decision.compactions.length).toBeGreaterThan(0);
		expect(result.decision.outputMessageCount).toBeLessThan(result.decision.inputMessageCount + 1);
	});

	it("does not synthesize legacy spec kit reads from PM handoff attachments alone", async () => {
		const prompt = "Build the QDM Finished Lot Yield Dashboard from the PM handoff.";
		const messages = [
			{
				...userMessage(prompt),
				attachments: [
					{
						type: "document",
						projectFilePath: "docs/Requirements Document.md",
						extractedText: "Build KPI cards, charts, filters, and CSV export.",
					},
				],
			} as AgentMessage,
			assistantWithProjectFile("js/dashboard.js", "x".repeat(12_000)),
			projectFileResult("call-file", "rewrite: js/dashboard.js\n" + "x".repeat(12_000)),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const result = await prepareContextPacket(messages, {
			capabilityPlan,
			providerPayloadBudgetChars: 1_000,
		});
		const packetText = latestUserText(result.messages);

		expect(packetText).not.toContain("docs/spec.md");
		expect(packetText).not.toContain("docs/plan.md");
		expect(packetText).not.toContain("docs/tasks.md");
		expect(packetText).not.toContain("Read spec execution files before implementation edits");
		expect(packetText).not.toContain("spec_execution:");
	});

	it("keeps validation failures without requiring legacy spec checklist files", async () => {
		const prompt = "Build the QDM dashboard with first-screen KPI data.";
		const messages = [
			userMessage(prompt),
			assistantWithProjectTask("validate"),
			projectTaskResult("call-task", {
				task: "validate",
				status: "failed",
				errors: [
					"Static preview quality gate: Metric placeholder #kpiLots starts as \"--\".",
					"Static preview smoke gate: Runtime smoke gate: loading element remained visible.",
				],
			}),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const result = await prepareContextPacket(messages, {
			capabilityPlan,
			providerPayloadBudgetChars: 20_000,
		});
		const packetText = latestUserText(result.messages);

		expect(packetText).toContain("task_state:");
		expect(packetText).toContain("validation_failures:");
		expect(packetText).toContain("Metric placeholder #kpiLots");
		expect(packetText).toContain("loading element remained visible");
		expect(packetText).toContain("next_best_step: Fix validation failures");
		expect(result.packet.taskState.validationFailures).toEqual([
			"Static preview quality gate: Metric placeholder #kpiLots starts as \"--\".",
			"Static preview smoke gate: Runtime smoke gate: loading element remained visible.",
		]);
	});

	it("uses the spec artifact objective instead of replaying PM handoff wrapper text", async () => {
		const messages = [
			userMessage(`You are a senior full-stack engineer responsible for implementing a runnable project strictly from the provided documents.

Read these files fully before writing code:
1. PRD document: Requirements Document-20260611-022831-597996.md
2. System design document: Design Document-20260611-022850-817700.md

Project context:
- Session title: QDM Finished Lot Yield Dashboard`),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const result = await prepareContextPacket(messages, {
			capabilityPlan,
			currentObjective: "QDM Finished Lot Yield Dashboard",
			requirementsSummary: [
				"Render QDM finished lot yield KPI cards, trend charts, and defect Pareto analysis.",
			],
			providerPayloadBudgetChars: 20_000,
		});
		const packetText = latestUserText(result.messages);

		expect(result.packet.currentObjective).toBe("QDM Finished Lot Yield Dashboard");
		expect(result.packet.requirementsSummary).toContain(
			"Render QDM finished lot yield KPI cards, trend charts, and defect Pareto analysis.",
		);
		expect(packetText).toContain("current_objective: QDM Finished Lot Yield Dashboard");
		expect(packetText).not.toContain("current_objective: You are a senior full-stack engineer");
	});
});
