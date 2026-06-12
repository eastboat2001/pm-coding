import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import type { StorageConfig } from "../src/types.js";
import { WorkspaceFileService } from "../src/workspace-file-service.js";
import { WorkspacePreviewService } from "../src/workspace-preview-service.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";

describe("workspace client isolation and path safety", () => {
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

		sessions.writeSession(
			"session-1",
			sessionData("session-1", "Client A"),
			sessionMetadata("session-1", "Client A"),
			"client-a",
		);
		sessions.writeSettings({ currentSessionId: "session-1", providerKeys: { openai: "global-key" } }, "client-a");
		sessions.writeSettings({ currentSessionId: "session-2" }, "client-b");

		expect(sessions.readSession("session-1", "client-a")?.metadata).toMatchObject({ title: "Client A" });
		expect(sessions.readSession("session-1", "client-b")).toBeUndefined();
		expect(sessions.listSessions("client-a").map((session) => session.id)).toEqual(["session-1"]);
		expect(sessions.listSessions("client-b")).toEqual([]);
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
	});

	it("rejects unsafe legacy session ids instead of falling back to the raw id", () => {
		const sessions = new WorkspaceSessionService(config);

		expect(() => sessions.readSession("/", "client-a")).toThrow("Invalid session id");
		expect(() =>
			sessions.writeSession("/", sessionData("/", "Escape"), sessionMetadata("/", "Escape"), "client-a"),
		).toThrow("Invalid session id");
		expect(existsSync(resolve(root, ".json"))).toBe(false);
	});

	it("isolates project workspaces by client id for the same session and title", () => {
		const files = new WorkspaceFileService(config);

		files.handle({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Shared title",
			command: "create",
			filename: "index.html",
			content: "client-a",
		});

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

function sessionData(id: string, title: string) {
	return { id, title, messages: [] };
}

function sessionMetadata(id: string, title: string) {
	return { id, title, lastModified: "2026-06-11T00:00:00.000Z" };
}

function testConfig(root: string): StorageConfig {
	return {
		sessionsDir: join(root, "data", "sessions"),
		settingsFile: join(root, "data", "settings.json"),
		projectsRootDir: join(root, "data", "projects"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runsEnabled: false,
		workerId: "test-worker",
		workerConcurrency: 2,
		runQueueName: "pi:runs",
		runEventRetentionDays: 30,
		clientIdRequired: true,
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		serverSessionSyncEnabled: false,
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
