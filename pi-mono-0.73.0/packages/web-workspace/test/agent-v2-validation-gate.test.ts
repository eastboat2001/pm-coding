import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import { createAgentV2ToolRegistry } from "../src/agent-v2-tool-governance.js";
import type { AgentV2ProductBlueprint } from "../src/agent-v2-types.js";
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

		expect(result.status).toBe("passed");
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
			expect.arrayContaining([
				expect.objectContaining({ code: "static.loading_visible", source: "static_smoke", blocking: false }),
			]),
		);
		expect(result.validation).toMatchObject({
			validationId: "static:validate",
			attempt: 1,
			status: "passed",
			taskId: "validate",
			summary: "Static validation passed with 2 advisory findings",
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

	it("turns high-confidence source-backed blueprint omissions into repairable failures", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T00:00:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false })),
			productBlueprint: dashboardBlueprint(),
			projectSources: [
				{
					path: "index.html",
					content:
						'<select><option disabled selected>Select customer</option></select><h2>Yield Trend</h2><svg id="trend"></svg>',
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.blueprint_chart_missing",
					blocking: true,
					retryable: true,
					path: "index.html",
				}),
				expect.objectContaining({ code: "static.blueprint_default_missing", blocking: true }),
				expect.objectContaining({ code: "static.blueprint_chart_interaction_missing", blocking: true }),
			]),
		);
		expect(result.validation.summary).toBe("Static validation failed");
	});

	it("routes an explicitly targeted but absent detail table into bounded repair", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const baseBlueprint = dashboardBlueprint();
		const tableItem: AgentV2ProductBlueprint["items"][number] = {
			id: "chart-trend",
			text: "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table",
			sourceInputId: "prd",
			sourcePath: "requirements.md",
			sourceChecksum: "sha256:prd",
			line: 80,
			categories: ["requirement", "visual", "interaction"],
		};
		const productBlueprint: AgentV2ProductBlueprint = {
			...baseBlueprint,
			items: [...baseBlueprint.items, tableItem],
			categoryItemIds: {
				...baseBlueprint.categoryItemIds,
				requirement: [...baseBlueprint.categoryItemIds.requirement, tableItem.id],
				interaction: [...baseBlueprint.categoryItemIds.interaction, tableItem.id],
				visual: [...baseBlueprint.categoryItemIds.visual, tableItem.id],
			},
		};
		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T00:00:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false })),
			productBlueprint,
			projectSources: [
				{
					path: "index.html",
					content: `<label>Customer <select><option selected>All selected</option><option>Customer A</option></select></label>
<h2>Finished Overall Trend</h2><canvas id="trendChart"></canvas>
<h2>Defect Loss Ratio</h2><canvas id="defectChart"></canvas><script>
document.getElementById('trendChart').addEventListener('click', selectWeek);
document.getElementById('defectChart').addEventListener('click', updateDepartmentDonut);
</script>`,
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.blueprint_table_missing",
				blocking: true,
				retryable: true,
				confidence: 0.99,
				data: expect.objectContaining({ requiredTables: ["Finished Overall Trend detail table"] }),
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		]);
	});

	it("routes a source-proven highlight-only cross-chart drill-down into bounded repair", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T00:00:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false })),
			productBlueprint: dashboardBlueprint(),
			projectSources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><label>Customer <select><option selected>All selected</option><option>Customer A</option></select></label><canvas id="defectChart"></canvas><script>
