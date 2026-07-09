import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PREFIX, PREVIEW_PREFIX } from "../src/constants.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { createRuntimeStore } from "../src/runtime-store-factory.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const baseConfig = {
	runtimeStore: "postgres" as const,
	postgresUrl: "postgres://user:pass@example.com:5432/pi",
	runtimeDbFile: "/tmp/pi-runtime.sqlite",
};

const testRoots: string[] = [];

afterEach(() => {
	for (const root of testRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("createRuntimeStore", () => {
	it("creates a Postgres runtime store by default", () => {
		const store = createRuntimeStore(baseConfig);

		expect(store).toBeInstanceOf(PostgresRuntimeStore);
	});

	it("creates a SQLite runtime store when configured", () => {
		const store = createRuntimeStore({ ...baseConfig, runtimeStore: "sqlite" });

		expect(store).toBeInstanceOf(RuntimeDbStore);
	});
});

describe("configured storage plugin runtime schema initialization", () => {
	it("awaits runtime schema initialization before serving preview requests", async () => {
		const schemaReady = deferred<void>();
		const harness = createPluginHarness({
			ensureSchema: () => schemaReady.promise,
		});

		const request = dispatch(harness.middleware, `${PREVIEW_PREFIX}/project-1/`);

		expect(harness.ensureSchema).toHaveBeenCalledTimes(1);
		await flushMicrotasks();
		expect(harness.servePreviewRequest).not.toHaveBeenCalled();
		expect(request.response.ended).toBe(false);

		schemaReady.resolve();
		await request.done;

		expect(harness.servePreviewRequest).toHaveBeenCalledTimes(1);
		expect(request.response.ended).toBe(true);
		expect(request.nextCalled()).toBe(false);
	});

	it("awaits runtime schema initialization before handling storage API requests", async () => {
		const schemaReady = deferred<void>();
		const harness = createPluginHarness({
			ensureSchema: () => schemaReady.promise,
		});

		const request = dispatch(harness.middleware, `${API_PREFIX}/status`);

		expect(harness.ensureSchema).toHaveBeenCalledTimes(1);
		await flushMicrotasks();
		expect(request.response.ended).toBe(false);

		schemaReady.resolve();
		await request.done;

		expect(request.response.statusCode).toBe(200);
		expect(JSON.parse(request.response.body)).toMatchObject({ configured: true });
		expect(request.nextCalled()).toBe(false);
	});

	it("retries runtime schema initialization after the cached promise rejects", async () => {
		const firstSchemaReady = deferred<void>();
		const secondSchemaReady = deferred<void>();
		const ensureSchema = vi.fn(() => {
			const next = ensureSchema.mock.calls.length === 1 ? firstSchemaReady : secondSchemaReady;
			return next.promise;
		});
		const harness = createPluginHarness({ ensureSchema });

		const firstRequest = dispatch(harness.middleware, `${API_PREFIX}/status`);
		expect(ensureSchema).toHaveBeenCalledTimes(1);
		firstSchemaReady.reject(new Error("schema unavailable"));
		await firstRequest.done;
		expect(firstRequest.response.statusCode).toBe(500);
		expect(JSON.parse(firstRequest.response.body)).toEqual({ error: "schema unavailable" });

		const secondRequest = dispatch(harness.middleware, `${API_PREFIX}/status`);

		expect(ensureSchema).toHaveBeenCalledTimes(2);
		await flushMicrotasks();
		expect(secondRequest.response.ended).toBe(false);

		secondSchemaReady.resolve();
		await secondRequest.done;

		expect(secondRequest.response.statusCode).toBe(200);
		expect(JSON.parse(secondRequest.response.body)).toMatchObject({ configured: true });
	});
});

describe("configured storage plugin run event bus lifecycle", () => {
	it("closes the run event bus once when the dev server closes", async () => {
		const harness = createPluginLifecycleHarness();
		const server = new FakeViteServer();

		harness.configureServer(server);
		server.close();
		server.close();
		await flushMicrotasks();

		expect(harness.runEventBusClose).toHaveBeenCalledTimes(1);
	});

	it("closes the run event bus once when the preview server closes", async () => {
		const harness = createPluginLifecycleHarness();
		const server = new FakeViteServer();

		harness.configurePreviewServer(server);
		server.close();
		server.close();
		await flushMicrotasks();

		expect(harness.runEventBusClose).toHaveBeenCalledTimes(1);
	});
});

type TestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

function createPluginHarness(options: { ensureSchema: () => void | Promise<void> }) {
	let middleware: Middleware | undefined;
	const ensureSchema = vi.fn(options.ensureSchema);
	const servePreviewRequest = vi.fn((_: Connect.IncomingMessage, res: ServerResponse) => {
		res.statusCode = 204;
		res.end();
		return true;
	});
	const services: TestServices = {
		config: createTestConfig(),
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
		} as unknown as TestServices["diagnostics"],
		sessions: {
			ensureDirs: vi.fn(),
			readSettings: vi.fn(),
			writeSettings: vi.fn(),
		} as unknown as TestServices["sessions"],
		files: {} as TestServices["files"],
		previews: { servePreviewRequest } as unknown as TestServices["previews"],
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: { ensureSchema } as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		runApi: {} as TestServices["runApi"],
		runEventBus: {
			publish: vi.fn(),
			read: vi.fn(),
			close: vi.fn(),
		} as unknown as TestServices["runEventBus"],
	};
	const plugin = createConfiguredStoragePluginForTest(services);
	const configureServer = plugin.configureServer as (server: {
		middlewares: { use(handler: Middleware): void };
	}) => void;

	configureServer({
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});

	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return { ensureSchema, middleware, servePreviewRequest };
}

function createPluginLifecycleHarness() {
	const services = createPluginServices({ ensureSchema: vi.fn() });
	const plugin = createConfiguredStoragePluginForTest(services);
	return {
		configurePreviewServer: plugin.configurePreviewServer as unknown as (server: FakeViteServer) => void,
		configureServer: plugin.configureServer as unknown as (server: FakeViteServer) => void,
		runEventBusClose: services.runEventBus!.close,
	};
}

function createPluginServices(options: { ensureSchema: () => void | Promise<void> }): TestServices {
	return {
		config: createTestConfig(),
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
		} as unknown as TestServices["diagnostics"],
		sessions: {
			ensureDirs: vi.fn(),
			readSettings: vi.fn(),
			writeSettings: vi.fn(),
		} as unknown as TestServices["sessions"],
		files: {} as TestServices["files"],
		previews: { servePreviewRequest: vi.fn(() => false) } as unknown as TestServices["previews"],
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: { ensureSchema: options.ensureSchema } as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		runApi: {} as TestServices["runApi"],
		runEventBus: {
			publish: vi.fn(),
			read: vi.fn(),
			close: vi.fn(),
		} as unknown as TestServices["runEventBus"],
	};
}

class FakeViteServer {
	readonly httpServer = new EventEmitter();
	readonly middlewares = {
		use: vi.fn(),
	};

	close(): void {
		this.httpServer.emit("close");
	}
}

function createTestConfig(): StorageConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-web-workspace-"));
	testRoots.push(root);
	return {
		settingsFile: join(root, "settings.json"),
		clientsRootDir: join(root, "clients"),
		skillsDir: join(root, "skills"),
		defaultSkillsDir: join(root, "default-skills"),
		runtimeDbFile: join(root, "runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "sqlite",
		postgresUrl: "postgres://user:pass@example.com:5432/pi",
		runsEnabled: true,
		workerId: "test-worker",
		workerConcurrency: 1,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "test-runs",
		agentV2RunQueueName: "pi:agent-v2:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 100,
		runEventStreamTtlSeconds: 60,
		agentV2RunEventStreamMaxLen: 5000,
		agentV2RunEventStreamTtlSeconds: 3600,
		runEventCheckpointIntervalMs: 100,
		runEventCheckpointMinChars: 16,
		clientIdRequired: false,
		previewBaseUrl: "",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 1_000,
		projectBuildTimeoutMs: 1_000,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "logs.sqlite"),
		loggingEnabled: false,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 1_000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 1_000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 1_000,
		modelStreamIdleTimeoutMs: 60_000,
		modelMaxOutputTokens: 12_000,
		contextProviderPayloadBudgetChars: 90_000,
		logRetentionDays: 30,
		logMaxEvents: 1_000,
		logCleanupIntervalMs: 3_600_000,
		logVacuumIntervalMs: 86_400_000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 1_000,
		langfuseBatchSize: 10,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web-test",
		otelDeploymentEnvironment: "",
	};
}

function dispatch(middleware: Middleware, url: string) {
	const response = new FakeResponse();
	let nextCalled = false;
	const done = Promise.resolve(
		middleware(createRequest(url), response as unknown as ServerResponse, () => {
			nextCalled = true;
		}),
	);
	return { done, nextCalled: () => nextCalled, response };
}

function createRequest(url: string): Connect.IncomingMessage {
	return {
		url,
		method: "GET",
		headers: {},
		on() {
			return this;
		},
	} as unknown as Connect.IncomingMessage;
}

class FakeResponse {
	statusCode = 200;
	ended = false;
	body = "";
	private readonly headers = new Map<string, number | string | readonly string[]>();

	setHeader(name: string, value: number | string | readonly string[]): this {
		this.headers.set(name, value);
		return this;
	}

	end(chunk?: unknown): this {
		if (chunk !== undefined) {
			this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		}
		this.ended = true;
		return this;
	}
}

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
}
