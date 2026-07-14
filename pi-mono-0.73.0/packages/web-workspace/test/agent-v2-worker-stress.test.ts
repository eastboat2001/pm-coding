import { afterEach, describe, expect, it } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import {
	type AgentV2RunQueue,
	type AgentV2RunQueueClearResult,
	type AgentV2RunQueueIdentity,
	createAgentV2RunQueue,
} from "../src/agent-v2-run-queue.js";
import {
	type AgentV2RunEventRecord,
	type AgentV2RunUpdateResult,
	type AppendAgentV2RunEventInput,
	applyAgentV2RunUpdate,
	buildAgentV2Run,
	type CreateAgentV2RunInput,
	type UpdateAgentV2RunInput,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";

describe("agent v2 worker stress", () => {
	afterEach(() => {
		// The stress test uses real timers so leave the global timer state clean.
	});

	it("drains 20 queued runs at concurrency 4 and leaves no queued, running, cancelling, or claimed state after mixed cancellation", async () => {
		const store = new MemoryStressStore();
		const queue = new TrackingQueue(createAgentV2RunQueue());
		const events = new RecordingEventLog();
		const now = createTimestampSequence("2026-07-09T10:00:00.000Z");
		const fastCancelTargets = new Set(["run-03", "run-04", "run-11"]);
		const slowCancelTargets = new Set(["run-01", "run-02", "run-12"]);
		const cancelledTargets = new Set([...fastCancelTargets, ...slowCancelTargets]);
		const execution = new StressExecution({ fastCancelTargets, slowCancelTargets });
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId: "worker-stress",
			concurrency: 4,
			claimTimeoutMs: 1,
			idleSleepMs: 1,
			cancelPollIntervalMs: 5,
			leaseHeartbeatIntervalMs: 10,
			now,
		});

		for (let index = 1; index <= 20; index += 1) {
			const runId = `run-${String(index).padStart(2, "0")}`;
			await seedQueuedRun(store, queue, now, runId);
		}

		await worker.start();
		await cancelRunsWhenRunning(queue, store, fastCancelTargets);
		await cancelRunsWhenRunning(queue, store, slowCancelTargets);
		await waitFor(async () => {
			const runs = await store.listAgentV2Runs("client-a");
			if (runs.length !== 20) return false;
			const byRunId = new Map(runs.map((run) => [run.runId, run]));
			return (
				runs.every((run) => run.status === "succeeded" || run.status === "cancelled") &&
				[...cancelledTargets].every((runId) => byRunId.get(runId)?.status === "cancelled")
			);
		}, 15_000);

		const runsBeforeStop = await store.listAgentV2Runs("client-a");
		expect(
			runsBeforeStop.filter(
				(run) => run.status === "queued" || run.status === "running" || run.status === "cancelling",
			),
		).toEqual([]);
		expect(await store.listAgentV2RunsByWorker("worker-stress")).toEqual([]);
		expect(execution.activeCount()).toBe(0);

		await worker.stop();

		const runs = await store.listAgentV2Runs("client-a");
		const closeDrainResult = queue.closeDrainResult();
		expect(runs).toHaveLength(20);
		expect(execution.maxActive).toBeLessThanOrEqual(4);
		expect(execution.abortCount).toBeGreaterThan(0);
		expect(runs.every((run) => run.status === "succeeded" || run.status === "cancelled")).toBe(true);
		expect(runs.filter((run) => run.status === "cancelled").map((run) => run.runId)).toEqual(
			expect.arrayContaining([...cancelledTargets]),
		);
		expect(
			runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "cancelling"),
		).toEqual([]);
		expect(await store.listAgentV2RunsByWorker("worker-stress")).toEqual([]);
		expect(queue.activeClaimCount()).toBe(0);
		expect(closeDrainResult).toEqual({ queueItemsDeleted: 0, activeClaimsDeleted: 0, cancelKeysDeleted: 0 });
		expect(queue.completedRuns()).toHaveLength(20);
		expect(events.appendCalls.filter((event) => event.type === "agent_v2.phase_changed")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ payload: expect.objectContaining({ status: "running" }) }),
				expect.objectContaining({ payload: expect.objectContaining({ status: "cancelled" }) }),
				expect.objectContaining({ payload: expect.objectContaining({ status: "succeeded" }) }),
			]),
		);
	}, 15_000);

	it("still interrupts in-flight runs when the worker is stopped early", async () => {
		const store = new MemoryStressStore();
		const queue = new TrackingQueue(createAgentV2RunQueue());
		const events = new RecordingEventLog();
		const now = createTimestampSequence("2026-07-09T10:30:00.000Z");
		const execution = new StressExecution({
			fastCancelTargets: new Set(),
			slowCancelTargets: new Set(["run-01", "run-02", "run-03", "run-04"]),
		});
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId: "worker-stop-early",
			concurrency: 4,
			claimTimeoutMs: 1,
			idleSleepMs: 1,
			cancelPollIntervalMs: 5,
			leaseHeartbeatIntervalMs: 10,
			now,
		});

		for (let index = 1; index <= 8; index += 1) {
			const runId = `run-${String(index).padStart(2, "0")}`;
			await seedQueuedRun(store, queue, now, runId);
		}

		await worker.start();
		await waitFor(
			async () =>
				execution.activeCount() > 0 && (await store.listAgentV2RunsByWorker("worker-stop-early")).length > 0,
			10_000,
		);
		await worker.stop();

		const runs = await store.listAgentV2Runs("client-a");
		expect(runs.some((run) => run.status === "interrupted")).toBe(true);
		expect(runs.filter((run) => run.status === "running" || run.status === "cancelling")).toEqual([]);
		expect(runs.filter((run) => run.status === "queued").length).toBeGreaterThan(0);
		expect(await store.listAgentV2RunsByWorker("worker-stop-early")).toEqual([]);
		expect(queue.activeClaimCount()).toBe(0);
		expect(queue.closeDrainResult()).toBeDefined();
	}, 15_000);
});

