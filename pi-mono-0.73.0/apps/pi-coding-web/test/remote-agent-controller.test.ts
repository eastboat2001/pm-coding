import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import type { RuntimeRunEventRecord } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import { RemoteAgentController } from "../src/runtime/remote-agent-controller.js";

describe("RemoteAgentController", () => {
	it("replays remote run events into the agent and finishes on terminal status", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);
		const assistantMessage = createAssistantMessage("remote reply");

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await controller.applyRunEvent(createRunEventRecord(2, "r1", { type: "message_end", message: assistantMessage }));
		await controller.applyRunEvent(
			createRunEventRecord(3, "r1", { type: "agent_end", messages: [assistantMessage] }),
		);
		await controller.finishRemoteRun("completed");

		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(3);
		expect(agent.state.messages).toEqual([assistantMessage]);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("settles a terminal remote run even when no agent_end event arrived", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await controller.settleRemoteRun("cancelled");

		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(1);
		expect(agent.appliedEvents.at(-1)?.type).toBe("agent_end");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("ignores remote prompt echo events for a user message that is already in local state", async () => {
		const userMessage = createUserMessage("hello");
		const agent = createFakeRemoteAgent([userMessage]);
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "message_start", message: userMessage }));
		await controller.applyRunEvent(createRunEventRecord(2, "r1", { type: "message_end", message: userMessage }));

		expect(controller.lastSeq).toBe(2);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.messages).toEqual([userMessage]);
	});

	it("ignores remote prompt echo events when a handoff attachment message is replayed as a user message", async () => {
		const localMessage = {
			role: "user-with-attachments",
			content: "read docs",
			timestamp: 123,
			attachments: [
				{
					type: "document",
					fileName: "需求.md",
					mimeType: "text/markdown",
					content: "",
					extractedText: "# PRD",
					llmContext: "none",
					projectFilePath: "docs/需求.md",
				},
			],
		};
		const remoteEcho = {
			...localMessage,
			role: "user",
		};
		const agent = createFakeRemoteAgent([localMessage as never]);
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "message_end", message: remoteEcho }));

		expect(controller.lastSeq).toBe(1);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.messages).toEqual([localMessage]);
	});

	it("hydrates historical events without replaying them through listeners or duplicating persisted messages", () => {
		const persistedAssistant = createAssistantMessage("already persisted");
		const streamingAssistant = createAssistantMessage("new partial output");
		const agent = createFakeRemoteAgent([persistedAssistant]);
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		controller.hydrateRunEvents([
			createRunEventRecord(3, "r1", { type: "message_end", message: persistedAssistant }),
			createRunEventRecord(1, "r1", { type: "message_start", message: createAssistantMessage("already") }),
			createRunEventRecord(2, "r1", { type: "message_update", message: persistedAssistant }),
			createRunEventRecord(4, "r1", { type: "message_start", message: createAssistantMessage("new") }),
			createRunEventRecord(5, "r1", { type: "message_update", message: streamingAssistant }),
		]);

		expect(controller.lastSeq).toBe(5);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.messages).toEqual([persistedAssistant]);
		expect(agent.state.streamingMessage).toEqual(streamingAssistant);
		expect(agent.state.isStreaming).toBe(true);
	});
});

function createFakeRemoteAgent(messages: Array<AssistantMessage | UserMessage> = []) {
	return {
		state: {
			isStreaming: false,
			messages,
			pendingToolCalls: new Set<string>(),
			streamingMessage: undefined as AssistantMessage | UserMessage | undefined,
		},
		appliedEvents: [] as AgentEvent[],
		beginRemoteRun() {
			this.state.isStreaming = true;
		},
		async applyRemoteEvent(event: AgentEvent) {
			this.appliedEvents.push(event);
			if (event.type === "message_end") {
				this.state.messages.push(event.message as AssistantMessage);
			}
		},
		async endRemoteRun() {
			this.state.isStreaming = false;
		},
	};
}

function createRunEventRecord(seq: number, runId: string, payload: Record<string, unknown>): RuntimeRunEventRecord {
	return {
		eventId: seq,
		runId,
		sessionId: "session-1",
		clientId: "client-1",
		seq,
		type: String(payload.type || "agent"),
		payload,
		createdAt: "2026-06-09T00:00:00.000Z",
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 123,
	};
}
