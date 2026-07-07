import { describe, expect, it } from "vitest";
import { type AgentV2RunTransportEvent, appendAgentV2RunEvent } from "../src/agent-v2-run-events.js";
import type { LiveRunEvent, RunEventBus } from "../src/run-event-bus.js";
import { RunEventSink, type RunEventSinkAgentEvent, type RunEventSinkStore } from "../src/run-event-sink.js";
import type { AppendMessageInput, AppendRunEventInput, RuntimeRunRecord } from "../src/types.js";

const run: RuntimeRunRecord = {
	runId: "run-1",
	sessionId: "session-1",
	clientId: "client-a",
	status: "running",
	model: { id: "gpt-5" },
	thinkingLevel: "medium",
	updatedAt: "2026-06-29T00:00:00.000Z",
};

describe("RunEventSink", () => {
	it("live publishes every message_update while durably checkpointing by interval or text growth", async () => {
		const store = new RecordingStore();
		const bus = new RecordingBus();
		const sink = new RunEventSink({
			store,
			bus,
			checkpointIntervalMs: 1_000,
			checkpointMinChars: 5,
			now: sequenceClock(
				"2026-06-29T00:00:00.000Z",
				"2026-06-29T00:00:00.500Z",
				"2026-06-29T00:00:00.600Z",
				"2026-06-29T00:00:01.700Z",
			),
		});

		await sink.persistAgentEvent(run, messageUpdate("hi"));
		await sink.persistAgentEvent(run, messageUpdate("hit"));
		await sink.persistAgentEvent(run, messageUpdate("hello!!"));
		await sink.persistAgentEvent(run, messageUpdate("hello!!!"));

		expect(bus.events.map((event) => [event.seq, event.type, event.payload])).toEqual([
			[1, "message_update", messageUpdate("hi")],
			[2, "message_update", messageUpdate("hit")],
			[3, "message_update", messageUpdate("hello!!")],
			[4, "message_update", messageUpdate("hello!!!")],
		]);
		expect(store.runEvents.map((event) => [event.seq, event.type, event.payload])).toEqual([
			[1, "message_update", messageUpdate("hi")],
			[3, "message_update", messageUpdate("hello!!")],
			[4, "message_update", messageUpdate("hello!!!")],
		]);
	});

	it("persists message_end and appends non-user messages once per run", async () => {
		const store = new RecordingStore();
		const sink = new RunEventSink({
			store,
			bus: new RecordingBus(),
			checkpointIntervalMs: 1_000,
			checkpointMinChars: 100,
		});
		const assistantEnd = messageEnd({ role: "assistant", content: "done" });

		await sink.persistAgentEvent(run, assistantEnd);
		await sink.persistAgentEvent(run, assistantEnd);

		expect(store.runEvents.map((event) => [event.seq, event.type])).toEqual([
			[1, "message_end"],
			[2, "message_end"],
		]);
		expect(store.messages).toEqual([
			{
				clientId: run.clientId,
				sessionId: run.sessionId,
				role: "assistant",
				payload: { role: "assistant", content: "done" },
			},
		]);
	});

	it("does not append user, user-with-attachments, or assistant failure marker message_end events as messages", async () => {
		const store = new RecordingStore();
		const sink = new RunEventSink({
			store,
			bus: new RecordingBus(),
			checkpointIntervalMs: 1_000,
			checkpointMinChars: 100,
		});

		await sink.persistAgentEvent(run, messageEnd({ role: "user", content: "hello" }));
		await sink.persistAgentEvent(
			run,
			messageEnd({ role: "user-with-attachments", content: "hello", attachments: [] }),
		);
		await sink.persistAgentEvent(run, messageEnd({ role: "assistant", content: "failed", errorMessage: "503" }));
		await sink.persistAgentEvent(run, messageEnd({ role: "assistant", content: "failed", stopReason: "error" }));

		expect(store.runEvents.map((event) => [event.seq, event.type])).toEqual([
			[1, "message_end"],
			[2, "message_end"],
			[3, "message_end"],
			[4, "message_end"],
		]);
		expect(store.messages).toEqual([]);
	});

	it("dedupes matching assistant message_end payloads per run without leaking across runs", async () => {
		const store = new RecordingStore();
		const sink = new RunEventSink({
			store,
			bus: new RecordingBus(),
			checkpointIntervalMs: 1_000,
			checkpointMinChars: 100,
		});
		const samePayload = messageEnd({ role: "assistant", payload: { content: "done" } });

		await sink.persistAgentEvent(run, samePayload);
		await sink.persistAgentEvent(run, samePayload);
		await sink.persistAgentEvent({ ...run, runId: "run-2" }, samePayload);

		expect(store.messages.map((message) => [message.sessionId, message.role, message.payload])).toEqual([
			["session-1", "assistant", { content: "done" }],
			["session-1", "assistant", { content: "done" }],
		]);
		expect(store.runEvents.map((event) => [event.runId, event.seq])).toEqual([
			["run-1", 1],
			["run-1", 2],
			["run-2", 1],
		]);
	});

	it("durably persists tool execution and run lifecycle events but only live publishes other events", async () => {
		const store = new RecordingStore();
		const bus = new RecordingBus();
		const sink = new RunEventSink({ store, bus, checkpointIntervalMs: 1_000, checkpointMinChars: 100 });
		const events: RunEventSinkAgentEvent[] = [
			{ type: "message_start", message: { role: "assistant", content: "" } },
			{ type: "tool_execution_started", toolCallId: "tc1" },
			{ type: "tool_execution_output", toolCallId: "tc1", output: "one" },
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "turn_end" },
			{
				type: "agent_retry_scheduled",
				attempt: 1,
				maxAttempts: 5,
				reasonCode: "transient_provider_error",
				message: "503 service unavailable",
				delayMs: 100,
			},
			{ type: "agent_end" },
		];

		for (const event of events) {
			await sink.persistAgentEvent(run, event);
		}

		expect(bus.events.map((event) => [event.seq, event.type])).toEqual([
			[1, "message_start"],
			[2, "tool_execution_started"],
			[3, "tool_execution_output"],
			[4, "agent_start"],
			[5, "turn_start"],
			[6, "turn_end"],
			[7, "agent_retry_scheduled"],
			[8, "agent_end"],
		]);
		expect(store.runEvents.map((event) => [event.seq, event.type])).toEqual([
			[2, "tool_execution_started"],
			[3, "tool_execution_output"],
			[4, "agent_start"],
			[5, "turn_start"],
			[6, "turn_end"],
			[7, "agent_retry_scheduled"],
			[8, "agent_end"],
		]);
	});

	it("fails fast when live publish fails", async () => {
		const store = new RecordingStore();
		const bus = new RecordingBus();
		bus.publishError = new Error("redis unavailable");
		const sink = new RunEventSink({ store, bus, checkpointIntervalMs: 1_000, checkpointMinChars: 100 });

		await expect(sink.persistAgentEvent(run, { type: "agent_end" })).rejects.toThrow("redis unavailable");

		expect(store.runEvents).toEqual([]);
	});

	it("persists agent v2 transport projection events through the sink", async () => {
		const store = new RecordingStore();
		const bus = new RecordingBus();
		const sink = new RunEventSink({ store, bus, checkpointIntervalMs: 1_000, checkpointMinChars: 100 });
		const event: AgentV2RunTransportEvent = {
			type: "agent_v2.phase_changed",
			phase: "validation",
			attempt: 2,
			at: "2026-07-07T00:04:00.000Z",
		};

		await appendAgentV2RunEvent(sink, run, event);

		expect(bus.events.map((liveEvent) => liveEvent.type)).toEqual(["agent_v2.phase_changed"]);
		expect(store.runEvents).toEqual([
			{
				clientId: run.clientId,
				sessionId: run.sessionId,
				runId: run.runId,
				seq: 1,
				type: "agent_v2.phase_changed",
				payload: event,
				createdAt: expect.any(String),
			},
		]);
		expect(store.messages).toEqual([]);
	});
});

function messageUpdate(content: string): RunEventSinkAgentEvent {
	return { type: "message_update", message: { role: "assistant", content } };
}

function messageEnd(message: Record<string, unknown>): RunEventSinkAgentEvent {
	return { type: "message_end", message };
}

function sequenceClock(...values: string[]): () => string {
	const timestamps = [...values];
	return () => {
		const value = timestamps.shift();
		if (!value) throw new Error("sequenceClock exhausted");
		return value;
	};
}

class RecordingBus implements RunEventBus {
	readonly events: LiveRunEvent[] = [];
	publishError: Error | undefined;

	async publish(event: LiveRunEvent): Promise<void> {
		if (this.publishError) throw this.publishError;
		this.events.push(event);
	}

	async read(): Promise<[]> {
		return [];
	}

	async close(): Promise<void> {}
}

class RecordingStore implements RunEventSinkStore {
	readonly messages: AppendMessageInput[] = [];
	readonly runEvents: AppendRunEventInput[] = [];

	async appendRunEvent(input: AppendRunEventInput): Promise<void> {
		this.runEvents.push(input);
	}

	async appendMessage(input: AppendMessageInput): Promise<void> {
		this.messages.push(input);
	}
}
