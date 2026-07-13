import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BuildRunner, BuildRunnerError } from "../src/build-runner.js";
import type { StorageConfig } from "../src/types.js";
import { runCommand } from "../src/workspace-command-service.js";
import { projectDirectory } from "../src/workspace-paths.js";
import { createWorkspaceTaskService } from "../src/workspace-task-factory.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-task-abort-"));
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

describe("WorkspaceTaskService abort handling", () => {
	it("passes AbortSignal to build_static command runner and reports abort failures", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const projectDir = projectDirectory(config.clientsRootDir, "s1", "client-a");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");

		const controller = new AbortController();
		let receivedSignal = false;
		const runner: BuildRunner = {
			build: async ({ signal }) => {
				receivedSignal = signal === controller.signal;
				controller.abort();
				throw new BuildRunnerError("build.cancelled", "Build was cancelled.", ["cancelled safely"]);
			},
		};
		const service = createWorkspaceTaskService(config, { buildRunner: runner });

		const result = await service.run(
			{ task: "build_static", clientId: "client-a", sessionId: "s1", title: "Abort" },
			undefined,
			controller.signal,
		);

		expect(receivedSignal).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.failureCode).toBe("build.cancelled");
		expect(result.errors).toContain("Build was cancelled.");
		expect(result.logs?.join("\n")).toContain("cancelled safely");
	});

	it("fails command execution immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(runCommand("node --version", tempRoot(), 1000, [], controller.signal)).rejects.toThrow(
			"Command aborted",
		);
	});
});