const state={selectedDefect:null};
function resetFilters(){state.selectedDefect=null}
function renderDefectChart(data){
 const canvas=document.getElementById('defectChart');
 if(data.code===state.selectedDefect) canvas.dataset.highlighted='true';
 canvas.onclick=function(){state.selectedDefect=data.code;renderDashboard()};
}
function renderDashboard(){renderDefectChart({code:'ED25'});renderDepartmentDonut()}
function renderDepartmentDonut(){document.body.dataset.department='all'}
</script>`,
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				blocking: true,
				retryable: true,
				confidence: 0.97,
				data: expect.objectContaining({ interactiveCharts: ["Defect Loss Ratio"] }),
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		]);
	});

	it("does not let an unclassified static source heuristic become an implicit blocker", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content:
				'<!doctype html><style>.action{color:#fff;background:#fff}</style><button class="action">Review</button>',
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
					code: "static.validation_failed",
					source: "static_quality",
					blocking: false,
					severity: "warning",
				}),
			]),
		);
		expect(result.validation.summary).toBe("Static validation passed with 1 advisory finding");
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

	it("reports a missing local stylesheet with its exact repair path instead of a generic script error", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: '<!doctype html><link rel="stylesheet" href="styles.css"><h1>Yield Dashboard</h1>',
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.local_asset_missing",
				path: "styles.css",
				blocking: true,
				confidence: 0.99,
				evidence: [expect.objectContaining({ kind: "runtime", path: "styles.css" })],
			}),
		);
		expect(result.failures).not.toContainEqual(
			expect.objectContaining({ code: "static.script_error", path: "styles.css" }),
		);
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

	it("classifies native Canvas DPR, viewport, and resize failures with canvas-specific repair evidence", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>.card{padding:16px}.chart-panel{height:320px}</style>
<div class="card chart-panel"><div class="card-title">Yield Trend</div><canvas id="yieldTrend"></canvas></div><script>
const canvas=document.getElementById('yieldTrend');
function draw(){const ctx=canvas.getContext('2d');const parent=canvas.parentElement;const width=parent.clientWidth;const height=parent.clientHeight;canvas.width=width*2;canvas.height=height*2;ctx.scale(2,2);ctx.moveTo(0,height);ctx.lineTo(width,0);ctx.fillText('100',0,10)}
draw();
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

		expect(result.status).toBe("failed");
		expect(result.failures.map((failure) => failure.code)).toEqual(
			expect.arrayContaining([
				"static.canvas_css_bitmap_mismatch",
				"static.canvas_layout_unbounded",
				"static.canvas_resize_unhandled",
			]),
		);
		for (const failure of result.failures.filter(
			(item) => item.code === "static.canvas_css_bitmap_mismatch" || item.code === "static.canvas_layout_unbounded",
		)) {
			expect(failure).toMatchObject({
				retryable: true,
				blocking: true,
				path: "index.html",
				data: expect.objectContaining({ canvasIds: ["yieldTrend"], sourceEvidence: expect.any(String) }),
				evidence: [
					expect.objectContaining({
						kind: "layout",
						path: "index.html",
						selector: "#yieldTrend",
					}),
				],
			});
		}
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.canvas_resize_unhandled",
					blocking: true,
					severity: "error",
					confidence: 0.96,
				}),
			]),
		);
	});

	it("routes an external Canvas resize failure to the script that owns the drawing code", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content:
				'<!doctype html><style>.chart-viewport{height:320px}.chart-viewport canvas{width:100%;height:100%}</style><div class="chart-viewport"><canvas id="yieldTrend"></canvas></div><script src="src/main.js"></script>',
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});
		files.writeFile({
			path: "src/main.js",
			content: `const canvas = document.getElementById('yieldTrend');
