import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { createAgentV2RunQueue, type AgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { InMemoryRunQueue } from "../src/run-queue.js";
import type {
	AppendAgentV2RunEventInput,
	AgentV2RunEventRecord,
	AgentV2RunUpdateResult,
	CreateAgentV2RunInput,
	UpdateAgentV2RunInput,
} from "../src/agent-v2-store.js";
import type { AgentV2Phase, AgentV2RunSnapshot } from "../src/agent-v2-types.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("AgentV2RunApiService", () => {
	afterEach(async () => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("startRun creates a queued v2 run, enqueues the client/run identity, and emits run_created", async () => {
		const { store } = createSqliteStore();
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const events = new RecordingEventLog();
		const service = new AgentV2RunApiService({
			store,
			queue,
			events,
			createRunId: () => "run-start",
		});

		const run = await service.startRun("client-a", {
			input: { prompt: "Build the gateway" },
			model: { provider: "test", id: "local" },
			createdAt: "2026-07-08T09:00:00.000Z",
		});

		expect(run).toMatchObject({
			clientId: "client-a",
			runId: "run-start",
			status: "queued",
			phase: "intake",
			attempt: 1,
		});
		expect(store.getAgentV2Run("client-a", "run-start")).toMatchObject({
			clientId: "client-a",
			runId: "run-start",
			status: "queued",
			phase: "intake",
		});
		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "run-start" });
		expect(events.appendCalls).toEqual([
			{
				clientId: "client-a",
				runId: "run-start",
				type: "agent_v2.run_created",
				payload: {
					type: "agent_v2.run_created",
					status: "queued",
					phase: "intake",
					attempt: 1,
					at: "2026-07-08T09:00:00.000Z",
				},
				createdAt: "2026-07-08T09:00:00.000Z",
			},
		]);
	});

	it("cancelRun on a queued run requests queue cancellation, marks the run cancelled, and emits a phase/status event", async () => {
		const { store } = createSqliteStore();
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const events = new RecordingEventLog();
		const service = new AgentV2RunApiService({
			store,
			queue,
			events,
			now: () => "2026-07-08T09:10:00.000Z",
		});

		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-queued",
			input: { prompt: "Queue then cancel" },
			model: { provider: "test" },
			createdAt: "2026-07-08T09:00:00.000Z",
		});
		await queue.enqueue({ clientId: "client-a", runId: "run-queued" });

		const cancelled = await service.cancelRun("client-a", "run-queued");

		expect(cancelled).toMatchObject({
			clientId: "client-a",
			runId: "run-queued",
			status: "cancelled",
			phase: "cancelled",
			updatedAt: "2026-07-08T09:10:00.000Z",
			endedAt: "2026-07-08T09:10:00.000Z",
		});
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: "run-queued" })).resolves.toBe(true);
		expect(events.appendCalls).toContainEqual({
			clientId: "client-a",
			runId: "run-queued",
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: "cancelled",
				status: "cancelled",
				attempt: 1,
				at: "2026-07-08T09:10:00.000Z",
			},
			createdAt: "2026-07-08T09:10:00.000Z",
		});
	});

	it("cancelRun does not emit a phase event when queued cancellation loses the status guard", async () => {
		const queued: AgentV2RunSnapshot = {
			clientId: "client-a",
			runId: "run-queued-cas-miss",
			status: "queued",
			phase: "intake",
			attempt: 1,
			input: { prompt: "Queue then lose cancel race" },
			model: { provider: "test" },
			createdAt: "2026-07-08T09:00:00.000Z",
			updatedAt: "2026-07-08T09:00:00.000Z",
		};
		const store = new GuardedStore([queued]);
		store.runBeforeNextUpdate(() => {
			store.forceRun({
				...queued,
				status: "cancelled",
				phase: "cancelled",
				updatedAt: "2026-07-08T09:10:00.000Z",
				endedAt: "2026-07-08T09:10:00.000Z",
			});
		});
		const events = new RecordingEventLog();
		const service = new AgentV2RunApiService({
			store,
			queue: new NoopQueue(),
			events,
			now: () => "2026-07-08T09:10:00.000Z",
		});

		const result = await service.cancelRun("client-a", "run-queued-cas-miss");

		expect(result).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			updatedAt: "2026-07-08T09:10:00.000Z",
			endedAt: "2026-07-08T09:10:00.000Z",
		});
		expect(events.appendCalls).toEqual([]);
	});

	it("cancelRun on a running run marks cancellation requested without reading legacy run state", async () => {
		const { store } = createSqliteStore();
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const events = new RecordingEventLog();
		const service = new AgentV2RunApiService({
			store,
			queue,
			events,
			now: () => "2026-07-08T09:15:00.000Z",
		});

		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-running",
			input: { prompt: "Running cancel" },
			model: { provider: "test" },
			createdAt: "2026-07-08T09:00:00.000Z",
		});
		store.updateAgentV2Run({
			clientId: "client-a",
			runId: "run-running",
			status: "running",
			phase: "implementation",
			workerId: "worker-a",
			startedAt: "2026-07-08T09:01:00.000Z",
			updatedAt: "2026-07-08T09:01:00.000Z",
		});
		await queue.enqueue({ clientId: "client-a", runId: "run-running" });

		const cancelling = await service.cancelRun("client-a", "run-running");

		expect(cancelling).toMatchObject({
			clientId: "client-a",
			runId: "run-running",
			status: "cancelling",
			phase: "implementation",
			workerId: "worker-a",
			updatedAt: "2026-07-08T09:15:00.000Z",
		});
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: "run-running" })).resolves.toBe(true);
		expect(events.appendCalls).toContainEqual({
			clientId: "client-a",
			runId: "run-running",
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: "implementation",
				status: "cancelling",
				attempt: 1,
				at: "2026-07-08T09:15:00.000Z",
			},
			createdAt: "2026-07-08T09:15:00.000Z",
		});
	});

	it("getRun and listRuns read only the v2 run store surface", async () => {
		const store = new GuardedStore([
			{
				clientId: "client-a",
				runId: "run-a",
				status: "queued",
				phase: "intake",
				attempt: 1,
				input: { prompt: "Client A" },
				model: { provider: "test" },
				createdAt: "2026-07-08T10:00:00.000Z",
				updatedAt: "2026-07-08T10:00:00.000Z",
			},
			{
				clientId: "client-b",
				runId: "run-b",
				status: "running",
				phase: "implementation",
				attempt: 2,
				input: { prompt: "Client B" },
				model: { provider: "test" },
				createdAt: "2026-07-08T10:05:00.000Z",
				updatedAt: "2026-07-08T10:06:00.000Z",
				startedAt: "2026-07-08T10:05:30.000Z",
			},
		]);
		const service = new AgentV2RunApiService({
			store,
			queue: new NoopQueue(),
			events: new RecordingEventLog(),
		});

		await expect(service.getRun("client-a", "run-a")).resolves.toMatchObject({ runId: "run-a", clientId: "client-a" });
		await expect(service.getRun("client-a", "run-b")).resolves.toBeUndefined();
		await expect(service.listRuns("client-a")).resolves.toEqual([
			expect.objectContaining({ clientId: "client-a", runId: "run-a" }),
		]);

		expect(store.calls).toEqual({
			getAgentV2Run: [
				{ clientId: "client-a", runId: "run-a" },
				{ clientId: "client-a", runId: "run-b" },
			],
			listAgentV2Runs: ["client-a"],
		});
	});

	it("lists run events through the v2 event log", async () => {
		const events = new RecordingEventLog([
			{
				clientId: "client-a",
				runId: "run-a",
				seq: 2,
				type: "agent_v2.phase_changed",
				payload: { type: "agent_v2.phase_changed", phase: "implementation", at: "2026-07-08T11:00:00.000Z" },
				createdAt: "2026-07-08T11:00:00.000Z",
			},
		]);
		const service = new AgentV2RunApiService({
			store: new GuardedStore([]),
			queue: new NoopQueue(),
			events,
		});

		await expect(service.listRunEvents("client-a", "run-a", 1)).resolves.toEqual([
			expect.objectContaining({ seq: 2, runId: "run-a" }),
		]);
		expect(events.listCalls).toEqual([{ clientId: "client-a", runId: "run-a", afterSeq: 1 }]);
	});
});

