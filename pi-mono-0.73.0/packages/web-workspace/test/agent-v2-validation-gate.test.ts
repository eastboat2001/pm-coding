import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import { createAgentV2ToolRegistry } from "../src/agent-v2-tool-governance.js";
import { runAgentV2StaticValidationGate } from "../src/agent-v2-validation-gate.js";
import type { ProjectTaskName, ProjectTaskResult, StorageConfig } from "../src/types.js";

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

		const tasks = mockTaskSequence([
			{
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
			},
			{
				task: "build_static",
				status: "failed",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 2,
				files: ["index.html", "src/main.ts"],
				hasPackageJson: true,
				valid: false,
				errors: ["Build failed: missing dependency"],
				mode: "static",
				serveRoot: "",
			},
			{
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
			},
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks,
		});
		const [failure] = result.failures;
		const [rawError] = result.rawResult.errors ?? [];

		expect(tasks.calls).toEqual(["validate", "build_static", "validate"]);
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
			buildResult: expect.objectContaining({
				status: "failed",
				errors: ["Build failed: missing dependency"],
			}),
		});
		expect(failure?.data).toMatchObject({
			sourceMessage: rawError,
		});
	});

	it("runs build_static between validate attempts when source output must be built", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Static preview found a build source entry at ./src/main.ts. Run build_static before preview so PI can serve browser-ready dist/build output.";
		const tasks = mockTaskSequence([
			{
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
			},
			{
				task: "build_static",
				status: "succeeded",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 3,
				files: ["index.html", "src/main.ts", "dist/index.html"],
				hasPackageJson: true,
				valid: true,
				errors: [],
				logs: ["built dist/index.html"],
				mode: "static",
				serveRoot: "C:/demo/project/dist",
			},
			{
				task: "validate",
				status: "succeeded",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 3,
				files: ["index.html", "src/main.ts", "dist/index.html"],
				hasPackageJson: true,
				valid: true,
				errors: [],
				mode: "static",
				serveRoot: "C:/demo/project/dist",
			},
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks,
		});

		expect(tasks.calls).toEqual(["validate", "build_static", "validate"]);
		expect(result.status).toBe("passed");
		expect(result.failures).toEqual([]);
		expect(result.rawResult.task).toBe("validate");
		expect(result.validation.details).toMatchObject({
			rawErrors: [],
			initialRawErrors: [sourceMessage],
			buildResult: expect.objectContaining({
				task: "build_static",
				status: "succeeded",
				logs: ["built dist/index.html"],
			}),
		});
	});

	it("passes the cancellation signal to every static validation workspace task", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const signal = new AbortController().signal;
		const sourceMessage =
			"Static preview found a build source entry at ./src/main.ts. Run build_static before preview so PI can serve browser-ready dist/build output.";
		const observedSignals: Array<AbortSignal | undefined> = [];
		const tasks = {
			calls: [] as ProjectTaskName[],
			run: async (request: { task: ProjectTaskName }, _req?: unknown, taskSignal?: AbortSignal) => {
				tasks.calls.push(request.task);
				observedSignals.push(taskSignal);
				return taskResult({
					task: request.task,
					status: request.task === "build_static" ? "succeeded" : "failed",
					errors: request.task === "build_static" ? [] : [sourceMessage],
				});
			},
		};

		await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks,
			signal,
		});

		expect(tasks.calls).toEqual(["validate", "build_static", "validate"]);
		expect(observedSignals).toEqual([signal, signal, signal]);
	});

	it("blocks static validation through restrictive production tool governance", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };

		await expect(
			runAgentV2StaticValidationGate({
				config,
				context,
				runId: "run-a",
				taskId: "validate",
				now: "2026-07-08T00:02:00.000Z",
				tasks: mockTaskSequence([]),
				toolRegistry: createAgentV2ToolRegistry([]),
			}),
		).rejects.toThrow("Agent v2 tool is not registered: validation.static_quality");
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

function mockTaskService(result: ProjectTaskResult) {
	return {
		run: async () => result,
	};
}

function mockTaskSequence(results: ProjectTaskResult[]) {
	const calls: ProjectTaskName[] = [];
	return {
		calls,
		run: async (request: { task: ProjectTaskName }) => {
			calls.push(request.task);
			const result = results.shift();
			if (!result) throw new Error(`No mock result for ${request.task}`);
			return result;
		},
	};
}

function taskResult(overrides: Partial<ProjectTaskResult> & { task: ProjectTaskName }): ProjectTaskResult {
	const { task, ...rest } = overrides;
	return {
		task,
		status: "succeeded",
		projectId: "project-a",
		sessionId: "session-a",
		title: "Demo",
		projectRoot: "C:/demo/project",
		fileCount: 2,
		files: ["index.html", "src/main.ts"],
		hasPackageJson: true,
		valid: true,
		errors: [],
		mode: "static",
		serveRoot: "C:/demo/project/dist",
		...rest,
	};
}
