import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisRunQueue } from "../src/run-queue.js";
import { type WorkerAgent, type WorkerAgentEvent, WorkspaceRunWorkerService } from "../src/run-worker-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeMessageRecord, RuntimeRunRecord } from "../src/types.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("RedisRunQueue integration", () => {
	let db: RuntimeDbStore;
	let dir: string;
	let queue: RedisRunQueue;
	let queueName: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-redis-run-queue-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		queueName = `pi:test:runs:${Date.now()}:${Math.random().toString(16).slice(2)}`;
		queue = new RedisRunQueue({ redisUrl: redisUrl!, queueName });
	});

	afterEach(async () => {
		await queue.close();
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("requeues active claims owned by a worker in Redis", async () => {
		await queue.enqueue({ clientId: "client-a", runId: "run-redis-1" });

		await expect(queue.claim("w1", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-1" });
		await expect(queue.requeueActive("w1")).resolves.toBe(1);

		await expect(queue.claim("w2", 1)).resolves.toEqual({ clientId: "client-a", runId: "run-redis-1" });
		await queue.complete({ clientId: "client-a", runId: "run-redis-1" }, "w2");
		await expect(queue.claim("w2", 1)).resolves.toBeUndefined();
	});

	it("recovers a queued run after a Redis active claim is reclaimed", async () => {
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

	it("interrupts a running run and drains its reclaimed Redis active claim", async () => {
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
});

function createRunFixture(db: RuntimeDbStore): RuntimeRunRecord {
	const clientId = "client-a";
	const sessionId = "session-1";
	db.upsertClient(clientId);
	const session = db.createSession({
		clientId,
		sessionId,
		title: "Redis integration session",
		model: { provider: "openai", id: "gpt-5" },
		thinkingLevel: "medium",
	});
	db.appendMessage({
		clientId: session.clientId,
		sessionId: session.sessionId,
		role: "user",
		payload: { content: "hello" },
	});
	return db.createRun({
		clientId: session.clientId,
		sessionId: session.sessionId,
		runId: "run-1",
		model: session.model,
		thinkingLevel: session.thinkingLevel,
	});
}

class ScriptedAgent implements WorkerAgent {
	private listeners: Array<(event: WorkerAgentEvent) => void> = [];

	subscribe(listener: (event: WorkerAgentEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	async prompt(_message: RuntimeMessageRecord): Promise<void> {
		const assistant = {
			role: "assistant",
			content: "done",
			timestamp: 123,
		};
		this.emit({ type: "message_end", message: assistant });
	}

	async continue(): Promise<void> {}

	abort(): void {}

	private emit(event: WorkerAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
