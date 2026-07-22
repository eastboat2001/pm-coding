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
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.loading_visible",
					retryable: true,
					path: "index.html",
					source: "static_quality",
					severity: "warning",
					blocking: false,
					confidence: 0.55,
					fingerprint: expect.stringMatching(/^sha256:/),
				}),
			]),
		);
		expect(result.failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "static.loading_visible", source: "static_smoke" })]),
		);
		expect(result.validation).toMatchObject({
			validationId: "static:validate",
			attempt: 1,
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

	it("keeps a missing build manifest repairable instead of invoking a doomed build", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});
		files.writeFile({
			path: "src/main.tsx",
			content: "document.body.dataset.ready = 'true';",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:01.000Z",
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
				code: "static.build_manifest_missing",
				retryable: true,
				path: "package.json",
				data: expect.objectContaining({ sourceEntry: "src/main.tsx" }),
			}),
		]);
		expect(result.validation.details).toMatchObject({ usedBuildStep: false, retryableFailureCount: 1 });
	});

	it("keeps a missing browser entry repairable through full regeneration", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "README.md",
			content: "Incomplete generated project",
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

		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.preview_missing_entry",
				retryable: true,
				path: "index.html",
			}),
		]);
	});

	it("preserves advisory findings without failing delivery", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: '<!doctype html><main><h1>Ready</h1></main><script src="https://cdn.example.test/chart.js"></script>',
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
		expect(result.rawResult.warnings).toEqual([
			"Static preview quality gate: External script https://cdn.example.test/chart.js should have a local fallback.",
			"Static preview smoke gate: Runtime smoke gate skipped external script https://cdn.example.test/chart.js.",
		]);
		expect(result.validation.details).toMatchObject({
			warningCount: 2,
			warnings: expect.arrayContaining([expect.stringContaining("External script")]),
		});
	});

	it("blocks high-confidence unbounded Chart.js layouts for bounded repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: '<!doctype html><div class="chart"><canvas id="trend"></canvas></div><script src="app.js"></script>',
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});
		files.writeFile({
			path: "app.js",
			content: "new Chart(document.getElementById('trend'), {options:{maintainAspectRatio:false}});",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:01.000Z",
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
				code: "static.canvas_layout_unbounded",
				severity: "error",
				blocking: true,
				path: "index.html",
				data: expect.objectContaining({ canvasIds: ["trend"] }),
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		]);
	});

	it("reports unwired filters and nondeterministic rendered data without blocking delivery", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="plant"><option>Fab A</option></select>
<canvas id="trend" height="240"></canvas><script>
new Chart(document.getElementById('trend'), {data:{datasets:[{data:[Math.random()]}]}});
</script>`,
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
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.control_unwired",
					severity: "warning",
					blocking: false,
					data: expect.objectContaining({ selector: "#plant" }),
				}),
				expect.objectContaining({ code: "static.nondeterministic_data", blocking: false }),
			]),
		);
	});

	it("reports a synthetic no-effect filter without blocking delivery", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="dateType"><option value="day">Day</option><option value="week">Week</option></select>
<output id="lastUpdated">Jul 20, 2026, 01:00 PM</output><script>
document.getElementById('dateType').addEventListener('change', () => {
  document.getElementById('lastUpdated').textContent = 'Jul 20, 2026, 01:00 PM';
});
</script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-20T05:01:00.000Z",
		});

		expect(result.status).toBe("passed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.control_no_effect",
					source: "static_smoke",
					severity: "warning",
					blocking: false,
				}),
			]),
		);
	});

	it("preserves structured BuildRunner failures in v2 validation", async () => {
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
				failureCode: "build.timeout",
				projectId: "project-a",
				sessionId: context.sessionId,
				title: context.title,
				projectRoot: "C:/demo/project",
				fileCount: 2,
				files: ["index.html", "src/main.ts"],
				hasPackageJson: true,
				valid: false,
				errors: ["Container build timed out."],
				logs: ["sanitized timeout log"],
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

		expect(tasks.calls).toEqual(["validate", "build_static"]);
		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "build.timeout",
				source: "static_validate",
				retryable: true,
			}),
		]);
		expect(result.rawResult.task).toBe("build_static");
		expect(failure?.data).toMatchObject({ sourceMessage: "Container build timed out." });
		expect(result.validation.details).toEqual({
			failureCount: 1,
			blockingFailureCount: 1,
			failureCodes: ["build.timeout"],
			retryableFailureCount: 1,
			usedBuildStep: true,
			warningCount: 0,
			warnings: [],
		});
	});

	it("keeps generated manifest policy failures repairable", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Static preview found a build source entry at ./package.json. Run build_static before preview so PI can serve browser-ready dist/build output.";
		const tasks = mockTaskSequence([
			taskResult({ task: "validate", status: "failed", valid: false, errors: [sourceMessage], serveRoot: "" }),
			taskResult({
				task: "build_static",
				status: "failed",
				failureCode: "build.policy_rejected",
				valid: false,
				errors: ["Dependencies require package-lock.json."],
				serveRoot: "",
			}),
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-15T00:00:00.000Z",
			tasks,
		});

		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "build.policy_rejected",
				message: "Dependencies require package-lock.json.",
				retryable: true,
			}),
		]);
		expect(result.validation.details).toMatchObject({ retryableFailureCount: 1 });
	});

	it.each(["Registry origins must be exact HTTPS DNS hostname origins.", "An unknown build policy rejection."])(
		"does not retry non-project policy rejection: %s",
		async (policyMessage) => {
			const config = testConfig(tempRoot());
			const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
			const sourceMessage =
				"Static preview found a build source entry at ./package.json. Run build_static before preview so PI can serve browser-ready dist/build output.";
			const tasks = mockTaskSequence([
				taskResult({ task: "validate", status: "failed", valid: false, errors: [sourceMessage], serveRoot: "" }),
				taskResult({
					task: "build_static",
					status: "failed",
					failureCode: "build.policy_rejected",
					valid: false,
					errors: [policyMessage],
					serveRoot: "",
				}),
			]);

			const result = await runAgentV2StaticValidationGate({
				config,
				context,
				runId: "run-a",
				taskId: "validate",
				now: "2026-07-15T00:00:00.000Z",
				tasks,
			});

			expect(result.failures).toEqual([
				expect.objectContaining({
					code: "build.policy_rejected",
					message: policyMessage,
					retryable: false,
				}),
			]);
			expect(result.validation.details).toMatchObject({ retryableFailureCount: 0 });
		},
	);

	it("stops after an untyped failed build and normalizes its classification", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Static preview found a build source entry at ./src/main.ts. Run build_static before preview so PI can serve browser-ready dist/build output.";
		const tasks = mockTaskSequence([
			taskResult({ task: "validate", status: "failed", valid: false, errors: [sourceMessage], serveRoot: "" }),
			taskResult({
				task: "build_static",
				status: "failed",
				valid: false,
				errors: ["Static build failed."],
				logs: ["Static build failed."],
				serveRoot: "",
			}),
			taskResult({ task: "validate", status: "failed", valid: false, errors: [sourceMessage], serveRoot: "" }),
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
			tasks,
		});

		expect(tasks.calls).toEqual(["validate", "build_static"]);
		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "build.execution_failed",
				source: "static_validate",
				retryable: true,
			}),
		]);
		expect(result.rawResult.task).toBe("build_static");
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
		expect(result.validation.details).toEqual({
			failureCount: 0,
			blockingFailureCount: 0,
			failureCodes: [],
			retryableFailureCount: 0,
			usedBuildStep: true,
			warningCount: 0,
			warnings: [],
		});
	});

	it("rebuilds package projects even when an older dist preview already validates", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const tasks = mockTaskSequence([
			taskResult({ task: "validate", status: "passed", valid: true, errors: [], serveRoot: "C:/demo/project/dist" }),
			taskResult({
				task: "build_static",
				status: "passed",
				valid: true,
				errors: [],
				serveRoot: "C:/demo/project/dist",
			}),
			taskResult({ task: "validate", status: "passed", valid: true, errors: [], serveRoot: "C:/demo/project/dist" }),
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-21T00:00:00.000Z",
			tasks,
		});

		expect(tasks.calls).toEqual(["validate", "build_static", "validate"]);
		expect(result.status).toBe("passed");
		expect(result.validation.details).toMatchObject({ usedBuildStep: true });
	});

	it("blocks disconnected inline and source implementations before running a build", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Build project entry conflict: root index.html contains a standalone inline application while source implementation entries are unreferenced: src/App.tsx, src/main.tsx. Keep one authoritative implementation and make preview output originate from that implementation's build.";
		const tasks = mockTaskSequence([
			taskResult({
				task: "validate",
				status: "failed",
				valid: false,
				errors: [sourceMessage],
				serveRoot: "C:/demo/project/dist",
			}),
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-21T00:00:00.000Z",
			tasks,
		});

		expect(tasks.calls).toEqual(["validate"]);
		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.project_entry_conflict",
				blocking: true,
				retryable: true,
				path: "index.html",
				data: expect.objectContaining({ sourceEntries: ["src/App.tsx", "src/main.tsx"] }),
			}),
		]);
		expect(result.validation.details).toMatchObject({ usedBuildStep: false });
	});

	it("uses the current formal workspace build-required message", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const sourceMessage =
			"Static preview found a build source entry at C:\\demo\\project\\index.html. Run build_static before preview so PI can serve browser-ready dist/build output.";
		const tasks = mockTaskSequence([
			taskResult({ task: "validate", status: "failed", valid: false, errors: [sourceMessage], serveRoot: "" }),
			taskResult({
				task: "build_static",
				status: "failed",
				valid: false,
				errors: ["build_static requires package.json."],
				serveRoot: "",
			}),
		]);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-15T00:00:00.000Z",
			tasks,
		});

		expect(tasks.calls).toEqual(["validate", "build_static"]);
		expect(result.rawResult.task).toBe("build_static");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.build_manifest_missing",
				retryable: true,
				path: "package.json",
			}),
		]);
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
		expect(result.validation.details).toEqual({
			failureCount: 1,
			blockingFailureCount: 1,
			failureCodes: ["static.validation_failed"],
			retryableFailureCount: 1,
			usedBuildStep: false,
			warningCount: 0,
			warnings: [],
		});
		expect(JSON.stringify(result.validation)).not.toContain(sourceMessage);
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
