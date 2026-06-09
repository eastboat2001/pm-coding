import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.js";

// Mock stream that mimics AssistantMessageEventStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

class ThrowingAssistantStream extends MockAssistantStream {
	constructor(
		private readonly events: AssistantMessageEvent[],
		private readonly error: Error,
	) {
		super();
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		for (const event of this.events) {
			yield event;
		}
		throw this.error;
	}

	override result(): Promise<AssistantMessage> {
		return Promise.resolve(createAssistantMessage("", "error", this.error.message));
	}
}

function createAssistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function createToolCallMessage(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
	};
}

function createTestModel(reasoning: boolean): Model<"openai-responses"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non Reasoning Model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = createTestModel(false);
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should not pass reasoning when the selected model does not support reasoning", async () => {
		let capturedReasoning: unknown = "unset";
		const agent = new Agent({
			initialState: {
				model: createTestModel(false),
				thinkingLevel: "high",
			},
			streamFn: (_model, _context, options) => {
				capturedReasoning = options?.reasoning;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");

		expect(capturedReasoning).toBeUndefined();
	});

	it("should pass reasoning when the selected model supports reasoning", async () => {
		let capturedReasoning: unknown = "unset";
		const agent = new Agent({
			initialState: {
				model: createTestModel(true),
				thinkingLevel: "high",
			},
			streamFn: (_model, _context, options) => {
				capturedReasoning = options?.reasoning;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");

		expect(capturedReasoning).toBe("high");
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("applies remote lifecycle events without running a prompt", async () => {
		const events: AgentEvent[] = [];
		const agent = new Agent({
			streamFn: () => {
				throw new Error("remote events should not run a prompt");
			},
		});
		const message = createAssistantMessage("remote response");
		agent.subscribe((event) => {
			events.push(event);
		});

		agent.beginRemoteRun();
		await agent.applyRemoteEvent({ type: "agent_start" });
		await agent.applyRemoteEvent({ type: "message_start", message });
		await agent.applyRemoteEvent({ type: "message_end", message });
		await agent.applyRemoteEvent({ type: "agent_end", messages: [message] });
		await agent.endRemoteRun();

		expect(events.map((event) => event.type)).toEqual(["agent_start", "message_start", "message_end", "agent_end"]);
		expect(agent.state.messages).toEqual([message]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
	});

	it("remote events pass an abort signal to subscribers and waitForIdle resolves after endRemoteRun", async () => {
		const agent = new Agent();
		let receivedSignal: AbortSignal | undefined;
		let idleResolved = false;

		agent.subscribe((_event, signal) => {
			receivedSignal = signal;
		});

		agent.beginRemoteRun();
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await agent.applyRemoteEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "remoteTool",
			args: {},
		});
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);
		expect(agent.state.pendingToolCalls).toEqual(new Set(["tool-1"]));

		agent.abort();
		expect(receivedSignal?.aborted).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);

		await expect(agent.endRemoteRun()).rejects.toThrow("Remote run cannot end before an agent_end event.");
		expect(agent.state.isStreaming).toBe(true);
		expect(agent.state.pendingToolCalls).toEqual(new Set(["tool-1"]));
		expect(idleResolved).toBe(false);

		await agent.applyRemoteEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "remoteTool",
			result: { content: [], details: undefined },
			isError: false,
		});
		await agent.applyRemoteEvent({ type: "agent_end", messages: [] });
		await agent.endRemoteRun();
		await idlePromise;

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
	});

	it("endRemoteRun waits for queued agent_end listeners before resolving idle", async () => {
		const barrier = createDeferred();
		const agent = new Agent();
		const message = createAssistantMessage("remote done");
		let listenerFinished = false;
		let eventResolved = false;
		let endResolved = false;
		let idleResolved = false;

		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		agent.beginRemoteRun();
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});
		const eventPromise = agent.applyRemoteEvent({ type: "agent_end", messages: [message] }).then(() => {
			eventResolved = true;
		});
		const endPromise = agent.endRemoteRun().then(() => {
			endResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(listenerFinished).toBe(false);
		expect(eventResolved).toBe(false);
		expect(endResolved).toBe(false);
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([eventPromise, endPromise, idlePromise]);

		expect(listenerFinished).toBe(true);
		expect(eventResolved).toBe(true);
		expect(endResolved).toBe(true);
		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("endRemoteRun before agent_end rejects", async () => {
		const agent = new Agent();

		agent.beginRemoteRun();

		await expect(agent.endRemoteRun()).rejects.toThrow("Remote run cannot end before an agent_end event.");
		expect(agent.state.isStreaming).toBe(true);

		await agent.applyRemoteEvent({ type: "agent_end", messages: [] });
		await agent.endRemoteRun();

		expect(agent.state.isStreaming).toBe(false);
	});

	it("beginRemoteRun rejects while local prompt active and applyRemoteEvent before begin rejects", async () => {
		const started = createDeferred();
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const abort = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage("", "aborted", "Request aborted by user"),
						});
					};
					options?.signal?.addEventListener("abort", abort, { once: true });
					stream.push({ type: "start", partial: createAssistantMessage("") });
					started.resolve();
					if (options?.signal?.aborted) abort();
				});
				return stream;
			},
		});
		const remoteOnlyAgent = new Agent();

		await expect(remoteOnlyAgent.applyRemoteEvent({ type: "agent_start" })).rejects.toThrow(
			"beginRemoteRun() must be called before applyRemoteEvent().",
		);

		const promptPromise = agent.prompt("hello");
		await started.promise;

		expect(() => agent.beginRemoteRun()).toThrow("Agent is already processing.");

		agent.abort();
		await promptPromise;
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should settle when the provider iterator throws after starting a response", async () => {
		const events: AgentEvent[] = [];
		const partial = createAssistantMessage("");
		const agent = new Agent({
			streamFn: () => new ThrowingAssistantStream([{ type: "start", partial }], new Error("iterator-boom")),
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await expect(agent.prompt("hello")).resolves.toBeUndefined();

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBe("iterator-boom");
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "iterator-boom",
		});
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("should settle and surface a tool result when a tool throws", async () => {
		const events: AgentEvent[] = [];
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "explode",
			label: "Explode",
			description: "Throws for testing",
			parameters: toolSchema,
			async execute() {
				throw new Error("tool-boom");
			},
		};

		let callIndex = 0;
		const agent = new Agent({
			initialState: {
				model: createTestModel(false),
				tools: [tool],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createToolCallMessage("tool-1", "explode", { value: "x" }),
						});
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("recovered") });
					}
					callIndex++;
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await expect(agent.prompt("run tool")).resolves.toBeUndefined();

		const toolResult = agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "tool-1",
		);
		const toolEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(callIndex).toBe(2);
		expect(toolEnd).toMatchObject({ toolCallId: "tool-1", toolName: "explode", isError: true });
		expect(toolResult).toMatchObject({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "explode",
			isError: true,
			content: [{ type: "text", text: "tool-boom" }],
		});
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("should settle when aborted while the provider stream is active", async () => {
		const started = createDeferred();
		const events: AgentEvent[] = [];
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const abort = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage("", "aborted", "Request aborted by user"),
						});
					};
					options?.signal?.addEventListener("abort", abort, { once: true });
					stream.push({ type: "start", partial: createAssistantMessage("") });
					started.resolve();
					if (options?.signal?.aborted) abort();
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		const promptPromise = agent.prompt("hello");
		await started.promise;
		agent.abort();
		await expect(promptPromise).resolves.toBeUndefined();

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBe("Request aborted by user");
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Request aborted by user",
		});
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.state.messages.push(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});
});
