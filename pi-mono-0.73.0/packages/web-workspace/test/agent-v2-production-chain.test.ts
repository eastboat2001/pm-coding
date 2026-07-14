import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import {
	AgentV2InputMaterializationError,
	type AgentV2InputMaterializer,
	type AgentV2InputMaterializerStore,
	DurableAgentV2InputMaterializer,
} from "../src/agent-v2-input-materializer.js";
import type { AgentV2ModelExecution, AgentV2ModelExecutionInput } from "../src/agent-v2-model-execution.js";
import { AGENT_V2_RESET_CONFIRMATION, resetAgentV2RuntimeData } from "../src/agent-v2-reset.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { InMemoryAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { parseAgentV2RunContext } from "../src/agent-v2-run-input-contract.js";
import type { AgentV2RunQueue, AgentV2RunQueueIdentity } from "../src/agent-v2-run-queue.js";
import type { AgentV2WorkerExecutionInput } from "../src/agent-v2-worker-service.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticExportService } from "../src/diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("agent v2 production chain rehearsal", () => {
	let dir: string;
	let diagnostics: WorkspaceDiagnosticLogService;
	let runtimeDb: RuntimeDbStore;
	let sessions: WorkspaceSessionService;
	let config: ReturnType<typeof loadStorageConfig>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-production-chain-"));
		config = { ...loadStorageConfig(dir), loggingEnabled: true, logStdoutEnabled: false };
		runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
		runtimeDb.ensureAgentV2Schema();
		diagnostics = new WorkspaceDiagnosticLogService(config);
		sessions = new WorkspaceSessionService(config);
		sessions.ensureDirs();
	});

	afterEach(() => {
		diagnostics.close();
		runtimeDb.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts, executes, replays, exports, and resets a v2 run without legacy state", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb, bus });
		const queue = new LocalAgentV2RunQueue();
		const api = new AgentV2RunApiService({
			store: runtimeDb,
			events: eventLog,
			queueName: "agent-v2-production-chain",
			createRunId: () => "run-production-chain",
			now: timestampSequence("2026-07-09T00:00:00.000Z", "2026-07-09T00:00:01.000Z"),
		});
		const worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events: eventLog,
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-production-chain",
			now: timestampSequence("2026-07-09T00:00:02.000Z", "2026-07-09T00:00:03.000Z"),
		});

		const run = await api.startRun(CLIENT_ID, {
			input: {
				objective: "Build a reliable v2 app",
				sessionId: "session-production",
				title: "Production Chain",
				projectFiles: [],
				attachments: [],
			},
			model: { provider: "test", id: "v2-test-model" },
		});
		expect(run).toMatchObject({ runId: "run-production-chain", status: "queued", phase: "implementation" });
		await deliverPendingRunEnqueue(runtimeDb, queue, "2026-07-09T00:00:01.500Z");

		await expect(worker.processOne()).resolves.toBe(true);
		expect(await api.getRun(CLIENT_ID, "run-production-chain")).toMatchObject({
			status: "succeeded",
			phase: "delivery",
			workerId: "worker-production-chain",
		});

		const replayed = await eventLog.readLive({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			afterSeq: 0,
			blockMs: 1,
		});
		expect(replayed.map((event) => event.type)).toEqual([
			"run_created",
			"planning_ready",
			"agent_v2.phase_changed",
			"agent_v2.phase_changed",
		]);

		const exported = await new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions).export({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			includeSettings: false,
		});
		expect(exported.runtime.runs).toHaveLength(1);
		const exportedRunEvents = exported.runtime.runEventsByRunId as Record<string, unknown[]>;
		expect(exportedRunEvents["run-production-chain"]).toHaveLength(4);

		const reset = await resetAgentV2RuntimeData(runtimeDb, {
			confirmation: AGENT_V2_RESET_CONFIRMATION,
			includeDiagnostics: true,
		});
		expect(reset.runsDeleted).toBe(1);
		expect(await api.listRuns(CLIENT_ID)).toEqual([]);
		expect(await eventLog.list(CLIENT_ID, "run-production-chain", 0)).toEqual([]);
	});

	it("materializes committed objective, project text, and image attachment before the model seam", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb, bus });
		const queue = new LocalAgentV2RunQueue();
		const api = new AgentV2RunApiService({
			store: runtimeDb,
			events: eventLog,
			queueName: "agent-v2-materialized-chain",
			createRunId: () => "run-materialized-chain",
			now: timestampSequence("2026-07-09T01:00:00.000Z", "2026-07-09T01:00:01.000Z"),
		});
		const model = new RecordingModelExecution();
		const worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events: eventLog,
			execution: new ProductionExecution(config, runtimeDb, new DurableAgentV2InputMaterializer(runtimeDb), model),
			workerId: "worker-materialized-chain",
			now: timestampSequence("2026-07-09T01:00:02.000Z", "2026-07-09T01:00:03.000Z"),
		});
		const image = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		).toString("base64");

		await api.startRun(CLIENT_ID, {
			input: {
				objective: "Build only from committed durable inputs",
				sessionId: "session-materialized",
				title: "Materialized Chain",
				projectFiles: [
					{ filename: "src/note.txt", content: "committed text" },
					{ filename: "assets/logo.png", content: image, encoding: "base64" },
				],
				attachments: [
					{ type: "image", fileName: "logo.png", mimeType: "image/png", projectFilePath: "assets/logo.png" },
				],
			},
			model: { provider: "test", id: "v2-test-model" },
		});
		await deliverPendingRunEnqueue(runtimeDb, queue, "2026-07-09T01:00:01.500Z");

		await expect(worker.processOne()).resolves.toBe(true);
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0]?.run.input.objective).toBe("Build only from committed durable inputs");
		expect(model.calls[0]?.inputs).toMatchObject([
			{ kind: "text", reference: { kind: "project_file", logicalPath: "src/note.txt" }, text: "committed text" },
			{ kind: "image", reference: { kind: "attachment", logicalPath: "assets/logo.png" }, mediaType: "image/png" },
		]);
		expect(await api.getRun(CLIENT_ID, "run-materialized-chain")).toMatchObject({ status: "succeeded" });
		expect(runtimeDb.listAgentV2Artifacts(CLIENT_ID, "run-materialized-chain")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "index.html", sourceTaskId: "implement", validationStatus: "passed" }),
			]),
		);
		expect(runtimeDb.listAgentV2RunEvents(CLIENT_ID, "run-materialized-chain", 0).map((event) => event.type)).toEqual(
			expect.arrayContaining(["agent_v2.task_updated", "agent_v2.artifact_indexed", "agent_v2.output_recorded"]),
		);
	});

	it("records a sanitized non-retryable worker diagnostic and never calls the model when materialization fails", async () => {
		const sentinel = "RAW_DURABLE_STORE_SECRET_SENTINEL";
		const bus = new InMemoryAgentV2RunEventBus();
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb, bus });
		const queue = new LocalAgentV2RunQueue();
		const api = new AgentV2RunApiService({
			store: runtimeDb,
			events: eventLog,
			queueName: "agent-v2-rejected-input-chain",
			createRunId: () => "run-rejected-input-chain",
			now: timestampSequence("2026-07-09T02:00:00.000Z", "2026-07-09T02:00:01.000Z"),
		});
		const model = new RecordingModelExecution();
		const forged = new AgentV2InputMaterializationError("authorization_mismatch");
		Object.defineProperties(forged, {
			message: { configurable: true, get: () => sentinel },
			stack: { configurable: true, get: () => `${sentinel}_STACK` },
			code: { configurable: true, enumerable: true, get: () => `${sentinel}_CODE` },
		});
		const rejectingStore: AgentV2InputMaterializerStore = {
			listAgentV2InputReferences: (clientId, runId) => runtimeDb.listAgentV2InputReferences(clientId, runId),
			readAgentV2InputBlob: async () => {
				throw forged;
			},
		};
		const worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events: eventLog,
			execution: new ProductionExecution(
				config,
				runtimeDb,
				new DurableAgentV2InputMaterializer(rejectingStore),
				model,
			),
			workerId: "worker-rejected-input-chain",
			now: timestampSequence("2026-07-09T02:00:02.000Z", "2026-07-09T02:00:03.000Z"),
		});

		await api.startRun(CLIENT_ID, {
			input: {
				objective: "Reject changed durable input",
				sessionId: "session-rejected",
				title: "Rejected Input Chain",
				projectFiles: [{ filename: "src/note.txt", content: "committed text" }],
				attachments: [],
			},
			model: { provider: "test", id: "v2-test-model" },
		});
		await deliverPendingRunEnqueue(runtimeDb, queue, "2026-07-09T02:00:01.500Z");

		await expect(worker.processOne()).resolves.toBe(true);
		expect(model.calls).toHaveLength(0);
		const failed = await api.getRun(CLIENT_ID, "run-rejected-input-chain");
		expect(failed).toMatchObject({
			status: "failed",
			error: {
				code: "agent_v2.worker_execution_failed",
				message: "Agent v2 committed input store operation failed.",
				retryable: false,
			},
		});
		const storedDiagnostics = runtimeDb.listAgentV2Diagnostics(CLIENT_ID, "run-rejected-input-chain");
		const workerDiagnostics = storedDiagnostics.filter(
			(diagnostic) => diagnostic.code === "agent_v2.worker_execution_failed",
		);
		expect(workerDiagnostics).toHaveLength(1);
		expect(workerDiagnostics[0]).toMatchObject({
			code: "agent_v2.worker_execution_failed",
			message: "Agent v2 committed input store operation failed.",
		});
		expect(JSON.stringify({ failed, storedDiagnostics })).not.toContain(sentinel);
	});
});