class MemoryStressStore {
	readonly diagnostics: AgentV2DiagnosticEvent[] = [];
	private readonly runs = new Map<string, AgentV2RunSnapshot>();

	async createAgentV2Run(input: CreateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		const run = buildAgentV2Run(input);
		this.runs.set(runKey(run.clientId, run.runId), run);
		return run;
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		return this.runs.get(runKey(clientId, runId));
	}

	async updateAgentV2Run(input: UpdateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		return (await this.updateAgentV2RunWithResult(input)).run;
	}

	async updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): Promise<AgentV2RunUpdateResult> {
		const current = this.runs.get(runKey(input.clientId, input.runId));
		if (!current) throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
			return { run: current, applied: false };
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return { run: next, applied: true };
	}

	async listAgentV2Runs(clientId: string): Promise<AgentV2RunSnapshot[]> {
		return [...this.runs.values()]
			.filter((run) => run.clientId === clientId)
			.sort((left, right) => left.runId.localeCompare(right.runId));
	}

	async listAgentV2RunsByWorker(workerId: string): Promise<AgentV2RunSnapshot[]> {
		return [...this.runs.values()].filter(
			(run) => run.workerId === workerId && (run.status === "running" || run.status === "cancelling"),
		);
	}

	async appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): Promise<AgentV2DiagnosticEvent> {
		this.diagnostics.push(input);
		return input;
	}
}

class TrackingQueue implements AgentV2RunQueue {
	private readonly activeClaims = new Set<string>();
	private readonly completed = new Set<string>();
	private closeResult: AgentV2RunQueueClearResult | undefined;

	constructor(private readonly inner: AgentV2RunQueue) {}

	async enqueue(run: AgentV2RunQueueIdentity): Promise<void> {
		await this.inner.enqueue(run);
	}

	async claim(workerId: string, timeoutMs: number): Promise<AgentV2RunQueueIdentity | undefined> {
		const claimed = await this.inner.claim(workerId, timeoutMs);
		if (claimed) this.activeClaims.add(runKey(claimed.clientId, claimed.runId));
		return claimed;
	}

	async complete(run: AgentV2RunQueueIdentity, workerId: string): Promise<void> {
		await this.inner.complete(run, workerId);
		this.activeClaims.delete(runKey(run.clientId, run.runId));
		this.completed.add(runKey(run.clientId, run.runId));
	}

	async requeueActive(workerId: string): Promise<number> {
		return await this.inner.requeueActive(workerId);
	}

	async renewLease(run: AgentV2RunQueueIdentity, workerId: string): Promise<boolean> {
		return await this.inner.renewLease(run, workerId);
	}

