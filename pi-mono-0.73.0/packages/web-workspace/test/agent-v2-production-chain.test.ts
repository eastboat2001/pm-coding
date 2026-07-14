import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { AGENT_V2_RESET_CONFIRMATION, resetAgentV2RuntimeData } from "../src/agent-v2-reset.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { InMemoryAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2RunQueue, AgentV2RunQueueIdentity } from "../src/agent-v2-run-queue.js";
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

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-production-chain-"));
		const config = { ...loadStorageConfig(dir), loggingEnabled: true, logStdoutEnabled: false };
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

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
}