async function deliverPendingRunEnqueue(
	store: RuntimeDbStore,
	queue: LocalAgentV2RunQueue,
	now: string,
): Promise<void> {
	const intents = store.leaseAgentV2Outbox({
		ownerId: "production-chain-test-dispatcher",
		kinds: ["run_enqueue"],
		limit: 1,
		now,
		leaseTtlMs: 1_000,
	});
	for (const intent of intents) {
		await queue.enqueue({ clientId: intent.clientId, runId: intent.runId });
		store.markAgentV2OutboxDelivered({
			intentId: intent.intentId,
			ownerId: "production-chain-test-dispatcher",
			leaseAttempt: intent.attemptCount,
			deliveredAt: now,
		});
	}
}

class LocalAgentV2RunQueue implements AgentV2RunQueue {
	private readonly queued: AgentV2RunQueueIdentity[] = [];
	private readonly cancelKeys = new Set<string>();

	async enqueue(run: AgentV2RunQueueIdentity): Promise<void> {
		this.queued.push(run);
	}

	async claim(): Promise<AgentV2RunQueueIdentity | undefined> {
		return this.queued.shift();
	}

	async complete(): Promise<void> {}
	async requeueActive(): Promise<number> {
		return 0;
	}
	async renewLease(): Promise<boolean> {
		return true;
	}
	async releaseExpiredClaims(): Promise<[]> {
		return [];
	}
	async requestCancel(run: AgentV2RunQueueIdentity): Promise<void> {
		this.cancelKeys.add(`${run.clientId}:${run.runId}`);
	}
	async isCancelRequested(run: AgentV2RunQueueIdentity): Promise<boolean> {
		return this.cancelKeys.has(`${run.clientId}:${run.runId}`);
	}
	async clear(): Promise<{ queueItemsDeleted: number; activeClaimsDeleted: number; cancelKeysDeleted: number }> {
		const queueItemsDeleted = this.queued.length;
		const cancelKeysDeleted = this.cancelKeys.size;
		this.queued.length = 0;
		this.cancelKeys.clear();
		return { queueItemsDeleted, activeClaimsDeleted: 0, cancelKeysDeleted };
	}
	async close(): Promise<void> {}
}

