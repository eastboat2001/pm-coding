import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import type { AgentV2InputMaterializer } from "../src/agent-v2-input-materializer.js";
import type { AgentV2ModelExecution } from "../src/agent-v2-model-execution.js";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import type { AgentV2ExecutionStore } from "../src/agent-v2-runtime-store.js";
import { createAgentV2ToolRegistry } from "../src/agent-v2-tool-governance.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { ProjectPreviewResult, StorageConfig } from "../src/types.js";
import { WorkspacePreviewService } from "../src/workspace-preview-service.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("agent v2 execution core", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("advances planning tasks without reading legacy runtime state", async () => {
		const root = tempRoot();
		const store = createStore(root);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { objective: "Build a static board" },
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
			...unusedExecutionDependencies(),
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

	it("returns the root failed dependency error when the task graph is blocked", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-blocked",
			input: { objective: "Build a canvas game" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-blocked",
			taskId: "revalidate:validate:3",
			kind: "validation",
			title: "Revalidate",
			status: "failed",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			error: {
				code: "agent_v2.validation_failed",
				message: "canvas.getContext is not a function",
				retryable: false,
			},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-blocked",
			taskId: "deliver",
			kind: "delivery",
			title: "Deliver",
			status: "pending",
			dependsOn: ["revalidate:validate:3"],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.001Z",
			updatedAt: "2026-07-08T00:00:00.001Z",
		});

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store,
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-blocked",
		});

		expect(result).toEqual({
			status: "task_blocked",
			diagnosticIds: [],
			blockingError: {
				code: "agent_v2.validation_failed",
				message: "canvas.getContext is not a function",
				retryable: false,
			},
		});
	});

	it("atomically expands a retryable validation failure into repair and revalidation tasks", async () => {
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
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation",
			taskId: "deliver",
			kind: "delivery",
			title: "Deliver",
			status: "pending",
			dependsOn: ["validate"],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.001Z",
			updatedAt: "2026-07-08T00:00:00.001Z",
		});

		const first = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
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
		expect(store.listAgentV2Diagnostics("client-a", "run-validation")).toEqual([
			expect.objectContaining({
				diagnosticId: "agent_v2.validation_failed:validate:1",
				code: "agent_v2.validation_failed",
				message: "Static validation failed.",
				data: expect.objectContaining({
					attempt: 1,
					maxAttempts: 3,
					failureCodes: expect.any(Array),
					failureDetails: expect.arrayContaining([
						expect.objectContaining({
							code: "static.workspace_empty",
							message: "Workspace has no project files to validate.",
							retryable: true,
							source: "static_validate",
						}),
					]),
				}),
			}),
		]);
		expect(store.listAgentV2Tasks("client-a", "run-validation")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "validate", status: "succeeded" }),
				expect.objectContaining({
					taskId: "repair:validate:1",
					kind: "repair",
					dependsOn: ["validate"],
				}),
				expect.objectContaining({
					taskId: "revalidate:validate:2",
					kind: "validation",
					dependsOn: ["repair:validate:1"],
				}),
				expect.objectContaining({ taskId: "deliver", dependsOn: ["revalidate:validate:2"] }),
			]),
		);
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
				...unusedExecutionDependencies(),
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

	it("records the terminal immutable attempt and creates no tasks at the repair limit", async () => {
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
			taskId: "revalidate:validate:3",
			kind: "validation",
			title: "Validate static app",
			status: "ready",
			dependsOn: ["repair:validate:2"],
			acceptanceCriteria: [],
			input: { baseValidationTaskId: "validate", validationAttempt: 3 },
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation-attempts",
			taskId: "repair:validate:2",
			kind: "repair",
			title: "Previous repair",
			status: "succeeded",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-07T23:59:59.000Z",
			updatedAt: "2026-07-07T23:59:59.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation-attempts",
			taskId: "deliver",
			kind: "delivery",
			title: "Deliver",
			status: "pending",
			dependsOn: ["revalidate:validate:3"],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.001Z",
			updatedAt: "2026-07-08T00:00:00.001Z",
		});

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation-attempts",
			now: () => "2026-07-08T00:02:00.000Z",
			maxRepairAttempts: 3,
		});

		expect(result).toMatchObject({
			status: "task_failed",
			taskId: "revalidate:validate:3",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-validation-attempts")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					diagnosticId: result.diagnosticIds[0],
					code: "agent_v2.validation_failed",
					data: expect.objectContaining({
						attempt: 3,
						maxAttempts: 3,
						failureCodes: expect.any(Array),
					}),
				}),
			]),
		);
		expect(
			store
				.listAgentV2Tasks("client-a", "run-validation-attempts")
				.find((task) => task.taskId === "revalidate:validate:3"),
		).toMatchObject({
			taskId: "revalidate:validate:3",
			status: "failed",
			error: expect.objectContaining({
				code: "agent_v2.validation_failed",
				message: "Static validation failed and cannot be repaired: Workspace has no project files to validate.",
				retryable: false,
				data: expect.objectContaining({
					attempt: 3,
					maxAttempts: 3,
				}),
			}),
			output: expect.objectContaining({ validationId: "static:validate", attempt: 3, maxAttempts: 3 }),
		});
		expect(store.listAgentV2Validations("client-a", "run-validation-attempts")).toEqual([
			expect.objectContaining({ validationId: "static:validate", attempt: 3, status: "failed" }),
		]);
		expect(
			store
				.listAgentV2Tasks("client-a", "run-validation-attempts")
				.some((task) => task.taskId === "repair:validate:3"),
		).toBe(false);
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
			...unusedExecutionDependencies(),
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

	it("materializes committed inputs, executes the model, writes all files, and commits task/artifacts/events atomically", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-implementation",
			input: { objective: "Build a static app" },
			model: { provider: "test", id: "v2-test-model" },
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

		const callOrder: string[] = [];
		const materializer: AgentV2InputMaterializer = {
			materialize: vi.fn(async () => {
				callOrder.push("materialize");
				return [
					{
						kind: "text" as const,
						reference: {
							kind: "project_file" as const,
							inputId: "input-1",
							logicalPath: "notes.txt",
							mediaType: "text/plain",
							byteLength: 7,
							checksum: "sha256:verified",
						},
						text: "MATERIALIZED_INPUT_SENTINEL",
						checksum: "sha256:verified",
					},
				];
			}),
		};
		const generateImplementation = vi.fn(async (input) => {
			callOrder.push("model");
			expect(input.run.input.objective).toBe("Build a static app");
			expect(input.run.model).toEqual({ provider: "test", id: "v2-test-model" });
			expect(input.inputs).toMatchObject([{ kind: "text", text: "MATERIALIZED_INPUT_SENTINEL" }]);
			expect(input.task.taskId).toBe("implement");
			expect(input.contextPacket.run.runId).toBe("run-implementation");
			return {
				result: {
					version: 1 as const,
					taskId: "implement",
					summary: "Built an accessible dashboard with responsive navigation.",
					files: [
						{ path: "src/app.js", content: "export const secret = 'RAW_FILE_SENTINEL';\n" },
						{ path: "index.html", content: "<!doctype html><main>Ready</main>\n" },
					],
				},
				provider: "test",
				model: "v2-test-model",
				usage: { input: 10, output: 20, totalTokens: 30, costTotal: 0.01 },
			};
		});
		const modelExecution: AgentV2ModelExecution = {
			generateImplementation,
			generateRepair: vi.fn(async () => {
				throw new Error("repair is outside Task 7");
			}),
		};
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");
		const directArtifactWrite = vi.spyOn(store, "upsertAgentV2Artifact");
		const directTaskWrite = vi.spyOn(store, "upsertAgentV2Task");

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-implementation",
			materializer,
			modelExecution,
			skillContext: {
				skills: [
					{ name: "ui-polish", location: "skill://ui-polish/SKILL.md", content: "Use accessible contrast." },
				],
				resources: [
					{
						skillName: "ui-polish",
						path: "references/colors.md",
						content: "Use blue.",
						checksum: `sha256:${"a".repeat(64)}`,
					},
				],
			},
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_succeeded",
			taskId: "implement",
			diagnosticIds: [],
		});
		expect(callOrder).toEqual(["materialize", "model"]);
		expect(materializer.materialize).toHaveBeenCalledTimes(1);
		expect(generateImplementation).toHaveBeenCalledTimes(1);
		expect(readFileSync(projectFile(root, "index.html"), "utf8")).toContain("Ready");
		expect(readFileSync(projectFile(root, "src/app.js"), "utf8")).toContain("RAW_FILE_SENTINEL");
		expect(commit).toHaveBeenCalledTimes(1);
		expect(directArtifactWrite).not.toHaveBeenCalled();
		expect(directTaskWrite).not.toHaveBeenCalled();
		expect(store.listAgentV2Artifacts("client-a", "run-implementation")).toEqual([
			expect.objectContaining({ artifactId: "file:index.html", path: "index.html", validationStatus: "pending" }),
			expect.objectContaining({ artifactId: "file:src/app.js", path: "src/app.js", validationStatus: "pending" }),
		]);
		expect(store.listAgentV2Tasks("client-a", "run-implementation")[0]).toMatchObject({
			taskId: "implement",
			status: "succeeded",
			output: expect.objectContaining({
				artifactIds: ["file:index.html", "file:src/app.js"],
				changedFiles: ["index.html", "src/app.js"],
			}),
		});
		expect(store.getAgentV2Run("client-a", "run-implementation")).toMatchObject({ phase: "validation" });
		const events = store.listAgentV2RunEvents("client-a", "run-implementation", 0);
		expect(events.map((event) => event.type)).toEqual([
			"agent_v2.skill_applied",
			"agent_v2.skill_resource_loaded",
			"agent_v2.task_updated",
			"agent_v2.artifact_indexed",
			"agent_v2.artifact_indexed",
			"agent_v2.output_recorded",
		]);
		expect(events.at(-1)?.payload).toMatchObject({
			summary: "Built an accessible dashboard with responsive navigation.",
			provider: "test",
			model: "v2-test-model",
			usage: { input: 10, output: 20, totalTokens: 30, costTotal: 0.01 },
		});
		expect(
			events.filter((event) => event.type === "agent_v2.artifact_indexed").map((event) => event.payload),
		).toEqual([
			expect.objectContaining({
				action: "created",
				path: "index.html",
				sourceTaskId: "implement",
				checksum: expect.any(String),
			}),
			expect.objectContaining({
				action: "created",
				path: "src/app.js",
				sourceTaskId: "implement",
				checksum: expect.any(String),
			}),
		]);
		const outbox = store.leaseAgentV2Outbox({
			ownerId: "task7-red",
			kinds: ["live_event"],
			limit: 10,
			now: "2026-07-08T00:03:00.000Z",
			leaseTtlMs: 30_000,
		});
		const durableBoundary = JSON.stringify({
			events,
			outbox,
			tasks: store.listAgentV2Tasks("client-a", "run-implementation"),
		});
		expect(durableBoundary).not.toContain("MATERIALIZED_INPUT_SENTINEL");
		expect(durableBoundary).not.toContain("RAW_FILE_SENTINEL");
		expect(durableBoundary).not.toContain("sk-model-summary-key-1234567890");
		expect(store.listAgentV2Tasks("client-a", "run-implementation")[0]?.error).toBeUndefined();
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
				...unusedExecutionDependencies(),
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

	it("does not call the model, write files, or mutate durable state when materialization fails", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createImplementationTask(store, "run-materializer-failure");
		const modelExecution = recordingModelExecution("implement", [{ path: "index.html", content: "never" }]);
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-materializer-failure",
				materializer: { materialize: async () => Promise.reject(new Error("stable materialization failure")) },
				modelExecution,
				now: () => "2026-07-08T00:02:00.000Z",
			}),
		).rejects.toThrow("stable materialization failure");

		expect(modelExecution.generateImplementation).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
		expect(existsSync(projectFile(root, "index.html"))).toBe(false);
		expect(store.listAgentV2Artifacts("client-a", "run-materializer-failure")).toEqual([]);
		expect(store.listAgentV2Tasks("client-a", "run-materializer-failure")[0]?.status).toBe("ready");
	});

	it("preflights the complete parsed model file set before the first authorized write", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createImplementationTask(store, "run-invalid-model-output");
		const modelExecution = recordingModelExecution("implement", [
			{ path: "index.html", content: "first" },
			{ path: "INDEX.HTML", content: "collision" },
		]);
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-invalid-model-output",
				materializer: { materialize: async () => [] },
				modelExecution,
				now: () => "2026-07-08T00:02:00.000Z",
			}),
		).rejects.toThrow("colliding output paths");

		expect(commit).not.toHaveBeenCalled();
		expect(existsSync(projectFile(root, "index.html"))).toBe(false);
		expect(store.listAgentV2Artifacts("client-a", "run-invalid-model-output")).toEqual([]);
	});

	it("rejects generated ancestor and descendant paths before the first write", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createImplementationTask(store, "run-ancestor-collision");
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-ancestor-collision",
				materializer: { materialize: async () => [] },
				modelExecution: recordingModelExecution("implement", [
					{ path: "foo", content: "first" },
					{ path: "foo/bar.js", content: "second" },
				]),
				now: () => "2026-07-08T00:02:00.000Z",
			}),
		).rejects.toThrow("colliding output paths");

		expect(commit).not.toHaveBeenCalled();
		expect(existsSync(projectFile(root, "foo"))).toBe(false);
		expect(store.listAgentV2Artifacts("client-a", "run-ancestor-collision")).toEqual([]);
	});

	it("rejects generated case aliases of existing workspace files before writing", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createImplementationTask(store, "run-existing-case-alias");
		mkdirSync(projectFile(root, "src"), { recursive: true });
		writeProjectFile(root, "src/app.js", "existing");
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");

		await expect(
			executeAgentV2NextTask({
				store: forbidLegacyRuntimeReads(store),
				config: testConfig(root),
				context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
				runId: "run-existing-case-alias",
				materializer: { materialize: async () => [] },
				modelExecution: recordingModelExecution("implement", [{ path: "SRC/App.js", content: "replacement" }]),
				now: () => "2026-07-08T00:02:00.000Z",
			}),
		).rejects.toThrow("colliding output paths");

		expect(commit).not.toHaveBeenCalled();
		expect(readFileSync(projectFile(root, "src/app.js"), "utf8")).toBe("existing");
		expect(store.listAgentV2Artifacts("client-a", "run-existing-case-alias")).toEqual([]);
	});

	it("returns a stable conflict and never performs a second durable write when execution CAS misses", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createImplementationTask(store, "run-cas-conflict");
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation").mockImplementation(() => ({
			applied: false,
			run: store.getAgentV2Run("client-a", "run-cas-conflict")!,
			tasks: store.listAgentV2Tasks("client-a", "run-cas-conflict"),
			artifacts: [],
			events: [],
			outboxIntentIds: [],
		}));

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-cas-conflict",
			materializer: { materialize: async () => [] },
			modelExecution: recordingModelExecution("implement", [{ path: "index.html", content: "written once" }]),
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({ status: "task_conflict", taskId: "implement", diagnosticIds: [] });
		expect(commit).toHaveBeenCalledTimes(1);
		expect(store.listAgentV2Tasks("client-a", "run-cas-conflict")[0]?.status).toBe("ready");
		expect(store.listAgentV2Artifacts("client-a", "run-cas-conflict")).toEqual([]);
	});

	it("publishes a browser-ready preview before succeeding the delivery task", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-delivery-preview",
			input: { objective: "Build a static app" },
			model: { provider: "test", id: "v2-test-model" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-delivery-preview",
			taskId: "deliver",
			kind: "delivery",
			title: "Publish static preview",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: ["Publish a browser-ready preview URL."],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});
		writeProjectFile(root, "index.html", "<!doctype html><main><h1>Ready</h1></main>");
		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");
		const directTaskWrite = vi.spyOn(store, "upsertAgentV2Task");

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-delivery-preview",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({ status: "task_succeeded", taskId: "deliver", diagnosticIds: [] });
		const metadataPath = projectFile(root, ".pi-project.json");
		expect(existsSync(metadataPath)).toBe(true);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		expect(metadata).toMatchObject({
			status: "running",
			previewUrl: "http://localhost:5173/preview/project-client-a-session-/",
		});
		expect(store.listAgentV2Tasks("client-a", "run-delivery-preview")[0]).toMatchObject({
			status: "succeeded",
			output: expect.objectContaining({
				previewUrl: "http://localhost:5173/preview/project-client-a-session-/",
				projectId: "project-client-a-session-",
			}),
		});
		expect(store.listAgentV2Tasks("client-a", "run-delivery-preview")[0]?.output).not.toHaveProperty("serveRoot");
		expect(store.getAgentV2Run("client-a", "run-delivery-preview")).toMatchObject({ phase: "delivery" });
		expect(commit).toHaveBeenCalledTimes(1);
		expect(directTaskWrite).not.toHaveBeenCalled();
		const events = store.listAgentV2RunEvents("client-a", "run-delivery-preview", 0);
		expect(events.map((event) => event.type)).toEqual(["agent_v2.task_updated", "agent_v2.delivery_reported"]);
		expect(events[0]?.payload).toMatchObject({
			type: "agent_v2.task_updated",
			taskId: "deliver",
			kind: "delivery",
			status: "succeeded",
			phase: "delivery",
		});
		expect(events[1]?.payload).toMatchObject({
			type: "agent_v2.delivery_reported",
			previewStatus: "running",
			previewUrl: "http://localhost:5173/preview/project-client-a-session-/",
			validationStatus: "passed",
			buildStatus: "not_required",
		});
		expect(
			JSON.stringify({ events, tasks: store.listAgentV2Tasks("client-a", "run-delivery-preview") }),
		).not.toContain(root);
	});

	it("does not commit delivery success when cancellation wins during preview publication", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createDeliveryTask(store, "run-delivery-cancelled", { running: true });
		vi.spyOn(WorkspacePreviewService.prototype, "preview").mockImplementation(async () => {
			store.updateAgentV2RunWithResult({
				clientId: "client-a",
				runId: "run-delivery-cancelled",
				status: "cancelling",
				expectedStatuses: ["running"],
				updatedAt: "2026-07-08T00:01:30.000Z",
			});
			return previewSuccess();
		});

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-delivery-cancelled",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({ status: "task_conflict", taskId: "deliver", diagnosticIds: [] });
		expect(store.getAgentV2Run("client-a", "run-delivery-cancelled")?.status).toBe("cancelling");
		expect(store.listAgentV2Tasks("client-a", "run-delivery-cancelled")[0]?.status).toBe("ready");
		expect(store.listAgentV2RunEvents("client-a", "run-delivery-cancelled", 0)).toEqual([]);
	});

	it("does not commit delivery success after lease ownership changes", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createDeliveryTask(store, "run-delivery-lease", { running: true });
		vi.spyOn(WorkspacePreviewService.prototype, "preview").mockImplementation(async () => {
			store.updateAgentV2RunWithResult({
				clientId: "client-a",
				runId: "run-delivery-lease",
				expectedStatuses: ["running"],
				workerId: "worker-b",
				updatedAt: "2026-07-08T00:01:30.000Z",
			});
			return previewSuccess();
		});

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-delivery-lease",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({ status: "task_conflict", taskId: "deliver", diagnosticIds: [] });
		expect(store.getAgentV2Run("client-a", "run-delivery-lease")?.workerId).toBe("worker-b");
		expect(store.listAgentV2Tasks("client-a", "run-delivery-lease")[0]?.status).toBe("ready");
		expect(store.listAgentV2RunEvents("client-a", "run-delivery-lease", 0)).toEqual([]);
	});

	it("atomically persists a classified preview failure without absolute paths", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createDeliveryTask(store, "run-delivery-failed");
		writeProjectFile(root, "app.js", "console.log('not previewable');");

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-delivery-failed",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_failed",
			taskId: "deliver",
			diagnosticIds: ["agent_v2.preview_missing_entry:deliver"],
		});
		expect(store.listAgentV2Tasks("client-a", "run-delivery-failed")[0]).toMatchObject({
			status: "failed",
			error: {
				code: "agent_v2.preview_missing_entry",
				message: "Preview requires a browser-ready index.html in the project root, dist, build, or public.",
				retryable: true,
			},
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-delivery-failed")).toEqual([
			expect.objectContaining({
				diagnosticId: "agent_v2.preview_missing_entry:deliver",
				category: "preview",
				code: "agent_v2.preview_missing_entry",
				message: "Preview requires a browser-ready index.html in the project root, dist, build, or public.",
				data: { retryable: true, taxonomy: "missing_entry" },
			}),
		]);
		const events = store.listAgentV2RunEvents("client-a", "run-delivery-failed", 0);
		expect(events.map((event) => event.type)).toEqual(["agent_v2.diagnostic_recorded", "agent_v2.task_updated"]);
		const durableBoundary = JSON.stringify({
			diagnostics: store.listAgentV2Diagnostics("client-a", "run-delivery-failed"),
			events,
			tasks: store.listAgentV2Tasks("client-a", "run-delivery-failed"),
		});
		expect(durableBoundary).not.toContain(root);
	});

	it("persists an unknown preview exception as bounded non-retryable diagnostics", async () => {
		const root = tempRoot();
		const store = createStore(root);
		createDeliveryTask(store, "run-delivery-exception");
		vi.spyOn(WorkspacePreviewService.prototype, "preview").mockRejectedValue(
			new Error(`redis://user:secret@internal.example/db ${root} ${"x".repeat(10_000)}`),
		);

		const result = await executeAgentV2NextTask({
			...unusedExecutionDependencies(),
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-delivery-exception",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result).toEqual({
			status: "task_failed",
			taskId: "deliver",
			diagnosticIds: ["agent_v2.preview_publish_failed:deliver"],
		});
		const durableBoundary = JSON.stringify({
			diagnostics: store.listAgentV2Diagnostics("client-a", "run-delivery-exception"),
			events: store.listAgentV2RunEvents("client-a", "run-delivery-exception", 0),
			tasks: store.listAgentV2Tasks("client-a", "run-delivery-exception"),
		});
		expect(durableBoundary).toContain("Preview publication failed for an unclassified reason.");
		expect(durableBoundary.length).toBeLessThan(8_000);
		expect(durableBoundary).not.toContain("secret");
		expect(durableBoundary).not.toContain(root);
		expect(durableBoundary).not.toContain("x".repeat(1_000));
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

function createImplementationTask(store: RuntimeDbStore, runId: string): void {
	store.createAgentV2Run({
		clientId: "client-a",
		runId,
		input: { objective: "Build a static app" },
		model: { provider: "test", id: "v2-test-model" },
		createdAt: "2026-07-08T00:00:00.000Z",
	});
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId,
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
}

function createDeliveryTask(store: RuntimeDbStore, runId: string, options: { running?: boolean } = {}): void {
	store.createAgentV2Run({
		clientId: "client-a",
		runId,
		input: { objective: "Build a static app" },
		model: { provider: "test", id: "v2-test-model" },
		createdAt: "2026-07-08T00:00:00.000Z",
	});
	if (options.running) {
		store.updateAgentV2RunWithResult({
			clientId: "client-a",
			runId,
			status: "running",
			expectedStatuses: ["queued"],
			phase: "preview",
			workerId: "worker-a",
			updatedAt: "2026-07-08T00:01:00.000Z",
		});
	}
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId,
		taskId: "deliver",
		kind: "delivery",
		title: "Publish static preview",
		status: "ready",
		dependsOn: [],
		acceptanceCriteria: ["Publish a browser-ready preview URL."],
		input: {},
		output: {},
		createdAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:00.000Z",
	});
}

