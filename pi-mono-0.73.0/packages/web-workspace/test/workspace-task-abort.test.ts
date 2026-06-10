import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StorageConfig } from "../src/types.js";
import { runCommand } from "../src/workspace-command-service.js";
import { projectDirectory } from "../src/workspace-paths.js";
import { WorkspaceTaskService } from "../src/workspace-task-service.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-task-abort-"));
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

describe("WorkspaceTaskService abort handling", () => {
	it("passes AbortSignal to build_static command runner and reports abort failures", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.projectsRootDir, "s1", "Abort");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "package.json"),
			JSON.stringify({ scripts: { build: "vite build" }, dependencies: {} }),
			"utf8",
		);

		const controller = new AbortController();
		let receivedSignal = false;
		const service = new WorkspaceTaskService(config, undefined, async (_command, _cwd, _timeoutMs, _logs, signal) => {
			receivedSignal = signal === controller.signal;
			controller.abort();
			throw new Error("Command aborted");
		});

		const result = await service.run(
			{ task: "build_static", sessionId: "s1", title: "Abort" },
			undefined,
			controller.signal,
		);

		expect(receivedSignal).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.errors).toContain("Command aborted");
	});

	it("fails command execution immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(runCommand("node --version", tempRoot(), 1000, [], controller.signal)).rejects.toThrow(
			"Command aborted",
		);
	});
});
