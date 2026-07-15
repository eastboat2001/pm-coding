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
import type {
	AgentV2ModelExecution,
	AgentV2ModelExecutionInput,
	AgentV2RepairModelExecutionInput,
} from "../src/agent-v2-model-execution.js";
import { AGENT_V2_RESET_CONFIRMATION, resetAgentV2RuntimeData } from "../src/agent-v2-reset.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { InMemoryAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { parseAgentV2RunContext } from "../src/agent-v2-run-input-contract.js";
import type { AgentV2ClaimedRun, AgentV2RunQueue, AgentV2RunQueueIdentity } from "../src/agent-v2-run-queue.js";
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

	it("crosses the durable production v2 chain through repair, replay, export, and reset", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb, bus });
		const queue = new LocalAgentV2RunQueue();
		let failedAttemptBeforeRepair: ReturnType<RuntimeDbStore["listAgentV2Validations"]>[number] | undefined;
		const model = new RecordingModelExecution(() => {
			failedAttemptBeforeRepair = structuredClone(
				runtimeDb.listAgentV2Validations(CLIENT_ID, "run-production-chain")[0],
			);
		});
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
			execution: new ProductionExecution(config, runtimeDb, new DurableAgentV2InputMaterializer(runtimeDb), model),
			workerId: "worker-production-chain",
			now: timestampSequence("2026-07-09T00:00:02.000Z", "2026-07-09T00:00:03.000Z"),
		});
		const image = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		).toString("base64");

		const run = await api.startRun(CLIENT_ID, {
			input: {
				objective: "Build only from committed durable inputs",
				sessionId: "session-production",
				title: "Production Chain",
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
		expect(run).toMatchObject({ runId: "run-production-chain", status: "queued", phase: "implementation" });
		await deliverPendingRunEnqueue(runtimeDb, queue, "2026-07-09T00:00:01.500Z");

		await expect(worker.processOne()).resolves.toBe(true);
		expect(await api.getRun(CLIENT_ID, "run-production-chain")).toMatchObject({
			status: "succeeded",
			phase: "delivery",
			workerId: "worker-production-chain",
		});
		expect(model.implementationCalls).toHaveLength(1);
		expect(model.implementationCalls[0]).toMatchObject({
			run: { input: { objective: "Build only from committed durable inputs" } },
			task: { taskId: "implement", kind: "implementation" },
			inputs: [
				{ kind: "text", reference: { kind: "project_file", logicalPath: "src/note.txt" }, text: "committed text" },
				{
					kind: "image",
					reference: { kind: "attachment", logicalPath: "assets/logo.png" },
					mediaType: "image/png",
				},
			],
		});
		expect(model.repairCalls).toHaveLength(1);
		expect(model.repairCalls[0]).toMatchObject({
			task: { taskId: "repair:validate:1", kind: "repair" },
			inputs: model.implementationCalls[0]?.inputs,
			workspaceFiles: [
				expect.objectContaining({
					path: "index.html",
					content: '<!doctype html><div id="loading">Loading...</div>',
				}),
			],
			diagnostics: [
				expect.objectContaining({
					code: "agent_v2.validation_failed",
					data: expect.objectContaining({ failureCodes: ["static.loading_visible"] }),
				}),
			],
		});

		const tasks = runtimeDb.listAgentV2Tasks(CLIENT_ID, "run-production-chain");
		expect(tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "implement", status: "succeeded" }),
				expect.objectContaining({ taskId: "validate", status: "succeeded" }),
				expect.objectContaining({ taskId: "repair:validate:1", status: "succeeded", dependsOn: ["validate"] }),
				expect.objectContaining({
					taskId: "revalidate:validate:2",
					status: "succeeded",
					dependsOn: ["repair:validate:1"],
				}),
				expect.objectContaining({
					taskId: "deliver",
					status: "succeeded",
					dependsOn: ["revalidate:validate:2"],
				}),
			]),
		);
		const validations = runtimeDb.listAgentV2Validations(CLIENT_ID, "run-production-chain");
		expect(validations).toEqual([
			expect.objectContaining({ validationId: "static:validate", attempt: 1, taskId: "validate", status: "failed" }),
			expect.objectContaining({
				validationId: "static:validate",
				attempt: 2,
				taskId: "revalidate:validate:2",
				status: "passed",
			}),
		]);
		expect(validations[0]).toEqual(failedAttemptBeforeRepair);
		expect(runtimeDb.listAgentV2Artifacts(CLIENT_ID, "run-production-chain")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "index.html",
					sourceTaskId: "repair:validate:1",
					validationStatus: "passed",
				}),
			]),
		);
		expect(runtimeDb.listAgentV2Diagnostics(CLIENT_ID, "run-production-chain")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					diagnosticId: "agent_v2.validation_failed:validate:1",
					code: "agent_v2.validation_failed",
				}),
			]),
		);

		const replayed = await eventLog.readLive({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			afterSeq: 0,
			blockMs: 1,
		});
		const eventTypes = replayed.map((event) => event.type);
		expect(eventTypes).toEqual(
			expect.arrayContaining([
				"run_created",
				"planning_ready",
				"agent_v2.task_updated",
				"agent_v2.artifact_indexed",
				"agent_v2.validation_recorded",
				"agent_v2.diagnostic_recorded",
				"agent_v2.output_recorded",
				"agent_v2.phase_changed",
			]),
		);
		const artifactRevisions = replayed
			.filter((event) => event.type === "agent_v2.artifact_indexed" && event.payload.path === "index.html")
			.map((event) => event.payload.revision);
		expect(new Set(artifactRevisions).size).toBeGreaterThanOrEqual(2);
		const pendingOutbox = runtimeDb.leaseAgentV2Outbox({
			ownerId: "production-chain-test-audit",
			kinds: ["live_event", "workspace_diagnostic", "langfuse_diagnostic"],
			limit: 100,
			now: "2026-07-10T00:00:00.000Z",
			leaseTtlMs: 1_000,
		});
		expect(pendingOutbox.map((intent) => intent.reference.kind)).toEqual(
			expect.arrayContaining(["live_event", "workspace_diagnostic", "langfuse_diagnostic"]),
		);
		expect(JSON.stringify({ tasks, validations, replayed, pendingOutbox })).not.toContain(
			"RAW_MODEL_SUMMARY_MUST_NOT_PERSIST",
		);

		const exported = await new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions).export({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			includeSettings: false,
		});
		expect(exported.runtime.runs).toHaveLength(1);
		const exportedRunEvents = exported.runtime.runEventsByRunId as Record<string, unknown[]>;
		expect(exportedRunEvents["run-production-chain"]).toHaveLength(replayed.length);

		const reset = await resetAgentV2RuntimeData(runtimeDb, {
			confirmation: AGENT_V2_RESET_CONFIRMATION,
			includeDiagnostics: true,
		});
		expect(reset.runsDeleted).toBe(1);
		expect(await api.listRuns(CLIENT_ID)).toEqual([]);
		expect(await eventLog.list(CLIENT_ID, "run-production-chain", 0)).toEqual([]);
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
		expect(model.implementationCalls).toHaveLength(0);
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
	private claimSequence = 0;

	async enqueue(run: AgentV2RunQueueIdentity): Promise<"enqueued"> {
		this.queued.push(run);
		return "enqueued";
	}

	async claim(workerId: string): Promise<AgentV2ClaimedRun | undefined> {
		const run = this.queued.shift();
		if (!run) return undefined;
		this.claimSequence += 1;
		return { ...run, workerId, claimToken: `local-${this.claimSequence}`, leaseExpiresAtMs: Date.now() + 30_000 };
	}

	async complete(): Promise<boolean> {
		return true;
	}
	async confirmOwnership(): Promise<"owned"> {
		return "owned";
	}
	async requeueActive(): Promise<number> {
		return 0;
	}
	async renewLease(claim: AgentV2ClaimedRun) {
		return { status: "renewed" as const, leaseExpiresAtMs: claim.leaseExpiresAtMs + 30_000 };
	}
	async requeueExpiredClaims(): Promise<[]> {
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

class RecordingModelExecution {
	readonly implementationCalls: AgentV2ModelExecutionInput[] = [];
	readonly repairCalls: AgentV2RepairModelExecutionInput[] = [];

	constructor(private readonly beforeRepair?: () => void) {}

	async generateImplementation(input: AgentV2ModelExecutionInput) {
		this.implementationCalls.push(input);
		return {
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "RAW_MODEL_SUMMARY_MUST_NOT_PERSIST",
				files: [{ path: "index.html", content: '<!doctype html><div id="loading">Loading...</div>' }],
			},
			provider: "test",
			model: "v2-test-model",
		};
	}

	async generateRepair(input: AgentV2RepairModelExecutionInput) {
		this.repairCalls.push(input);
		this.beforeRepair?.();
		return {
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "RAW_MODEL_SUMMARY_MUST_NOT_PERSIST",
				files: [{ path: "index.html", content: "<!doctype html><main>Ready</main>" }],
				addressedDiagnosticIds: input.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
			},
			provider: "test",
			model: "v2-test-model",
		};
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
