import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Connect } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";
import { WorkspaceFileService } from "../src/workspace-file-service.js";
import { projectDirectory, projectSlug } from "../src/workspace-paths.js";
import { WorkspacePreviewService } from "../src/workspace-preview-service.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";

describe("workspace client isolation and path safety", () => {
	const clientA = "11111111-1111-4111-8111-111111111111";
	const clientB = "22222222-2222-4222-8222-222222222222";
	let root: string;
	let config: StorageConfig;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-workspace-isolation-"));
		config = testConfig(root);
	});

	afterEach(() => {
		rmSync(root, { force: true, recursive: true });
	});

	it("isolates configured sessions while sharing provider settings globally", () => {
		const sessions = new WorkspaceSessionService(config);
		sessions.ensureDirs();

		sessions.writeSettings({ currentSessionId: "session-1", providerKeys: { openai: "global-key" } }, "client-a");
		sessions.writeSettings({ currentSessionId: "session-2" }, "client-b");

		expect(sessions.readSettings("client-a")).toMatchObject({
			currentSessionId: "session-1",
			providerKeys: { openai: "global-key" },
		});
		expect(sessions.readSettings("client-b")).toMatchObject({
			currentSessionId: "session-2",
			providerKeys: { openai: "global-key" },
		});
		expect(sessions.readSettings()).toMatchObject({
			providerKeys: { openai: "global-key" },
		});
		expect(existsSync(join(root, "data", "sessions"))).toBe(false);
		expect(existsSync(join(config.clientsRootDir, "client-a", "settings.json"))).toBe(true);
	});

	it("rejects unsafe client ids for client settings paths", () => {
		const sessions = new WorkspaceSessionService(config);

		expect(() => sessions.writeSettings({ currentSessionId: "session-1" }, "/")).toThrow("Invalid client id");
		expect(existsSync(resolve(root, "settings.json"))).toBe(false);
	});

	it("isolates project workspaces by client id for the same session and title", () => {
		const files = new WorkspaceFileService(config);

		const created = files.handle({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Shared title",
			command: "create",
			filename: "index.html",
			content: "client-a",
		});

		expect(created.projectRoot).toBe(join(config.clientsRootDir, "client-a", "sessions", "session-1", "project"));
		expect(existsSync(join(root, "data", "projects", String(created.projectId)))).toBe(false);
		expect(
			files.handle({ clientId: "client-a", sessionId: "session-1", title: "Shared title", command: "list" }).files,
		).toEqual(["index.html"]);
		expect(
			files.handle({ clientId: "client-b", sessionId: "session-1", title: "Shared title", command: "list" }).files,
		).toEqual([]);
	});

	it("rejects project workspace ids that cannot produce a safe path component", () => {
		const files = new WorkspaceFileService(config);

		expect(() =>
			files.handle({ clientId: "client-a", sessionId: "/", title: "Shared title", command: "list" }),
		).toThrow("Invalid session id");
	});

	it("rejects file reads and writes through an escaping junction", () => {
		const files = new WorkspaceFileService(config);
		const projectDir = projectDirectory(config.clientsRootDir, "session-1", "client-a");
		const outside = join(root, "outside");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
		symlinkSync(outside, join(projectDir, "linked"), process.platform === "win32" ? "junction" : "dir");

		expect(() =>
			files.handle({
				clientId: "client-a",
				sessionId: "session-1",
				title: "Shared title",
				command: "get",
				filename: "linked/secret.txt",
			}),
		).toThrow();
		expect(() =>
			files.handle({
				clientId: "client-a",
				sessionId: "session-1",
				title: "Shared title",
				command: "rewrite",
				filename: "linked/secret.txt",
				content: "overwritten",
			}),
		).toThrow();
		expect(() =>
			files.handle({
				clientId: "client-a",
				sessionId: "session-1",
				title: "Shared title",
				command: "create",
				filename: "linked/new.txt",
				content: "created",
			}),
		).toThrow();
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
	});

	it("derives project workspace ids only from client and session ids", () => {
		const projectId = projectSlug("session-1", "client-a");

		expect(projectId).toBe("project-client-a-session-");
		expect(projectSlug("session-1", "client-b")).not.toBe(projectId);
		const stableProjectDir = projectDirectory(config.clientsRootDir, "session-1", "client-a");
		expect(stableProjectDir).toBe(join(config.clientsRootDir, "client-a", "sessions", "session-1", "project"));
		expect(stableProjectDir).not.toContain("Snake");
		expect(stableProjectDir).not.toContain("生成");
		expect(projectDirectory(config.clientsRootDir, "session-1", "client-b")).not.toBe(stableProjectDir);
	});

	it("does not migrate or read legacy flat project directories", () => {
		const files = new WorkspaceFileService(config);
		const legacyProjectDir = join(root, "data", "projects", "snake-game-client-a-session-");
		const stableProjectDir = projectDirectory(config.clientsRootDir, "session-1", "client-a");
		mkdirSync(legacyProjectDir, { recursive: true });
		writeFileSync(join(legacyProjectDir, "index.html"), "<h1>legacy</h1>", "utf8");

		const result = files.handle({
			clientId: "client-a",
			sessionId: "session-1",
			title: "新的中文标题",
			command: "list",
		});

		expect(result.files).toEqual([]);
		expect(existsSync(join(stableProjectDir, "index.html"))).toBe(false);
		expect(existsSync(legacyProjectDir)).toBe(true);
	});

	it("isolates project preview list, logs, and rename by client id", async () => {
		const files = new WorkspaceFileService(config);
		const previews = new WorkspacePreviewService(config);
		const req = { headers: { host: "localhost:5173", "x-forwarded-proto": "http" } };

		files.handle({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Shared title",
			command: "create",
			filename: "index.html",
			content: "<h1>client-a</h1>",
		});

		const preview = await previews.preview(
			{ clientId: "client-a", sessionId: "session-1", title: "Shared title" },
			req,
		);

		expect(preview.projectRoot).toBe(join(config.clientsRootDir, "client-a", "sessions", "session-1", "project"));
		expect(existsSync(join(String(preview.projectRoot), ".pi-project.json"))).toBe(true);
		expect(existsSync(join(root, "data", "projects", preview.projectId, ".pi-project.json"))).toBe(false);
		expect(previews.listProjects(req, "client-a").projects.map((project) => project.projectId)).toEqual([
			preview.projectId,
		]);
		expect(previews.listProjects(req, "client-b").projects).toEqual([]);
		expect(previews.readProjectLogs(preview.projectId, "client-b")).toEqual({ error: "Project not found." });
		expect(() => previews.renameProject(preview.projectId, "Client B rename", req, "client-b")).toThrow(
			"Project not found",
		);
		expect(previews.renameProject(preview.projectId, "Client A rename", req, "client-a").title).toBe(
			"Client A rename",
		);
	});

	it("uses the configured client id for batch project summaries instead of trusting the body", async () => {
		const files = new WorkspaceFileService(config);
		files.handle({
			clientId: clientA,
			sessionId: "session-1",
			title: "Client A App",
			command: "create",
			filename: "index.html",
			content: "<h1>client-a</h1>",
		});
		files.handle({
			clientId: clientB,
			sessionId: "session-1",
			title: "Client B App",
			command: "create",
			filename: "index.html",
			content: "<h1>client-b</h1>",
		});
		files.handle({
			clientId: clientB,
			sessionId: "session-1",
			title: "Client B App",
			command: "create",
			filename: "secret.js",
			content: "export const secret = true;",
		});
		const harness = await createProjectsApiHarness(config, files);

		const response = await dispatchJson(harness.middleware, "/api/pi-projects/batch-summary", {
			headers: { "x-pi-client-id": clientA },
			body: {
				clientId: clientB,
				sessions: [
					{ clientId: clientB, sessionId: "session-1", title: "Client A App" },
					{ sessionId: "", title: "ignored" },
				],
			},
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({
			summaries: [
				{
					projectId: projectSlug("session-1", clientA),
					sessionId: "session-1",
					title: "Client A App",
					fileCount: 1,
				},
			],
		});
		expect(response.body).not.toContain(clientB);
		expect(response.body).not.toContain("secret.js");
		expect(response.body).not.toContain("projectRoot");
	});

	it("filters diagnostic events by client id", () => {
		const diagnostics = new WorkspaceDiagnosticLogService(config);
		diagnostics.ensureDirs();

		try {
			diagnostics.writeEvents({
				events: [
					{ eventType: "client-a-event", data: { clientId: "client-a" } },
					{ eventType: "client-b-event", data: { clientId: "client-b" } },
				],
			});

			expect(diagnostics.queryEvents({ clientId: "client-a" }).events.map((event) => event.eventType)).toEqual([
				"client-a-event",
			]);
			expect(diagnostics.queryEvents({ clientId: "client-b" }).events.map((event) => event.eventType)).toEqual([
				"client-b-event",
			]);
		} finally {
			diagnostics.close();
		}
	});
});

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
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

type TestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

async function createProjectsApiHarness(
	config: StorageConfig,
	files: WorkspaceFileService,
): Promise<{ middleware: Middleware }> {
	let middleware: Middleware | undefined;
	const services = {
		config,
		diagnostics: {
			ensureDirs() {},
			writeEvents() {},
		} as unknown as TestServices["diagnostics"],
		sessions: new WorkspaceSessionService(config),
		files,
		previews: new WorkspacePreviewService(config),
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: {
			ensureAgentV2Schema: async () => undefined,
			ping: async () => undefined,
		} as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
	} satisfies TestServices;
	const plugin = createConfiguredStoragePluginForTest(services);
	const configureServer = plugin.configureServer as (server: {
		middlewares: { use(handler: Middleware): void };
	}) => Promise<void>;
	await configureServer({
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});
	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return { middleware };
}

async function dispatchJson(
	middleware: Middleware,
	url: string,
	options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<FakeResponse> {
	const request = new FakeRequest(url, options);
	const response = new FakeResponse();
	const done = Promise.resolve(
		middleware(request as unknown as Connect.IncomingMessage, response as unknown as ServerResponse, () => undefined),
	);
	await done;
	return response;
}

class FakeRequest extends EventEmitter {
	readonly method = "POST";
	readonly headers: Record<string, string>;
	private readonly rawBody: string;
	private flushed = false;

	constructor(
		readonly url: string,
		options: { headers?: Record<string, string>; body?: unknown },
	) {
		super();
		this.headers = options.headers || {};
		this.rawBody = JSON.stringify(options.body || {});
	}

	setEncoding(_encoding: BufferEncoding): void {}

	override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
		super.on(eventName, listener);
		if (
			(eventName === "data" || eventName === "end") &&
			this.listenerCount("data") > 0 &&
			this.listenerCount("end") > 0
		) {
			queueMicrotask(() => this.flush());
		}
		return this;
	}

	private flush(): void {
		if (this.flushed) return;
		this.flushed = true;
		this.emit("data", this.rawBody);
		this.emit("end");
	}
}

class FakeResponse {
	statusCode = 200;
	body = "";
	readonly headers = new Map<string, number | string | readonly string[]>();

	setHeader(name: string, value: number | string | readonly string[]): this {
		this.headers.set(name, value);
		return this;
	}

	end(chunk?: unknown): this {
		if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return this;
	}
}
