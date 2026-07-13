import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import type { AgentV2ExecutionStore } from "../src/agent-v2-runtime-store.js";
import { createAgentV2ToolRegistry } from "../src/agent-v2-tool-governance.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
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

	it("keeps retryable validation failures selectable and retries them before max attempts", async () => {
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

		const first = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation",
			now: () => "2026-07-08T00:02:00.000Z",
			maxRepairAttempts: 3,
		});

		expect(first.status).toBe("task_failed");
		expect(first.taskId).toBe("validate");
		expect(first.diagnosticIds).toHaveLength(1);
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
					diagnosticId: first.diagnosticIds[0],
					category: "validation",
					code: "agent_v2.validation_failed",
					taskId: "validate",
					severity: "error",
					data: expect.objectContaining({
						attempt: 1,
						maxAttempts: 3,
						failures: expect.any(Array),
						repairActions: expect.arrayContaining([
							expect.objectContaining({
								type: "rerun_validation",
								retryable: true,
							}),
						]),
					}),
				}),
			]),
		);
		const firstPersistedTask = store.listAgentV2Tasks("client-a", "run-validation")[0];
		expect(firstPersistedTask).toMatchObject({
			taskId: "validate",
			status: "ready",
			output: expect.objectContaining({
				validationId: "static:validate",
				repairActions: expect.any(Array),
				phase4: expect.objectContaining({
					validationRepairAttempt: 1,
					validationMaxRepairAttempts: 3,
				}),
			}),
		});
		expect(firstPersistedTask?.error).toBeUndefined();

		const second = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation",
			now: () => "2026-07-08T00:03:00.000Z",
			maxRepairAttempts: 3,
		});

		expect(second).toMatchObject({
			status: "task_failed",
			taskId: "validate",
		});
		expect(store.listAgentV2Tasks("client-a", "run-validation")[0]).toMatchObject({
			taskId: "validate",
			status: "ready",
			output: expect.objectContaining({
				phase4: expect.objectContaining({
					validationRepairAttempt: 2,
					validationMaxRepairAttempts: 3,
				}),
			}),
		});
	});

	it("stops before static validation when the execution signal is already aborted", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-validation-aborted",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation-aborted",
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
		const controller = new AbortController();
		controller.abort(new Error("stop validation"));

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-validation-aborted",
				now: () => "2026-07-08T00:02:00.000Z",
				signal: controller.signal,
			}),
		).rejects.toThrow("stop validation");
		expect(store.listAgentV2Validations("client-a", "run-validation-aborted")).toEqual([]);
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

	it("writes implementation artifacts through the v2 file adapter and persists source records", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-implementation",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-implementation",
			taskId: "implement",
			kind: "implementation",
			title: "Implement static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: ["Create browser-ready source"],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-implementation",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_succeeded",
			taskId: "implement",
			diagnosticIds: [],
		});
		expect(existsSync(projectFile(root, "index.html"))).toBe(true);
		expect(readFileSync(projectFile(root, "index.html"), "utf8")).toContain("Build a static app");
		expect(store.listAgentV2Artifacts("client-a", "run-implementation")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					artifactId: "file:index.html",
					kind: "source",
					path: "index.html",
					sourceTaskId: "implement",
				}),
			]),
		);
		expect(store.listAgentV2Tasks("client-a", "run-implementation")[0]).toMatchObject({
			taskId: "implement",
			status: "succeeded",
			output: expect.objectContaining({
				artifactIds: ["file:index.html"],
				changedFiles: ["index.html"],
			}),
		});
	});

	it("blocks implementation file writes through restrictive production tool governance", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-governance",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-governance",
			taskId: "implement",
			kind: "implementation",
			title: "Implement static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-governance",
				now: () => "2026-07-08T00:02:00.000Z",
				toolRegistry: createAgentV2ToolRegistry([]),
			}),
		).rejects.toThrow("Agent v2 tool is not registered: file.write");
		expect(existsSync(projectFile(root, "index.html"))).toBe(false);
		expect(store.listAgentV2Artifacts("client-a", "run-governance")).toEqual([]);
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-execution-core-"));
	cleanupRoots.push(root);
	return root;
}

function createStore(root: string): RuntimeDbStore {
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureAgentV2Schema();
	cleanupStores.push(store);
	return store;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
	const projectDir = join(root, "data", "clients", "client-a", "sessions", "session-a", "project");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, relativePath), content);
}

function projectFile(root: string, relativePath: string): string {
	return join(root, "data", "clients", "client-a", "sessions", "session-a", "project", ...relativePath.split("/"));
}

function forbidLegacyRuntimeReads(store: RuntimeDbStore): AgentV2ExecutionStore {
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
	}) as AgentV2ExecutionStore;
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
