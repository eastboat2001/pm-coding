import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type BuildRunner, BuildRunnerError } from "../src/build-runner.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import type { StorageConfig } from "../src/types.js";
import { WorkspaceFileService } from "../src/workspace-file-service.js";
import { projectDirectory } from "../src/workspace-paths.js";
import { WorkspacePreviewService } from "../src/workspace-preview-service.js";
import { createWorkspaceTaskService } from "../src/workspace-task-factory.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-hardening-"));
}

describe("project execution and preview hardening", () => {
	it("rejects a symlinked static serve-root candidate", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		const outside = join(root, "outside-dist");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "index.html"), "<h1>outside</h1>", "utf8");
		symlinkSync(outside, join(projectDir, "dist"), process.platform === "win32" ? "junction" : "dir");
		const service = createWorkspaceTaskService(config);

		const result = await service.run({ task: "inspect", clientId: "client-a", sessionId: "s1", title: "Static" });

		expect(result.serveRoot).toBe("");
	});

	it("routes build_static exclusively through BuildRunner without executing configured host commands", async () => {
		const root = tempRoot();
		const marker = join(root, "host-command-ran");
		const config = {
			...testConfig(root),
			projectInstallCommand: "",
			projectBuildCommand: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')"`,
		};
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { build: "node build.js" } }), "utf8");

		const build = vi.fn<BuildRunner["build"]>(async ({ projectRoot, artifactRoot, signal }) => {
			expect(projectRoot).toBe(projectDir);
			expect(artifactRoot).toBe(projectDir);
			expect(signal).toBeUndefined();
			const serveRoot = join(projectDir, "dist");
			mkdirSync(serveRoot);
			writeFileSync(join(serveRoot, "index.html"), "<h1>built</h1>", "utf8");
			return { serveRoot, outputDirectory: "dist", files: ["index.html"], logs: ["isolated build"], durationMs: 1 };
		});
		const service = createWorkspaceTaskService(config, { buildRunner: { build } });

		const result = await service.run({
			task: "build_static",
			clientId: "client-a",
			sessionId: "s1",
			title: "Hardening",
		});

		expect(build).toHaveBeenCalledOnce();
		expect(existsSync(marker)).toBe(false);
		expect(result.status).toBe("passed");
		expect(result.serveRoot).toBe(join(projectDir, "dist"));
		expect(result.logs?.join("\n")).toContain("isolated build");
	});

	it("rejects create rewrite delete and preview of trusted metadata", async () => {
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

		for (const command of ["create", "rewrite"] as const) {
			expect(() =>
				files.handle({
					clientId: "client-a",
					sessionId: "s1",
					title: "Preview",
					command,
					filename: ".pi-project.json",
					content: "untrusted",
				}),
			).toThrow();
		}
		expect(() =>
			files.handle({
				clientId: "client-a",
				sessionId: "s1",
				title: "Preview",
				command: "delete",
				filename: ".pi-project.json",
			}),
		).toThrow();
	});

	it("does not trust metadata serveRoot outside the real project root", async () => {
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
			content: "<h1>project</h1>",
		});
		const preview = await previews.preview({ clientId: "client-a", sessionId: "s1", title: "Preview" }, req);
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "index.html"), "<h1>outside secret</h1>", "utf8");
		writeFileSync(
			join(projectDirectory(config.clientsRootDir, "s1", "client-a"), ".pi-project.json"),
			JSON.stringify({ ...preview, serveRoot: outside }),
			"utf8",
		);
		const res = new MockResponse();

		expect(
			previews.servePreviewRequest(
				{ url: `/preview/${encodeURIComponent(preview.projectId)}/` } as IncomingMessage,
				res as unknown as ServerResponse,
			),
		).toBe(true);
		expect(res.statusCode).toBe(404);
		expect(res.body).not.toContain("outside secret");
	});

	it("does not convert a rejected preview path into SPA index fallback", async () => {
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
			content: "<h1>spa fallback</h1>",
		});
		const preview = await previews.preview({ clientId: "client-a", sessionId: "s1", title: "Preview" }, req);
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		symlinkSync(
			outside,
			join(projectDirectory(config.clientsRootDir, "s1", "client-a"), "escape"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const res = new MockResponse();

		expect(
			previews.servePreviewRequest(
				{ url: `/preview/${encodeURIComponent(preview.projectId)}/escape/missing.js` } as IncomingMessage,
				res as unknown as ServerResponse,
			),
		).toBe(true);
		expect(res.statusCode).toBe(404);
		expect(res.body).not.toContain("spa fallback");
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

	it("truncates sanitized BuildRunner failure logs", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
		const runner: BuildRunner = {
			build: async () => {
				throw new BuildRunnerError("build.execution_failed", "Container build failed.", ["x".repeat(200_000)]);
			},
		};
		const service = createWorkspaceTaskService(config, { buildRunner: runner });

		const result = await service.run({ task: "build_static", clientId: "client-a", sessionId: "s1", title: "Logs" });

		const logText = result.logs?.join("") ?? "";
		expect(logText.length).toBeLessThan(80_000);
		expect(logText).toContain("[truncated");
		expect(result.failureCode).toBe("build.execution_failed");
	});

	it("normalizes unknown BuildRunner failures without exposing raw error details", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { build: "node build.js" } }), "utf8");
		const diagnostics = new WorkspaceDiagnosticLogService(config);
		diagnostics.ensureDirs();
		const runner: BuildRunner = {
			build: async () => {
				throw new Error("Authorization=Bearer secret");
			},
		};
		const service = createWorkspaceTaskService(config, { buildRunner: runner, diagnostics });

		const result = await service.run({
			task: "build_static",
			clientId: "client-a",
			sessionId: "s1",
			title: "Secret",
		});
		const diagnosticText = JSON.stringify(diagnostics.queryEvents({ sessionId: "s1", limit: 10 }));

		expect(result).toMatchObject({
			status: "failed",
			failureCode: "build.execution_failed",
			errors: ["Static build failed."],
		});
		expect(result.logs?.join("\n")).toContain("Static build failed.");
		expect(JSON.stringify(result)).not.toContain("Authorization=Bearer secret");
		expect(diagnosticText).not.toContain("Authorization=Bearer secret");
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
		const service = createWorkspaceTaskService(config);

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
		const service = createWorkspaceTaskService(config);

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