function createSqliteStore(): { store: RuntimeDbStore } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-run-api-service-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return { store };
}

class RecordingEventLog implements Pick<AgentV2RunEventLog, "append" | "list"> {
	readonly appendCalls: AppendAgentV2RunEventInput[] = [];
	readonly listCalls: Array<{ clientId: string; runId: string; afterSeq: number }> = [];

	constructor(private readonly listResult: AgentV2RunEventRecord[] = []) {}

	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		this.appendCalls.push(input);
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: input.seq ?? this.appendCalls.length,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		};
	}

	async list(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		this.listCalls.push({ clientId, runId, afterSeq });
		return this.listResult.filter((event) => event.clientId === clientId && event.runId === runId && event.seq > afterSeq);
	}
}

class GuardedStore {
	readonly calls = {
		getAgentV2Run: [] as Array<{ clientId: string; runId: string }>,
		listAgentV2Runs: [] as string[],
	};
	private readonly beforeUpdateCallbacks: Array<(input: UpdateAgentV2RunInput) => void> = [];
	private readonly runs = new Map<string, AgentV2RunSnapshot>();

	constructor(runs: AgentV2RunSnapshot[]) {
		for (const run of runs) {
			this.runs.set(runKey(run.clientId, run.runId), run);
		}
	}

	async createAgentV2Run(input: CreateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		const run: AgentV2RunSnapshot = {
			clientId: input.clientId,
			runId: input.runId,
			status: "queued",
			phase: "intake",
			attempt: 1,
			input: input.input,
			model: input.model,
			createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
			updatedAt: input.updatedAt ?? input.createdAt ?? "2026-07-08T00:00:00.000Z",
			...(input.workerId ? { workerId: input.workerId } : {}),
			...(input.startedAt ? { startedAt: input.startedAt } : {}),
			...(input.endedAt ? { endedAt: input.endedAt } : {}),
			...(input.error ? { error: input.error } : {}),
		};
		this.runs.set(runKey(run.clientId, run.runId), run);
		return run;
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		this.calls.getAgentV2Run.push({ clientId, runId });
		return this.runs.get(runKey(clientId, runId));
	}

