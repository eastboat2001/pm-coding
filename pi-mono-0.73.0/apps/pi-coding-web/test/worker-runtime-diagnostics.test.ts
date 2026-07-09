import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RedisAgentV2RunEventBusOptions } from "../../../packages/web-workspace/src/agent-v2-run-event-bus.js";
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import { RuntimeDbStore } from "../../../packages/web-workspace/src/runtime-db.js";
import { createAgentV2WorkerExecution, createAgentV2WorkerRunEventOptions, createWorkerStartupDiagnosticEvents } from "../src/worker/main.js";

describe("worker runtime diagnostics", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = undefined;
	});

	it("records agent v2 defaults in worker startup diagnostics without a legacy version field", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-startup-"));
		const config = {
			...loadStorageConfig(dir),
			runQueueName: "legacy-runs",
			agentV2RunQueueName: "agent-v2-runs",
			agentV2RunEventStreamMaxLen: 4321,
			agentV2RunEventStreamTtlSeconds: 8765,
		};

		const events = createWorkerStartupDiagnosticEvents(config);

		expect(events).toContainEqual(
			expect.objectContaining({
				eventType: "system.startup.config",
				data: expect.objectContaining({
					runQueueName: "legacy-runs",
					agentV2RunQueueName: "agent-v2-runs",
					agentV2RunEventStreamMaxLen: 4321,
					agentV2RunEventStreamTtlSeconds: 8765,
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				eventType: "system.startup.config",
				data: expect.not.objectContaining({
					appAgentVersion: expect.anything(),
				}),
			}),
		);
	});

	it("does not keep a renamed legacy worker diagnostics entry alongside the v2 worker", () => {
		expect(existsSync(new URL("../src/worker/worker-diagnostics.ts", import.meta.url))).toBe(false);
	});

	it("maps agent v2 worker queue and event stream config into Redis options", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-events-"));
		const config = {
			...loadStorageConfig(dir),
			redisUrl: "redis://127.0.0.1:6381",
			agentV2RunQueueName: "agent-v2-runs",
			agentV2RunEventStreamMaxLen: 2222,
			agentV2RunEventStreamTtlSeconds: 3333,
		};

		const options = createAgentV2WorkerRunEventOptions(config);
		const busOptions: RedisAgentV2RunEventBusOptions = options.bus;

		expect(options.queue).toEqual({
			redisUrl: "redis://127.0.0.1:6381",
			queueName: "agent-v2-runs",
		});
		expect(busOptions).toEqual({
			redisUrl: "redis://127.0.0.1:6381",
			maxLen: 2222,
			ttlSeconds: 3333,
		});
	});

	it("forwards the production agent v2 worker cancellation signal into execution", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-cancel-"));
		const config = loadStorageConfig(dir);
		const db = new RuntimeDbStore(join(dir, "runtime.sqlite"));

		try {
			db.ensureAgentV2Schema();
			const run = db.createAgentV2Run({
				clientId: "client-a",
				runId: "run-v2-cancel",
				input: { prompt: "Build an app", sessionId: "session-1", title: "Diagnostics" },
				model: { provider: "test" },
				createdAt: "2026-07-08T09:00:00.000Z",
			});
			const controller = new AbortController();
			controller.abort(new Error("worker cancellation"));

			await expect(
				createAgentV2WorkerExecution(config).executeNextTask({
					store: db,
					run,
					workerId: "worker-1",
					signal: controller.signal,
				}),
			).rejects.toThrow("worker cancellation");
		} finally {
			db.close();
		}
	});
});
