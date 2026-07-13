import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStorageConfig, RetiredApplicationGenerationConfigError } from "../src/config.js";
import { createStartupDiagnosticEvents } from "../src/vite-plugin.js";

const RETIRED_APPLICATION_GENERATION_ENV = [
	"PI_APP_AGENT_VERSION",
	"PI_RUNS_ENABLED",
	"PI_RUN_QUEUE_NAME",
	"PI_RUN_EVENT_RETENTION_DAYS",
	"PI_RUN_EVENT_STREAM_MAXLEN",
	"PI_RUN_EVENT_STREAM_TTL_SECONDS",
	"PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS",
	"PI_RUN_EVENT_CHECKPOINT_MIN_CHARS",
	"PI_RUN_RETRY_MAX_ATTEMPTS",
	"PI_RUN_RETRY_BASE_DELAY_MS",
	"PI_RUN_RETRY_MAX_DELAY_MS",
	"PI_RUN_RETRY_JITTER_RATIO",
	"PI_RUN_MAX_AGENT_TURNS",
	"PI_RUN_MAX_AGENT_TOOL_EXECUTIONS",
	"PI_PROJECT_INSTALL_COMMAND",
	"PI_PROJECT_BUILD_COMMAND",
	"PI_PROJECT_INSTALL_TIMEOUT_MS",
	"PI_PROJECT_BUILD_TIMEOUT_MS",
] as const;
const SECRET_SENTINEL = "super-secret-retired-value-DO-NOT-LEAK";
const INVALID_REGISTRY_ORIGINS = [
	"https://.",
	"https://.example.com",
	"https://a..b",
	"https://-",
	"https://_",
	"https://example.com:0",
] as const;
const INVALID_REGISTRY_MESSAGE = "Error: Invalid production container build configuration: PI_BUILD_REGISTRY_ORIGINS";

const CONFIG_ENV_KEYS = [
	"PI_STORAGE_ENV_FILE",
	"PI_REDIS_URL",
	...RETIRED_APPLICATION_GENERATION_ENV,
	"PI_LOG_STDOUT",
	"PI_STORAGE_DIR",
	"PI_CLIENTS_ROOT_DIR",
	"PI_DB_FILE",
	"PI_RUNTIME_STORE",
	"PI_POSTGRES_URL",
	"PI_WORKER_ID",
	"PI_AGENT_V2_RUN_QUEUE_NAME",
	"PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN",
	"PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS",
	"PI_MODEL_MAX_OUTPUT_TOKENS",
	"PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS",
	"PI_PREVIEW_INTERNAL_ORIGIN",
	"PI_BUILD_CONTAINER_ENGINE",
	"PI_BUILD_CONTAINER_IMAGE",
	"PI_BUILD_PROXY_IMAGE",
	"PI_BUILD_TIMEOUT_MS",
	"PI_BUILD_CPUS",
	"PI_BUILD_MEMORY_MB",
	"PI_BUILD_PIDS_LIMIT",
	"PI_BUILD_MAX_LOG_CHARS",
	"PI_BUILD_REGISTRY_ORIGINS",
] as const;

function withIsolatedConfigEnv<T>(run: () => T): T {
	const previousEnv = new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of CONFIG_ENV_KEYS) delete process.env[key];
		return run();
	} finally {
		for (const key of CONFIG_ENV_KEYS) {
			const previousValue = previousEnv.get(key);
			if (previousValue === undefined) delete process.env[key];
			else process.env[key] = previousValue;
		}
	}
}

