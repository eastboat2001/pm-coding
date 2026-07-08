import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import { runAgentV2StaticValidationGate } from "../src/agent-v2-validation-gate.js";
import type { ProjectTaskResult, StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];

describe("agent v2 validation gate", () => {
	afterEach(() => {
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("maps visible loading placeholders to structured validation failures", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: '<!doctype html><div id="load" class="loading">Loading...</div>',
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.loading_visible",
				retryable: true,
				path: "index.html",
				source: "static_quality",
			}),
		]);
		expect(result.validation).toMatchObject({
			validationId: "static:validate",
			status: "failed",
			taskId: "validate",
			summary: "Static validation failed",
		});
	});

	it("passes a basic static app", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: "<!doctype html><main><h1>Ready</h1></main>",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("passed");
		expect(result.failures).toEqual([]);
		expect(result.validation).toMatchObject({ status: "passed", summary: "Static validation passed" });
	});

	it("normalizes build-required messaging into v2 preview failures", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Static preview found a build source entry at ./src/main.ts. Run build_static before preview so PI can serve browser-ready dist/build output.";

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks: mockTaskService({
				task: "validate",
				status: "failed",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 2,
				files: ["index.html", "src/main.ts"],
				hasPackageJson: true,
				valid: false,
				errors: [sourceMessage],
				mode: "static",
				serveRoot: "",
			}),
		});
		const [failure] = result.failures;
		const [rawError] = result.rawResult.errors ?? [];

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.preview_build_required",
					source: "preview",
					retryable: false,
				}),
			]),
		);
		expect(result.rawResult.errors).toEqual([sourceMessage]);
		expect(rawError).toContain("build_static before preview");
		expect(failure?.message).not.toContain("project_task");
		expect(failure?.code).not.toContain("project_task");
		expect(result.validation.details).toMatchObject({
			rawErrors: [rawError],
		});
		expect(failure?.data).toMatchObject({
			sourceMessage: rawError,
		});
	});

	it("keeps unknown legacy validation text in diagnostics while returning a generic v2 failure", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage = "project_task validate failed: webpack chunk graph exploded";

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks: mockTaskService({
				task: "validate",
				status: "failed",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 1,
				files: ["index.html"],
				hasPackageJson: false,
				valid: false,
				errors: [sourceMessage],
				mode: "static",
				serveRoot: "C:/demo/project",
			}),
		});

		expect(result.status).toBe("failed");
		expect(result.rawResult.errors).toEqual([sourceMessage]);
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.validation_failed",
				message: "Static validation failed.",
				source: "static_validate",
			}),
		]);
		expect(result.failures[0]?.message).not.toContain("project_task");
		expect(result.failures[0]?.code).not.toContain("project_task");
		expect(result.failures[0]?.data).toMatchObject({
			sourceMessage,
		});
		expect(result.validation.details).toMatchObject({
			rawErrors: [sourceMessage],
		});
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-validation-gate-"));
	cleanupRoots.push(root);
	return root;
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
		workerId: "test-worker",
		workerConcurrency: 2,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "pi:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 5000,
		runEventStreamTtlSeconds: 3600,
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

function mockTaskService(result: ProjectTaskResult) {
	return {
		run: async () => result,
	};
}