function draw() { const rect = canvas.parentElement.getBoundingClientRect(); const dpr = devicePixelRatio || 1; canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px'; canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('Yield', 10, 10); }
draw();`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.canvas_resize_unhandled",
				path: "src/main.js",
				data: expect.objectContaining({ sourceEvidence: expect.stringContaining("src/main.js:2") }),
				evidence: [expect.objectContaining({ kind: "layout", path: "src/main.js", selector: "#yieldTrend" })],
			}),
		);
	});

	it("classifies a responsive SVG coordinate mismatch as retryable bounded layout evidence", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>.chart-box{height:260px}.chart-box svg{width:100%;height:100%}</style>
<h1>Quality Dashboard</h1><div class="chart-box"><svg id="deptChart"></svg></div><script>
const s=id=>document.getElementById(id);const bounds=s('deptChart').getBoundingClientRect();drawDonut(s('deptChart'),{},bounds.width,360);
function drawDonut(svg,data,width,height){svg.innerHTML='<path d="M0 '+height+' L'+width+' 0"/>'}
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

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.svg_coordinate_space_mismatch",
				blocking: true,
				retryable: true,
				confidence: 0.99,
				path: "index.html",
				data: expect.objectContaining({ selector: "#deptChart", sourceEvidence: expect.any(String) }),
				evidence: [expect.objectContaining({ kind: "layout", selector: "#deptChart" })],
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		]);
	});

	it("blocks an intrinsically wide table in a multi-column dashboard grid with repair evidence", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>.detail-grid{display:grid;grid-template-columns:1fr 1fr 1fr}.card{padding:20px}table{width:100%;min-width:900px}</style>
<h1>Yield Dashboard</h1><section class="detail-grid"><article class="card">Pareto Chart</article><article class="card"><table><thead><tr><th>Defect</th><th>Description</th><th>Count</th><th>Loss</th><th>Department</th></tr></thead></table></article><article class="card">Donut Chart</article></section>`,
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
				code: "static.page_horizontal_overflow",
				blocking: true,
				retryable: true,
				confidence: 0.97,
				path: "index.html",
				data: expect.objectContaining({
					selector: "section.detail-grid",
					sourceEvidence: expect.stringContaining("grid-template-columns"),
				}),
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		]);
	});

	it("routes Canvas Grid intrinsic-width feedback to a retryable source-specific repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Operations Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.chart-card{padding:20px}
.chart-viewport{position:relative;width:100%;height:250px;overflow:hidden}.chart-canvas{display:block;width:100%;height:100%}
</style><h1>Operations Trend Dashboard</h1><section class="charts-grid">
<article class="chart-card"><h2>Throughput Trend</h2><div class="chart-viewport"><canvas id="trend-chart" class="chart-canvas"></canvas></div></article>
<article class="chart-card"><h2>Defect Summary</h2><p>Deterministic summary content</p></article>
</section><script src="./src/main.js"></script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-23T00:01:00.000Z",
		});
		files.writeFile({
			path: "src/main.js",
			content: `function drawTrend(){
  const canvas=document.getElementById('trend-chart');const container=canvas.parentElement;const dpr=devicePixelRatio||1;
  canvas.width=container.offsetWidth*dpr;canvas.height=container.offsetHeight*dpr;
  canvas.style.width=container.offsetWidth+'px';canvas.style.height=container.offsetHeight+'px';
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.moveTo(0,container.offsetHeight);ctx.lineTo(container.offsetWidth,0);ctx.fillText('Trend',8,16);
}
new ResizeObserver(drawTrend).observe(document.getElementById('trend-chart').parentElement);drawTrend();`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-23T00:01:01.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T00:02:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.page_horizontal_overflow",
				blocking: true,
				retryable: true,
				confidence: 0.97,
				path: "src/main.js",
				data: expect.objectContaining({
					selector: "section.charts-grid",
					canvasIds: ["trend-chart"],
					sourceEvidence: expect.stringContaining("src/main.js:"),
				}),
				evidence: [
					expect.objectContaining({
						kind: "layout",
						path: "src/main.js",
						selector: "#trend-chart",
					}),
				],
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
			}),
		);
	});

	it("classifies a proven hyphenated filter state-key mismatch before runtime smoke", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select>
<output id="kpi">1</output><script>let state={dateType:'Weekly'};const filters=['date-type-filter'];
filters.forEach(id=>document.getElementById(id).addEventListener('change',e=>{const key=id.split('-')[0];state[key]=e.target.value;render()}));
function render(){document.getElementById('kpi').textContent=state.dateType}</script>`,
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
					code: "static.filter_state_key_mismatch",
					blocking: true,
					retryable: true,
					confidence: 0.99,
					data: expect.objectContaining({ selector: "#date-type-filter", sourceEvidence: expect.any(String) }),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("keeps unwired-filter heuristics advisory but blocks direct random chart data", async () => {
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

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.control_unwired",
					severity: "warning",
					blocking: false,
					data: expect.objectContaining({ selector: "#plant" }),
				}),
				expect.objectContaining({
					code: "static.nondeterministic_data",
					blocking: true,
					confidence: 0.97,
					data: expect.objectContaining({ highConfidence: true }),
				}),
			]),
		);
	});

	it("blocks unseeded game randomness only when the product requirement explicitly requires reproducible state", async () => {
		const result = await runAgentV2StaticValidationGate({
			config: testConfig(tempRoot()),
			context: { clientId: "client-a", sessionId: "session-a", title: "Brick Game" },
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T08:00:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false, files: ["index.html"] })),
			productBlueprint: determinismBlueprint("固定关卡和初始球速，刷新后必须可复现，不允许使用无种子的随机数。"),
			projectSources: [
				{
					path: "index.html",
					content: `<!doctype html><canvas id="game" width="800" height="600"></canvas><script>
class BrickGame {
  resetBall() {
    this.ball = { dx: Math.random() > 0.5 ? 4 : -4, dy: -4 };
  }
}
</script>`,
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({
				code: "static.nondeterministic_data",
				path: "index.html",
				blocking: true,
				retryable: true,
				confidence: 0.97,
				data: expect.objectContaining({
					highConfidence: true,
					requirementKind: "explicit_determinism",
					blueprintItemId: "deterministic-requirement",
					blueprintEvidence: expect.stringContaining("刷新后必须可复现"),
					sourceEvidence: expect.stringMatching(/^index\.html:\d+ Math\.random\(\)$/u),
				}),
				repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
			}),
		]);
	});

	it("does not block ordinary game randomness when reproducibility was not requested", async () => {
		const result = await runAgentV2StaticValidationGate({
			config: testConfig(tempRoot()),
			context: { clientId: "client-a", sessionId: "session-a", title: "Asteroid Game" },
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T08:01:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false, files: ["index.html"] })),
			productBlueprint: determinismBlueprint("Build an arcade game with random asteroid spawns."),
			projectSources: [
				{
					path: "index.html",
					content:
						'<!doctype html><canvas id="game" width="800" height="600"></canvas><script>const asteroidX = Math.random() * 800;</script>',
				},
			],
		});

		expect(result.status).toBe("passed");
		expect(result.failures).toEqual([]);
	});

	it("does not treat Math.random text in comments or strings as executable randomness", async () => {
		const result = await runAgentV2StaticValidationGate({
			config: testConfig(tempRoot()),
			context: { clientId: "client-a", sessionId: "session-a", title: "Seeded Demo" },
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T08:02:00.000Z",
			tasks: mockTaskService(taskResult({ task: "validate", hasPackageJson: false, files: ["index.html"] })),
			productBlueprint: determinismBlueprint("The demo must be deterministic and reproducible across refreshes."),
			projectSources: [
				{
					path: "index.html",
					content: `<!doctype html><output id="value"></output><script>
// Never call Math.random() in this deterministic demo.
const guidance = "Replace Math.random() with a seeded generator";
let seed = 7;
function nextSeeded() { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }
document.getElementById('value').textContent = nextSeeded().toFixed(3);
</script>`,
				},
			],
		});

		expect(result.status).toBe("passed");
		expect(result.failures).toEqual([]);
	});

	it("blocks only an exact source-backed all-visuals filter when select wiring is absent", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T00:00:00.000Z",
			tasks: mockTaskService(
				taskResult({
					task: "validate",
					hasPackageJson: false,
					status: "failed",
					valid: false,
					errors: [
						"Static preview quality gate: Select control #customerFilter is never referenced by local JavaScript and cannot affect rendered data.",
						"Static preview quality gate: Select control #plantFilter is never referenced by local JavaScript and cannot affect rendered data.",
					],
				}),
			),
			productBlueprint: scopedFiltersBlueprint(),
			projectSources: [
				{
					path: "index.html",
					content: `<label for="customerFilter">Customer</label><select id="customerFilter"><option>All</option><option>A</option></select>
<label for="plantFilter">Plant</label><select id="plantFilter"><option>All</option><option>P1</option></select>`,
				},
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.control_unwired",
					blocking: true,
					confidence: 0.97,
					data: expect.objectContaining({ selector: "#customerFilter", highConfidence: true }),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
				expect.objectContaining({
					code: "static.control_unwired",
					blocking: false,
					severity: "warning",
					data: expect.objectContaining({ selector: "#plantFilter", highConfidence: false }),
				}),
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
		expect(result.failures).toEqual([]);
		expect(result.validation.details).toEqual(
			expect.objectContaining({
				warnings: expect.arrayContaining([expect.stringContaining("select #dateType changed value")]),
			}),
		);
	});

	it("blocks a deterministic dashboard filter with representative KPIs and identical native Canvas output", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="unitType" data-filter="unitType"><option value="NSQM">NSQM</option><option value="SQM">SQM</option></select>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<canvas id="yieldTrend"></canvas><script>
const mockData = [{ unitType: 'NSQM', output: 120 }, { unitType: 'SQM', output: 120 }];
const ctx = document.getElementById('yieldTrend').getContext('2d');
function render() {
  ctx.clearRect(0, 0, 300, 150); ctx.fillRect(0, 30, 40, 120); ctx.fillText('120', 10, 12);
  document.getElementById('kpiOutput').textContent = '120';
  document.getElementById('kpiYield').textContent = '95%';
}
document.getElementById('unitType').addEventListener('change', render); render();
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

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.control_no_effect",
					severity: "error",
					blocking: true,
					confidence: 0.97,
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
					data: expect.objectContaining({ highConfidence: true }),
				}),
			]),
		);
	});

	it("attributes a deterministic no-effect filter to the external script that binds the control", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		const html = `<!doctype html><main class="dashboard">
<select id="customer-filter"><option value="All">All</option><option value="A">A</option></select>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><rect width="120"></rect></svg><table><tbody id="detailRows"><tr><td>All</td></tr></tbody></table>
<script src="app.js"></script></main>`;
		const app = `// Deterministic mock data
const DEMO_ROWS = [{ customer: 'A', output: 120, yield: 95 }];
const customerFilter = document.getElementById('customer-filter');
function renderDashboard() {
  document.getElementById('kpiOutput').textContent = '120';
  document.getElementById('kpiYield').textContent = '95%';
}
customerFilter.addEventListener('change', renderDashboard);
renderDashboard();`;
		files.writeFile({
			path: "index.html",
			content: html,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});
		files.writeFile({
			path: "app.js",
			content: app,
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
			projectSources: [
				{ path: "index.html", content: html },
				{ path: "app.js", content: app },
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.control_no_effect",
				path: "app.js",
				blocking: true,
				data: expect.objectContaining({
					selector: "#customer-filter",
					sourceEvidence: expect.stringContaining("app.js:3 binds #customer-filter"),
				}),
			}),
		);
	});

	it("attributes a dynamically delegated no-effect select to its external browser script", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		const html = `<!doctype html><main class="dashboard">
<select id="filter-date-type"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><rect width="120"></rect></svg><table><tbody id="detailRows"><tr><td>Weekly</td></tr></tbody></table>
<script src="src/main.js"></script></main>`;
		const app = `// Deterministic mock data
const DEMO_ROWS = [{ dateType: 'Weekly', output: 120 }, { dateType: 'Monthly', output: 120 }];
const state = { dateType: 'Weekly' };
document.querySelectorAll('select').forEach((select) => {
  select.addEventListener('change', (event) => {
    const id = event.target.id;
    if (id === 'filter-date-type') state.dateType = event.target.value;
    document.getElementById('kpiOutput').textContent = '120';
    document.getElementById('kpiYield').textContent = '95%';
  });
});`;
		files.writeFile({
			path: "index.html",
			content: html,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});
		files.writeFile({
			path: "src/main.js",
			content: app,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
			projectSources: [
				{ path: "index.html", content: html },
				{ path: "src/main.js", content: app },
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.control_no_effect",
				path: "src/main.js",
				blocking: true,
				data: expect.objectContaining({
					selector: "#filter-date-type",
					sourceEvidence: expect.stringContaining("src/main.js:7 delegates a select change branch"),
				}),
			}),
		);
	});

	it("attributes id-collection dynamic select wiring to the external repair target", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		const html = `<!doctype html><main class="dashboard">
<select id="filter-customer"><option value="All">All</option><option value="C01">Customer A</option></select>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><rect width="120"></rect></svg><table><tbody id="detailRows"><tr><td>All</td></tr></tbody></table>
<script src="app.js"></script></main>`;
		const app = `const DEMO_ROWS = [{ customer: 'All', output: 120 }, { customer: 'C01', output: 120 }];
const state = { filters: { customer: 'All' } };
const filterIds = ['filter-customer'];
filterIds.forEach(id => {
  const select = document.getElementById(id);
  select.addEventListener('change', event => {
    const stateKey = id.replace('filter-', '');
    state.filters[stateKey] = event.target.value;
    renderDashboard();
  });
});
function renderDashboard() {
  document.getElementById('kpiOutput').textContent = '120';
  document.getElementById('kpiYield').textContent = '95%';
}
renderDashboard();`;
		files.writeFile({
			path: "index.html",
			content: html,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});
		files.writeFile({
			path: "app.js",
			content: app,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
			projectSources: [
				{ path: "index.html", content: html },
				{ path: "app.js", content: app },
			],
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.control_no_effect",
				path: "app.js",
				blocking: true,
				data: expect.objectContaining({
					selector: "#filter-customer",
					sourceEvidence: expect.stringContaining("app.js:3 delegates a select change branch"),
				}),
			}),
		);
	});

	it("routes a source-local global filter with a stale detail table into bounded repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><div id="filters"><select id="customer"><option value="All">All</option><option value="A">A</option></select><select id="plant"><option value="All">All</option><option value="P1">P1</option></select></div>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div><svg id="yieldTrend"></svg><svg id="defectChart"></svg><table><tbody id="detailTableBody"></tbody></table><script>
const mockData = { All: 120, A: 85 };
function renderAll() { const customer = document.getElementById('customer').value; const plant = document.getElementById('plant').value; const value = (mockData[customer] || 120) + (plant === 'P1' ? 1 : 0); document.getElementById('kpiOutput').textContent = String(value); document.getElementById('kpiYield').textContent = value < 100 ? '93%' : '95%'; document.getElementById('yieldTrend').innerHTML = '<rect width="' + value + '"></rect>'; document.getElementById('defectChart').innerHTML = '<rect width="40"></rect>'; document.getElementById('detailTableBody').innerHTML = '<tr><td>unchanged</td></tr>'; }
document.querySelectorAll('#filters select').forEach((select) => select.addEventListener('change', () => renderAll())); renderAll();
</script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});

		const advisory = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-20T05:01:00.000Z",
		});
		expect(advisory.status).toBe("passed");
		expect(advisory.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_partial_update",
					severity: "warning",
					blocking: false,
					data: expect.objectContaining({ highConfidence: false }),
				}),
			]),
		);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-b",
			taskId: "validate",
			now: "2026-07-20T05:02:00.000Z",
			productBlueprint: dashboardBlueprint(),
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_partial_update",
					severity: "error",
					blocking: true,
					confidence: 0.97,
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
					data: expect.objectContaining({ highConfidence: true }),
				}),
			]),
		);
	});

	it("does not borrow one filter's all-visuals scope for a different local filter", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Operations Overview" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><main class="dashboard"><div class="filter-toolbar">
<label for="customer-filter">Customer</label><select id="customer-filter"><option value="All">All</option><option value="A">A</option></select>
<label for="plant-filter">Plant</label><select id="plant-filter"><option value="All">All</option><option value="P1">P1</option></select></div>
<output id="kpi-output" class="kpi-value">120</output><output id="kpi-rate" class="kpi-value">95%</output>
<svg id="volume-chart"></svg><svg id="risk-chart"></svg><table><tbody id="detail-result"></tbody></table><script>
const demoFixture = [{ customer:'All', output:120 }, { customer:'A', output:85 }];
function renderDashboard(){const customer=document.getElementById('customer-filter').value;const plant=document.getElementById('plant-filter').value;
const row=demoFixture.find(item=>item.customer===customer)||demoFixture[0];const localBoost=plant==='P1'?1:0;
document.getElementById('kpi-output').textContent=String(row.output+localBoost);document.getElementById('kpi-rate').textContent=String(90+row.output/24+localBoost)+'%';
document.getElementById('volume-chart').innerHTML='<rect width="'+row.output+'"></rect>';
document.getElementById('risk-chart').innerHTML='<rect width="'+(row.output-20)+'"></rect>';
document.getElementById('detail-result').innerHTML='<tr><td>'+customer+'</td><td>'+row.output+'</td></tr>';}
document.querySelectorAll('.filter-toolbar select').forEach(control=>control.addEventListener('change',renderDashboard));renderDashboard();
</script></main>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-23T06:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-scoped-filter",
			taskId: "validate",
			now: "2026-07-23T06:01:00.000Z",
			tasks: mockTaskService(
				taskResult({
					task: "validate",
					hasPackageJson: false,
					status: "failed",
					valid: false,
					errors: [
						"Static preview smoke gate: Runtime smoke gate: deterministic global select #plant-filter changed some dashboard data but left synchronized surfaces unchanged: chart #volume-chart, result #detail-result.",
					],
				}),
			),
			productBlueprint: scopedFiltersBlueprint(),
			projectSources: [
				{
					path: "index.html",
					content:
						'<label for="customer-filter">Customer</label><select id="customer-filter"><option>All</option><option>A</option></select><label for="plant-filter">Plant</label><select id="plant-filter"><option>All</option><option>P1</option></select>',
				},
			],
		});

		expect(result.status, JSON.stringify(result.failures, null, 2)).toBe("passed");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				code: "static.filter_partial_update",
				blocking: false,
				data: expect.objectContaining({ selector: "#plant-filter", highConfidence: false }),
			}),
		);
	});

	it("routes invalid aggregated dashboard labels into a specific bounded repair diagnostic", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>.chart-viewport{position:relative;height:320px}.chart-viewport canvas{width:100%;height:100%}</style>
<select id="filterDateType"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<div id="kpiOutput" class="kpi-value">159 Lots</div><div id="kpiYield" class="kpi-value">94.81%</div>
<div class="chart-viewport"><canvas id="yieldTrend"></canvas></div><div class="chart-viewport"><canvas id="defectChart"></canvas></div>
<div id="detailWeekLabel">Week 202621</div><table><tbody id="detailTableBody"><tr><td>202621</td></tr></tbody></table><script>
const demoRows = [{ week: '202620' }, { week: '202621' }];
document.getElementById('filterDateType').addEventListener('change', (event) => {
  const first = demoRows[0]; const last = event.target.value === 'Monthly' ? demoRows[3] : demoRows[1];
  document.getElementById('kpiOutput').textContent = event.target.value === 'Monthly' ? '319 Lots' : '159 Lots';
  document.getElementById('kpiYield').textContent = event.target.value === 'Monthly' ? '95.10%' : '94.81%';
  document.getElementById('detailWeekLabel').textContent = 'Week ' + first.week + '-' + last?.week;
  document.getElementById('detailTableBody').innerHTML = '<tr><td>' + first.week + '-' + last?.week + '</td></tr>';
});
</script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T13:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T13:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.invalid_rendered_data",
					blocking: true,
					confidence: 0.99,
					path: "index.html",
					data: expect.objectContaining({
						selector: "#detailWeekLabel",
						token: "undefined",
						highConfidence: true,
					}),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("routes stale chart data beside an explicit empty dashboard result into bounded repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><main class="dashboard">
<select id="customer"><option value="all">All</option><option value="C002">Customer B</option></select>
<output id="kpi-yield" class="kpi-value">95%</output><output id="kpi-output" class="kpi-value">150</output>
<svg id="yield-chart"></svg><svg id="defect-chart"></svg><table><tbody id="detail-body"></tbody></table>
<script>
const DEMO_ROWS = [{ customer: 'all', yield: 95, output: 150 }];
function renderDashboard() {
  const empty = document.getElementById('customer').value === 'C002';
  document.getElementById('kpi-yield').textContent = empty ? '--' : '95%';
  document.getElementById('kpi-output').textContent = empty ? '--' : '150';
  document.getElementById('detail-body').innerHTML = empty ? '<tr><td>No data available</td></tr>' : '<tr><td>Week 12</td></tr>';
  if (!empty) {
    document.getElementById('yield-chart').innerHTML = '<rect x="0" y="0" width="20" height="40"></rect>';
    document.getElementById('defect-chart').innerHTML = '<path d="M0 0 L20 20"></path>';
  }
}
document.getElementById('customer').addEventListener('change', renderDashboard);
renderDashboard();
</script></main>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T13:00:00.000Z",
		});

		const advisory = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T13:01:00.000Z",
		});
		expect(advisory.status).toBe("passed");
		expect(advisory.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_empty_state_inconsistent",
					blocking: false,
					confidence: 0.72,
					data: expect.objectContaining({ highConfidence: false }),
				}),
			]),
		);

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-b",
			taskId: "validate",
			now: "2026-07-22T13:02:00.000Z",
			productBlueprint: dashboardBlueprint(),
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_empty_state_inconsistent",
					blocking: true,
					confidence: 0.99,
					path: "index.html",
					data: expect.objectContaining({
						selector: "#detail-body",
						chartSelectors: ["#yield-chart", "#defect-chart"],
						highConfidence: true,
					}),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("keeps an inert-filter observation advisory when an external render script was not simulated", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><style>.chart-viewport{position:relative;height:280px}.chart-viewport canvas{width:100%!important;height:100%!important}</style><select id="plant"><option value="all">All</option><option value="P1">P1</option></select>
<p id="kpiOutput">-</p><p id="kpiYield">-</p>
<div class="chart-viewport"><canvas id="yieldTrend"></canvas></div><script src="https://example.test/chart.js"></script><script src="app.js"></script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});
		files.writeFile({
			path: "app.js",
			content: `const MOCK_DATA = { output: 120, yield: 95 };
const state = { filters: { plant: 'all' } };
function render() {
  document.getElementById('kpiOutput').textContent = String(MOCK_DATA.output);
  document.getElementById('kpiYield').textContent = MOCK_DATA.yield + '%';
}
document.getElementById('plant').addEventListener('change', (event) => {
  state.filters.plant = event.target.value;
  render();
});
document.addEventListener('DOMContentLoaded', render);`,
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

		// The source-proven unused filter remains a legitimate blocker; only the
		// incomplete synthetic-runtime observation is downgraded.
		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "static.filter_value_unused", blocking: true })]),
		);
		expect(result.validation.details).toEqual(
			expect.objectContaining({
				warnings: expect.arrayContaining([
					expect.stringContaining("select #plant changed value"),
					expect.stringContaining("skipped external script"),
				]),
			}),
		);
	});

	it("blocks an unchanged default Apply action that empties deterministic fixture data", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="dateType"><option value="Weekly" selected>Weekly</option></select>
<button id="applyFilters">Apply Filters</button><div id="kpiOutput" class="kpi-value">100</div>
				<div id="kpiYield" class="kpi-value">95%</div><tbody id="detailTableBody">one row</tbody><script src="main.js"></script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});
		files.writeFile({
			path: "main.js",
			content: `const mockData = [{ ATSDate: '2026-06-01', Yield: 95 }];
document.getElementById('applyFilters').addEventListener('click', () => {
  const value = document.getElementById('dateType').value;
  const rows = mockData.filter((item) => item.DateType === value);
  document.getElementById('kpiOutput').textContent = rows.length ? '100' : '0';
  document.getElementById('kpiYield').textContent = rows.length ? '95%' : '0%';
  document.getElementById('detailTableBody').innerHTML = rows.length ? 'one row' : 'No data';
});`,
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

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.default_filter_inconsistent",
					path: "main.js",
					source: "static_smoke",
					severity: "error",
					confidence: 0.95,
					blocking: true,
					retryable: true,
					data: expect.objectContaining({ field: "DateType", sourceEvidence: expect.stringContaining("main.js") }),
				}),
			]),
		);
	});

	it("blocks a captured filter value that local source provably never uses", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="filter-date-type"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<div id="result">Ready</div><script src="main.js"></script>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:00.000Z",
		});
		files.writeFile({
			path: "main.js",
			content: `const dateType = document.getElementById('filter-date-type').value;
document.getElementById('result').textContent = 'unchanged';`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-20T05:00:01.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-20T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					path: "main.js",
					blocking: true,
					confidence: 0.98,
					data: expect.objectContaining({
						selector: "#filter-date-type",
						variable: "dateType",
						sourceEvidence: expect.stringContaining("main.js:1"),
					}),
				}),
			]),
		);
	});

	it("classifies a flat filter state property with no rendered-data read into bounded repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><main class="dashboard">
<select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select><output id="kpi">1</output>
<script>const state={dateType:'Weekly'};
document.getElementById('date-type-filter').addEventListener('change', event => { state.dateType=event.target.value; render(); });
function render(){document.getElementById('kpi').textContent='1';}</script></main>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					path: "index.html",
					blocking: true,
					retryable: true,
					data: expect.objectContaining({
						selector: "#date-type-filter",
						statePath: "state.dateType",
						sourceEvidence: expect.stringContaining("index.html:"),
					}),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("routes a delegated identity data getter into bounded filter repair with source evidence", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><main class="dashboard"><div id="filter-bar">
<select id="date-type"><option>Weekly</option><option>Monthly</option></select>
<select id="customer"><option>All</option><option>A</option></select></div><output id="kpi">1</output><table><tbody></tbody></table>
<script>const State={filters:{dateType:'Weekly',customer:'All'},dataset:[{customer:'A'}],listeners:[],
updateFilter(key,value){this.filters[key]=value;this.notify();},notify(){this.listeners.forEach(fn=>fn(this.filters));},
subscribe(fn){this.listeners.push(fn);},getFilteredData(){return this.dataset;}};
document.getElementById('filter-bar').addEventListener('change',event=>{State.updateFilter(event.target.id.replace(/-([a-z])/g,(_m,c)=>c.toUpperCase()),event.target.value);});
function render(){document.getElementById('kpi').textContent=String(State.getFilteredData().length);}State.subscribe(()=>render());render();</script></main>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-23T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-23T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					path: "index.html",
					blocking: true,
					retryable: true,
					data: expect.objectContaining({
						selector: "#date-type",
						statePath: "this.filters.dateType",
						sharedDataGetter: "getFilteredData",
						sourceEvidence: expect.stringContaining("index.html:"),
					}),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("routes an unread nested filter from a shared derived-key handler into bounded repair", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><main class="dashboard"><select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select><output id="kpi">1</output>
<script>const rows=[{value:1}],state={filters:{dateType:'Weekly'}};
function render(){document.getElementById('kpi').textContent=rows.length;}
document.querySelectorAll('select').forEach(el=>el.addEventListener('change',event=>{const key=el.id.replace('filter-','');if(key==='date-type')state.filters.dateType=event.target.value;render();}));</script></main>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-22T05:00:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					blocking: true,
					data: expect.objectContaining({
						selector: "#filter-date-type",
						statePath: "state.filters.dateType",
					}),
					repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
				}),
			]),
		);
	});

	it("routes an unread explicit binding-map filter to its script instead of a generic advisory", async () => {
		const config = testConfig(tempRoot());
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const sourceMessage =
			"Static preview quality gate: static.filter_value_unused: Select #customer-filter is bound through a generic change handler, but its value is never read by rendered-data code. Evidence: src/main.js:369 'customer-filter': 'customer',";

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-22T05:01:00.000Z",
			tasks: mockTaskSequence([
				{
					task: "validate",
					status: "failed",
					projectId: "project-a",
					sessionId: context.sessionId,
					title: context.title,
					projectRoot: "C:/demo/project",
					fileCount: 2,
					files: ["index.html", "src/main.js"],
					hasPackageJson: false,
					valid: false,
					errors: [sourceMessage],
					mode: "static",
					serveRoot: "C:/demo/project",
				},
			]),
		});

		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					path: "src/main.js",
					blocking: true,
					data: expect.objectContaining({ selector: "#customer-filter", genericHandler: true }),
				}),
			]),
		);
	});

	it("blocks a dashboard filter that is only referenced by Reset and never read by Apply", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Yield Dashboard" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><select id="plantFilter"><option value="all">All</option><option value="P1">P1</option></select>
<button id="applyFilters">Apply Filters</button><button id="resetFilters">Reset</button><canvas id="yieldTrend"></canvas><script>
const MOCK_DATA = [120, 95];
document.getElementById('applyFilters').onclick = () => MOCK_DATA;
document.getElementById('resetFilters').onclick = () => { document.getElementById('plantFilter').selectedIndex = 0; };
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

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "static.filter_value_unused",
					blocking: true,
					data: expect.objectContaining({ selector: "#plantFilter", resetOnly: true }),
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

function dashboardBlueprint(): AgentV2ProductBlueprint {
	const items: AgentV2ProductBlueprint["items"] = [
		{
			id: "chart-defect",
			text: "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut",
			sourceInputId: "prd",
			sourcePath: "requirements.md",
			sourceChecksum: "sha256:prd",
			line: 81,
			categories: ["requirement", "visual", "interaction"],
		},
		{
			id: "filter-customer",
			text: "Customer | Dropdown | All selected | All charts",
			sourceInputId: "prd",
			sourcePath: "requirements.md",
			sourceChecksum: "sha256:prd",
			line: 42,
			categories: ["requirement", "interaction"],
		},
	];
	return {
		kind: "product_blueprint",
		version: 1,
		title: "Dashboard blueprint",
		summary: "Dashboard",
		responseLanguage: "en",
		sourceDocuments: [{ inputId: "prd", path: "requirements.md", checksum: "sha256:prd", lineCount: 100 }],
		items,
		categoryItemIds: {
			requirement: items.map((item) => item.id),
			page: [],
			interaction: items.map((item) => item.id),
			state: [],
			permission: [],
			visual: ["chart-defect"],
			acceptance: [],
		},
	};
}

function determinismBlueprint(text: string): AgentV2ProductBlueprint {
	const items: AgentV2ProductBlueprint["items"] = [
		{
			id: "deterministic-requirement",
			text,
			sourceInputId: "run-objective",
			sourcePath: "run.objective",
			sourceChecksum: "sha256:objective",
			line: 1,
			categories: ["requirement"],
		},
	];
	return {
		kind: "product_blueprint",
		version: 1,
		title: "Runtime objective blueprint",
		summary: text,
		responseLanguage: "en",
		sourceDocuments: [],
		items,
		categoryItemIds: {
			requirement: ["deterministic-requirement"],
			page: [],
			interaction: [],
			state: [],
			permission: [],
			visual: [],
			acceptance: [],
		},
	};
}

function scopedFiltersBlueprint(): AgentV2ProductBlueprint {
	const items: AgentV2ProductBlueprint["items"] = [
		{
			id: "filter-customer",
			text: "Customer | Dropdown | All | All visuals",
			sourceInputId: "prd",
			sourcePath: "requirements.md",
			sourceChecksum: "sha256:scoped-prd",
			line: 20,
			categories: ["requirement", "interaction"],
		},
		{
			id: "filter-plant",
			text: "Plant | Dropdown | All | KPI summary only",
			sourceInputId: "prd",
			sourcePath: "requirements.md",
			sourceChecksum: "sha256:scoped-prd",
			line: 21,
			categories: ["requirement", "interaction"],
		},
	];
	return {
		kind: "product_blueprint",
		version: 1,
		title: "Scoped filter blueprint",
		summary: "Different controls have different downstream scopes.",
		responseLanguage: "en",
		sourceDocuments: [{ inputId: "prd", path: "requirements.md", checksum: "sha256:scoped-prd", lineCount: 40 }],
		items,
		categoryItemIds: {
			requirement: items.map((item) => item.id),
			page: [],
			interaction: items.map((item) => item.id),
			state: [],
			permission: [],
			visual: [],
			acceptance: [],
		},
	};
}