describe("storage config diagnostics", () => {
	it("records nested agent v2 defaults when the default .env file is missing", () => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-diagnostics-"));
			const config = loadStorageConfig(root);

			expect(config.envFile).toBe(resolve(root, ".env"));
			expect(config.envFileExists).toBe(false);
			expect(config.agentV2).toEqual({
				queueName: "pi:agent-v2:runs",
				eventStreamMaxLen: 5000,
				eventStreamTtlSeconds: 3600,
			});
			expect(config.logStdoutEnabled).toBe(true);
			expect(config.clientsRootDir).toBe(resolve(root, "data/clients"));
			expect(config.runtimeDbFile).toBe(resolve(root, "data/runtime/pi-runtime.sqlite"));
			expect(config.modelMaxOutputTokens).toBe(12000);
			expect(config.contextProviderPayloadBudgetChars).toBe(90000);
			expect(config.containerBuild).toEqual({
				engine: "docker",
				image: "node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752",
				proxyImage: "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
				timeoutMs: 120000,
				cpus: 1,
				memoryMb: 512,
				pidsLimit: 128,
				maxLogChars: 12000,
				registryOrigins: ["https://registry.npmjs.org"],
			});

			const events = createStartupDiagnosticEvents(config);

			expect(events).toEqual([
				expect.objectContaining({
					level: "info",
					category: "system",
					eventType: "system.startup.config",
					data: expect.objectContaining({
						envFile: resolve(root, ".env"),
						envFileExists: false,
						redisUrl: "redis://127.0.0.1:6379",
						agentV2: {
							queueName: "pi:agent-v2:runs",
							eventStreamMaxLen: 5000,
							eventStreamTtlSeconds: 3600,
						},
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
			expect(loadStorageConfig(root).workerId).toBe("pi-worker");

			process.env.PI_WORKER_ID = "worker-custom";
			expect(loadStorageConfig(root).workerId).toBe("worker-custom");
		});
	});

	it("defaults and normalizes the internal preview origin", () => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-preview-origin-"));
			expect(loadStorageConfig(root).previewInternalOrigin).toBe("http://127.0.0.1:5173");

			process.env.PI_PREVIEW_INTERNAL_ORIGIN = "https://preview.internal:8443/";
			expect(loadStorageConfig(root).previewInternalOrigin).toBe("https://preview.internal:8443");
		});
	});

	it.each([
		"ftp://preview.internal",
		"http://user:secret@preview.internal",
		"http://preview.internal/path",
		"http://preview.internal?secret=value",
		"http://preview.internal#secret-value",
	])("rejects invalid internal preview origin without leaking its value", (value) => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-invalid-preview-origin-"));
			process.env.PI_PREVIEW_INTERNAL_ORIGIN = value;

			expect(() => loadStorageConfig(root)).toThrow("PI_PREVIEW_INTERNAL_ORIGIN");
			try {
				loadStorageConfig(root);
			} catch (error) {
				expect(String(error)).not.toContain(value);
			}
		});
	});

	it.each(RETIRED_APPLICATION_GENERATION_ENV)("rejects retired process env %s", (variable) => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-retired-process-"));
			process.env[variable] = SECRET_SENTINEL;

			try {
				loadStorageConfig(root);
				throw new Error("expected retired configuration to be rejected");
			} catch (error) {
				expect(error).toBeInstanceOf(RetiredApplicationGenerationConfigError);
				if (!(error instanceof RetiredApplicationGenerationConfigError)) throw error;
				expect(error.variables).toEqual([variable]);
				expect(error.message).toContain(variable);
				expect(error.variables).not.toContain(SECRET_SENTINEL);
				expect(error.message).not.toContain(SECRET_SENTINEL);
			}
		});
	});

	it("rejects an empty retired process env value", () => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-retired-empty-process-"));
			process.env.PI_APP_AGENT_VERSION = "";

			expect(() => loadStorageConfig(root)).toThrow(/PI_APP_AGENT_VERSION/);
		});
	});

	it("rejects retired variables from the configured .env file without leaking their values", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-retired-file-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(join(dir, ".env"), `PI_RUN_QUEUE_NAME=${SECRET_SENTINEL}\n`);

				try {
					loadStorageConfig(dir);
					throw new Error("expected retired configuration to be rejected");
				} catch (error) {
					expect(error).toBeInstanceOf(RetiredApplicationGenerationConfigError);
					if (!(error instanceof RetiredApplicationGenerationConfigError)) throw error;
					expect(error.variables).toEqual(["PI_RUN_QUEUE_NAME"]);
					expect(error.message).not.toContain(SECRET_SENTINEL);
				}
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("rejects an empty retired value from the configured .env file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-retired-empty-file-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(join(dir, ".env"), "PI_RUN_QUEUE_NAME=\n");
				expect(() => loadStorageConfig(dir)).toThrow(/PI_RUN_QUEUE_NAME/);
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("rejects retired project command variables from the configured .env file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-retired-project-command-file-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(join(dir, ".env"), `PI_PROJECT_BUILD_COMMAND=${SECRET_SENTINEL}\n`);
				expect(() => loadStorageConfig(dir)).toThrow(/PI_PROJECT_BUILD_COMMAND/);
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it.each([
		["PI_BUILD_CONTAINER_ENGINE", "nerdctl"],
		["PI_BUILD_CONTAINER_IMAGE", "node:22"],
		["PI_BUILD_PROXY_IMAGE", "ubuntu/squid:latest"],
		["PI_BUILD_TIMEOUT_MS", "0"],
		["PI_BUILD_CPUS", "0"],
		["PI_BUILD_MEMORY_MB", "not-a-number"],
		["PI_BUILD_PIDS_LIMIT", "-1"],
		["PI_BUILD_MAX_LOG_CHARS", "0"],
		["PI_BUILD_REGISTRY_ORIGINS", "https://127.0.0.1"],
		["PI_BUILD_REGISTRY_ORIGINS", "https://registry.npmjs.org/path"],
	] as const)("rejects invalid production container config %s", (variable, value) => {
		withIsolatedConfigEnv(() => {
			const root = mkdtempSync(join(tmpdir(), "pi-config-invalid-container-build-"));
			process.env[variable] = value;
			expect(() => loadStorageConfig(root)).toThrow(variable);
		});
	});

	it.each(INVALID_REGISTRY_ORIGINS)(
		"rejects malformed process-env registry origin without leaking its value: %s",
		(value) => {
			withIsolatedConfigEnv(() => {
				const root = mkdtempSync(join(tmpdir(), "pi-config-invalid-registry-process-"));
				process.env.PI_BUILD_REGISTRY_ORIGINS = value;

				try {
					loadStorageConfig(root);
					throw new Error("expected malformed registry origin to be rejected");
				} catch (error) {
					expect(String(error)).toBe(INVALID_REGISTRY_MESSAGE);
				}
			});
		},
	);

	it.each(INVALID_REGISTRY_ORIGINS)(
		"rejects malformed env-file registry origin without leaking its value: %s",
		(value) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-config-invalid-registry-file-"));
			try {
				withIsolatedConfigEnv(() => {
					writeFileSync(join(dir, ".env"), `PI_BUILD_REGISTRY_ORIGINS=${value}\n`);

					try {
						loadStorageConfig(dir);
						throw new Error("expected malformed registry origin to be rejected");
					} catch (error) {
						expect(String(error)).toBe(INVALID_REGISTRY_MESSAGE);
					}
				});
			} finally {
				rmSync(dir, { force: true, recursive: true });
			}
		},
	);

	it("loads all agent v2 runtime overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-agent-v2-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(
					join(dir, ".env"),
					[
						"PI_RUNTIME_STORE=postgres",
						"PI_POSTGRES_URL=postgres://pi:secret@postgres:5432/pi_coding",
						"PI_AGENT_V2_RUN_QUEUE_NAME=custom-agent-v2-runs",
						"PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN=2500",
						"PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS=900",
					].join("\n"),
				);

				const config = loadStorageConfig(dir);

				expect(config.runtimeStore).toBe("postgres");
				expect(config.postgresUrl).toBe("postgres://pi:secret@postgres:5432/pi_coding");
				expect(config.agentV2).toEqual({
					queueName: "custom-agent-v2-runs",
					eventStreamMaxLen: 2500,
					eventStreamTtlSeconds: 900,
				});
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("prefers process env for all agent v2 runtime overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-config-agent-v2-precedence-"));
		try {
			withIsolatedConfigEnv(() => {
				writeFileSync(
					join(dir, ".env"),
					[
						"PI_AGENT_V2_RUN_QUEUE_NAME=file-agent-v2-runs",
						"PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN=1111",
						"PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS=2222",
					].join("\n"),
				);
				process.env.PI_AGENT_V2_RUN_QUEUE_NAME = "process-agent-v2-runs";
				process.env.PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN = "3333";
				process.env.PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS = "4444";

				expect(loadStorageConfig(dir).agentV2).toEqual({
					queueName: "process-agent-v2-runs",
					eventStreamMaxLen: 3333,
					eventStreamTtlSeconds: 4444,
				});
			});
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
