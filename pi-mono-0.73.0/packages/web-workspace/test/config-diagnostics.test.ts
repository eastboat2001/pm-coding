import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import { createStartupDiagnosticEvents } from "../src/vite-plugin.js";

const CONFIG_ENV_KEYS = [
	"PI_STORAGE_ENV_FILE",
	"PI_REDIS_URL",
	"PI_RUN_QUEUE_NAME",
	"PI_RUNS_ENABLED",
	"PI_LOG_STDOUT",
	"PI_STORAGE_DIR",
	"PI_CLIENTS_ROOT_DIR",
	"PI_DB_FILE",
	"PI_RUNTIME_STORE",
	"PI_POSTGRES_URL",
	"PI_RUN_EVENT_STREAM_MAXLEN",
	"PI_RUN_EVENT_STREAM_TTL_SECONDS",
	"PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS",
	"PI_RUN_EVENT_CHECKPOINT_MIN_CHARS",
	"PI_WORKER_ID",
] as const;

function withIsolatedConfigEnv<T>(run: () => T): T {
	const previousEnv = new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of CONFIG_ENV_KEYS) {
			delete process.env[key];
		}
		return run();
	} finally {
		for (const key of CONFIG_ENV_KEYS) {
			const previousValue = previousEnv.get(key);
			if (previousValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previousValue;
			}
		}
	}
}

describe("storage config diagnostics", () => {
	it("records when the default .env file is missing and includes run dependencies in startup diagnostics", () => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-diagnostics-"));
			const config = loadStorageConfig(root);

			expect(config.envFile).toBe(resolve(root, ".env"));
			expect(config.envFileExists).toBe(false);
			expect(config.runsEnabled).toBe(true);
			expect(config.logStdoutEnabled).toBe(true);
			expect(config.clientsRootDir).toBe(resolve(root, "data/clients"));
			expect(config.runtimeDbFile).toBe(resolve(root, "data/runtime/pi-runtime.sqlite"));

			const events = createStartupDiagnosticEvents(config);

			expect(events).toEqual([
				expect.objectContaining({
					level: "info",
					category: "system",
					eventType: "system.startup.config",
					data: expect.objectContaining({
						envFile: resolve(root, ".env"),
						envFileExists: false,
						runsEnabled: true,
						redisUrl: "redis://127.0.0.1:6379",
						runQueueName: "pi:runs",
					}),
				}),
				expect.objectContaining({
					level: "warn",
					category: "system",
					eventType: "system.config.env_missing",
					data: expect.objectContaining({
						envFile: resolve(root, ".env"),
						message: "PI configuration file was not found; defaults are in use.",
					}),
				}),
			]);
		});
	});

	it("uses a stable default worker id and allows env override", () => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-worker-id-"));
			delete process.env.PI_WORKER_ID;
			expect(loadStorageConfig(root).workerId).toBe("pi-worker");

			process.env.PI_WORKER_ID = "worker-custom";
			expect(loadStorageConfig(root).workerId).toBe("worker-custom");
		});
	});

	it("loads postgres runtime and run event stream configuration", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-postgres-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(
					join(dir, ".env"),
					[
						"PI_RUNTIME_STORE=postgres",
						"PI_POSTGRES_URL=postgres://pi:secret@postgres:5432/pi_coding",
						"PI_RUN_EVENT_STREAM_MAXLEN=2500",
						"PI_RUN_EVENT_STREAM_TTL_SECONDS=900",
						"PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS=400",
						"PI_RUN_EVENT_CHECKPOINT_MIN_CHARS=256",
					].join("\n"),
				);

				const config = loadStorageConfig(dir);

				expect(config.runtimeStore).toBe("postgres");
				expect(config.postgresUrl).toBe("postgres://pi:secret@postgres:5432/pi_coding");
				expect(config.runEventStreamMaxLen).toBe(2500);
				expect(config.runEventStreamTtlSeconds).toBe(900);
				expect(config.runEventCheckpointIntervalMs).toBe(400);
				expect(config.runEventCheckpointMinChars).toBe(256);
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
