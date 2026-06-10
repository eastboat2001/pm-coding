import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ClaimedRun, InMemoryRunQueue, type RunQueue, type RunQueueItem } from "../src/run-queue.js";
import { type WorkerAgent, type WorkerAgentEvent, WorkspaceRunWorkerService } from "../src/run-worker-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { JsonObject, RuntimeMessageRecord, RuntimeRunRecord } from "../src/types.js";

describe("WorkspaceRunWorkerService", () => {
	let dir: string;
	let db: RuntimeDbStore;
	let queue: InMemoryRunQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-run-worker-service-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		queue = new InMemoryRunQueue();
	});

	afterEach(async () => {
		await queue.close();
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("marks owned running runs interrupted on startup recovery", () => {
		const run = createRunFixture(db);
		db.updateRunStatus(run.runId, run.clientId, "running", { workerId: "w1" });
		db.updateRunStatus("other-run", "client-a", "running", { workerId: "w2" });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		worker.markOwnedRunningRunsInterrupted();

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("interrupted");
		expect(db.getRun("client-a", "other-run")?.status).toBe("running");
	});

	it("processes one queued run through the fake agent", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
		await expect(queue.claim("w1", 1)).resolves.toBeUndefined();
		expect(db.listRunEvents(run.clientId, run.runId, 0).length).toBeGreaterThan(0);
		expect(db.listMessages(run.clientId, run.sessionId).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("does not append duplicate assistant message_end events to the transcript", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new DuplicateMessageAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const messages = db.listMessages(run.clientId, run.sessionId);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(
			messages.filter((message) => message.role === "assistant" && message.payload.content === "done"),
		).toHaveLength(1);
	});

	it("does not dedupe matching assistant message_end payloads across separate runs in the same session", async () => {
		const run = createRunFixture(db);
		const secondRun = db.createRun({
			clientId: run.clientId,
			sessionId: run.sessionId,
			runId: "run-2",
			model: run.model,
			thinkingLevel: run.thinkingLevel,
		});
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });
		await queue.enqueue({ clientId: secondRun.clientId, runId: secondRun.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);
		await expect(worker.processOne()).resolves.toBe(true);

		const messages = db.listMessages(run.clientId, run.sessionId);
		expect(
			messages.filter((message) => message.role === "assistant" && message.payload.content === "done"),
		).toHaveLength(2);
	});

	it("does not append user message_end events to the transcript", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new UserMessageAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.listMessages(run.clientId, run.sessionId).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("does not append user-with-attachments message_end events to the transcript", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new UserWithAttachmentsMessageAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.listMessages(run.clientId, run.sessionId).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("persists non-user tool result message_end events once per run", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ToolResultMessageAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const messages = db.listMessages(run.clientId, run.sessionId);
		expect(messages.map((message) => message.role)).toEqual(["user", "toolResult"]);
		expect(
			messages.filter((message) => message.role === "toolResult" && message.payload.content === "tool done"),
		).toHaveLength(1);
	});

	it("keeps raw agent event payloads replayable while appending transcript messages", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new RawMessageAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const messageEndEvent = db
			.listRunEvents(run.clientId, run.runId, 0)
			.find((event) => event.type === "message_end");
		expect(messageEndEvent?.payload.message).toEqual(rawAssistantMessage());
		expect(db.listMessages(run.clientId, run.sessionId).at(-1)).toEqual(
			expect.objectContaining({
				role: "assistant",
				payload: rawAssistantMessage(),
			}),
		);
	});

	it("continues when the transcript tail is not a user message", async () => {
		const run = createRunFixture(db);
		const agent = new ScriptedAgent();
		db.appendMessage({
			clientId: run.clientId,
			sessionId: run.sessionId,
			role: "assistant",
			payload: { content: "prior assistant response" },
		});
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => agent,
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(agent.promptCalls).toBe(0);
		expect(agent.continueCalls).toBe(1);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
	});

	it("aborts the active agent when cancellation is requested", async () => {
		const run = createRunFixture(db);
		const agent = new BlockingAgent();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			cancelPollIntervalMs: 1,
			createAgent: () => agent,
		});

		const processing = worker.processOne();
		await agent.waitForPrompt();
		await queue.requestCancel({ clientId: run.clientId, runId: run.runId });
		await agent.waitForAbort();
		agent.finish();

		await expect(processing).resolves.toBe(true);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("cancelled");
	});

	it("uses the claimed client identity when multiple clients share a run id", async () => {
		const clientARun = createRunFixture(db);
		const clientBRun = createRunFixture(db, {
			clientId: "client-b",
			sessionId: "session-b",
			title: "Client B session",
			runId: clientARun.runId,
			otherRunId: "other-run-b",
		});
		await queue.enqueue({ clientId: clientBRun.clientId, runId: clientBRun.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.getRun(clientBRun.clientId, clientBRun.runId)?.status).toBe("completed");
		expect(db.getRun(clientARun.clientId, clientARun.runId)?.status).toBe("queued");
	});

	it("marks an active run interrupted when stop aborts its agent", async () => {
		const run = createRunFixture(db);
		const agent = new BlockingAgent();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			cancelPollIntervalMs: 1,
			createAgent: () => agent,
		});

		await worker.start();
		await agent.waitForPrompt();
		const stopped = worker.stop();
		await agent.waitForAbort();
		agent.finish();
		await stopped;

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("interrupted");
	});

	it("records queue claim failures without letting the worker loop die silently", async () => {
		const failingQueue = new ClaimFailingQueue();
		const diagnostics = new RecordingDiagnostics();
		const worker = new WorkspaceRunWorkerService({
			db,
			queue: failingQueue,
			workerId: "w1",
			diagnostics,
			createAgent: () => new ScriptedAgent(),
		});

		await worker.start();
		await failingQueue.waitForClaims(1);

		await expect(worker.stop()).resolves.toBeUndefined();
		expect(diagnostics.events).toContainEqual(
			expect.objectContaining({
				level: "error",
				category: "system",
				eventType: "worker.queue.claim.error",
				data: expect.objectContaining({
					workerId: "w1",
					message: "redis unavailable",
				}),
			}),
		);
	});
});

