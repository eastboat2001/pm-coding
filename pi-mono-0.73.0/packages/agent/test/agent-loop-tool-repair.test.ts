import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, StreamFn } from "../src/types.js";

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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createStream(message: AssistantMessage): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		for (const [contentIndex, block] of message.content.entries()) {
			if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
			} else if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial: message });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
			}
		}
		stream.push({
			type: "done",
			reason: message.stopReason === "toolUse" || message.stopReason === "length" ? message.stopReason : "stop",
			message,
		});
		stream.end(message);
	});
	return stream;
}

describe("agentLoop tool-call repair", () => {
	it("repairs invalid tool arguments once before executing the tool", async () => {
		const executedArgs: unknown[] = [];
		const writeSchema = Type.Object(
			{
				value: Type.String(),
			},
			{ additionalProperties: false },
		);
		const tool: AgentTool<typeof writeSchema> = {
			label: "Write",
			name: "write",
			description: "Write value",
			parameters: writeSchema,
			execute: async (_id, args) => {
				executedArgs.push(args);
				return {
					content: [{ type: "text", text: `wrote ${args.value}` }],
					details: undefined,
				};
			},
		};

		let callCount = 0;
		const streamFn: StreamFn = () => {
			callCount++;
			if (callCount === 1) {
				return createStream(
					createAssistantMessage([{ type: "toolCall", id: "call-1", name: "write", arguments: {} }], "toolUse"),
				);
			}
			if (callCount === 2) {
				return createStream(createAssistantMessage([{ type: "text", text: '{"value":"fixed"}' }], "stop"));
			}
			return createStream(createAssistantMessage([{ type: "text", text: "done" }], "stop"));
		};

		const context: AgentContext = {
			systemPrompt: "system",
			messages: [],
			tools: [tool],
		};
		const events: AgentEvent[] = [];

		const stream = agentLoop(
			[createUserMessage("write")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				repairToolCalls: true,
			},
			undefined,
			streamFn,
		);
		for await (const event of stream) events.push(event);

		expect(executedArgs).toEqual([{ value: "fixed" }]);
		expect(events.some((event) => event.type === "tool_execution_end" && event.result.isError)).toBe(false);
	});
});
