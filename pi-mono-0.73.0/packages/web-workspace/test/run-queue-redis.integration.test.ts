import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { createRedisAgentV2RunQueue, type AgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import {
	applyAgentV2RunUpdate,
	buildAgentV2Run,
	type AgentV2RunEventRecord,
	type AgentV2RunUpdateResult,
	type AppendAgentV2RunEventInput,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2RunStatus } from "../src/agent-v2-types.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("createRedisAgentV2RunQueue integration", () => {
	it("requeues active claims owned by a worker in Redis", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			await queue.enqueue({ clientId: "client-a", runId: "run-redis-1" });

			await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-1" });
			await expect(queue.requeueActive("w1")).resolves.toBe(1);

			await expect(queue.claim("w2", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-1" });
			await queue.complete({ clientId: "client-a", runId: "run-redis-1" }, "w2");
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});

	it("recovers a queued run after a Redis active claim is reclaimed", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			const store = new MemoryWorkerStore();
			store.createQueuedRun("client-a", "run-redis-queued");

			await queue.enqueue({ clientId: "client-a", runId: "run-redis-queued" });
			await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-queued" });

			const worker = new AgentV2WorkerService({
				store,
				queue,
				events: new RecordingEventLog(),
				execution: new CompleteExecution(),
				workerId: "w1",
				now: timestampSequence("2026-07-09T00:00:00.000Z", "2026-07-09T00:00:01.000Z"),
			});

			await worker.recoverOwnedRuns();
			await expect(worker.processOne()).resolves.toBe(true);

			expect(store.getRunSnapshot("client-a", "run-redis-queued")).toMatchObject({ status: "succeeded" });
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});

	it("interrupts a running run and drains its reclaimed Redis active claim", async () => {
		const queue = createQueue();
		await usingQueue(queue, async () => {
			const store = new MemoryWorkerStore();
			store.createOwnedActiveRun("client-a", "run-redis-running", "running", "w1");

			await queue.enqueue({ clientId: "client-a", runId: "run-redis-running" });
			await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-running" });

			const worker = new AgentV2WorkerService({
				store,
				queue,
				events: new RecordingEventLog(),
				execution: {
					executeNextTask: async () => {
						throw new Error("interrupted recovered runs should not execute");
					},
				},
				workerId: "w1",
				now: () => "2026-07-09T00:00:02.000Z",
			});

			await worker.recoverOwnedRuns();
			await expect(worker.processOne()).resolves.toBe(true);

			expect(store.getRunSnapshot("client-a", "run-redis-running")).toMatchObject({ status: "interrupted" });
			await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
		});
	});
});

function createQueue(): AgentV2RunQueue {
	return createRedisAgentV2RunQueue({
		redisUrl: redisUrl!,
		queueName: `pi:test:agent-v2:runs:${Date.now()}:${randomUUID()}`,
	});
}

async function usingQueue(queue: AgentV2RunQueue, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} finally {
		try {
			await queue.clear();
		} catch {}
		await queue.close();
	}
}

class MemoryWorkerStore {
	readonly diagnostics: AgentV2DiagnosticEvent[] = [];
	private readonly runs = new Map<string, AgentV2RunSnapshot>();

	createQueuedRun(clientId: string, runId: string): AgentV2RunSnapshot {
		const run = buildAgentV2Run({
			clientId,
			runId,
			input: { prompt: `prompt:${runId}`, sessionId: `session:${runId}`, title: runId },
			model: { provider: "test" },
			createdAt: "2026-07-09T00:00:00.000Z",
			updatedAt: "2026-07-09T00:00:00.000Z",
		});
		this.runs.set(runKey(clientId, runId), run);
		return run;
	}

	createOwnedActiveRun(
		clientId: string,
		runId: string,
		status: Extract<AgentV2RunStatus, "running" | "cancelling">,
		workerId: string,
	): void {
		this.createQueuedRun(clientId, runId);
		this.applyForcedUpdate({
			clientId,
			runId,
			status: "running",
			phase: "implementation",
			workerId,
			startedAt: "2026-07-09T00:00:00.000Z",
			updatedAt: "2026-07-09T00:00:00.000Z",
		});
		if (status === "cancelling") {
			this.applyForcedUpdate({
				clientId,
				runId,
				status: "cancelling",
				updatedAt: "2026-07-09T00:00:01.000Z",
			});
		}
	}

	getRunSnapshot(clientId: string, runId: string): AgentV2RunSnapshot | undefined {
		return this.runs.get(runKey(clientId, runId));
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		return this.getRunSnapshot(clientId, runId);
	}

	async updateAgentV2Run(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		updatedAt?: string;
	}): Promise<AgentV2RunSnapshot> {
		return this.applyForcedUpdate(input);
	}

	async updateAgentV2RunWithResult(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		expectedStatuses?: readonly AgentV2RunStatus[];
		updatedAt?: string;
	}): Promise<AgentV2RunUpdateResult> {
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
			return { run: current, applied: false };
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return { run: next, applied: true };
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

	private applyForcedUpdate(input: {
		clientId: string;
		runId: string;
		status?: AgentV2RunStatus;
		phase?: AgentV2RunSnapshot["phase"];
		workerId?: string;
		startedAt?: string;
		endedAt?: string;
		error?: AgentV2RunSnapshot["error"];
		updatedAt?: string;
	}): AgentV2RunSnapshot {
		const current = this.getRunSnapshot(input.clientId, input.runId);
		if (!current) {
			throw new Error(`Missing run ${input.clientId}/${input.runId}`);
		}
		const next = applyAgentV2RunUpdate(current, input);
		this.runs.set(runKey(input.clientId, input.runId), next);
		return next;
	}
}

class RecordingEventLog implements Pick<AgentV2RunEventLog, "append"> {
	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		return {
			clientId: input.clientId,
			runId: input.runId,
			seq: 1,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-09T00:00:00.000Z",
		};
	}
}

class CompleteExecution {
	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		return { status: "complete", diagnosticIds: [] };
	}
}

function runKey(clientId: string, runId: string): string {
	return `${clientId}:${runId}`;
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => {
		const value = timestamps[index] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
		index += 1;
		return value;
	};
}
