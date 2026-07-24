import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const brokenMarkup = `<!doctype html><style>.card{padding:16px}.chart-panel{height:320px}</style>
<div class="card chart-panel"><div class="card-title">Yield Trend</div><canvas id="yieldTrend"></canvas></div><script>
const canvas=document.getElementById('yieldTrend');function draw(){const ctx=canvas.getContext('2d');const parent=canvas.parentElement;const width=parent.clientWidth||300;const height=parent.clientHeight||240;canvas.width=width*2;canvas.height=height*2;ctx.scale(2,2);ctx.moveTo(0,height);ctx.lineTo(width,0);ctx.fillText('100',0,10)}draw();
</script>`;
		const initialContent = `${brokenMarkup}${" ".repeat(24_513 - Buffer.byteLength(brokenMarkup, "utf8"))}`;
		expect(Buffer.byteLength(initialContent, "utf8")).toBe(24_513);
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

		let observedRepairContentMode: string | undefined;
		const generateRepair = vi.fn(async (input: Parameters<AgentV2ModelExecution["generateRepair"]>[0]) => {
			const workspace = input.workspaceFiles[0];
			if (!workspace) throw new Error("missing repair workspace");
			observedRepairContentMode = workspace.contentMode;
			expect(workspace.contentByteLength).toBeLessThanOrEqual(workspace.byteLength);
			// Exercise the production prompt validator here as well as the execution
			// seam so excerpt metadata regressions cannot hide behind a mocked model.
			renderAgentV2RepairPrompt(input);
			return {
				result: {
					version: 1 as const,
					taskId: input.task.taskId,
					summary: "RAW_MODEL_SUMMARY_MUST_NOT_PERSIST",
					files: [],
					patches: [
						{
							path: "index.html",
							expectedChecksum: workspace.checksum,
							oldText: brokenMarkup,
							newText: "<!doctype html><main>Ready</main>",
						},
					],
					addressedDiagnosticIds: input.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
				},
				provider: "test",
				model: "v2-test-model",
			};
		});
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
		expect(store.listAgentV2Diagnostics("client-a", "run-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "agent_v2.validation_failed",
					data: expect.objectContaining({
						failureCodes: expect.arrayContaining(["static.canvas_css_bitmap_mismatch"]),
						failureDetails: expect.arrayContaining([
							expect.objectContaining({
								code: "static.canvas_css_bitmap_mismatch",
								evidence: [expect.objectContaining({ selector: "#yieldTrend", path: "index.html" })],
							}),
						]),
					}),
				}),
			]),
		);

		await expect(execute("2026-07-14T00:00:02.000Z")).resolves.toMatchObject({
			status: "task_succeeded",
			taskId: "repair:validate:1",
		});
		expect(generateRepair).toHaveBeenCalledTimes(1);
		expect(observedRepairContentMode).toBe("excerpt");
		expect(generateRepair.mock.calls[0]?.[0]).toMatchObject({
			run: { model: { provider: "test", id: "v2-test-model" } },
			task: { taskId: "repair:validate:1", kind: "repair" },
			diagnostics: [expect.objectContaining({ code: "agent_v2.validation_failed" })],
		});
		expect(readFileSync(join(projectRoot, "index.html"), "utf8")).toMatch(/^<!doctype html><main>Ready<\/main>/u);
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

	it("deletes a disclosed obsolete implementation and persists an artifact tombstone", async () => {
		const fixture = directRepairFixture("<!doctype html><main>Legacy root</main>");
		const obsoletePath = join(fixture.projectRoot, "src", "main.tsx");
		mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
		const obsoleteContent = "ReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n";
		writeFileSync(obsoletePath, obsoleteContent);
		fixture.store.upsertAgentV2Artifact({
			clientId: "client-a",
			runId: "run-direct-repair",
			artifactId: "file:src/main.tsx",
			kind: "source",
			path: "src/main.tsx",
			mediaType: "text/plain",
			checksum: checksum(obsoleteContent),
			version: checksum(obsoleteContent),
			sourceTaskId: "implement",
			validationStatus: "failed",
			metadataJson: {},
			createdAt: "2026-07-14T01:00:00.000Z",
			updatedAt: "2026-07-14T01:00:00.000Z",
		});

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async (input) => ({
						result: {
							version: 1 as const,
							taskId: input.task.taskId,
							summary: "Keep the standalone application.",
							files: [{ path: "index.html", content: "<!doctype html><main>Ready</main>" }],
							deletedPaths: ["src/main.tsx"],
							addressedDiagnosticIds: input.diagnostics.map((item) => item.diagnosticId),
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toMatchObject({ status: "task_succeeded", taskId: "repair:validate:1" });

		expect(existsSync(obsoletePath)).toBe(false);
		expect(fixture.store.listAgentV2Artifacts("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					artifactId: "file:src/main.tsx",
					validationStatus: "deleted",
					metadataJson: { action: "deleted" },
				}),
			]),
		);
		expect(
			fixture.store
				.listAgentV2RunEvents("client-a", "run-direct-repair", 0)
				.find((event) => event.type === "agent_v2.artifact_indexed" && event.payload.path === "src/main.tsx")
				?.payload,
		).toMatchObject({ action: "deleted", validationStatus: "deleted" });
	});

	it("repairs a large source file through a checksum-bound excerpt patch instead of rejecting its byte size", async () => {
		const brokenMarkup = '<!doctype html><div id="loading">Loading...</div>';
		const initialContent = `${brokenMarkup}${" ".repeat(120_000)}`;
		const fixture = directRepairFixture(initialContent);
		let observedMode: string | undefined;
		let observedContextBytes = 0;

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async (input) => {
						const workspace = input.workspaceFiles[0];
						if (!workspace) throw new Error("missing repair workspace");
						observedMode = workspace.contentMode;
						observedContextBytes = Buffer.byteLength(workspace.content, "utf8");
						return {
							result: {
								version: 1 as const,
								taskId: input.task.taskId,
								summary: "ignored",
								files: [],
								patches: [
									{
										path: "index.html",
										expectedChecksum: workspace.checksum,
										oldText: brokenMarkup,
										newText: "<!doctype html><main>Ready</main>",
									},
								],
								addressedDiagnosticIds: input.diagnostics.map((item) => item.diagnosticId),
							},
							provider: "test",
							model: "v2-test-model",
						};
					},
				},
			}),
		).resolves.toMatchObject({ status: "task_succeeded", taskId: "repair:validate:1" });

		expect(observedMode).toBe("excerpt");
		expect(observedContextBytes).toBeLessThanOrEqual(65_536);
		const repaired = readFileSync(join(fixture.projectRoot, "index.html"), "utf8");
		expect(repaired.startsWith("<!doctype html><main>Ready</main>")).toBe(true);
		expect(Buffer.byteLength(repaired, "utf8")).toBeGreaterThan(100_000);
	});

	it("applies several non-overlapping patches for one file as one atomic repair write", async () => {
		const initialContent =
			'<!doctype html><div id="loading">Loading...</div><script>const value = Math.random();</script>';
		const fixture = directRepairFixture(initialContent);

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async (input) => {
						const workspace = input.workspaceFiles[0];
						if (!workspace) throw new Error("missing repair workspace");
						return {
							result: {
								version: 1 as const,
								taskId: input.task.taskId,
								summary: "ignored",
								files: [],
								patches: [
									{
										path: "index.html",
										expectedChecksum: workspace.checksum,
										oldText: '<div id="loading">Loading...</div>',
										newText: "<main>Ready</main>",
									},
									{
										path: "index.html",
										expectedChecksum: workspace.checksum,
										oldText: "Math.random()",
										newText: "0.5",
									},
								],
								addressedDiagnosticIds: input.diagnostics.map((item) => item.diagnosticId),
							},
							provider: "test",
							model: "v2-test-model",
						};
					},
				},
			}),
		).resolves.toMatchObject({ status: "task_succeeded", taskId: "repair:validate:1" });

		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(
			"<!doctype html><main>Ready</main><script>const value = 0.5;</script>",
		);
		const repairTask = fixture.store
			.listAgentV2Tasks("client-a", "run-direct-repair")
			.find((task) => task.taskId === "repair:validate:1");
		expect(repairTask?.output.changedFiles).toEqual(["index.html"]);
	});

	it("rejects overlapping same-file patches before any workspace write", async () => {
		const initialContent = "<!doctype html><main>abcdef</main>";
		const fixture = directRepairFixture(initialContent);

		await expect(
			executeAgentV2NextTask({
				...fixture.execution,
				modelExecution: {
					generateImplementation: async () => {
						throw new Error("implementation must not run");
					},
					generateRepair: async (input) => {
						const workspace = input.workspaceFiles[0];
						if (!workspace) throw new Error("missing repair workspace");
						return {
							result: {
								version: 1 as const,
								taskId: input.task.taskId,
								summary: "ignored",
								files: [],
								patches: [
									{ path: "index.html", expectedChecksum: workspace.checksum, oldText: "abc", newText: "one" },
									{ path: "index.html", expectedChecksum: workspace.checksum, oldText: "bcd", newText: "two" },
								],
								addressedDiagnosticIds: input.diagnostics.map((item) => item.diagnosticId),
							},
							provider: "test",
							model: "v2-test-model",
						};
					},
				},
			}),
		).resolves.toMatchObject({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(initialContent);
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

	it("retries a malformed repair contract once before consuming another validation attempt", async () => {
		const fixture = directRepairFixture("<!doctype html><main>unchanged</main>");
		const generateRepair = vi.fn(async (input: Parameters<AgentV2ModelExecution["generateRepair"]>[0]) => ({
			result: {
				version: 1 as const,
				taskId: input.task.taskId,
				summary: "RAW_EMPTY_SUMMARY",
				files: [],
				addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
			},
			provider: "test",
			model: "v2-test-model",
		}));
		const execution = {
			...fixture.execution,
			modelExecution: {
				generateImplementation: async () => {
					throw new Error("implementation must not run");
				},
				generateRepair,
			},
		};

		await expect(executeAgentV2NextTask(execution)).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					taskId: "repair:validate:1",
					status: "succeeded",
					output: expect.objectContaining({
						recoveryMode: "model_contract_retry",
						modelContractCode: "invalid_schema",
					}),
				}),
				expect.objectContaining({
					taskId: "repair:validate:1:contract-retry:1",
					status: "pending",
					dependsOn: ["repair:validate:1"],
				}),
				expect.objectContaining({
					taskId: "revalidate:validate:2",
					dependsOn: ["repair:validate:1:contract-retry:1"],
				}),
			]),
		);
		expect(fixture.store.listAgentV2Diagnostics("client-a", "run-direct-repair")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "agent_v2.repair_model_contract_recovery",
					severity: "warn",
					data: { modelContractCode: "invalid_schema", nextContractRecoveryAttempt: 1 },
				}),
			]),
		);
		expect(fixture.store.listAgentV2Validations("client-a", "run-direct-repair")).toHaveLength(1);

		await expect(executeAgentV2NextTask(execution)).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1:contract-retry:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1:contract-retry:1"],
		});
		expect(generateRepair).toHaveBeenCalledTimes(2);
		expect(
			fixture.store
				.listAgentV2Tasks("client-a", "run-direct-repair")
				.find((task) => task.taskId === "repair:validate:1:contract-retry:1"),
		).toMatchObject({
			status: "succeeded",
			output: { recoveryMode: "model_contract_revalidation", modelContractCode: "invalid_schema" },
		});
		expect(fixture.store.listAgentV2Validations("client-a", "run-direct-repair")).toHaveLength(1);
		expect(JSON.stringify(fixture.store.listAgentV2Tasks("client-a", "run-direct-repair"))).not.toContain(
			"RAW_EMPTY_SUMMARY",
		);
	});

	it("enforces the diagnostic maxChangedFiles budget before any repair write", async () => {
		const original = "<!doctype html><main>before</main>";
		const fixture = directRepairFixture(original, { maxChangedFiles: 1 });

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
							summary: "over-broad replacement",
							files: [
								{ path: "index.html", content: "<!doctype html><main>replacement</main>" },
								{ path: "README.md", content: "replacement notes" },
							],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});

		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(original);
		expect(existsSync(join(fixture.projectRoot, "README.md"))).toBe(false);
	});

	it("allows one bounded file per explicit blocking path plus one related pathless finding", async () => {
		const fixture = directRepairFixture(
			'<!doctype html><link rel="stylesheet" href="styles.css"><script src="data.js"></script><script src="app.js"></script>',
			{
				failureDetails: [
					{
						code: "static.local_script_missing",
						path: "data.js",
						blocking: true,
						repairBudget: { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
					},
					{
						code: "static.local_script_missing",
						path: "app.js",
						blocking: true,
						repairBudget: { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
					},
					{
						code: "static.script_error",
						blocking: true,
						repairBudget: { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
					},
				],
			},
		);

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
							summary: "create the three referenced browser resources",
							files: [
								{ path: "data.js", content: "window.demoRows = [];" },
								{ path: "app.js", content: "document.body.dataset.ready = 'true';" },
								{ path: "styles.css", content: "body { margin: 0; }" },
							],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({ status: "task_succeeded", taskId: "repair:validate:1", diagnosticIds: [] });

		expect(readFileSync(join(fixture.projectRoot, "data.js"), "utf8")).toContain("demoRows");
		expect(readFileSync(join(fixture.projectRoot, "app.js"), "utf8")).toContain("dataset.ready");
		expect(readFileSync(join(fixture.projectRoot, "styles.css"), "utf8")).toContain("margin");
	});

	it("rejects a repair that adds an unreferenced source-tree implementation beside a static root app", async () => {
		const fixture = directRepairFixture("<!doctype html><main>existing static app</main>");
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
							summary: "parallel source implementation",
							files: [{ path: "src/main.js", content: "document.body.textContent = 'replacement';" }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(existsSync(join(fixture.projectRoot, "src", "main.js"))).toBe(false);
		expect(
			fixture.store
				.listAgentV2Tasks("client-a", "run-direct-repair")
				.find((task) => task.taskId === "repair:validate:1"),
		).toMatchObject({
			status: "succeeded",
			output: { recoveryMode: "model_contract_retry", modelContractCode: "invalid_schema" },
		});
	});

	it("rejects a repair that turns an existing referenced source implementation into an orphan", async () => {
		const original = '<!doctype html><main id="app"></main><script src="src/main.js"></script>';
		const fixture = directRepairFixture(original);
		mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
		writeFileSync(join(fixture.projectRoot, "src", "main.js"), "document.body.dataset.ready = 'true';");
		const inlineReplacement = `<!doctype html><style>${".panel{display:block}".repeat(40)}</style><body>${"<section>dashboard</section>".repeat(20)}<script>${"document.body.dataset.ready='true';".repeat(20)}</script></body>`;

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
							summary: "inline replacement that accidentally orphans the existing source entry",
							files: [{ path: "index.html", content: inlineReplacement }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(original);
		expect(readFileSync(join(fixture.projectRoot, "src", "main.js"), "utf8")).toContain("dataset.ready");
		expect(
			fixture.store
				.listAgentV2Tasks("client-a", "run-direct-repair")
				.find((task) => task.taskId === "repair:validate:1"),
		).toMatchObject({
			status: "succeeded",
			output: { recoveryMode: "model_contract_retry", modelContractCode: "invalid_schema" },
		});
	});

	it("rejects a localized repair that deletes existing filters, chart hosts, or the detail table", async () => {
		const original = `<!doctype html><main>
<select id="plant-filter"><option>All</option><option>Fab 1</option></select>
<div id="yield-trend-chart"><canvas id="yield-canvas"></canvas></div>
<table><tbody><tr><td>Lot 1</td></tr></tbody></table>
</main>`;
		const fixture = directRepairFixture(original);

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
							summary: "removed working dashboard surfaces",
							files: [{ path: "index.html", content: "<!doctype html><main>Only a KPI remains</main>" }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});

		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(original);
	});

	it("allows a localized Canvas-to-SVG repair when existing interactive surfaces are preserved", async () => {
		const original = `<!doctype html><main>
<select id="plant-filter"><option>All</option><option>Fab 1</option></select>
<div id="yield-trend-chart"><canvas id="yield-canvas"></canvas></div>
<table><tbody><tr><td>Lot 1</td></tr></tbody></table>
</main>`;
		const replacement = `<!doctype html><main>
<select id="plant-filter"><option>All</option><option>Fab 1</option></select>
<div id="yield-trend-chart"><svg id="yield-canvas" viewBox="0 0 600 240"></svg></div>
<table><tbody><tr><td>Lot 1</td></tr></tbody></table>
</main>`;
		const fixture = directRepairFixture(original);

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
							summary: "responsive SVG replacement",
							files: [{ path: "index.html", content: replacement }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toMatchObject({ status: "task_succeeded", taskId: "repair:validate:1", diagnosticIds: [] });

		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(replacement);
	});

	it("treats colliding repair output paths as bounded revalidation instead of a terminal run error", async () => {
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
							summary: "duplicate repair paths",
							files: [
								{ path: "index.html", content: "first" },
								{ path: "INDEX.HTML", content: "second" },
							],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						},
						provider: "test",
						model: "v2-test-model",
					}),
				},
			}),
		).resolves.toEqual({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(
			fixture.store
				.listAgentV2Tasks("client-a", "run-direct-repair")
				.find((task) => task.taskId === "repair:validate:1"),
		).toMatchObject({
			status: "succeeded",
			output: { recoveryMode: "model_contract_retry", modelContractCode: "duplicate_path" },
		});
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe(
			"<!doctype html><main>unchanged</main>",
		);
	});

	it("revalidates unchanged files after a repair provider identity mismatch", async () => {
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
		).resolves.toMatchObject({
			status: "task_succeeded",
			taskId: "repair:validate:1",
			diagnosticIds: ["agent_v2.repair_model_contract_recovery:repair:validate:1"],
		});
		expect(readFileSync(join(fixture.projectRoot, "index.html"), "utf8")).toBe("<!doctype html><main>before</main>");
		expect(
			fixture.store
				.listAgentV2Tasks("client-a", "run-direct-repair")
				.find((task) => task.taskId === "repair:validate:1"),
		).toMatchObject({ status: "succeeded", output: { modelContractCode: "invalid_schema" } });
		expect(fixture.store.listAgentV2RunEvents("client-a", "run-direct-repair", 0)).toHaveLength(
			beforeEvents.length + 4,
		);
	});

	it("keeps the base validation identity across repeated failure and stops with zero new tasks at max attempt", async () => {
		const fixture = directRepairFixture('<!doctype html><script>throw new Error("broken one")</script>');
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
								? '<!doctype html><script>throw new Error("broken two")</script>'
								: '<!doctype html><script>throw new Error("broken three")</script>',
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
		expect(finalTasks.find((task) => task.taskId === "revalidate:validate:3")).toMatchObject({
			output: expect.objectContaining({
				attempt: 3,
				maxAttempts: 3,
				failureCodes: expect.any(Array),
				diagnosticIds: ["agent_v2.validation_failed:validate:3"],
			}),
			error: expect.objectContaining({
				retryable: false,
				data: expect.objectContaining({
					attempt: 3,
					maxAttempts: 3,
					failureCodes: expect.any(Array),
					failureDetails: expect.any(Array),
					diagnosticIds: ["agent_v2.validation_failed:validate:3"],
					fingerprintAttempts: expect.any(Object),
				}),
			}),
		});
	});

	it.each([
		{
			name: "unsafe path",
			files: [{ path: "../escape.txt", content: "escape" }],
			message: "unsafe output path",
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

function directRepairFixture(
	content: string,
	options: {
		maxChangedFiles?: number;
		failureDetails?: Array<Record<string, unknown>>;
	} = {},
) {
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
				...(options.failureDetails
					? { failureDetails: options.failureDetails }
					: options.maxChangedFiles === undefined
						? {}
						: {
								failureDetails: [
									{
										code: "static.loading_visible",
										blocking: true,
										repairBudget: {
											maxAttempts: 2,
											maxSameFingerprintAttempts: 2,
											maxChangedFiles: options.maxChangedFiles,
										},
									},
								],
							}),
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
			repairStrategy: "targeted_patch",
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
