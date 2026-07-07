import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import type { RuntimeRunEventRecord } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import {
	drainRemoteRunEvents,
	RemoteAgentController,
	tryDrainRemoteRunEvents,
} from "../src/runtime/remote-agent-controller.js";

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
		expect(agent.appliedEvents.map((event) => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(agent.state.messages).toHaveLength(1);
		const message = agent.state.messages[0];
		expect(message.role).toBe("assistant");
		if (message.role === "assistant") {
			expect(message.stopReason).toBe("aborted");
			expect(message.errorMessage).toBe("Request was aborted.");
			expect(message.content).toEqual([]);
		}
		expect(agent.state.isStreaming).toBe(false);
	});

	it("adds a cancelled assistant marker even when agent_end arrived without an assistant message_end", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await controller.applyRunEvent(createRunEventRecord(2, "r1", { type: "agent_end", messages: [] }));
		await controller.settleRemoteRun("cancelled");

		expect(controller.activeRunId).toBeUndefined();
		expect(agent.appliedEvents.map((event) => event.type)).toEqual(["agent_start", "agent_end", "message_end"]);
		expect(agent.state.messages[0]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
		});
		expect(agent.state.isStreaming).toBe(false);
	});

	it("adds a cancelled assistant marker after a tool-use assistant turn", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);
		const toolUseAssistant = createToolUseAssistantMessage();

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await controller.applyRunEvent(createRunEventRecord(2, "r1", { type: "message_end", message: toolUseAssistant }));
		await controller.settleRemoteRun("cancelled");

		expect(controller.activeRunId).toBeUndefined();
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[0]).toBe(toolUseAssistant);
		expect(agent.state.messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
		});
		expect(agent.state.isStreaming).toBe(false);
	});

	it("settles a failed remote run with a visible assistant error when no output event arrived", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await controller.settleRemoteRun("failed", "400 invalid reasoning_effort: minimal");

		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(1);
		expect(agent.appliedEvents.map((event) => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(agent.state.messages).toHaveLength(1);
		const message = agent.state.messages[0];
		expect(message.role).toBe("assistant");
		if (message.role === "assistant") {
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("reasoning_effort");
			expect(message.content).toEqual([{ type: "text", text: "Run failed: 400 invalid reasoning_effort: minimal" }]);
		}
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

	it("ignores retry status events while advancing the remote event checkpoint", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(
			createRunEventRecord(4, "r1", {
				type: "agent_retry_scheduled",
				attempt: 1,
				maxAttempts: 5,
				reasonCode: "transient_provider_error",
				delayMs: 1000,
			}),
		);

		expect(controller.lastSeq).toBe(4);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.isStreaming).toBe(true);
	});

	it("ignores internal continuation prompt events while advancing the remote event checkpoint", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);
		const internalPrompt = {
			role: "user",
			content: "Continue from the previous assistant response and complete the original request.",
			piInternal: { kind: "app_preview_continuation" },
		};

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(4, "r1", { type: "message_start", message: internalPrompt }));
		await controller.applyRunEvent(createRunEventRecord(5, "r1", { type: "message_end", message: internalPrompt }));

		expect(controller.lastSeq).toBe(5);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.messages).toEqual([]);
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

	it("hydrates an active run checkpoint seq even when no checkpoint event is available", () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		controller.hydrateCheckpoint(undefined, 9);

		expect(controller.lastSeq).toBe(9);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.isStreaming).toBe(true);
	});

	it("hydrates an active run checkpoint event into streaming message state", () => {
		const streamingAssistant = createAssistantMessage("checkpoint output");
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		controller.hydrateCheckpoint(
			createRunEventRecord(7, "r1", { type: "message_update", message: streamingAssistant }),
			7,
		);

		expect(controller.lastSeq).toBe(7);
		expect(agent.appliedEvents).toEqual([]);
		expect(agent.state.streamingMessage).toEqual(streamingAssistant);
		expect(agent.state.isStreaming).toBe(true);
	});

	it("does not let a stale checkpoint event overwrite newer streaming state", () => {
		const newerStreamingAssistant = createAssistantMessage("newer output");
		const staleStreamingAssistant = createAssistantMessage("stale checkpoint output");
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		controller.hydrateRunEvents([
			createRunEventRecord(10, "r1", { type: "message_update", message: newerStreamingAssistant }),
		]);
		controller.hydrateCheckpoint(
			createRunEventRecord(7, "r1", { type: "message_update", message: staleStreamingAssistant }),
			8,
		);

		expect(controller.lastSeq).toBe(10);
		expect(agent.state.streamingMessage).toEqual(newerStreamingAssistant);
		expect(agent.state.isStreaming).toBe(true);
	});

	it("requires an active remote run before hydrating a checkpoint", () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		expect(() => controller.hydrateCheckpoint(undefined, 1)).toThrow(
			"startRemoteRun() must be called before hydrateCheckpoint().",
		);
	});

	it("rejects checkpoint events for a different active remote run", () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");

		expect(() =>
			controller.hydrateCheckpoint(
				createRunEventRecord(1, "r2", { type: "message_update", message: createAssistantMessage("wrong run") }),
				1,
			),
		).toThrow("Remote run event r2 does not match active run r1.");
	});

	it("drains missed events after the applied checkpoint before terminal settle", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);
		const assistantMessage = createAssistantMessage("missed terminal output");

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		await drainRemoteRunEvents("r1", controller, async (runId, afterSeq) => {
			expect(runId).toBe("r1");
			expect(afterSeq).toBe(1);
			return [
				createRunEventRecord(2, "r1", { type: "message_end", message: assistantMessage }),
				createRunEventRecord(3, "r1", { type: "agent_end", messages: [assistantMessage] }),
			];
		});
		await controller.finishRemoteRun("completed");

		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(3);
		expect(agent.state.messages).toEqual([assistantMessage]);
	});

	it("reports missed event drain failures without preventing terminal settle", async () => {
		const agent = createFakeRemoteAgent();
		const controller = new RemoteAgentController(agent as never);

		controller.startRemoteRun("r1");
		await controller.applyRunEvent(createRunEventRecord(1, "r1", { type: "agent_start" }));
		const result = await tryDrainRemoteRunEvents("r1", controller, async () => {
			throw new Error("event API unavailable");
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
			expect(result.afterSeq).toBe(1);
		}
		await controller.settleRemoteRun("failed", "Connection error.");

		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(1);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages[0]).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Connection error.",
		});
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

function createToolUseAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "skill_load",
				arguments: { name: "frontend-design" },
			},
		],
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
		stopReason: "toolUse",
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
