import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeStore } from "../src/runtime-store.js";
import type { StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("agent v2 execution core", () => {
	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("advances planning tasks without reading legacy runtime state", async () => {
		const root = tempRoot();
		const store = createStore(root);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "Build a static board" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		await persistAgentV2PlanningBootstrap(
			store,
			buildAgentV2PlanningBootstrap({
				run,
				now: () => "2026-07-08T00:01:00.000Z",
			}),
		);

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-a",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_succeeded",
			taskId: "capability",
			diagnosticIds: [],
		});
		expect(store.listAgentV2Tasks("client-a", "run-a")[0]).toMatchObject({
			taskId: "capability",
			status: "succeeded",
			output: {
				phase4: {
					completedBy: "agent-v2-execution-core",
					deterministic: true,
				},
			},
		});
	});

	it("records failed validation and repair actions without entering delivery", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-validation",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation",
			taskId: "validate",
			kind: "validation",
			title: "Validate static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("task_failed");
		expect(result.taskId).toBe("validate");
		expect(result.diagnosticIds).toHaveLength(1);
		expect(store.listAgentV2Validations("client-a", "run-validation")).toEqual([
			expect.objectContaining({
				validationId: "static:validate",
				status: "failed",
				taskId: "validate",
			}),
		]);
		expect(store.listAgentV2Diagnostics("client-a", "run-validation")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					diagnosticId: result.diagnosticIds[0],
					category: "validation",
					code: "agent_v2.validation_failed",
					taskId: "validate",
					severity: "error",
					data: expect.objectContaining({
						failures: expect.any(Array),
						repairActions: expect.arrayContaining([
							expect.objectContaining({
								type: "block_task",
							}),
						]),
					}),
				}),
			]),
		);
		expect(store.listAgentV2Tasks("client-a", "run-validation")[0]).toMatchObject({
			taskId: "validate",
			status: "failed",
			error: expect.objectContaining({ code: "agent_v2.validation_failed" }),
			output: expect.objectContaining({
				validationId: "static:validate",
				repairActions: expect.any(Array),
			}),
		});
	});

	it("uses persisted validation repair attempts to stop retryable failures at max attempts", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-validation-attempts",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation-attempts",
			taskId: "validate",
			kind: "validation",
			title: "Validate static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {
				phase4: {
					validationRepairAttempt: 2,
				},
			},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation-attempts",
			now: () => "2026-07-08T00:02:00.000Z",
			maxRepairAttempts: 3,
		});

		expect(result).toMatchObject({
			status: "task_failed",
			taskId: "validate",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-validation-attempts")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					diagnosticId: result.diagnosticIds[0],
					code: "agent_v2.validation_failed",
					data: expect.objectContaining({
						attempt: 3,
						maxAttempts: 3,
						repairActions: [
							expect.objectContaining({
								type: "block_task",
								retryable: false,
								validationCode: "repair.max_attempts_exceeded",
							}),
						],
					}),
				}),
			]),
		);
		expect(store.listAgentV2Tasks("client-a", "run-validation-attempts")[0]).toMatchObject({
			taskId: "validate",
			status: "failed",
			error: expect.objectContaining({
				code: "agent_v2.validation_failed",
				retryable: false,
				data: expect.objectContaining({
					attempt: 3,
					maxAttempts: 3,
				}),
			}),
			output: expect.objectContaining({
				validationId: "static:validate",
				repairActions: [
					expect.objectContaining({
						type: "block_task",
						validationCode: "repair.max_attempts_exceeded",
					}),
				],
				phase4: expect.objectContaining({
					validationRepairAttempt: 3,
					validationMaxRepairAttempts: 3,
				}),
			}),
		});
	});

	it("persists passed validation records and transitions validation tasks to succeeded", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-validation-passed",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation-passed",
			taskId: "validate",
			kind: "validation",
			title: "Validate static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {
				phase4: {
					note: "keep-me",
				},
			},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		writeProjectFile(root, "index.html", "<!doctype html><main><h1>Ready</h1></main>");

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation-passed",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_succeeded",
			taskId: "validate",
			diagnosticIds: [],
		});
		expect(store.listAgentV2Validations("client-a", "run-validation-passed")).toEqual([
			expect.objectContaining({
				validationId: "static:validate",
				status: "passed",
				taskId: "validate",
				summary: "Static validation passed",
			}),
		]);
		const persistedTask = store.listAgentV2Tasks("client-a", "run-validation-passed")[0];
		expect(persistedTask).toMatchObject({
			taskId: "validate",
			status: "succeeded",
			output: expect.objectContaining({
				validationId: "static:validate",
				phase4: {
					note: "keep-me",
				},
			}),
		});
		expect(persistedTask?.error).toBeUndefined();
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-execution-core-"));
	cleanupRoots.push(root);
	return root;
}

function createStore(root: string): RuntimeDbStore {
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupStores.push(store);
	return store;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
	const projectDir = join(root, "data", "clients", "client-a", "sessions", "session-a", "project");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, relativePath), content);
}

function forbidLegacyRuntimeReads(store: RuntimeDbStore): RuntimeStore {
	const legacyReadMethods = new Set([
		"getSession",
		"listSessions",
		"updateSessionTitle",
		"appendMessage",
		"listMessages",
		"iterateMessages",
		"getRun",
		"getRunById",
		"listRuns",
		"listRunsForSession",
		"listRunsByStatus",
		"listRunningRunsByWorker",
		"createRun",
		"createContinuationRun",
		"createRunWithMessage",
		"updateRunStatus",
		"appendRunEvent",
		"listRunEvents",
		"iterateRunEvents",
		"getLatestRunCheckpoint",
		"getSessionMessageStats",
		"upsertAppPreviewGoal",
		"getAppPreviewGoal",
		"updateAppPreviewGoal",
		"appendAppPreviewGoalEvent",
		"listAppPreviewGoalEvents",
	]);
	return new Proxy(store, {
		get(target, property, receiver) {
			if (typeof property !== "string") {
				return Reflect.get(target, property, receiver);
			}
			if (legacyReadMethods.has(property)) {
				throw new Error(`legacy runtime read is forbidden in phase 4 execution core: ${property}`);
			}
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeStore;
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
