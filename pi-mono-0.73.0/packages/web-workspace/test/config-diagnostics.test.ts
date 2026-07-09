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
	"PI_RUN_MAX_AGENT_TURNS",
	"PI_RUN_MAX_AGENT_TOOL_EXECUTIONS",
	"PI_RUN_RETRY_MAX_ATTEMPTS",
	"PI_RUN_RETRY_BASE_DELAY_MS",
	"PI_RUN_RETRY_MAX_DELAY_MS",
	"PI_RUN_RETRY_JITTER_RATIO",
	"PI_MODEL_MAX_OUTPUT_TOKENS",
	"PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS",
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
			expect(config.runMaxAgentTurns).toBe(80);
			expect(config.runMaxAgentToolExecutions).toBe(240);
			expect(config.runRetryMaxAttempts).toBe(8);
			expect(config.runRetryBaseDelayMs).toBe(2000);
			expect(config.runRetryMaxDelayMs).toBe(60000);
			expect(config.runRetryJitterRatio).toBe(0.2);
			expect(config.modelMaxOutputTokens).toBe(12000);
			expect(config.contextProviderPayloadBudgetChars).toBe(90000);

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
						agentV2RunQueueName: "pi:agent-v2:runs",
						runMaxAgentTurns: 80,
						runMaxAgentToolExecutions: 240,
						runRetryMaxAttempts: 8,
						runRetryBaseDelayMs: 2000,
						runRetryMaxDelayMs: 60000,
						runRetryJitterRatio: 0.2,
						modelMaxOutputTokens: 12000,
						contextProviderPayloadBudgetChars: 90000,
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

	it("loads run and model pressure caps and allows disabling caps", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-model-caps-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(
					join(dir, ".env"),
					[
						"PI_RUN_MAX_AGENT_TURNS=12",
						"PI_RUN_MAX_AGENT_TOOL_EXECUTIONS=0",
						"PI_MODEL_MAX_OUTPUT_TOKENS=0",
						"PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS=85000",
					].join("\n"),
				);

				const config = loadStorageConfig(dir);

				expect(config.runMaxAgentTurns).toBe(12);
				expect(config.runMaxAgentToolExecutions).toBe(0);
				expect(config.modelMaxOutputTokens).toBe(0);
				expect(config.contextProviderPayloadBudgetChars).toBe(85000);
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("loads run retry policy configuration", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-run-retry-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(
					join(dir, ".env"),
					[
						"PI_RUN_RETRY_MAX_ATTEMPTS=10",
						"PI_RUN_RETRY_BASE_DELAY_MS=1500",
						"PI_RUN_RETRY_MAX_DELAY_MS=90000",
						"PI_RUN_RETRY_JITTER_RATIO=0.35",
					].join("\n"),
				);

				const config = loadStorageConfig(dir);

				expect(config.runRetryMaxAttempts).toBe(10);
				expect(config.runRetryBaseDelayMs).toBe(1500);
				expect(config.runRetryMaxDelayMs).toBe(90000);
				expect(config.runRetryJitterRatio).toBe(0.35);
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
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