class SequencedExecution {
	private index = 0;
	constructor(private readonly steps: AgentV2ExecutionStepResult[]) {}
	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		return this.steps[this.index++] ?? { status: "complete", diagnosticIds: [] };
	}
}

class RecordingModelExecution {
	readonly calls: AgentV2ModelExecutionInput[] = [];

	async generateImplementation(input: AgentV2ModelExecutionInput) {
		this.calls.push(input);
		return {
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "recorded",
				files: [{ path: "index.html", content: "<!doctype html><main>Production v2 chain</main>\n" }],
			},
			provider: "test",
			model: "v2-test-model",
		};
	}

	async generateRepair(): Promise<never> {
		throw new Error("Repair is outside this Task 6 fixture.");
	}
}

class ProductionExecution {
	constructor(
		private readonly config: ReturnType<typeof loadStorageConfig>,
		private readonly store: RuntimeDbStore,
		private readonly materializer: AgentV2InputMaterializer,
		private readonly model: AgentV2ModelExecution,
	) {}

	async executeNextTask(input: AgentV2WorkerExecutionInput): Promise<AgentV2ExecutionStepResult> {
		return await executeAgentV2NextTask({
			store: this.store,
			config: this.config,
			context: { clientId: input.run.clientId, ...parseAgentV2RunContext(input.run.input) },
			runId: input.run.runId,
			materializer: this.materializer,
			modelExecution: this.model,
			signal: input.signal,
		});
	}
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
}
