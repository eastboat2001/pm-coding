import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { StorageConfig } from "../src/types.js";
import { WorkspaceFileService } from "../src/workspace-file-service.js";
import { projectDirectory } from "../src/workspace-paths.js";
import { WorkspacePreviewService } from "../src/workspace-preview-service.js";
import { WorkspaceTaskService } from "../src/workspace-task-service.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-hardening-"));
}

describe("project execution and preview hardening", () => {
	it("rejects build_static package script commands before executing the runner", async () => {
		const root = tempRoot();
		const config = { ...testConfig(root), projectInstallCommand: "", projectBuildCommand: "npm run build" };
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { build: "node build.js" } }), "utf8");

		const commands: string[] = [];
		const service = new WorkspaceTaskService(config, undefined, async (command) => {
			commands.push(command);
		});

		const result = await service.run({
			task: "build_static",
			clientId: "client-a",
			sessionId: "s1",
			title: "Hardening",
		});

		expect(commands).toEqual([]);
		expect(result.status).toBe("failed");
		expect(result.errors?.join("\n")).toContain("package scripts are not allowed");
	});

	it("does not serve internal preview metadata files", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const files = new WorkspaceFileService(config);
		const previews = new WorkspacePreviewService(config);
		const req = { headers: { host: "localhost:5173", "x-forwarded-proto": "http" } };
		files.handle({
			clientId: "client-a",
			sessionId: "s1",
			title: "Preview",
			command: "create",
			filename: "index.html",
			content: "<h1>ok</h1>",
		});
		const preview = await previews.preview({ clientId: "client-a", sessionId: "s1", title: "Preview" }, req);
		const res = new MockResponse();

		expect(
			previews.servePreviewRequest(
				{ url: `/preview/${encodeURIComponent(preview.projectId)}/.pi-project.json` } as IncomingMessage,
				res as unknown as ServerResponse,
			),
		).toBe(true);

		expect(res.statusCode).toBe(404);
		expect(res.body).not.toContain("projectRoot");
		expect(res.body).not.toContain("serveRoot");
	});

	it("truncates project_file get results for large files", () => {
		const root = tempRoot();
		const files = new WorkspaceFileService(testConfig(root));
		const content = "a".repeat(700 * 1024);
		files.handle({
			clientId: "client-a",
			sessionId: "s1",
			title: "Large File",
			command: "create",
			filename: "large.txt",
			content,
		});

		const result = files.handle({
			clientId: "client-a",
			sessionId: "s1",
			title: "Large File",
			command: "get",
			filename: "large.txt",
		});

		expect(result.content?.length).toBeLessThan(content.length);
		expect(result.truncated).toBe(true);
		expect(result.omittedBytes).toBeGreaterThan(0);
	});

	it("truncates build_static command logs", async () => {
		const root = tempRoot();
		const config = { ...testConfig(root), projectInstallCommand: "", projectBuildCommand: "node build.js" };
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
		const service = new WorkspaceTaskService(config, undefined, async (_command, _cwd, _timeoutMs, logs) => {
			logs.push("x".repeat(200_000));
			throw new Error("boom");
		});

		const result = await service.run({ task: "build_static", clientId: "client-a", sessionId: "s1", title: "Logs" });

		const logText = result.logs?.join("") ?? "";
		expect(logText.length).toBeLessThan(80_000);
		expect(logText).toContain("[truncated");
	});

	it("fails validate when static app JavaScript does not match the generated HTML contract", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(join(projectDir, "js"), { recursive: true });
		writeFileSync(
			join(projectDir, "index.html"),
			`<!doctype html>
<html>
  <body>
    <span id="lastUpdated">Last Updated: --</span>
    <div class="chart-loading" id="chart1Loading">Loading chart data...</div>
    <span class="kpi-value" id="kpiYieldValue">--</span>
    <script src="./js/app.js"></script>
  </body>
</html>`,
			"utf8",
		);
		writeFileSync(
			join(projectDir, "js", "app.js"),
			`
const $ = (selector) => document.querySelector(selector);
$('#last-updated').textContent = 'now';
$('#loading-overlay').classList.remove('active');
$('#kpi-yield').textContent = '91.2%';
`,
			"utf8",
		);
		const service = new WorkspaceTaskService(config);

		const result = await service.run({
			task: "validate",
			clientId: "client-a",
			sessionId: "s1",
			title: "Broken Preview",
		});

		expect(result.status).toBe("failed");
		expect(result.valid).toBe(false);
		expect(result.errors?.join("\n")).toContain("#last-updated");
		expect(result.errors?.join("\n")).toContain("chart1Loading");
		expect(result.errors?.join("\n")).toContain("kpiYieldValue");
	});

	it("fails validate when static app JavaScript matches ids but fails before first screen data renders", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(join(projectDir, "js"), { recursive: true });
		writeFileSync(
			join(projectDir, "index.html"),
			`<!doctype html>
<html>
  <body>
    <div class="chart-loading" id="chartLoading">Loading chart data...</div>
    <span class="kpi-value" id="kpiYieldValue">--</span>
    <script src="./js/app.js"></script>
  </body>
</html>`,
			"utf8",
		);
		writeFileSync(
			join(projectDir, "js", "app.js"),
			`
document.addEventListener('DOMContentLoaded', () => {
  const loading = document.getElementById('chartLoading');
  const kpi = document.getElementById('kpiYieldValue');
  const values = window.missingRows.map((row) => row.value);
  loading.classList.add('hidden');
  kpi.textContent = String(values.length);
});
`,
			"utf8",
		);
		const service = new WorkspaceTaskService(config);

		const result = await service.run({
			task: "validate",
			clientId: "client-a",
			sessionId: "s1",
			title: "Runtime Broken Preview",
		});

		expect(result.status).toBe("failed");
		expect(result.valid).toBe(false);
		expect(result.errors?.join("\n")).toContain("Static preview smoke gate");
		expect(result.errors?.join("\n")).toContain("missingRows");
		expect(result.errors?.join("\n")).toContain("chartLoading");
		expect(result.errors?.join("\n")).toContain("kpiYieldValue");
	});
});

class MockResponse extends Writable {
	statusCode = 200;
	body = "";
	headers: Record<string, string | number | readonly string[]> = {};

	setHeader(name: string, value: string | number | readonly string[]): this {
		this.headers[name.toLowerCase()] = value;
		return this;
	}

	_write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		callback();
	}
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
		runsEnabled: false,
		appAgentVersion: "v2",
		workerId: "test-worker",
		workerConcurrency: 2,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "pi:runs",
		agentV2RunQueueName: "pi:agent-v2:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 5000,
		runEventStreamTtlSeconds: 3600,
		agentV2RunEventStreamMaxLen: 5000,
		agentV2RunEventStreamTtlSeconds: 3600,
		runEventCheckpointIntervalMs: 400,
		runEventCheckpointMinChars: 256,
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