function previewSuccess(): ProjectPreviewResult {
	return {
		version: 1 as const,
		projectId: "project-client-a-session-",
		clientId: "client-a",
		sessionId: "session-a",
		title: "Demo",
		status: "running",
		mode: "static",
		previewUrl: "http://localhost:5173/preview/project-client-a-session-/",
		projectRoot: "C:/server/private/project",
		serveRoot: "C:/server/private/project/dist",
		fileCount: 1,
		updatedAt: "2026-07-08T00:01:30.000Z",
		logs: [],
	};
}

function recordingModelExecution(
	taskId: string,
	files: Array<{ path: string; content: string }>,
): AgentV2ModelExecution & { generateImplementation: ReturnType<typeof vi.fn> } {
	return {
		generateImplementation: vi.fn(async () => ({
			result: { version: 1 as const, taskId, summary: "Generated files", files },
			provider: "test",
			model: "v2-test-model",
		})),
		generateRepair: vi.fn(async () => {
			throw new Error("repair is outside Task 7");
		}),
	};
}

function unusedExecutionDependencies(): {
	materializer: AgentV2InputMaterializer;
	modelExecution: AgentV2ModelExecution;
} {
	return {
		materializer: {
			materialize: async () => {
				throw new Error("materializer must not be called for this task");
			},
		},
		modelExecution: {
			generateImplementation: async () => {
				throw new Error("implementation model must not be called for this task");
			},
			generateRepair: async () => {
				throw new Error("repair model must not be called for this task");
			},
		},
	};
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
