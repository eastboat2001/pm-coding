import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import type { AgentV2ModelExecution } from "../src/agent-v2-model-execution.js";
import { renderAgentV2RepairPrompt } from "../src/agent-v2-model-prompt.js";
import { loadStorageConfig } from "../src/config.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("agent v2 production repair loop", () => {
	it("atomically expands validation, executes a real repair, and preserves immutable history through revalidation", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-repair-loop-"));
		roots.push(root);
		const config = loadStorageConfig(root);
		const store = new RuntimeDbStore(config.runtimeDbFile);
		stores.push(store);
		store.ensureAgentV2Schema();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-repair",
			input: { objective: "Build a static app" },
			model: { provider: "test", id: "v2-test-model" },
			createdAt: "2026-07-14T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-repair",
			taskId: "validate",
			kind: "validation",
			title: "Validate",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-14T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-repair",
			taskId: "deliver",
			kind: "delivery",
			title: "Deliver",
			status: "pending",
			dependsOn: ["validate"],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-14T00:00:00.001Z",
			updatedAt: "2026-07-14T00:00:00.001Z",
		});
		const projectRoot = join(config.clientsRootDir, "client-a", "sessions", "session-a", "project");
		mkdirSync(projectRoot, { recursive: true });
		const initialContent = '<!doctype html><div id="loading">Loading...</div>';
		writeFileSync(join(projectRoot, "index.html"), initialContent);
		store.upsertAgentV2Artifact({
			clientId: "client-a",
			runId: "run-repair",
			artifactId: "file:index.html",
			kind: "source",
			path: "index.html",
			mediaType: "text/html",
			checksum: checksum(initialContent),
			version: checksum(initialContent),
			sourceTaskId: "implement",
			validationStatus: "pending",
			metadataJson: {},
			createdAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-14T00:00:00.000Z",
		});

		const generateRepair = vi.fn(async (input: Parameters<AgentV2ModelExecution["generateRepair"]>[0]) => ({
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "RAW_MODEL_SUMMARY_MUST_NOT_PERSIST",
				files: [{ path: "index.html", content: "<!doctype html><main>Ready</main>" }],
				addressedDiagnosticIds: input.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
			},
			provider: "test",
			model: "v2-test-model",
		}));
		const modelExecution: AgentV2ModelExecution = {
			generateImplementation: async () => {
				throw new Error("implementation must not run");
			},
			generateRepair,
		};
		const execute = (now: string) =>
			executeAgentV2NextTask({
				store,
				config,
				context: { clientId: "client-a", sessionId: "session-a", title: "Repair" },
				runId: "run-repair",
				materializer: { materialize: async () => [] },
				modelExecution,
				maxRepairAttempts: 3,
				now: () => now,
			});

		const commit = vi.spyOn(store, "commitAgentV2ExecutionMutation");
		const appendValidation = vi.spyOn(store, "appendAgentV2ValidationAttempt");
		const appendDiagnostic = vi.spyOn(store, "appendAgentV2Diagnostic");
		await expect(execute("2026-07-14T00:00:01.000Z")).resolves.toMatchObject({
			status: "task_failed",
			taskId: "validate",
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(appendValidation).not.toHaveBeenCalled();
		expect(appendDiagnostic).not.toHaveBeenCalled();
		expect(store.listAgentV2Tasks("client-a", "run-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "validate", kind: "validation", status: "succeeded" }),
				expect.objectContaining({
					taskId: "repair:validate:1",
					kind: "repair",
					status: "pending",
					dependsOn: ["validate"],
				}),
				expect.objectContaining({
					taskId: "revalidate:validate:2",
					kind: "validation",
					status: "pending",
					dependsOn: ["repair:validate:1"],
				}),
				expect.objectContaining({ taskId: "deliver", dependsOn: ["revalidate:validate:2"] }),
			]),
		);
		expect(store.listAgentV2Artifacts("client-a", "run-repair")[0]?.validationStatus).toBe("failed");

		await expect(execute("2026-07-14T00:00:02.000Z")).resolves.toMatchObject({
			status: "task_succeeded",
			taskId: "repair:validate:1",
		});
		expect(generateRepair).toHaveBeenCalledTimes(1);
		expect(generateRepair.mock.calls[0]?.[0]).toMatchObject({
			run: { model: { provider: "test", id: "v2-test-model" } },
			task: { taskId: "repair:validate:1", kind: "repair" },
			diagnostics: [expect.objectContaining({ code: "agent_v2.validation_failed" })],
		});
		expect(readFileSync(join(projectRoot, "index.html"), "utf8")).toBe("<!doctype html><main>Ready</main>");
		expect(store.listAgentV2Artifacts("client-a", "run-repair")[0]).toMatchObject({
			artifactId: "file:index.html",
			validationStatus: "pending",
			sourceTaskId: "repair:validate:1",
		});

		await expect(execute("2026-07-14T00:00:03.000Z")).resolves.toMatchObject({
			status: "task_succeeded",
			taskId: "revalidate:validate:2",
		});
		expect(store.listAgentV2Validations("client-a", "run-repair")).toEqual([
			expect.objectContaining({ validationId: "static:validate", attempt: 1, status: "failed", taskId: "validate" }),
			expect.objectContaining({
				validationId: "static:validate",
				attempt: 2,
				status: "passed",
				taskId: "revalidate:validate:2",
			}),
		]);
		expect(store.listAgentV2Artifacts("client-a", "run-repair")[0]?.validationStatus).toBe("passed");
		expect(
			store.listAgentV2Tasks("client-a", "run-repair").find((task) => task.taskId === "deliver")?.dependsOn,
		).toEqual(["revalidate:validate:2"]);
		expect(
			JSON.stringify({
				validations: store.listAgentV2Validations("client-a", "run-repair"),
				diagnostics: store.listAgentV2Diagnostics("client-a", "run-repair"),
				events: store.listAgentV2RunEvents("client-a", "run-repair", 0),
				tasks: store.listAgentV2Tasks("client-a", "run-repair"),
			}),
		).not.toContain("RAW_MODEL_SUMMARY_MUST_NOT_PERSIST");
	});

	it("renders the real production repair prompt with the failed validation identity and bounded workspace context", async () => {
		const currentContent = '<!doctype html><div id="loading">PROMPT_WORKSPACE_SENTINEL</div>';
		const fixture = directRepairFixture(currentContent);
		let renderedPrompt = "";
		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async (input) => {
						renderedPrompt = renderAgentV2RepairPrompt(input).userPrompt;
						return {
							result: {
								version: 1 as const,
								taskId: input.task.taskId,
								summary: "ignored",
								files: [{ path: "index.html", content: "<!doctype html><main>Ready</main>" }],
								addressedDiagnosticIds: input.diagnostics.map((item) => item.diagnosticId),
							},
							provider: "test",
							model: "v2-test-model",
						};
					},
				},
			}),
		).resolves.toMatchObject({ status: "task_succeeded", taskId: "repair:validate:1" });
		expect(renderedPrompt).toContain("PROMPT_WORKSPACE_SENTINEL");
		expect(renderedPrompt).toContain("static.loading_visible");
		expect(renderedPrompt).not.toContain("prompt raw validator secret");
	});

	it("fails a no-change repair atomically and never enables revalidation", async () => {
		const fixture = directRepairFixture("<!doctype html><main>unchanged</main>");
		const generateRepair = vi.fn(async () => ({
			result: {
				version: 1 as const,
				taskId: "repair:validate:1",
				summary: "RAW_NO_CHANGE_SUMMARY",
				files: [{ path: "index.html", content: "<!doctype html><main>unchanged</main>" }],
				addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
			},
			provider: "test",
			model: "v2-test-model",
		}));
		const commit = vi.spyOn(fixture.store, "commitAgentV2ExecutionMutation");

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair,
				},
			}),
		).resolves.toEqual({
			status: "task_failed",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_no_change:repair:validate:1"],
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "repair:validate:1", status: "failed" }),
				expect.objectContaining({ taskId: "revalidate:validate:2", status: "pending" }),
			]),
		);
		expect(fixture.store.listAgentV2Artifacts("client-a", "run-direct-repair")[0]?.validationStatus).toBe("failed");
		expect(
			JSON.stringify({
				diagnostics: fixture.store.listAgentV2Diagnostics("client-a", "run-direct-repair"),
				tasks: fixture.store.listAgentV2Tasks("client-a", "run-direct-repair"),
			}),
		).not.toContain("RAW_NO_CHANGE_SUMMARY");
	});

	it("fails an empty repair result atomically and never enables revalidation", async () => {
		const fixture = directRepairFixture("<!doctype html><main>unchanged</main>");
		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async () => ({
						result: {
							version: 1 as const,
							taskId: "repair:validate:1",
							summary: "RAW_EMPTY_SUMMARY",
							files: [],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toMatchObject({ status: "task_failed", taskId: "repair:validate:1" });
		expect(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "repair:validate:1", status: "failed" }),
				expect.objectContaining({ taskId: "revalidate:validate:2", status: "pending" }),
			]),
		);
		expect(JSON.stringify(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair"))).not.toContain(
			"RAW_EMPTY_SUMMARY",
		);
	});

	it("rejects provider identity mismatch before repair writes or durable success", async () => {
		const fixture = directRepairFixture("<!doctype html><main>before</main>");
		const beforeEvents = fixture.store.listAgentV2RunEvents("client-a", "run-direct-repair", 0);

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async () => ({
						result: {
							version: 1,
							taskId: "repair:validate:1",
							summary: "forged",
							files: [{ path: "index.html", content: "changed" }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "unexpected-model",
					}),
				},
			}),
		).rejects.toThrow("does not match the required result schema");
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe("<!doctype html><main>before</main>");
		expect(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair")[0]?.status).toBe("ready");
		expect(fixture.store.listAgentV2RunEvents("client-a", "run-direct-repair", 0)).toEqual(beforeEvents);
	});

	it("keeps the base validation identity across repeated failure and stops with zero new tasks at max attempt", async () => {
		const fixture = directRepairFixture('<!doctype html><div id="loading">Loading one...</div>');
		const generateRepair = vi.fn(async (input: Parameters<AgentV2ModelExecution["generateRepair"]>[0]) => ({
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "still invalid",
				files: [
					{
						path: "index.html",
						content:
							input.task.taskId === "repair:validate:1"
								? '<!doctype html><div id="loading">Loading two...</div>'
								: '<!doctype html><div id="loading">Loading three...</div>',
					},
				],
				addressedDiagnosticIds: input.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
			},
			provider: "test",
			model: "v2-test-model",
		}));
		const execution = {
			...fixture.execution,
			maxRepairAttempts: 3,
			modelExecution: {
				generateImplementation: async () => {
					throw new Error("implementation must not run");
				},
				generateRepair,
			},
		};

		await expect(executeAgentV2NextTask(execution)).resolves.toMatchObject({ taskId: "repair:validate:1" });
		await expect(executeAgentV2NextTask(execution)).resolves.toMatchObject({
			status: "task_failed",
			taskId: "revalidate:validate:2",
		});
		expect(
			fixture.store
				.listAgentV2Validations("client-a", "run-direct-repair")
				.map((row) => [row.validationId, row.attempt]),
		).toEqual([
			["static:validate", 1],
			["static:validate", 2],
		]);
		expect(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "repair:validate:2", dependsOn: ["revalidate:validate:2"] }),
				expect.objectContaining({ taskId: "revalidate:validate:3", dependsOn: ["repair:validate:2"] }),
				expect.objectContaining({ taskId: "deliver", dependsOn: ["revalidate:validate:3"] }),
			]),
		);

		await expect(executeAgentV2NextTask(execution)).resolves.toMatchObject({ taskId: "repair:validate:2" });
		await expect(executeAgentV2NextTask(execution)).resolves.toMatchObject({
			status: "task_failed",
			taskId: "revalidate:validate:3",
		});
		expect(fixture.store.listAgentV2Validations("client-a", "run-direct-repair").map((row) => row.attempt)).toEqual([
			1, 2, 3,
		]);
		const finalTasks = fixture.store.listAgentV2Tasks("client-a", "run-direct-repair");
		expect(finalTasks.find((task) => task.taskId === "revalidate:validate:3")?.status).toBe("failed");
		expect(finalTasks.some((task) => task.taskId === "repair:validate:3")).toBe(false);
		expect(finalTasks.some((task) => task.taskId === "revalidate:validate:4")).toBe(false);
		expect(finalTasks.find((task) => task.taskId === "deliver")?.dependsOn).toEqual(["revalidate:validate:3"]);
	});

	it.each([
		{
			name: "unsafe path",
			files: [{ path: "../escape.txt", content: "escape" }],
			message: "unsafe output path",
		},
		{
			name: "colliding path set",
			files: [
				{ path: "index.html", content: "first" },
				{ path: "INDEX.HTML", content: "second" },
			],
			message: "colliding output paths",
		},
	])("preflights repair $name before the first file or durable write", async ({ files, message }) => {
		const fixture = directRepairFixture("<!doctype html><main>before</main>");
		const commit = vi.spyOn(fixture.store, "commitAgentV2ExecutionMutation");
		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async () => ({
						result: {
							version: 1 as const,
							taskId: "repair:validate:1",
							summary: "untrusted",
							files,
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).rejects.toThrow(message);
		expect(commit).not.toHaveBeenCalled();
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe("<!doctype html><main>before</main>");
	});

	it("honors abort before the repair provider seam and performs no mutation", async () => {
		const fixture = directRepairFixture("<!doctype html><main>before</main>");
		const controller = new AbortController();
		controller.abort(new Error("stop repair"));
		const generateRepair = vi.fn();
		const commit = vi.spyOn(fixture.store, "commitAgentV2ExecutionMutation");
		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				signal: controller.signal,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair,
				} as unknown as AgentV2ModelExecution,
			}),
		).rejects.toThrow("stop repair");
		expect(generateRepair).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
	});
});

