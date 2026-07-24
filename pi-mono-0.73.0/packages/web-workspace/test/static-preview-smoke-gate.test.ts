import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runStaticPreviewSmokeGate } from "../src/static-preview-smoke-gate.js";

const canvasDashboardFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canvas-dashboard");

function tempServeRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-static-preview-smoke-"));
}

function writeProject(files: Record<string, string>): string {
	const root = tempServeRoot();
	for (const [filename, content] of Object.entries(files)) {
		const path = join(root, filename);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return root;
}

function runGateInIsolatedProcess(serveRoot: string, scriptTimeoutMs: number) {
	const moduleUrl = pathToFileURL(join(process.cwd(), "src", "static-preview-smoke-gate.js")).href;
	const source = `
import { runStaticPreviewSmokeGate } from ${JSON.stringify(moduleUrl)};
const result = await runStaticPreviewSmokeGate({
  serveRoot: ${JSON.stringify(serveRoot)},
  scriptTimeoutMs: ${scriptTimeoutMs}
});
process.stdout.write(JSON.stringify(result));
`;
	return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
		encoding: "utf8",
		timeout: 2_000,
	});
}

describe("runStaticPreviewSmokeGate", () => {
	it("runs the browser acceptance Canvas dashboard fixture without synthetic runtime errors", async () => {
		const result = await runStaticPreviewSmokeGate({ serveRoot: canvasDashboardFixture });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("runs local scripts and rejects runtime errors before first screen state is updated", async () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <div id="chartLoading" class="chart-loading">Loading chart data...</div>
    <span id="kpiYieldValue" class="kpi-value">--</span>
    <script src="./js/app.js"></script>
  </body>
</html>`,
			"js/app.js": `
document.addEventListener('DOMContentLoaded', () => {
  const loading = document.getElementById('chartLoading');
  const kpi = document.getElementById('kpiYieldValue');
  const values = window.missingRows.map((row) => row.value);
  loading.classList.add('hidden');
  kpi.textContent = String(values.length);
});
`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("Runtime smoke gate");
		expect(result.errors.join("\n")).toContain("missingRows");
		expect(result.errors.join("\n")).not.toContain("chartLoading");
		expect(result.errors.join("\n")).not.toContain("kpiYieldValue");
	});

	it("passes when DOMContentLoaded updates KPI placeholders and hides loading state", async () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <div id="chartLoading" class="chart-loading">Loading chart data...</div>
    <span id="kpiYieldValue" class="kpi-value">--</span>
    <script>
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chartLoading').classList.add('hidden');
  document.getElementById('kpiYieldValue').textContent = '91.2%';
});
    </script>
  </body>
</html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.checkedFiles).toEqual(["index.html", "inline script 1"]);
	});

	it("models parsed element siblings without turning valid KPI updates into startup failures", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div class="kpi-card"><div id="kpiTarget" class="kpi-value">94.8%</div><div class="change">Pending</div></div>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const target = document.getElementById('kpiTarget');
  target.nextElementSibling.textContent = 'Achieved';
  if (target.previousElementSibling !== null) throw new Error('unexpected previous sibling');
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("models common element traversal APIs used by delegated dashboard handlers", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<section id="filter-panel"><button id="applyFilter">Apply Filter</button></section>
<div id="kpiOutput" class="kpi-value">1</div><div id="kpiYield" class="kpi-value">90%</div>
<script>
document.getElementById('applyFilter').addEventListener('click', (event) => {
  const panel = event.target.closest('#filter-panel');
  if (!panel || !panel.contains(event.target) || panel.firstElementChild !== event.target) {
    throw new Error('delegated element traversal failed');
  }
  panel.removeChild(event.target);
  document.getElementById('kpiOutput').textContent = '2';
  document.getElementById('kpiYield').textContent = '91%';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("runs startup listeners registered on window DOMContentLoaded", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<span id="kpiYieldValue" class="kpi-value">--</span><script>
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('kpiYieldValue').textContent = '92.4%';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("keeps a startup root cause without flooding diagnostics with cascading filter failures", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customer"><option value="All">All</option><option value="A">A</option></select>
<output id="kpiOutput">--</output><script>
let dashboardData;
function render() { document.getElementById('kpiOutput').textContent = dashboardData[0].output; }
document.getElementById('customer').addEventListener('change', render);
document.addEventListener('DOMContentLoaded', render);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("DOMContentLoaded handler failed");
		expect(result.errors.join("\n")).not.toContain("select change handler failed");
	});

	it("treats an explicitly disclosed deterministic mock fixture with business-specific names as high-confidence", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="lotType"><option>HVM</option><option>NVM</option></select>
<div id="kpiLots" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><rect width="120"></rect></svg><table><tbody id="detailRows"><tr><td>ED25</td></tr></tbody></table>
<script>
// Deterministic mock data
const WEEKS = ['202620', '202621'];
function genWeekData() { return WEEKS.map((week) => ({ week, lots: 120, yield: 95 })); }
function renderAll() { const rows = genWeekData(); document.getElementById('kpiLots').textContent = String(rows[0].lots); }
document.getElementById('lotType').addEventListener('change', renderAll); renderAll();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Runtime smoke gate: deterministic fixture select #lotType changed value but did not change rendered metrics, chart data, results, or empty state.",
		);
	});

	it("executes cached DOM onchange properties and rejects an inert deterministic dashboard filter", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="dateTypeFilter"><option>Weekly</option><option>Monthly</option></select>
<div id="kpiLots" class="kpi-value">2</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><text>95</text></svg><table><tbody id="detailRows"><tr><td>W1</td></tr></tbody></table>
<script>
// Deterministic mock data
const rows = [{ week: 'W1', yield: 95 }, { week: 'W2', yield: 96 }];
const state = { dateType: 'Weekly' };
const els = { dateTypeFilter: document.getElementById('dateTypeFilter') };
function updateDashboard() {
  document.getElementById('kpiLots').textContent = String(rows.length);
  document.getElementById('kpiYield').textContent = String(rows[0].yield) + '%';
}
els.dateTypeFilter.onchange = event => { state.dateType = event.target.value; updateDashboard(); };
updateDashboard();
</script></main></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Runtime smoke gate: deterministic fixture select #dateTypeFilter changed value but did not change rendered metrics, chart data, results, or empty state.",
		);
	});

	it("executes a cached DOM onchange property when it updates synchronized dashboard data", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="customerFilter"><option>All</option><option>A</option></select>
<div id="kpiLots" class="kpi-value">2</div><div id="kpiYield" class="kpi-value">95.5%</div>
<svg id="yieldTrend"><text>95.5</text></svg><table><tbody id="detailRows"><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>
<script>
// Deterministic mock data
const rows = [{ customer: 'A', yield: 95 }, { customer: 'B', yield: 96 }];
const state = { customer: 'All' };
const els = { customerFilter: document.getElementById('customerFilter') };
function updateDashboard() {
  const filtered = rows.filter(row => state.customer === 'All' || row.customer === state.customer);
  document.getElementById('kpiLots').textContent = String(filtered.length);
  document.getElementById('kpiYield').textContent = String(filtered[0].yield) + '%';
  document.getElementById('yieldTrend').innerHTML = '<text>' + filtered[0].yield + '</text>';
  document.getElementById('detailRows').innerHTML = filtered.map(row => '<tr><td>' + row.customer + '</td></tr>').join('');
}
els.customerFilter.onchange = event => { state.customer = event.target.value; updateDashboard(); };
updateDashboard();
</script></main></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("recognizes deterministic simulation disclosure with literal arrays nested in a data object", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customer"><option>All</option><option>Apple</option></select>
<div id="kpi-container"></div><div id="trend-chart-container"></div><div id="defect-chart-container"></div>
<table id="detail-table"><tbody><tr><td>ED25</td></tr></tbody></table>
<script>
// --- MOCK DATA (Deterministic Simulation) ---
const MOCK_DATA = { weeks: ['202620', '202621'], weeklyData: [{ week: '202620', output: 150 }] };
function renderAll() { document.getElementById('kpi-container').innerHTML = '<div class="kpi-card">150</div>'; }
document.getElementById('customer').addEventListener('change', renderAll); renderAll();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Runtime smoke gate: deterministic fixture select #customer changed value but did not change rendered metrics, chart data, results, or empty state.",
		);
	});

	it("exercises selectedOptions through an explicit Apply action without misclassifying it as inert", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customer" multiple></select>
<button id="btnApplyFilters">Apply Filters</button>
<div id="kpiOutput" class="kpi-value">--</div>
<div id="kpiYield" class="kpi-value">--</div>
<tbody id="detailTableBody"></tbody><script>
const rows = [{ Customer: 'CustomerA', Yield: 95 }, { Customer: 'CustomerB', Yield: 97 }];
window.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('customer');
  select.innerHTML = '<option value="" disabled selected>Select...</option>';
  for (const value of ['CustomerA', 'CustomerB']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  const apply = () => {
    const values = Array.from(select.selectedOptions).map((option) => option.value);
    const filtered = rows.filter((row) => !values.length || values.includes(row.Customer));
    document.getElementById('kpiOutput').textContent = filtered.length ? String(filtered.length) : 'N/A';
    document.getElementById('kpiYield').textContent = filtered.length ? String(filtered[0].Yield) : 'N/A';
    document.getElementById('detailTableBody').innerHTML = filtered.length ? 'rows:' + filtered.length : 'No records';
  };
  document.getElementById('btnApplyFilters').addEventListener('click', apply);
  apply();
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("default filter state leaves all 2 visible KPI metrics empty");
	});

	it("rejects unchanged default filters that empty deterministic fixture data because a predicate field is missing", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="dateType"><option value="Weekly" selected>Weekly</option></select>
<button id="applyFilters">Apply Filters</button>
<div id="kpiOutput" class="kpi-value">100</div>
<div id="kpiYield" class="kpi-value">95%</div>
<tbody id="detailTableBody">one row</tbody><script>
const mockData = [{ ATSDate: '2026-06-01', Yield: 95 }];
document.getElementById('applyFilters').addEventListener('click', () => {
  const dateType = document.getElementById('dateType').value;
  const rows = mockData.filter((item) => item.DateType === dateType);
  document.getElementById('kpiOutput').textContent = rows.length ? '100' : '0';
  document.getElementById('kpiYield').textContent = rows.length ? '95%' : '0%';
  document.getElementById('detailTableBody').innerHTML = rows.length ? 'one row' : 'No data';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"applying unchanged default filters replaced representative KPI data with an empty result",
		);
	});

	it("accepts unchanged default filters when deterministic fixture rows contain matching fields", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="dateType"><option value="Weekly" selected>Weekly</option></select>
<button id="applyFilters">Apply Filters</button>
<div id="kpiOutput" class="kpi-value">100</div>
<div id="kpiYield" class="kpi-value">95%</div>
<tbody id="detailTableBody">one row</tbody><script>
const mockData = [{ ATSDate: '2026-06-01', DateType: 'Weekly', Yield: 95 }];
document.getElementById('applyFilters').addEventListener('click', () => {
  const dateType = document.getElementById('dateType').value;
  const rows = mockData.filter((item) => item.DateType === dateType);
  document.getElementById('kpiOutput').textContent = rows.length ? '100' : '0';
  document.getElementById('kpiYield').textContent = rows.length ? '95%' : '0%';
  document.getElementById('detailTableBody').innerHTML = rows.length ? 'one row' : 'No data';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects an out-of-range aggregation label rendered after a dashboard filter change", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filterDateType"><option value="Weekly" selected>Weekly</option><option value="Monthly">Monthly</option></select>
<div id="kpiOutput" class="kpi-value">159 Lots</div><div id="kpiYield" class="kpi-value">94.81%</div>
<canvas id="yieldTrend"></canvas><canvas id="defectChart"></canvas>
<div id="detailWeekLabel">Week 202621</div><table><tbody id="detailTableBody"><tr><td>202621</td></tr></tbody></table>
<script>
const demoRows = [{ week: '202620', lots: 159 }, { week: '202621', lots: 160 }];
document.getElementById('filterDateType').addEventListener('change', (event) => {
  const first = demoRows[0];
  const end = event.target.value === 'Monthly' ? demoRows[3] : demoRows[1];
  document.getElementById('kpiOutput').textContent = event.target.value === 'Monthly' ? '319 Lots' : '159 Lots';
  document.getElementById('kpiYield').textContent = event.target.value === 'Monthly' ? '95.10%' : '94.81%';
  document.getElementById('detailWeekLabel').textContent = 'Week ' + first.week + '-' + end?.week;
  document.getElementById('detailTableBody').innerHTML = '<tr><td>' + first.week + '-' + end?.week + '</td></tr>';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"dashboard data surface #detailWeekLabel rendered invalid token undefined after select #filterDateType changed",
				),
			]),
		);
	});

	it("does not mistake explanatory prose about undefined values for broken dashboard data", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<canvas id="yieldTrend"></canvas><canvas id="defectChart"></canvas>
<table><tbody id="detailTableBody"><tr><td>Undefined values: 0 (all rows are complete)</td></tr></tbody></table>
</body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("settles async startup handlers and supports createTextNode with Node checks", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div id="app"></div><script>
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    new Promise((resolve) => setTimeout(resolve, 25)),
    new Promise((resolve) => setTimeout(resolve, 25))
  ]);
  const metric = document.createElement('strong');
  metric.id = 'kpiYieldValue';
  metric.className = 'kpi-value';
  const text = document.createTextNode('94.7%');
  if (text instanceof Node) metric.appendChild(text);
  document.getElementById('app').appendChild(metric);
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("records async callback failures without leaking an unhandled rejection", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><div id="app"></div><script>
document.addEventListener('DOMContentLoaded', async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error('async startup failed');
});
</script></body></html>`,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await runStaticPreviewSmokeGate({ serveRoot: root });
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("asynchronous callback failed");
			expect(result.errors.join("\n")).toContain("async startup failed");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("warns without blocking when every visible KPI stays zero beside a chart", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div id="kpiOutput" class="kpi-value">0</div>
<div id="kpiYield" class="kpi-value">0%</div>
<canvas id="trendChart"></canvas>
</body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("all 2 visible KPI metrics remain zero");
	});

	it("supports standard browser dialog APIs without VM-only ReferenceErrors", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="mode"><option value="a">A</option><option value="b">B</option></select>
<output id="result">a</output><script>
document.getElementById('mode').addEventListener('change', (event) => {
  alert('changed');
  const accepted = confirm('continue?');
  const suffix = prompt('suffix', '!');
  document.getElementById('result').textContent = accepted ? event.target.value + suffix : 'cancelled';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("warns instead of blocking when startup uses a standard browser global absent from the synthetic DOM", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><div id="layoutMode">unknown</div><script>
const compact = matchMedia('(max-width: 600px)').matches;
document.getElementById('layoutMode').textContent = compact ? 'compact' : 'wide';
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("matchMedia");
	});

	it("coerces numeric textContent assignments like the browser DOM", async () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <output id="countValue">0</output>
    <script>
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('countValue').textContent = 1;
});
    </script>
  </body>
</html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("supports standard Canvas 2D startup used by generated games", async () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <canvas id="gameCanvas" width="400" height="300"></canvas>
    <script>
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('gameCanvas');
  if (canvas.width !== 400 || canvas.height !== 300) {
    throw new Error('canvas dimensions unavailable: ' + canvas.width + 'x' + canvas.height);
  }
  if (!canvas.parentElement || canvas.parentElement.clientWidth <= 0) {
    throw new Error('canvas parent layout metrics unavailable');
  }
  if (document.body.clientWidth <= 0 || document.body.clientHeight <= 0) {
    throw new Error('document layout metrics unavailable');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  if (ctx.canvas !== canvas || ctx.canvas.width !== 400 || ctx.canvas.height !== 300) {
    throw new Error('2d context canvas back-reference unavailable');
  }
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#0f0';
  ctx.shadowBlur = 8;
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(20, 20);
  ctx.quadraticCurveTo(25, 25, 30, 20);
  ctx.bezierCurveTo(30, 20, 35, 15, 40, 20);
  ctx.arcTo(40, 20, 40, 30, 5);
  ctx.rect(1, 1, 10, 10);
  ctx.roundRect(2, 2, 20, 12, 4);
  ctx.arc(10, 10, 5, 0, Math.PI * 2);
  ctx.ellipse(15, 15, 8, 4, 0, 0, Math.PI * 2);
  ctx.transform(1, 0, 0, 1, 2, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillText('Ready', 20, 20);
});
    </script>
  </body>
</html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("uses browser default dimensions for dynamically created canvases", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
const canvas = document.createElement('canvas');
if (canvas.width !== 300 || canvas.height !== 150) throw new Error('unexpected canvas defaults');
if (!canvas.getContext('2d')) throw new Error('2d context unavailable');
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("supports table insertRow and insertCell during deterministic filter rendering", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customerFilter"><option value="All">All</option><option value="A">A</option></select>
<output id="kpiYield" class="kpi-value"></output><output id="kpiCount" class="kpi-value"></output>
<table id="detailTable"><tbody id="detailTableBody"></tbody></table><script>
const mockData = [{ customer: 'A', yield: 95 }, { customer: 'B', yield: 91 }];
const filter = document.getElementById('customerFilter');
const body = document.getElementById('detailTableBody');
function render() {
  const rows = mockData.filter(row => filter.value === 'All' || row.customer === filter.value);
  document.getElementById('kpiYield').textContent = String(rows.reduce((sum, row) => sum + row.yield, 0));
  document.getElementById('kpiCount').textContent = String(rows.length);
  body.innerHTML = '';
  rows.forEach(item => {
    const row = body.insertRow();
    row.insertCell().textContent = item.customer;
    row.insertCell().textContent = String(item.yield);
  });
}
filter.addEventListener('change', render);render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("supports the standard document head for dynamically appended resources", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head></head><body><h1>Ready</h1><script>
const script = document.createElement('script');
script.src = './optional-library.js';
document.head.appendChild(script);
if (script.parentElement !== document.head) throw new Error('document.head append failed');
</script></body></html>`,
			"optional-library.js": "window.optionalLibraryLoaded = true;",
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("executes select changes and chart drill-down callbacks before delivery", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><select id="customer"><option value="all">All</option></select>
<canvas id="pareto"></canvas><script>
window.chart = new Chart(document.getElementById('pareto'), {
  data: { datasets: [{ backgroundColor: 'rgba(37,99,235,.7)' }] },
  options: { onClick: () => { window.chart.data.datasets[0].backgroundColor.map(() => 'blue'); } }
});
document.getElementById('customer').addEventListener('change', (event) => { document.body.dataset.customer = event.target.value; });
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("chart click handler failed");
		expect(result.errors.join("\n")).toContain("backgroundColor.map is not a function");
	});

	it("supports standard Chart.js element lookup inside drill-down handlers", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div id="kpiOutput" class="kpi-value">120</div><canvas id="trend"></canvas><script>
const trendChartInstance = new Chart(document.getElementById('trend'), {
  data: { labels: ['W1'], datasets: [{ data: [94.2] }] },
  options: { onClick: (event) => {
    const points = trendChartInstance.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false);
    if (points.length > 0) document.getElementById('kpiOutput').textContent = String(points[0].index + 121);
  } }
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("supports HTMLSelectElement.add for dynamically created options", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><select id="customer"><option value="All">All</option></select><script>
const option = document.createElement('option');
option.value = 'CustomerA';
option.text = 'Customer A';
document.getElementById('customer').add(option);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("supports iterable HTMLSelectElement.options without cascading VM-only filter errors", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customer"><option value="all" selected>All</option><option value="A">A</option></select>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"><rect width="120"></rect></svg><table><tbody id="detailRows"><tr><td>All</td></tr></tbody></table>
<script>
const mockData = { all: 120, A: 85 };
function renderAll() {
  const select = document.getElementById('customer');
  const selected = Array.from(select.options).filter((option) => option.selected).map((option) => option.value);
  const value = mockData[selected[0]];
  document.getElementById('kpiOutput').textContent = String(value);
  document.getElementById('kpiYield').textContent = value === 120 ? '95%' : '93%';
  document.getElementById('yieldTrend').innerHTML = '<rect width="' + value + '"></rect>';
  document.getElementById('detailRows').innerHTML = '<tr><td>' + selected[0] + '</td></tr>';
}
document.getElementById('customer').addEventListener('change', renderAll); renderAll();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("bounds chart interaction sampling when a click re-renders replacement charts", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="trend"></canvas><script>
let current;
function render() {
  if (current) current.destroy();
  current = new Chart(document.getElementById('trend'), {
    data: { labels: ['W1'], datasets: [{ data: [94.2] }] },
    options: { onClick: () => render() }
  });
}
render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("keeps a non-semantic select redraw advisory when data-filter intent is not proven", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<div id="kpiOutput" class="kpi-value">120</div><script>
document.getElementById('plant').addEventListener('change', () => {
  document.getElementById('kpiOutput').textContent = '120';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("select #plant changed value but did not change rendered metrics");
	});

	it("does not claim high confidence for an inert filter when an external render script was not simulated", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="all">All</option><option value="P1">P1</option></select>
<p id="kpiOutput">-</p><p id="kpiYield">-</p>
<canvas id="yieldTrend"></canvas><script src="https://example.test/chart.js"></script><script src="app.js"></script>
</body></html>`,
			"app.js": `const MOCK_DATA = { output: 120, yield: 95 };
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
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("select #plant changed value");
		expect(result.warnings.join("\n")).not.toContain("deterministic fixture select #plant");
		expect(result.warnings.join("\n")).toContain("skipped external script");
	});

	it("keeps a missing global from an unsimulated external script advisory", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>External chart</h1>
<svg id="trend"></svg><script src="https://cdn.example.test/d3.js"></script><script>
d3.select('#trend').append('path').attr('d', 'M0 0L10 10');
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("d3 because an external script was not simulated");
	});

	it("marks an inert deterministic chart-and-table dashboard as high-confidence when KPI cards are injected dynamically", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="all">All</option><option value="P1">P1</option></select>
<button id="applyFilters">Apply Filters</button><div id="kpiContainer"></div>
<canvas id="yieldTrendChart"></canvas><canvas id="defectChart"></canvas>
<table><tbody id="detailTableBody"></tbody></table><script>
const MOCK_DATA = { output: 120, yield: 95 };
const first = document.getElementById('yieldTrendChart').getContext('2d');
const second = document.getElementById('defectChart').getContext('2d');
function render() {
  document.getElementById('kpiContainer').innerHTML = '<div class="kpi-value">120</div><div class="kpi-value">95%</div>';
  first.clearRect(0, 0, 300, 150); first.fillRect(0, 30, 40, 120);
  second.clearRect(0, 0, 300, 150); second.fillRect(0, 40, 40, 110);
  document.getElementById('detailTableBody').innerHTML = '<tr><td>120</td></tr>';
}
document.getElementById('applyFilters').addEventListener('click', render); render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("deterministic fixture select #plant changed value");
	});

	it("accepts a select that changes rendered metric values", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<div id="kpiOutput" class="kpi-value">120</div><script>
document.getElementById('plant').addEventListener('change', (event) => {
  document.getElementById('kpiOutput').textContent = event.target.value === 'b' ? '85' : '120';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a dynamic SVG dashboard that uses createElementNS and changes synchronized metrics", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<div id="kpiOutput">120</div><div id="kpiYield">95%</div>
<div class="chart-viewport"><svg id="yieldTrend" viewBox="0 0 300 150"></svg></div><script>
const FIXTURE_VALUES = { a: { output: 120, yield: 95 }, b: { output: 85, yield: 93 } };
function render() {
  const current = FIXTURE_VALUES[document.getElementById('plant').value];
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('width', String(current.output));
  document.getElementById('yieldTrend').appendChild(rect);
  document.getElementById('kpiOutput').textContent = String(current.output);
  document.getElementById('kpiYield').textContent = current.yield + '%';
}
document.getElementById('plant').addEventListener('change', render); render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects a deterministic global filter that updates KPIs and SVG but leaves the detail result stale", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div id="filters"><select id="customer"><option value="All">All</option><option value="A">A</option></select><select id="plant"><option value="All">All</option><option value="P1">P1</option></select></div>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"></svg><svg id="defectChart"></svg><table><tbody id="detailTableBody"></tbody></table><script>
const mockData = { All: 120, A: 85 };
function renderAll() {
  const value = mockData[document.getElementById('customer').value] || 120;
  document.getElementById('kpiOutput').textContent = String(value);
  document.getElementById('kpiYield').textContent = value === 85 ? '93%' : '95%';
  document.getElementById('yieldTrend').innerHTML = '<rect width="' + value + '"></rect>';
  document.getElementById('defectChart').innerHTML = '<rect width="40"></rect>';
  document.getElementById('detailTableBody').innerHTML = '<tr><td>unchanged</td></tr>';
}
document.querySelectorAll('#filters select').forEach((select) => select.addEventListener('change', () => renderAll()));
renderAll();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"deterministic global select #customer changed some dashboard data but left synchronized surfaces unchanged",
		);
		expect(result.errors.join("\n")).toContain("result #detailTableBody");
	});

	it("keeps parsed filter ancestry aligned through head/style and nested filter groups", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.filters{display:grid}</style></head><body>
<section class="filters" id="filters">
  <div class="filter-group"><select id="customer"><option value="All">All</option><option value="A">A</option></select></div>
  <div class="filter-group"><select id="plant"><option value="All">All</option><option value="P1">P1</option></select></div>
</section>
<div id="kpiOutput" class="kpi-value">120</div><div id="kpiYield" class="kpi-value">95%</div>
<svg id="yieldTrend"></svg><svg id="defectChart"></svg><table><tbody id="detailTableBody"></tbody></table><script>
const mockData = { All: 120, A: 85 };
function renderAll() {
  const value = mockData[document.getElementById('customer').value] || 120;
  document.getElementById('kpiOutput').textContent = String(value);
  document.getElementById('kpiYield').textContent = value === 85 ? '93%' : '95%';
  document.getElementById('yieldTrend').innerHTML = '<rect width="' + value + '"></rect>';
  document.getElementById('defectChart').innerHTML = '<rect width="40"></rect>';
  document.getElementById('detailTableBody').innerHTML = '<tr><td>unchanged</td></tr>';
}
document.querySelectorAll('#filters select').forEach((select) => select.addEventListener('change', () => renderAll()));
renderAll();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"deterministic global select #customer changed some dashboard data but left synchronized surfaces unchanged",
		);
	});

	it("accepts a chart-only filter when native Canvas drawing commands change deterministically", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<canvas id="yieldTrend"></canvas><script>
const MOCK_VALUES = { a: 120, b: 85 };
const canvas = document.getElementById('yieldTrend');
const ctx = canvas.getContext('2d');
function render() {
  const value = MOCK_VALUES[document.getElementById('plant').value];
	canvas.width = 300;
	canvas.height = 150;
  ctx.clearRect(0, 0, 300, 150);
  ctx.fillRect(0, 150 - value, 40, value);
  ctx.fillText(String(value), 10, 12);
}
document.getElementById('plant').addEventListener('change', render);
render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("keeps an unscoped native Canvas select advisory when identical redraw intent is ambiguous", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<canvas id="yieldTrend"></canvas><script>
const canvas = document.getElementById('yieldTrend');
const ctx = canvas.getContext('2d');
function render() {
  ctx.clearRect(0, 0, 300, 150);
  ctx.fillRect(0, 30, 40, 120);
  ctx.fillText('120', 10, 12);
}
document.getElementById('plant').addEventListener('change', render);
render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("select #plant changed value but did not change rendered metrics");
	});

	it("treats Canvas bitmap reassignment as a browser reset instead of a false filter change", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filterPlant"><option value="all">All</option><option value="P1">P1</option></select>
<div id="kpiOutput" class="kpi-value">159 Lots</div><div id="kpiYield" class="kpi-value">94.81%</div>
<canvas id="yieldTrend"></canvas><canvas id="defectChart"></canvas>
<table><tbody id="detailTableBody"><tr><td>159</td></tr></tbody></table><script>
function generateData() { return [{ output: 159, yield: 94.81 }]; }
const mockDataset = generateData();
function draw(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.parentElement.clientWidth * devicePixelRatio;
  canvas.height = 240 * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillRect(0, 30, 40, 120);
  ctx.fillText('159', 10, 12);
}
function render() {
  document.getElementById('kpiOutput').textContent = mockDataset[0].output + ' Lots';
  document.getElementById('kpiYield').textContent = mockDataset[0].yield + '%';
  document.getElementById('detailTableBody').innerHTML = '<tr><td>159</td></tr>';
  draw('yieldTrend'); draw('defectChart');
}
document.querySelectorAll('select').forEach((select) => select.addEventListener('change', render));
render();
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"deterministic fixture select #filterPlant changed value but did not change rendered metrics",
		);
	});

	it("observes innerText updates and evaluates each select from the default filter state", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="dateType"><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
<select id="lotType"><option value="hvm">HVM</option><option value="lvm">LVM</option></select>
<div id="kpiOutput" class="kpi-value">120</div><script>
const values = { 'weekly:hvm': '120', 'weekly:lvm': '85' };
function render() {
  const key = document.getElementById('dateType').value + ':' + document.getElementById('lotType').value;
  document.getElementById('kpiOutput').innerText = values[key] || '-';
}
document.getElementById('dateType').addEventListener('change', render);
document.getElementById('lotType').addEventListener('change', render);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("binds this to the select element inside classic event listeners", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="plant"><option value="a">Fab A</option><option value="b">Fab B</option></select>
<div id="kpiOutput" class="kpi-value">120</div><script>
document.getElementById('plant').addEventListener('change', function() {
  document.getElementById('kpiOutput').textContent = this.value === 'b' ? '85' : '120';
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("does not hide misspelled Canvas API calls", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="gameCanvas"></canvas><script>
document.getElementById('gameCanvas').getContex('2d');
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("getContex is not a function");
	});

	it("supports ResizeObserver and DOMRect measurement used by responsive native Canvas charts", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><div class="chart-viewport"><canvas id="yieldTrend"></canvas></div><script>
const canvas = document.getElementById('yieldTrend');
function draw() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 10, 10);
}
new ResizeObserver(draw).observe(canvas.parentElement);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("supports standard Canvas line dashes and classic window globals without VM-only failures", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<canvas id="yieldTrend"></canvas><button id="prevPage">Previous</button><script>
const ctx = document.getElementById('yieldTrend').getContext('2d');
ctx.setLineDash([5, 5]);
ctx.moveTo(0, 10); ctx.lineTo(100, 10); ctx.stroke();
window.prevPage = document.getElementById('prevPage');
prevPage.addEventListener('click', () => { document.body.dataset.page = 'previous'; });
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("setLineDash");
		expect(result.errors.join("\n")).not.toContain("prevPage is not defined");
	});

	it("samples a self-scheduling animation frame without treating it as a runaway startup queue", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="scene"></canvas><script>
let frames = 0;
function renderFrame() {
  frames += 1;
  document.body.dataset.frames = String(frames);
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("timer queue exceeded");
	});

	it("does not run cancelled startup callbacks", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
const timeoutId = setTimeout(() => { throw new Error('cancelled timeout ran'); }, 0);
const intervalId = setInterval(() => { throw new Error('cancelled interval ran'); }, 0);
const frameId = requestAnimationFrame(() => { throw new Error('cancelled frame ran'); });
clearTimeout(timeoutId);
clearInterval(intervalId);
cancelAnimationFrame(frameId);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("still rejects runaway one-shot timer recursion", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
function scheduleAgain() { setTimeout(scheduleAgain, 0); }
setTimeout(scheduleAgain, 0);
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("timer queue exceeded 50 callbacks");
	});

	it("applies the VM timeout to DOM event callbacks", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
document.addEventListener('DOMContentLoaded', () => { while (true) {} });
</script></body></html>`,
		});

		const child = runGateInIsolatedProcess(root, 20);

		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout) as { valid: boolean; errors: string[] };
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("timed out");
	});

	it("applies the VM timeout to timer callbacks", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
setTimeout(() => { while (true) {} }, 0);
</script></body></html>`,
		});

		const child = runGateInIsolatedProcess(root, 20);

		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout) as { valid: boolean; errors: string[] };
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("timer callback failed");
		expect(result.errors.join("\n")).toContain("timed out");
	});

	it("downgrades explicitly registered browser capability gaps to warnings", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
navigator.geolocation.getCurrentPosition(() => {});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("navigator.geolocation.getCurrentPosition");
	});

	it("preserves capability-gap classification inside DOM callbacks", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
document.addEventListener('DOMContentLoaded', () => {
  navigator.geolocation.getCurrentPosition(() => {});
});
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("navigator.geolocation.getCurrentPosition");
	});

	it("continues to reject ordinary application exceptions", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Ready</h1><script>
throw new Error('business failure');
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("business failure");
	});

	it("does not fail optional selector probes when first screen state is rendered", async () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <div id="chartLoading" class="chart-loading">Loading chart data...</div>
    <span id="kpiYieldValue" class="kpi-value">--</span>
    <script>
document.addEventListener('DOMContentLoaded', () => {
  const optionalPanel = document.querySelector('#optionalPanel');
  if (optionalPanel) optionalPanel.textContent = 'Optional';
  document.getElementById('chartLoading').classList.add('hidden');
  document.getElementById('kpiYieldValue').textContent = '91.2%';
});
    </script>
  </body>
</html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("authorizes nested native paths after stripping URL query and hash", async () => {
		const root = writeProject({
			"index.html":
				'<!doctype html><html><body><h1>Ready</h1><script src="./js/nested/app.js?v=1#boot"></script></body></html>',
			"js/nested/app.js": "document.querySelector('h1').textContent = 'Ready';",
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.checkedFiles).toContain("js/nested/app.js");
	});

	it("rejects stale SVG chart data beside explicit empty KPI and table results", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="filter-customer"><option value="all">All</option><option value="C002">Customer B</option></select>
<output id="kpi-yield" class="kpi-value">95%</output><output id="kpi-output" class="kpi-value">150</output>
<svg id="yield-chart"></svg><svg id="defect-chart"></svg><table><tbody id="detail-body"></tbody></table>
<script>
const MOCK_DATA = [{ customer: 'all', yield: 95, output: 150 }];
function renderDashboard() {
  const empty = document.getElementById('filter-customer').value === 'C002';
  document.getElementById('kpi-yield').textContent = empty ? '--' : '95%';
  document.getElementById('kpi-output').textContent = empty ? '--' : '150';
  document.getElementById('detail-body').innerHTML = empty ? '<tr><td>No data available for selected filters</td></tr>' : '<tr><td>Week 12</td></tr>';
  if (!empty) {
    document.getElementById('yield-chart').innerHTML = '<rect x="0" y="0" width="20" height="40"></rect>';
    document.getElementById('defect-chart').innerHTML = '<path d="M0 0 L20 20"></path>';
  }
}
document.getElementById('filter-customer').addEventListener('change', renderDashboard);
renderDashboard();
</script></main></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.stringContaining(
				"explicit empty state in #detail-body while chart surfaces #yield-chart, #defect-chart still contained data after select #filter-customer changed",
			),
		]);
	});

	it("accepts an empty filter result when every SVG chart is cleared in the same render", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="filter-customer"><option value="all">All</option><option value="C002">Customer B</option></select>
<output id="kpi-yield" class="kpi-value">95%</output><output id="kpi-output" class="kpi-value">150</output>
<svg id="yield-chart"></svg><svg id="defect-chart"></svg><table><tbody id="detail-body"></tbody></table>
<script>
const MOCK_DATA = [{ customer: 'all', yield: 95, output: 150 }];
function renderDashboard() {
  const empty = document.getElementById('filter-customer').value === 'C002';
  document.getElementById('kpi-yield').textContent = empty ? '--' : '95%';
  document.getElementById('kpi-output').textContent = empty ? '--' : '150';
  document.getElementById('detail-body').innerHTML = empty ? '<tr><td>No data available for selected filters</td></tr>' : '<tr><td>Week 12</td></tr>';
  document.getElementById('yield-chart').innerHTML = empty ? '' : '<rect x="0" y="0" width="20" height="40"></rect>';
  document.getElementById('defect-chart').innerHTML = empty ? '' : '<path d="M0 0 L20 20"></path>';
}
document.getElementById('filter-customer').addEventListener('change', renderDashboard);
renderDashboard();
</script></main></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("fails closed when an explicit index escapes the serve root", async () => {
		const parent = tempServeRoot();
		const root = join(parent, "site");
		mkdirSync(root);
		writeFileSync(join(parent, "outside.html"), "<h1>outside</h1>", "utf8");

		const result = await runStaticPreviewSmokeGate({ serveRoot: root, indexFile: "../outside.html" });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("index.html");
	});

	it("rejects a missing unquoted local script", async () => {
		const root = writeProject({
			"index.html": "<!doctype html><html><body><h1>Ready</h1><script src=missing.js></script></body></html>",
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("missing.js");
	});

	it.each(["https://cdn.example/app.js", "data:text/javascript,document.body.dataset.ready='yes'"])(
		"does not classify an unquoted external or data script as local: %s",
		async (src) => {
			const root = writeProject({
				"index.html": `<!doctype html><html><body><h1>Ready</h1><script src=${src}></script></body></html>`,
			});

			const result = await runStaticPreviewSmokeGate({ serveRoot: root });

			expect(result.valid).toBe(true);
			expect(result.checkedFiles).toEqual(["index.html"]);
		},
	);

	it("authorizes an unquoted local script after stripping query and hash", async () => {
		const root = writeProject({
			"index.html":
				"<!doctype html><html><body><h1>Ready</h1><script src=js/app.js?v=1#boot></script></body></html>",
			"js/app.js": "document.querySelector('h1').textContent = 'Ready';",
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.checkedFiles).toContain("js/app.js");
	});

	it("rejects an unquoted local script that escapes the serve root", async () => {
		const parent = tempServeRoot();
		const root = join(parent, "site");
		mkdirSync(root);
		writeFileSync(join(root, "index.html"), "<h1>Ready</h1><script src=../outside.js></script>", "utf8");
		writeFileSync(join(parent, "outside.js"), "document.body.textContent = 'outside';", "utf8");

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("../outside.js");
	});

	it("supports scoped element queries and common modern DOM update methods without VM-only failures", async () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<section class="panel"><span class="result">A</span></section>
<section class="panel"><span class="result">B</span></section>
<table><tbody id="rows"></tbody></table><script>
const panels = document.querySelectorAll('.panel');
const first = panels[0].querySelector('.result');
const second = panels[1].querySelector('.result');
if (!first || !second || first === second) throw new Error('element query scope was lost');
const row = document.createElement('tr'); row.append('stable row');
document.getElementById('rows').replaceChildren(row);
const dynamic = document.createElement('button'); dynamic.id = 'dynamic-action';
let clicked = false; dynamic.addEventListener('click', () => { clicked = true; });
document.body.prepend(dynamic); document.getElementById('dynamic-action').click();
if (!clicked) throw new Error('programmatic click was not dispatched');
</script></body></html>`,
		});

		const result = await runStaticPreviewSmokeGate({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});
});
