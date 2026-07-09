import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisAgentV2RunEventBusOptions } from "../../../packages/web-workspace/src/agent-v2-run-event-bus.js";
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import { RuntimeDbStore } from "../../../packages/web-workspace/src/runtime-db.js";
import {
	createAgentV2WorkerExecution,
	createAgentV2WorkerRunEventOptions,
	createWorkerStartupDiagnosticEvents,
	installWorkerFatalDiagnostics,
	stopWorkerRuntime,
} from "../src/worker/main.js";

describe("worker runtime diagnostics", () => {
	let dir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
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

	it("flushes Langfuse during stop cleanup and still closes the runtime database when flush fails", async () => {
		const cleanupOrder: string[] = [];
		const workerStop = vi.fn(async () => {
			cleanupOrder.push("worker.stop");
		});
		const eventBusClose = vi.fn(async () => {
			cleanupOrder.push("agentV2RunEventBus.close");
		});
		const flushLangfuse = vi.fn(async () => {
			cleanupOrder.push("diagnostics.flushLangfuse");
			throw new Error("langfuse flush failed");
		});
		const runtimeDbClose = vi.fn(async () => {
			cleanupOrder.push("runtimeDb.close");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await stopWorkerRuntime({
			worker: { stop: workerStop } as unknown as Parameters<typeof stopWorkerRuntime>[0]["worker"],
			agentV2RunEventBus: { close: eventBusClose } as unknown as Parameters<
				typeof stopWorkerRuntime
			>[0]["agentV2RunEventBus"],
			runtimeDb: { close: runtimeDbClose } as unknown as Parameters<typeof stopWorkerRuntime>[0]["runtimeDb"],
			diagnostics: { flushLangfuse },
		});

		expect(exitCode).toBe(1);
		expect(flushLangfuse).toHaveBeenCalledTimes(1);
		expect(runtimeDbClose).toHaveBeenCalledTimes(1);
		expect(cleanupOrder).toEqual([
			"worker.stop",
			"agentV2RunEventBus.close",
			"diagnostics.flushLangfuse",
			"runtimeDb.close",
		]);
	});

	it("writes fatal diagnostics, flushes Langfuse, and attempts to exit after a fatal worker error", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-v2-fatal-"));
		const config = loadStorageConfig(dir);
		const writeEvents = vi.fn();
		const flushComplete = deferred<void>();
		const flushLangfuse = vi.fn(() => flushComplete.promise);
		const exitCodes: Array<string | number | null | undefined> = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null): never => {
			exitCodes.push(code);
			return undefined as never;
		}) as typeof process.exit);
		const timeoutHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((() => timeoutHandle) as unknown as typeof setTimeout);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const existingUncaughtExceptionListeners = new Set(process.listeners("uncaughtException"));
		let removeFatalDiagnostics: (() => void) | undefined;
		let fatalListener: ((error: Error) => void) | undefined;

		try {
			removeFatalDiagnostics = installWorkerFatalDiagnostics(config, { writeEvents, flushLangfuse });
			const fatalListeners = process
				.listeners("uncaughtException")
				.filter((listener) => !existingUncaughtExceptionListeners.has(listener));
			expect(fatalListeners).toHaveLength(1);
			fatalListener = fatalListeners[0] as (error: Error) => void;

			const error = new Error("fatal worker failure");
			fatalListener(error);

			expect(writeEvents).toHaveBeenCalledWith({
				events: [
					expect.objectContaining({
						level: "error",
						category: "system",
						eventType: "system.worker.uncaught_exception",
						data: expect.objectContaining({
							workerId: config.workerId,
							workerConcurrency: config.workerConcurrency,
							agentV2RunQueueName: config.agentV2RunQueueName,
							name: "Error",
							message: "fatal worker failure",
						}),
					}),
				],
			});
			expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
			expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);
			expect(flushLangfuse).toHaveBeenCalledTimes(1);
			expect(exitSpy).not.toHaveBeenCalled();

			flushComplete.resolve();
			await flushMicrotasks();

			expect(exitCodes).toEqual([1]);
		} finally {
			removeFatalDiagnostics?.();
		}

		expect(fatalListener).toBeDefined();
		expect(process.listeners("uncaughtException")).not.toContain(fatalListener);
	});
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
