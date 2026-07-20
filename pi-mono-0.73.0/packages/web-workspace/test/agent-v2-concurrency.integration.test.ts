import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { AgentV2OutboxDispatcher } from "../src/agent-v2-outbox-dispatcher.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { RedisAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";
import { createPostgresTestSchema } from "./helpers/postgres-test-schema.js";

const postgresUrl = process.env.PI_TEST_POSTGRES_URL;
const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeInfrastructure = postgresUrl && redisUrl ? describe : describe.skip;
const CLIENT_ID = "99999999-9999-4999-8999-999999999999";

describeInfrastructure("agent v2 real infrastructure concurrency", () => {
	it("drains 20 simultaneous starts at worker concurrency 4 without duplicate execution or stranded state", async () => {
		const postgres = await createPostgresTestSchema();
		const queueName = `pi:test:concurrency:${randomUUID()}`;
		const store = new PostgresRuntimeStore({ queryable: postgres.pool });
		const queue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName });
		const bus = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, ttlSeconds: 60 });
		const events = new AgentV2RunEventLog({ store });
		const dispatcher = AgentV2OutboxDispatcher.forQueueAndLive({ store, queue, queueName, bus });
		const execution = new ConcurrentExecution();
		const workerId = `worker-${randomUUID()}`;
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events,
			execution,
			workerId,
			queueName,
			concurrency: 4,
			claimTimeoutMs: 5,
			idleSleepMs: 2,
			leaseHeartbeatIntervalMs: 20,
		});
		const api = new AgentV2RunApiService({ store, events, queueName });

		try {
			await store.ensureAgentV2Schema();
			const runIds = Array.from({ length: 20 }, (_, index) => `concurrent-${String(index + 1).padStart(2, "0")}`);
			const created = await Promise.all(
				runIds.map((runId) =>
					api.startRun(CLIENT_ID, {
						runId,
						input: {
							sessionId: `session-${runId}`,
							title: `Concurrent ${runId}`,
							objective: `Build isolated demo ${runId}`,
						},
						model: { provider: "test", id: "concurrency-model" },
					}),
			),
			);
			expect(created).toHaveLength(20);
			expect(created.every((run) => run.status === "queued" && run.attempt === 1)).toBe(true);

			await dispatcher.dispatchAvailable({ ownerId: "concurrency-dispatcher", limit: 200 });
			await worker.start();
			await waitFor(async () => {
				const runs = await store.listAgentV2Runs(CLIENT_ID);
				return runs.length === runIds.length && runs.every((run) => run.status === "succeeded");
			}, 20_000);
			await worker.stop();

			const runs = await store.listAgentV2Runs(CLIENT_ID);
			expect(runs).toHaveLength(20);
			expect(runs.every((run) => run.status === "succeeded" && run.attempt === 1)).toBe(true);
			expect(await store.listAgentV2RunsByWorker(workerId)).toEqual([]);
			expect(execution.maxActive).toBe(4);
			for (const runId of runIds) {
				expect(execution.calls.get(runId)).toBe(2);
				const runEvents = await store.listAgentV2RunEvents(CLIENT_ID, runId, 0);
				expect(runEvents.map((event) => event.seq)).toEqual(
					Array.from({ length: runEvents.length }, (_, index) => index + 1),
				);
			}
		} finally {
			await worker.stop().catch(() => undefined);
			const cleanupQueue = createRedisAgentV2RunQueue({ redisUrl: redisUrl!, queueName });
			await cleanupQueue.clear().catch(() => undefined);
			await cleanupQueue.close().catch(() => undefined);
			await bus.close().catch(() => undefined);
			await store.close();
			await postgres.close();
		}
	}, 30_000);
});

class ConcurrentExecution {
	readonly calls = new Map<string, number>();
	maxActive = 0;
	private active = 0;

	async executeNextTask(input: { run: AgentV2RunSnapshot; signal: AbortSignal }): Promise<AgentV2ExecutionStepResult> {
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			const calls = (this.calls.get(input.run.runId) ?? 0) + 1;
			this.calls.set(input.run.runId, calls);
			await abortableDelay(40, input.signal);
			return calls === 1
				? { status: "task_succeeded", taskId: `task-${input.run.runId}`, diagnosticIds: [] }
				: { status: "complete", diagnosticIds: [] };
		} finally {
			this.active -= 1;
		}
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		setTimeout(() => signal.removeEventListener("abort", abort), ms);
	});
}
