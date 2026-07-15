import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentV2Readiness, AgentV2ReadinessGate, type AgentV2ReadinessReport } from "../src/agent-v2-readiness.js";
import { AGENT_V2_RESET_CONFIRMATION, resetAgentV2RuntimeData } from "../src/agent-v2-reset.js";
import { loadStorageConfig } from "../src/config.js";
import { API_PREFIX, PREVIEW_PREFIX } from "../src/constants.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { createAgentV2RuntimeStore } from "../src/runtime-store-factory.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const testRoots: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const root of testRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("createAgentV2RuntimeStore", () => {
	it("creates a Postgres runtime store by default", () => {
		const store = createAgentV2RuntimeStore(createRuntimeConfig("postgres"));

		expect(store).toBeInstanceOf(PostgresRuntimeStore);
	});

	it("creates a SQLite runtime store when configured", () => {
		const store = createAgentV2RuntimeStore(createRuntimeConfig("sqlite"));

		expect(store).toBeInstanceOf(RuntimeDbStore);
		store.close();
	});

	it("exposes every v2 production capability through the composite store", () => {
		const store = createAgentV2RuntimeStore(createRuntimeConfig("sqlite"));
		const capabilities = [
			"ensureAgentV2Schema",
			"createAgentV2Run",
			"getAgentV2Run",
			"listAgentV2Runs",
			"updateAgentV2Run",
			"updateAgentV2RunWithResult",
			"listAgentV2RunsByWorker",
			"appendAgentV2RunEvent",
			"listAgentV2RunEvents",
			"listAgentV2Tasks",
			"listAgentV2Artifacts",
			"listAgentV2Documents",
			"listAgentV2Diagnostics",
			"upsertAgentV2Task",
			"upsertAgentV2Artifact",
			"appendAgentV2ValidationAttempt",
			"appendAgentV2Diagnostic",
			"commitAgentV2RunStart",
			"commitAgentV2RunCancel",
			"commitAgentV2RunTransition",
			"commitAgentV2ExecutionMutation",
			"commitAgentV2Diagnostic",
			"listAgentV2InputReferences",
			"readAgentV2InputBlob",
			"leaseAgentV2Outbox",
			"markAgentV2OutboxDelivered",
			"rescheduleAgentV2Outbox",
			"resetAgentV2RuntimeData",
			"close",
		] as const;

		for (const capability of capabilities) expect(store[capability], capability).toBeTypeOf("function");
		store.close();
	});

	it("resets v2 runtime data through the SQLite reset rehearsal path", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-reset-rehearsal-"));
		let store: RuntimeDbStore | undefined;
		try {
			const config = { ...loadStorageConfig(root), runtimeStore: "sqlite" as const };
			const createdStore = createAgentV2RuntimeStore(config);
			if (!(createdStore instanceof RuntimeDbStore)) throw new Error("expected SQLite runtime store");
			store = createdStore;
			store.ensureAgentV2Schema();
			store.createAgentV2Run({
				clientId: "client-a",
				runId: "run-reset-rehearsal",
				input: { prompt: "reset me", sessionId: "session-a", title: "Reset" },
				model: { provider: "test" },
				createdAt: "2026-07-09T02:00:00.000Z",
			});

			const result = resetAgentV2RuntimeData(store, { confirmation: AGENT_V2_RESET_CONFIRMATION });

			expect(result.runsDeleted).toBe(1);
			expect(store.listAgentV2Runs("client-a")).toEqual([]);
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function createRuntimeConfig(runtimeStore: "postgres" | "sqlite"): StorageConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-runtime-store-"));
	testRoots.push(root);
	return {
		...loadStorageConfig(root),
		runtimeStore,
		postgresUrl: "postgres://user:pass@example.com:5432/pi",
	};
}

describe("configured storage plugin agent v2 schema initialization", () => {
	it("awaits runtime schema initialization before registering preview routes", async () => {
		const schemaReady = deferred<void>();
		const harness = createPluginHarness({
			ensureAgentV2Schema: () => schemaReady.promise,
		});

		expect(harness.ensureAgentV2Schema).toHaveBeenCalledTimes(1);
		await flushMicrotasks();
		expect(harness.servePreviewRequest).not.toHaveBeenCalled();
		expect(harness.registered()).toBe(false);

		schemaReady.resolve();
		await harness.startup;
		const request = dispatch(harness.middleware(), `${PREVIEW_PREFIX}/project-1/`);
		await request.done;

		expect(harness.servePreviewRequest).toHaveBeenCalledTimes(1);
		expect(request.response.ended).toBe(true);
		expect(request.nextCalled()).toBe(false);
	});

	it("awaits runtime schema initialization before registering storage API routes", async () => {
		const schemaReady = deferred<void>();
		const harness = createPluginHarness({
			ensureAgentV2Schema: () => schemaReady.promise,
		});

		expect(harness.ensureAgentV2Schema).toHaveBeenCalledTimes(1);
		await flushMicrotasks();
		expect(harness.registered()).toBe(false);

		schemaReady.resolve();
		await harness.startup;
		const request = dispatch(harness.middleware(), `${API_PREFIX}/status`);
		await request.done;

		expect(request.response.statusCode).toBe(200);
		expect(JSON.parse(request.response.body)).toMatchObject({ configured: true });
		expect(request.nextCalled()).toBe(false);
	});

	it("surfaces runtime schema initialization failure without registering routes", async () => {
		const firstSchemaReady = deferred<void>();
		const ensureAgentV2Schema = vi.fn(() => firstSchemaReady.promise);
		const harness = createPluginHarness({ ensureAgentV2Schema });

		expect(ensureAgentV2Schema).toHaveBeenCalledTimes(1);
		firstSchemaReady.reject(new Error("schema unavailable"));
		await expect(harness.startup).rejects.toThrow("schema unavailable");
		expect(harness.registered()).toBe(false);
	});
});

describe("configured storage plugin run event bus lifecycle", () => {
	it("closes the run event bus once when the dev server closes", async () => {
		const harness = createPluginLifecycleHarness();
		const server = new FakeViteServer();

		await harness.configureServer(server);
		server.close();
		server.close();
		await harness.closeBundle();

		expect(harness.agentV2RunEventBusClose).toHaveBeenCalledTimes(1);
	});

	it("closes the run event bus once when the preview server closes", async () => {
		const harness = createPluginLifecycleHarness();
		const server = new FakeViteServer();

		await harness.configurePreviewServer(server);
		server.close();
		server.close();
		await harness.closeBundle();

		expect(harness.agentV2RunEventBusClose).toHaveBeenCalledTimes(1);
	});

	it("awaits an aborted background readiness refresh before closing bus, queue, and store", async () => {
		vi.useFakeTimers();
		const refresh = deferred<AgentV2ReadinessReport>();
		const gate = new AgentV2ReadinessGate(new AgentV2Readiness([]));
		let checks = 0;
		let refreshSignal: AbortSignal | undefined;
		vi.spyOn(gate, "check").mockImplementation((signal) => {
			checks += 1;
			if (checks === 1) {
				return Promise.resolve({ ready: true, checkedAt: "2026-07-15T00:00:00.000Z", dependencies: [] });
			}
			refreshSignal = signal;
			return refresh.promise;
		});
		const closeOrder: string[] = [];
		const services = createPluginServices({ ensureAgentV2Schema: vi.fn() });
		services.agentV2ReadinessGate = gate;
		services.runtimeDb.close = vi.fn(() => {
			closeOrder.push("store");
		});
		services.agentV2RunEventBus!.close = vi.fn(async () => {
			closeOrder.push("event_bus");
		});
		services.agentV2RunQueue = {
			close: vi.fn(async () => {
				closeOrder.push("queue");
			}),
		} as unknown as NonNullable<TestServices["agentV2RunQueue"]>;
		const plugin = createConfiguredStoragePluginForTest(services);
		const server = new FakeViteServer();
		await (plugin.configureServer as unknown as (server: FakeViteServer) => Promise<void>)(server);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(checks).toBe(2);

		const closing = (plugin.closeBundle as () => Promise<void>)();
		for (let turn = 0; turn < 16; turn += 1) await flushMicrotasks();
		expect(refreshSignal?.aborted).toBe(true);
		expect(closeOrder).toEqual([]);

		refresh.resolve({
			ready: false,
			checkedAt: "2026-07-15T00:00:01.000Z",
			dependencies: [{ name: "store", ready: false, code: "agent_v2.readiness_aborted", message: "aborted" }],
		});
		await closing;
		expect(closeOrder).toEqual(["event_bus", "queue", "store"]);
	});
});

type TestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

function createPluginHarness(options: { ensureAgentV2Schema: () => void | Promise<void> }) {
	let middleware: Middleware | undefined;
	const ensureAgentV2Schema = vi.fn(options.ensureAgentV2Schema);
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
		runtimeDb: { ensureAgentV2Schema, ping: vi.fn(async () => undefined) } as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		agentV2RunEventBus: {
			ping: vi.fn(async () => undefined),
			project: vi.fn(),
			read: vi.fn(),
			close: vi.fn(),
		} as unknown as TestServices["agentV2RunEventBus"],
	};
	const plugin = createConfiguredStoragePluginForTest(services);
	const configureServer = plugin.configureServer as (server: {
		middlewares: { use(handler: Middleware): void };
	}) => Promise<void>;

	const startup = configureServer({
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});

	return {
		ensureAgentV2Schema,
		middleware: () => {
			if (!middleware) throw new Error("configured storage plugin did not register middleware");
			return middleware;
		},
		registered: () => middleware !== undefined,
		servePreviewRequest,
		startup,
	};
}

function createPluginLifecycleHarness() {
	const services = createPluginServices({ ensureAgentV2Schema: vi.fn() });
	const plugin = createConfiguredStoragePluginForTest(services);
	return {
		configurePreviewServer: plugin.configurePreviewServer as unknown as (server: FakeViteServer) => Promise<void>,
		configureServer: plugin.configureServer as unknown as (server: FakeViteServer) => Promise<void>,
		agentV2RunEventBusClose: services.agentV2RunEventBus!.close,
		closeBundle: plugin.closeBundle as () => Promise<void>,
	};
}

function createPluginServices(options: { ensureAgentV2Schema: () => void | Promise<void> }): TestServices {
	return {
		config: createTestConfig(),
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
			flushLangfuse: vi.fn(async () => undefined),
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
		runtimeDb: {
			ensureAgentV2Schema: options.ensureAgentV2Schema,
			ping: vi.fn(async () => undefined),
		} as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		agentV2RunEventBus: {
			ping: vi.fn(async () => undefined),
			project: vi.fn(),
			read: vi.fn(),
			close: vi.fn(),
		} as unknown as TestServices["agentV2RunEventBus"],
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
		workerId: "test-worker",
		workerConcurrency: 1,
		agentV2: {
			queueName: "pi:agent-v2:runs",
			eventStreamMaxLen: 5000,
			eventStreamTtlSeconds: 3600,
		},
		clientIdRequired: false,
		previewBaseUrl: "",
		previewInternalOrigin: "http://127.0.0.1:5173",
		containerBuild: {
			engine: "docker",
			image: "node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752",
			proxyImage: "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
			timeoutMs: 120000,
			cpus: 1,
			memoryMb: 512,
			pidsLimit: 128,
			maxLogChars: 12000,
			registryOrigins: ["https://registry.npmjs.org"],
		},
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