	async releaseExpiredClaims() {
		return await this.inner.releaseExpiredClaims();
	}

	async requestCancel(run: AgentV2RunQueueIdentity): Promise<void> {
		await this.inner.requestCancel(run);
	}

	async isCancelRequested(run: AgentV2RunQueueIdentity): Promise<boolean> {
		return await this.inner.isCancelRequested(run);
	}

	async clear() {
		return await this.inner.clear();
	}

	async close(): Promise<void> {
		this.closeResult = await this.inner.clear();
		await this.inner.close();
	}

	activeClaimCount(): number {
		return this.activeClaims.size;
	}

	completedRuns(): string[] {
		return [...this.completed].sort();
	}

	closeDrainResult(): AgentV2RunQueueClearResult | undefined {
		return this.closeResult;
	}
}

class RecordingEventLog implements Pick<AgentV2RunEventLog, "append" | "list"> {
	readonly appendCalls: AppendAgentV2RunEventInput[] = [];

	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		this.appendCalls.push(input);
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: input.seq ?? this.appendCalls.length,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-09T00:00:00.000Z",
		};
	}

	async list(): Promise<AgentV2RunEventRecord[]> {
		return [];
	}
}

class StressExecution {
	abortCount = 0;
	maxActive = 0;
	private active = 0;
	private readonly attempts = new Map<string, number>();

	constructor(
		private readonly options: {
			fastCancelTargets: ReadonlySet<string>;
			slowCancelTargets: ReadonlySet<string>;
		},
	) {}

	async executeNextTask(input: { run: AgentV2RunSnapshot; signal: AbortSignal }): Promise<AgentV2ExecutionStepResult> {
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			const attempt = this.attempts.get(input.run.runId) ?? 0;
			this.attempts.set(input.run.runId, attempt + 1);
			if (this.options.fastCancelTargets.has(input.run.runId)) {
				await this.sleepWithAbort(20, input.signal);
				return { status: "task_succeeded", taskId: `task-${input.run.runId}`, diagnosticIds: [] };
			}
			if (this.options.slowCancelTargets.has(input.run.runId)) {
				await this.sleepWithAbort(250, input.signal);
				return { status: "task_succeeded", taskId: `task-${input.run.runId}`, diagnosticIds: [] };
			}
			await this.sleepWithAbort(25, input.signal);
			if (attempt === 0) {
				return { status: "task_succeeded", taskId: `task-${input.run.runId}`, diagnosticIds: [] };
			}
			return { status: "complete", diagnosticIds: [] };
		} finally {
			this.active -= 1;
		}
	}

	activeCount(): number {
		return this.active;
	}

	private async sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
		try {
			await abortableSleep(ms, signal);
		} catch (error) {
			if (signal.aborted) this.abortCount += 1;
			throw error;
		}
	}
}

async function cancelRunsWhenRunning(
	queue: TrackingQueue,
	store: MemoryStressStore,
	runIds: ReadonlySet<string>,
): Promise<void> {
	const pending = new Set(runIds);
	await waitFor(async () => {
		for (const runId of [...pending]) {
			const run = await store.getAgentV2Run("client-a", runId);
			if (run?.status === "running") {
				await queue.requestCancel({ clientId: "client-a", runId });
				pending.delete(runId);
			}
		}
		return pending.size === 0;
	}, 10_000);
}

async function seedQueuedRun(
	store: MemoryStressStore,
	queue: TrackingQueue,
	now: () => string,
	runId: string,
): Promise<void> {
	const createdAt = now();
	await store.createAgentV2Run({
		clientId: "client-a",
		runId,
		input: { objective: `Objective ${runId}`, sessionId: `session-${runId}`, title: `Session ${runId}` },
		model: { provider: "test", id: "local" },
		createdAt,
		updatedAt: createdAt,
	});
	await queue.enqueue({ clientId: "client-a", runId });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await abortableSleep(5);
	}
}

function createTimestampSequence(startIso: string): () => string {
	let tick = 0;
	const startMs = Date.parse(startIso);
	return () => {
		const value = new Date(startMs + tick * 1_000).toISOString();
		tick += 1;
		return value;
	};
}

function runKey(clientId: string, runId: string): string {
	return `${clientId}:${runId}`;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("execution aborted"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