function directRepairFixture(content: string) {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-direct-repair-"));
	roots.push(root);
	const config = loadStorageConfig(root);
	const store = new RuntimeDbStore(config.runtimeDbFile);
	stores.push(store);
	store.ensureAgentV2Schema();
	store.createAgentV2Run({
		clientId: "client-a",
		runId: "run-direct-repair",
		input: { objective: "Repair a static app" },
		model: { provider: "test", id: "v2-test-model" },
		createdAt: "2026-07-14T01:00:00.000Z",
	});
	const diagnosticId = "agent_v2.validation_failed:validate:1";
	store.appendAgentV2Diagnostic(
		createAgentV2DiagnosticEvent({
			diagnosticId,
			clientId: "client-a",
			runId: "run-direct-repair",
			severity: "error",
			category: "validation",
			code: "agent_v2.validation_failed",
			phase: "validation",
			taskId: "validate",
			message: "Static validation failed.",
			data: {
				validationId: "static:validate",
				attempt: 1,
				failureCodes: ["static.loading_visible"],
			},
			createdAt: "2026-07-14T01:00:00.000Z",
		}),
	);
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId: "run-direct-repair",
		taskId: "validate",
		kind: "validation",
		title: "Validate",
		status: "succeeded",
		dependsOn: [],
		acceptanceCriteria: [],
		input: {},
		output: {},
		createdAt: "2026-07-14T01:00:00.000Z",
		updatedAt: "2026-07-14T01:00:00.000Z",
	});
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId: "run-direct-repair",
		taskId: "repair:validate:1",
		parentTaskId: "validate",
		kind: "repair",
		title: "Repair",
		status: "ready",
		dependsOn: ["validate"],
		acceptanceCriteria: [],
		input: {
			baseValidationTaskId: "validate",
			failedValidationTaskId: "validate",
			validationId: "static:validate",
			validationAttempt: 1,
			diagnosticIds: [diagnosticId],
		},
		output: {},
		createdAt: "2026-07-14T01:00:00.000Z",
		updatedAt: "2026-07-14T01:00:00.000Z",
	});
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId: "run-direct-repair",
		taskId: "revalidate:validate:2",
		kind: "validation",
		title: "Revalidate",
		status: "pending",
		dependsOn: ["repair:validate:1"],
		acceptanceCriteria: [],
		input: { validationAttempt: 2 },
		output: {},
		createdAt: "2026-07-14T01:00:00.001Z",
		updatedAt: "2026-07-14T01:00:00.001Z",
	});
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId: "run-direct-repair",
		taskId: "deliver",
		kind: "delivery",
		title: "Deliver",
		status: "pending",
		dependsOn: ["revalidate:validate:2"],
		acceptanceCriteria: [],
		input: {},
		output: {},
		createdAt: "2026-07-14T01:00:00.002Z",
		updatedAt: "2026-07-14T01:00:00.002Z",
	});
	store.appendAgentV2ValidationAttempt({
		clientId: "client-a",
		runId: "run-direct-repair",
		validationId: "static:validate",
		attempt: 1,
		taskId: "validate",
		status: "failed",
		summary: "Static validation failed",
		details: { failureCodes: ["static.loading_visible"] },
		createdAt: "2026-07-14T01:00:00.000Z",
		updatedAt: "2026-07-14T01:00:00.000Z",
	});
	const projectRoot = join(config.clientsRootDir, "client-a", "sessions", "session-a", "project");
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(join(projectRoot, "index.html"), content);
	store.upsertAgentV2Artifact({
		clientId: "client-a",
		runId: "run-direct-repair",
		artifactId: "file:index.html",
		kind: "source",
		path: "index.html",
		mediaType: "text/html",
		checksum: checksum(content),
		version: checksum(content),
		sourceTaskId: "implement",
		validationStatus: "failed",
		metadataJson: {},
		createdAt: "2026-07-14T01:00:00.000Z",
		updatedAt: "2026-07-14T01:00:00.000Z",
	});
	return {
		store,
		projectRoot,
		execution: {
			store,
			config,
			context: { clientId: "client-a", sessionId: "session-a", title: "Repair" },
			runId: "run-direct-repair",
			materializer: { materialize: async () => [] },
			now: () => "2026-07-14T01:00:01.000Z",
		},
	};
}

function checksum(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
