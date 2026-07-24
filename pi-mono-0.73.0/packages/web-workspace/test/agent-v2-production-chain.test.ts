import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
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
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb });
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
		const completedRun = await api.getRun(CLIENT_ID, "run-production-chain");
		if (!completedRun) throw new Error("Expected the production chain run to exist.");
		expect(completedRun.error).toBeUndefined();
		expect(completedRun).toMatchObject({
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
					content: "<!doctype html><script>throw new Error('startup failed')</script>",
				}),
			],
			diagnostics: [
				expect.objectContaining({
					code: "agent_v2.validation_failed",
					data: expect.objectContaining({ failureCodes: ["static.script_error"] }),
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

		const replayed = await eventLog.list(CLIENT_ID, "run-production-chain", 0);
		const eventTypes = replayed.map((event) => event.type);
		expect(eventTypes).toEqual(
			expect.arrayContaining([
				"agent_v2.run_created",
				"agent_v2.planning_ready",
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

	it.each([
		{
			id: "interactive-demo",
			title: "Interactive Demo",
			objective: "Build a small interactive counter demo",
			marker: "demo-counter",
			html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Counter Demo</title></head><body><main id="demo-counter"><h1>Counter Demo</h1><output id="value">0</output><button id="increment" type="button">Increment</button></main><script>const value=document.querySelector('#value');document.querySelector('#increment').addEventListener('click',()=>{value.textContent=String(Number(value.textContent)+1)});</script></body></html>`,
		},
		{
			id: "visualization",
			title: "Visualization",
			objective: "Build a responsive sales visualization",
			marker: "sales-chart",
			html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sales Visualization</title><style>body{font-family:sans-serif;margin:2rem;background:#f6f8fb}svg{max-width:100%;background:white;border-radius:16px}rect{fill:#6366f1}</style></head><body><main id="sales-chart"><h1>Quarterly Sales</h1><svg viewBox="0 0 640 320" role="img" aria-label="Quarterly sales bar chart"><rect x="70" y="180" width="80" height="100"/><rect x="210" y="120" width="80" height="160"/><rect x="350" y="70" width="80" height="210"/><rect x="490" y="30" width="80" height="250"/></svg></main></body></html>`,
		},
		{
			id: "dashboard",
			title: "Operations Dashboard",
			objective: "Build an operations dashboard with KPIs and a filterable table",
			marker: "operations-dashboard",
			html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations Dashboard</title><style>body{font-family:sans-serif;margin:0;background:#f3f4f6;color:#111827}main{padding:24px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card,table{background:white;border-radius:12px;padding:16px}table{width:100%;margin-top:20px}td,th{text-align:left;padding:10px}@media(max-width:640px){.cards{grid-template-columns:1fr}}</style></head><body><main id="operations-dashboard"><h1>Operations Dashboard</h1><label>Filter orders <input id="filter" type="search"></label><section class="cards"><article class="card"><strong>Revenue</strong><p>$84,200</p></article><article class="card"><strong>Orders</strong><p>1,284</p></article><article class="card"><strong>On-time</strong><p>96.8%</p></article></section><table><thead><tr><th>Order</th><th>Status</th></tr></thead><tbody><tr><td>Northwind</td><td>Ready</td></tr><tr><td>Contoso</td><td>Review</td></tr></tbody></table></main><script>const input=document.querySelector('#filter');const rows=[...document.querySelectorAll('tbody tr')];input.addEventListener('input',()=>{const query=input.value.toLowerCase();for(const row of rows)row.hidden=!row.textContent.toLowerCase().includes(query)});</script></body></html>`,
		},
		{
			id: "canvas-game",
			title: "Canvas Game",
			objective: "Build a small Canvas snake game demo",
			marker: "snake-game",
			html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>贪吃蛇</title><style>body{font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:white}canvas{background:#111827;border:2px solid #34d399;border-radius:16px}</style></head><body><main id="snake-game"><h1>贪吃蛇</h1><canvas id="board" width="480" height="320"></canvas><p>使用方向键移动</p></main><script>const canvas=document.querySelector('#board');const ctx=canvas.getContext('2d');ctx.fillStyle='#34d399';ctx.beginPath();ctx.moveTo(48,40);ctx.arcTo(72,40,72,64,10);ctx.quadraticCurveTo(72,72,64,72);ctx.lineTo(48,72);ctx.closePath();ctx.fill();ctx.fillStyle='#f43f5e';ctx.beginPath();ctx.arc(320,160,9,0,Math.PI*2);ctx.fill();</script></body></html>`,
		},
	])("generates and delivers the $id project through the full worker chain", async (fixture) => {
		const runId = `run-generation-${fixture.id}`;
		const sessionId = `session-generation-${fixture.id}`;
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb });
		const queue = new LocalAgentV2RunQueue();
		const model = new MatrixModelExecution(fixture.html);
		const api = new AgentV2RunApiService({
			store: runtimeDb,
			events: eventLog,
			queueName: `agent-v2-generation-${fixture.id}`,
			createRunId: () => runId,
			now: timestampSequence("2026-07-09T01:00:00.000Z", "2026-07-09T01:00:01.000Z"),
		});
		const worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events: eventLog,
			execution: new ProductionExecution(config, runtimeDb, new DurableAgentV2InputMaterializer(runtimeDb), model),
			workerId: `worker-generation-${fixture.id}`,
			now: timestampSequence("2026-07-09T01:00:02.000Z", "2026-07-09T01:00:03.000Z"),
		});

		await api.startRun(CLIENT_ID, {
			input: { objective: fixture.objective, sessionId, title: fixture.title },
			model: { provider: "test", id: "v2-test-model" },
		});
		await deliverPendingRunEnqueue(runtimeDb, queue, "2026-07-09T01:00:01.500Z");
		await expect(worker.processOne()).resolves.toBe(true);

		const completedRun = await api.getRun(CLIENT_ID, runId);
		if (!completedRun) throw new Error(`Expected ${runId} to exist.`);
		expect(completedRun.error).toBeUndefined();
		expect(completedRun).toMatchObject({ status: "succeeded", phase: "delivery" });
		const generated = createAgentV2FileAdapter({
			config,
			context: { clientId: CLIENT_ID, sessionId, title: fixture.title },
		}).readFile("index.html");
		expect(generated.truncated).toBe(false);
		expect(generated.content).toContain(fixture.marker);
		expect(runtimeDb.listAgentV2Validations(CLIENT_ID, runId)).toEqual([
			expect.objectContaining({ status: "passed", attempt: 1 }),
		]);
		expect((await eventLog.list(CLIENT_ID, runId, 0)).map((event) => event.type)).toContain(
			"agent_v2.delivery_reported",
		);
		expect(model.repairCalls).toBe(0);
	});

	it("records a sanitized non-retryable worker diagnostic and never calls the model when materialization fails", async () => {
		const sentinel = "RAW_DURABLE_STORE_SECRET_SENTINEL";
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb });
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
			message: "Agent v2 worker recorded a durable terminal failure.",
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
	async requestCancel(run: AgentV2RunQueueIdentity, cancelToken: string): Promise<"requested"> {
		this.cancelKeys.add(`${run.clientId}:${run.runId}`);
		void cancelToken;
		return "requested";
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
				files: [
					{ path: "index.html", content: "<!doctype html><script>throw new Error('startup failed')</script>" },
				],
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

class MatrixModelExecution implements AgentV2ModelExecution {
	repairCalls = 0;

	constructor(private readonly html: string) {}

	async generateImplementation(input: AgentV2ModelExecutionInput) {
		return {
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "Generated a validated static application.",
				files: [{ path: "index.html", content: this.html }],
			},
			provider: "test",
			model: "v2-test-model",
		};
	}

	async generateRepair(_input: AgentV2RepairModelExecutionInput): Promise<never> {
		this.repairCalls += 1;
		throw new Error("Generation matrix fixtures must pass validation without repair.");
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
			previewReadinessChecker: {
				check: async () => ({ verified: true, ready: true, reasonCode: "ready" as const }),
			},
			signal: input.signal,
		});
	}
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
}
