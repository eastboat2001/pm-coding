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
		db.updateRunStatus("other-run", "client-a", "running", { workerId: "w1" });
		db.updateRunStatus("other-run", "client-a", "cancelling");
		db.createRun({
			clientId: run.clientId,
			sessionId: run.sessionId,
			runId: "foreign-run",
			model: run.model,
			thinkingLevel: run.thinkingLevel,
		});
		db.updateRunStatus("foreign-run", "client-a", "running", { workerId: "w2" });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		worker.markOwnedRunningRunsInterrupted();

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("interrupted");
		expect(db.getRun("client-a", "other-run")?.status).toBe("interrupted");
		expect(db.getRun("client-a", "foreign-run")?.status).toBe("running");
	});

	it("requeues active claims for queued runs during startup recovery", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });
		await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => new ScriptedAgent(),
		});

		await worker.recoverOwnedRuns();
		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
	});

	it("requeues active claims and interrupts owned running runs during startup recovery", async () => {
		const run = createRunFixture(db);
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });
		await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: run.clientId, runId: run.runId });
		db.updateRunStatus(run.runId, run.clientId, "running", { workerId: "w1" });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => {
				throw new Error("interrupted recovered runs should not invoke an agent");
			},
		});

		await worker.recoverOwnedRuns();
		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("interrupted");
		await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
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

	it("retries transient agent failures before completing the run", async () => {
		const run = createRunFixture(db);
		const agents = [new PreSideEffectAssistantErrorAgent(), new ScriptedAgent()];
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				const agent = agents.shift();
				if (!agent) throw new Error("unexpected retry attempt");
				return agent;
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(factoryCalls).toBe(2);
		expect(agents).toHaveLength(0);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
		expect(db.listRunEvents(run.clientId, run.runId, 0)).toContainEqual(
			expect.objectContaining({
				type: "agent_retry_scheduled",
				payload: expect.objectContaining({
					type: "agent_retry_scheduled",
					attempt: 1,
					maxAttempts: 5,
					reasonCode: "transient_provider_error",
				}),
			}),
		);
		expect(db.listMessages(run.clientId, run.sessionId).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(JSON.stringify(db.listRunEvents(run.clientId, run.runId, 0))).not.toContain("503 service unavailable");
		expect(diagnostics.events).toContainEqual(
			expect.objectContaining({
				eventType: "agent.retry_scheduled",
				level: "warn",
				category: "agent",
				data: expect.objectContaining({
					runId: run.runId,
					reasonCode: "transient_provider_error",
				}),
			}),
		);
	});

	it("retries transient assistant errors after replayable user prompt echoes", async () => {
		const run = createRunFixture(db);
		const agents = [new PromptEchoThenAssistantErrorAgent(), new PromptEchoThenAssistantSuccessAgent()];
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				const agent = agents.shift();
				if (!agent) throw new Error("unexpected retry attempt");
				return agent;
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		const events = db.listRunEvents(run.clientId, run.runId, 0);
		expect(factoryCalls).toBe(2);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
		expect(JSON.stringify(events)).not.toContain("503 service unavailable");
		expect(events.filter((event) => event.type === "message_end" && eventMessageRole(event.payload) === "user"))
			.toHaveLength(1);
		expect(diagnostics.events.map((event) => event.eventType)).toContain("agent.retry_scheduled");
	});

	it("persists streamed events before the agent attempt completes", async () => {
		const run = createRunFixture(db);
		const agent = new StreamingPauseAgent();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => agent,
		});

		const processing = worker.processOne();
		await agent.waitForStreamStart();

		expect(db.listRunEvents(run.clientId, run.runId, 0).map((event) => event.type)).toEqual([
			"agent_start",
			"message_start",
		]);

		agent.finish();
		await expect(processing).resolves.toBe(true);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
	});

	it("does not retry transient failures after visible output has streamed", async () => {
		const run = createRunFixture(db);
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				return new PartialThenThrowAgent();
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(factoryCalls).toBe(1);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("failed");
		expect(db.listRunEvents(run.clientId, run.runId, 0).map((event) => event.type)).toEqual([
			"agent_start",
			"message_start",
		]);
		expect(diagnostics.events.map((event) => event.eventType)).not.toContain("agent.retry_scheduled");
	});

	it("does not retry assistant errors after non-replayable side effects and keeps attempt audit events", async () => {
		const run = createRunFixture(db);
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				return new SideEffectThenAssistantErrorAgent();
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(factoryCalls).toBe(1);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("failed");
		const events = db.listRunEvents(run.clientId, run.runId, 0);
		expect(events.map((event) => event.type)).toEqual(["tool_execution_started", "message_end", "agent_end"]);
		expect(JSON.stringify(events)).toContain("503 service unavailable");
		expect(db.listMessages(run.clientId, run.sessionId).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(diagnostics.events.map((event) => event.eventType)).not.toContain("agent.retry_scheduled");
	});

	it("fails assistant stopReason error without an error message before side effects", async () => {
		const run = createRunFixture(db);
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				return new StopReasonOnlyAssistantErrorAgent();
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(factoryCalls).toBe(1);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("failed");
		expect(JSON.stringify(db.listRunEvents(run.clientId, run.runId, 0))).not.toContain("assistant stopped with error");
		expect(diagnostics.events.map((event) => event.eventType)).toContain("agent.retry_exhausted");
	});

	it("does not retry assistant stopReason error without an error message after side effects", async () => {
		const run = createRunFixture(db);
		let factoryCalls = 0;
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			retry: { sleep: async () => {} },
			createAgent: () => {
				factoryCalls += 1;
				return new SideEffectThenStopReasonOnlyAssistantErrorAgent();
			},
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(factoryCalls).toBe(1);
		expect(db.getRun(run.clientId, run.runId)?.status).toBe("failed");
		const events = db.listRunEvents(run.clientId, run.runId, 0);
		expect(events.map((event) => event.type)).toEqual(["tool_execution_started", "message_end", "agent_end"]);
		expect(JSON.stringify(events)).toContain('"stopReason":"error"');
		expect(diagnostics.events.map((event) => event.eventType)).not.toContain("agent.retry_scheduled");
	});

	it("notifies the goal supervisor after a run reaches a terminal status", async () => {
		const run = createRunFixture(db);
		let notifiedRun: RuntimeRunRecord | undefined;
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			goalSupervisor: {
				afterRunTerminal(current) {
					notifiedRun = current;
				},
			},
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(notifiedRun).toEqual(
			expect.objectContaining({
				clientId: run.clientId,
				runId: run.runId,
			status: "completed",
		}),
	);
});

	it("notifies the goal supervisor before completing the queue claim", async () => {
		const run = createRunFixture(db);
		const order: string[] = [];
		const recordingQueue = new CompleteRecordingQueue(order);
		await recordingQueue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue: recordingQueue,
			workerId: "w1",
			goalSupervisor: {
				afterRunTerminal() {
					order.push("supervisor");
				},
			},
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(order).toEqual(["supervisor", "complete"]);
	});

	it("records goal supervisor failures without changing the completed run status", async () => {
		const run = createRunFixture(db);
		const diagnostics = new RecordingDiagnostics();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			diagnostics,
			goalSupervisor: {
				async afterRunTerminal() {
					throw new Error("preview goal supervisor unavailable");
				},
			},
			createAgent: () => new ScriptedAgent(),
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
		expect(diagnostics.events).toContainEqual(
			expect.objectContaining({
				eventType: "worker_goal_supervisor_failed",
				level: "error",
				category: "agent",
				data: expect.objectContaining({
					runId: run.runId,
					message: "preview goal supervisor unavailable",
				}),
			}),
		);
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

	it("continues when the transcript tail is a tool result message", async () => {
		const run = createRunFixture(db);
		const agent = new ScriptedAgent();
		db.appendMessage({
			clientId: run.clientId,
			sessionId: run.sessionId,
			role: "toolResult",
			payload: { content: "prior tool result", toolCallId: "tc1" },
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

	it("uses an internal follow-up prompt when a continuation run follows an assistant message", async () => {
		const run = createRunFixture(db);
		const agent = new ScriptedAgent();
		db.appendMessage({
			clientId: run.clientId,
			sessionId: run.sessionId,
			role: "assistant",
			payload: { content: "prior assistant response", stopReason: "length" },
		});
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			createAgent: () => agent,
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(agent.continueCalls).toBe(0);
		expect(agent.promptCalls).toBe(1);
		expect(agent.promptMessages[0]).toEqual(
			expect.objectContaining({
				role: "user",
				payload: expect.objectContaining({
					content: expect.stringContaining("Continue"),
					piInternal: { kind: "app_preview_continuation" },
				}),
			}),
		);
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

	it("does not write retry_exhausted when cancellation aborts retry sleep", async () => {
		const run = createRunFixture(db);
		const diagnostics = new RecordingDiagnostics();
		const sleepStarted = createDeferred<void>();
		const agent = new PreSideEffectAssistantErrorAgent();
		await queue.enqueue({ clientId: run.clientId, runId: run.runId });

		const worker = new WorkspaceRunWorkerService({
			db,
			queue,
			workerId: "w1",
			cancelPollIntervalMs: 1,
			diagnostics,
			retry: {
				sleep: (_ms, signal) =>
					new Promise<void>((resolve, reject) => {
						sleepStarted.resolve();
						if (signal?.aborted) {
							reject(new Error("Retry cancelled"));
							return;
						}
						signal?.addEventListener("abort", () => reject(new Error("Retry cancelled")), { once: true });
					}),
			},
			createAgent: () => agent,
		});

		const processing = worker.processOne();
		await sleepStarted.promise;
		await queue.requestCancel({ clientId: run.clientId, runId: run.runId });
		await expect(processing).resolves.toBe(true);

		expect(db.getRun(run.clientId, run.runId)?.status).toBe("cancelled");
		expect(
			diagnostics.events.filter((event) => event.eventType === "agent.retry_exhausted" && event.level === "error"),
		).toHaveLength(0);
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
	promptMessages: Array<RuntimeMessageRecord | RuntimeMessageRecord[]> = [];

	subscribe(listener: (event: WorkerAgentEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	async prompt(_message: RuntimeMessageRecord): Promise<void> {
		this.promptCalls += 1;
		this.promptMessages.push(_message);
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

class StreamingPauseAgent extends ScriptedAgent {
	private readonly finishDeferred = createDeferred<void>();
	private readonly streamStartDeferred = createDeferred<void>();

	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: assistant });
		this.streamStartDeferred.resolve();
		await this.finishDeferred.promise;
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}

	finish(): void {
		this.finishDeferred.resolve();
	}

	waitForStreamStart(): Promise<void> {
		return this.streamStartDeferred.promise;
	}
}

class PartialThenThrowAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: assistant });
		throw new Error("503 service unavailable");
	}
}

class PreSideEffectAssistantErrorAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant: JsonObject = {
			role: "assistant",
			content: "failed",
			errorMessage: "503 service unavailable",
			stopReason: "error",
			timestamp: 123,
		};
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}
}

class PromptEchoThenAssistantErrorAgent extends ScriptedAgent {
	override async prompt(message: RuntimeMessageRecord): Promise<void> {
		const assistant: JsonObject = {
			role: "assistant",
			content: "failed",
			errorMessage: "503 service unavailable",
			stopReason: "error",
			timestamp: 123,
		};
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [message, assistant] });
	}
}

class PromptEchoThenAssistantSuccessAgent extends ScriptedAgent {
	override async prompt(message: RuntimeMessageRecord): Promise<void> {
		const assistant = assistantMessage();
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
		this.emit({ type: "message_start", message: assistant });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [message, assistant] });
	}
}

class SideEffectThenAssistantErrorAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant: JsonObject = {
			role: "assistant",
			content: "failed",
			errorMessage: "503 service unavailable",
			stopReason: "error",
			timestamp: 123,
		};
		this.emit({ type: "tool_execution_started", toolCallId: "tc1", toolName: "write_file" });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}
}

class StopReasonOnlyAssistantErrorAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant: JsonObject = {
			role: "assistant",
			content: "failed",
			stopReason: "error",
			timestamp: 123,
		};
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
	}
}

class SideEffectThenStopReasonOnlyAssistantErrorAgent extends ScriptedAgent {
	override async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant: JsonObject = {
			role: "assistant",
			content: "failed",
			stopReason: "error",
			timestamp: 123,
		};
		this.emit({ type: "tool_execution_started", toolCallId: "tc1", toolName: "write_file" });
		this.emit({ type: "message_end", message: assistant });
		this.emit({ type: "agent_end", messages: [assistant] });
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

	async requeueActive(_workerId: string): Promise<number> {
		return 0;
	}

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

class CompleteRecordingQueue extends InMemoryRunQueue {
	constructor(private readonly order: string[]) {
		super();
	}

	override async complete(run: RunQueueItem | ClaimedRun, workerId: string): Promise<void> {
		this.order.push("complete");
		await super.complete(run, workerId);
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

function eventMessageRole(payload: JsonObject): string | undefined {
	const message = payload.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolveValue: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}