	runBeforeNextUpdate(callback: (input: UpdateAgentV2RunInput) => void): void {
		this.beforeUpdateCallbacks.push(callback);
	}

	forceRun(run: AgentV2RunSnapshot): void {
		this.runs.set(runKey(run.clientId, run.runId), run);
	}

	async updateAgentV2Run(input: UpdateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		return (await this.updateAgentV2RunWithResult(input)).run;
	}

	async updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): Promise<AgentV2RunUpdateResult> {
		const beforeUpdate = this.beforeUpdateCallbacks.shift();
		beforeUpdate?.(input);
		const current = this.runs.get(runKey(input.clientId, input.runId));
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
			return { run: current, applied: false };
		}
		const next: AgentV2RunSnapshot = {
			...current,
			...(input.status ? { status: input.status } : {}),
			...(input.phase ? { phase: input.phase } : {}),
			...(input.attempt ? { attempt: input.attempt } : {}),
			...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
			updatedAt: input.updatedAt ?? current.updatedAt,
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : current.startedAt ? { startedAt: current.startedAt } : {}),
			...(input.endedAt !== undefined ? { endedAt: input.endedAt } : current.endedAt ? { endedAt: current.endedAt } : {}),
			...(input.error !== undefined ? { error: input.error } : current.error ? { error: current.error } : {}),
		};
		this.runs.set(runKey(input.clientId, input.runId), next);
		return { run: next, applied: true };
	}

	async listAgentV2Runs(clientId: string): Promise<AgentV2RunSnapshot[]> {
		this.calls.listAgentV2Runs.push(clientId);
		return [...this.runs.values()].filter((run) => run.clientId === clientId);
	}

	getRun(): never {
		throw new Error("legacy getRun must not be called");
	}

	listRuns(): never {
		throw new Error("legacy listRuns must not be called");
	}
}

class NoopQueue implements AgentV2RunQueue {
	async enqueue(): Promise<void> {}
	async claim(): Promise<undefined> {
		return undefined;
	}
	async complete(): Promise<void> {}
	async requeueActive(): Promise<number> {
		return 0;
	}
	async requestCancel(): Promise<void> {}
	async isCancelRequested(): Promise<boolean> {
		return false;
	}
	async close(): Promise<void> {}
}

function runKey(clientId: string, runId: string): string {
	return `${clientId}:${runId}`;
}
