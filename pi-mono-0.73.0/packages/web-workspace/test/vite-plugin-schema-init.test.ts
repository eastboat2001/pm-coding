import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

describe("configured storage plugin schema init", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { force: true, recursive: true });
		root = undefined;
	});

	it("initializes only the agent v2 schema before handling API routes", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-vite-plugin-schema-init-"));
		const calls: string[] = [];
		const middleware = createMiddleware(testConfig(root), calls);

		const response = await dispatch(middleware, "/api/pi-skills/unknown");

		expect(response.statusCode).toBe(404);
		expect(calls).toEqual(["ensureAgentV2Schema"]);
	});

	it("defers schema initialization until a non-retired API request", async () => {
		root = mkdtempSync(join(tmpdir(), "pi-vite-plugin-schema-init-"));
		const calls: string[] = [];
		const middleware = createMiddleware(testConfig(root), calls);

		expect(calls).toEqual([]);

		const retiredResponse = await dispatch(middleware, "/api/runtime/runs/retired-run/events");
		expect(retiredResponse.statusCode).toBe(410);
		expect(JSON.parse(retiredResponse.body)).toEqual({
			error: "Application Generation Agent v1 runtime routes have been removed.",
		});
		expect(calls).toEqual([]);

		const activeResponse = await dispatch(middleware, "/api/pi-skills/unknown");
		expect(activeResponse.statusCode).toBe(404);
		expect(calls).toEqual(["ensureAgentV2Schema"]);
	});
});

type TestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

function createMiddleware(config: StorageConfig, calls: string[]): Middleware {
	let middleware: Middleware | undefined;
	const plugin = createConfiguredStoragePluginForTest(
		createSchemaInitServices(config, {
			async ensureAgentV2Schema() {
				calls.push("ensureAgentV2Schema");
			},
		}),
	);
	const configureServer = plugin.configureServer as (server: {
		middlewares: { use(handler: Middleware): void };
	}) => void;
	configureServer(
		createFakeServer((handler) => {
			middleware = handler;
		}),
	);
	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return middleware;
}

function createSchemaInitServices(
	config: StorageConfig,
	runtimeDb: Pick<TestServices["runtimeDb"], "ensureAgentV2Schema">,
): TestServices {
	return {
		config,
		diagnostics: {
			ensureDirs() {},
			writeEvents() {},
		} as unknown as TestServices["diagnostics"],
		sessions: {
			ensureDirs() {},
		} as unknown as TestServices["sessions"],
		files: {} as TestServices["files"],
		previews: {
			servePreviewRequest() {
				return false;
			},
		} as unknown as TestServices["previews"],
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: runtimeDb as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
	};
}

function createFakeServer(onUse?: (handler: Middleware) => void): {
	middlewares: { use(handler: Middleware): void };
} {
	return {
		middlewares: {
			use(handler) {
				onUse?.(handler);
			},
		},
	};
}

async function dispatch(middleware: Middleware, url: string): Promise<FakeResponse> {
	const response = new FakeResponse();
	await Promise.resolve(
		middleware(
			new FakeRequest(url) as unknown as Connect.IncomingMessage,
			response as unknown as ServerResponse,
			() => {
				throw new Error("next should not be called for API routes");
			},
		),
	);
	return response;
}

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "postgres",
		postgresUrl: "postgres://pi:pi@postgres:5432/pi_coding",
		workerId: "test-worker",
		workerConcurrency: 2,
		agentV2: {
			queueName: "pi:agent-v2:runs",
			eventStreamMaxLen: 5000,
			eventStreamTtlSeconds: 3600,
		},
		clientIdRequired: true,
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "data", "logs", "pi-diagnostics.sqlite"),
		loggingEnabled: true,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 12000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 20000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 20000,
		modelStreamIdleTimeoutMs: 60000,
		modelMaxOutputTokens: 12000,
		contextProviderPayloadBudgetChars: 90000,
		logRetentionDays: 30,
		logMaxEvents: 50000,
		logCleanupIntervalMs: 3600000,
		logVacuumIntervalMs: 86400000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 5000,
		langfuseBatchSize: 50,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
	};
}

class FakeRequest extends EventEmitter {
	readonly method = "POST";
	readonly headers: Record<string, string> = {};

	constructor(readonly url: string) {
		super();
	}
}

class FakeResponse {
	statusCode = 200;
	body = "";

	setHeader(_name: string, _value: number | string | readonly string[]): this {
		return this;
	}

	end(chunk?: unknown): this {
		if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return this;
	}
}