function createRunFixture(
	db: RuntimeDbStore,
	options: {
		clientId?: string;
		sessionId?: string;
		title?: string;
		runId?: string;
		otherRunId?: string;
	} = {},
): RuntimeRunRecord {
	const clientId = options.clientId ?? "client-a";
	const sessionId = options.sessionId ?? "session-1";
	db.upsertClient(clientId);
	const session = db.createSession({
		clientId,
		sessionId,
		title: options.title ?? "Client A session",
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "medium",
	});
	db.appendMessage({
		clientId: session.clientId,
		sessionId: session.sessionId,
		role: "user",
		payload: { content: "hello" },
	});
	const run = db.createRun({
		clientId: session.clientId,
		sessionId: session.sessionId,
		runId: options.runId ?? "run-1",
		model: session.model,
		thinkingLevel: session.thinkingLevel,
	});
	db.createRun({
		clientId: session.clientId,
		sessionId: session.sessionId,
		runId: options.otherRunId ?? "other-run",
		model: session.model,
		thinkingLevel: session.thinkingLevel,
	});
	return run;
}

class ScriptedAgent implements WorkerAgent {
	continueCalls = 0;
	private listeners: Array<(event: WorkerAgentEvent) => void> = [];
	promptCalls = 0;

	subscribe(listener: (event: WorkerAgentEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	async prompt(_message: RuntimeMessageRecord): Promise<void> {
		this.promptCalls += 1;
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}

	async continue(): Promise<void> {
		this.continueCalls += 1;
		await this.emitAssistant();
	}

	abort(): void {}

	private async emitAssistant(): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}

	protected emit(event: WorkerAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class BlockingAgent extends ScriptedAgent {
	private readonly abortDeferred = createDeferred<void>();
	private readonly finishDeferred = createDeferred<void>();
	private readonly promptDeferred = createDeferred<void>();

	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		this.promptDeferred.resolve();
		await this.finishDeferred.promise;
	}

	override abort(): void {
		this.abortDeferred.resolve();
	}

	finish(): void {
		this.finishDeferred.resolve();
	}

	waitForAbort(): Promise<void> {
		return this.abortDeferred.promise;
	}

	waitForPrompt(): Promise<void> {
		return this.promptDeferred.promise;
	}
}

class DuplicateMessageAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}
}

class UserMessageAgent extends ScriptedAgent {
	override async prompt(message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "message_end", message });
		this.emit({ type: "message_end", message: assistant });
	}
}

class UserWithAttachmentsMessageAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({
			type: "message_end",
			message: {
				role: "user-with-attachments",
				content: "hello",
				timestamp: 123,
				attachments: [],
			},
		});
		this.emit({ type: "message_end", message: assistant });
	}
}

class ToolResultMessageAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const toolResult = toolResultMessage();
		this.emit({ type: "message_end", message: toolResult });
		this.emit({ type: "message_end", message: toolResult });
		this.emit({ type: "agent_end", messages: [toolResult] });
	}
}

class RawMessageAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = rawAssistantMessage();
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}
}

class ClaimFailingQueue implements RunQueue {
	private readonly claimDeferreds: Array<{ count: number; resolve: () => void }> = [];
	private claimCount = 0;

	async enqueue(_run: RunQueueItem): Promise<void> {}

	async claim(_workerId: string, _timeoutMs: number): Promise<ClaimedRun | undefined> {
		this.claimCount += 1;
		this.flushClaimDeferreds();
		throw new Error("redis unavailable");
	}

	async complete(_run: RunQueueItem | ClaimedRun, _workerId: string): Promise<void> {}

	async requestCancel(_run: RunQueueItem | ClaimedRun): Promise<void> {}

	async isCancelRequested(_run: RunQueueItem | ClaimedRun): Promise<boolean> {
		return false;
	}

	async close(): Promise<void> {}

	async waitForClaims(count: number): Promise<void> {
		if (this.claimCount >= count) return;
		await new Promise<void>((resolve) => {
			this.claimDeferreds.push({ count, resolve });
		});
	}

	private flushClaimDeferreds(): void {
		const ready = this.claimDeferreds.filter((deferred) => this.claimCount >= deferred.count);
		for (const deferred of ready) deferred.resolve();
		for (const deferred of ready) {
			const index = this.claimDeferreds.indexOf(deferred);
			if (index !== -1) this.claimDeferreds.splice(index, 1);
		}
	}
}

class RecordingDiagnostics {
	events: JsonObject[] = [];

	writeEvents(input: { events: JsonObject[] }): JsonObject {
		this.events.push(...input.events);
		return { accepted: input.events.length, dropped: 0 };
	}
}

function assistantMessage(): RuntimeMessageRecord {
	return {
		messageId: 0,
		sessionId: "session-1",
		clientId: "client-a",
		role: "assistant",
		payload: { content: "done" },
		createdAt: "2026-06-08T00:00:00.000Z",
	};
}

function toolResultMessage(): RuntimeMessageRecord {
	return {
		messageId: 0,
		sessionId: "session-1",
		clientId: "client-a",
		role: "toolResult",
		payload: { content: "tool done", toolCallId: "tc1" },
		createdAt: "2026-06-08T00:00:00.000Z",
	};
}

function rawAssistantMessage() {
	return {
		role: "assistant",
		content: [{ type: "text", text: "raw done" }],
		model: "test-model",
		timestamp: 123,
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolveValue: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}
