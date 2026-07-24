import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessStaticPreviewQuality } from "../src/static-preview-quality-gate.js";

const canvasDashboardFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "canvas-dashboard");

function tempServeRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-static-preview-quality-"));
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

describe("assessStaticPreviewQuality", () => {
	it("finds unused properties in dynamically constructed dashboard filter definitions", () => {
		const root = writeProject({
			"index.html": `<!doctype html><div id="filter-panel"></div><output id="kpi">0</output><script>
const state={filters:{customer:'All',dateType:'Weekly',lotType:'HVM'}};
const rows=[{customer:'A',value:1}];
const filterDefs=[
 {id:'customer',label:'Customer',options:['All','A']},
 {id:'dateType',label:'Date Type',options:['Weekly','Monthly']},
 {id:'lotType',label:'Lot Type',options:['HVM','LVM']}
];
const panel=document.getElementById('filter-panel');
panel.innerHTML=filterDefs.map(f=>\`<label>\${f.label}<select id="filter-\${f.id}">\${f.options.map(o=>\`<option \${o===state.filters[f.id]?'selected':''}>\${o}</option>\`).join('')}</select></label>\`).join('');
panel.querySelectorAll('select').forEach(sel=>sel.addEventListener('change',e=>{const key=e.target.id.split('-')[1];state.filters[key]=e.target.value;render()}));
function render(){const data=rows.filter(r=>state.filters.customer==='All'||r.customer===state.filters.customer);document.getElementById('kpi').textContent=data.length}
render();</script>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });
		expect(result.errors.join("\n")).toContain("Select #filter-dateType writes state.filters.dateType");
		expect(result.errors.join("\n")).toContain("Select #filter-lotType writes state.filters.lotType");
		expect(result.errors.join("\n")).not.toContain("Select #filter-customer writes state.filters.customer");
	});

	it("recognizes select handlers bound through an inline suffix list and constructed id", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filter-customer"><option>All</option><option>A</option></select>
<select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select>
<output id="kpi">1</output><script>
['customer', 'date-type'].forEach(id => {
  const el = document.getElementById('filter-' + id);
  el.addEventListener('change', () => {
    const values = { customer: 'A', dateType: 'Monthly' };
    document.getElementById('kpi').textContent = el.value + values.customer;
  });
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("is never referenced by local JavaScript");
	});

	it("recognizes a named filter list whose loop appends an id suffix", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1>
<select id="customer-filter"><option>All</option><option>A</option></select>
<select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select>
<output id="kpi">1</output><script>
const filters=['customer','date-type'];
filters.forEach(filterName=>{const element=document.getElementById(filterName+'-filter');element.addEventListener('change',e=>{document.getElementById('kpi').textContent=e.target.value})});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("is never referenced by local JavaScript");
	});

	it("accepts the browser acceptance Canvas dashboard fixture", () => {
		const result = assessStaticPreviewQuality({ serveRoot: canvasDashboardFixture });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("rejects b7a-style local JavaScript selectors that do not match HTML ids", () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <span id="lastUpdated">Last Updated: --</span>
    <button id="btnExportCSV">Export CSV</button>
    <div class="chart-loading" id="chart1Loading">Loading chart data...</div>
    <span class="kpi-value" id="kpiYieldValue">--</span>
    <script src="./js/app.js"></script>
  </body>
</html>`,
			"js/app.js": `
const $ = (selector) => document.querySelector(selector);
function showLoading() {
  const overlay = $('#loading-overlay');
  if (overlay) overlay.classList.add('active');
}
function updateTimestamp() {
  const el = $('#last-updated');
  if (el) el.textContent = 'done';
}
function updateKpi() {
  const kpiYield = $('#kpi-yield');
  if (kpiYield) kpiYield.textContent = '91.2%';
}
function bindEvents() {
  const exportBtn = $('#btn-export');
  if (exportBtn) exportBtn.addEventListener('click', () => {});
}
`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("#loading-overlay"),
				expect.stringContaining("#last-updated"),
				expect.stringContaining("#kpi-yield"),
				expect.stringContaining("#btn-export"),
				expect.stringContaining("chart1Loading"),
				expect.stringContaining("kpiYieldValue"),
			]),
		);
	});

	it("passes when local JavaScript controls visible loading and KPI placeholders", () => {
		const root = writeProject({
			"index.html": `<!doctype html>
<html>
  <body>
    <span id="last-updated">Last Updated: --</span>
    <button id="btn-export">Export CSV</button>
    <div class="chart-loading" id="chart1Loading">Loading chart data...</div>
    <span class="kpi-value" id="kpiYieldValue">--</span>
    <script src="./js/app.js"></script>
  </body>
</html>`,
			"js/app.js": `
document.getElementById('chart1Loading').classList.add('d-none');
document.getElementById('kpiYieldValue').textContent = '91.2%';
document.querySelector('#last-updated').textContent = 'Last Updated: now';
document.querySelector('#btn-export').addEventListener('click', () => {});
`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects unbounded Chart.js canvases when aspect-ratio preservation is disabled", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.chart-panel{padding:16px}</style></head><body>
<div class="chart-panel"><canvas id="trendChart"></canvas></div><script src="./app.js"></script></body></html>`,
			"app.js": `new Chart(document.getElementById('trendChart'), {type:'bar',data:{labels:[],datasets:[]},options:{responsive:true,maintainAspectRatio:false}});`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("bounded chart or canvas height");
	});

	it("also inspects inline Chart.js setup instead of only linked scripts", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.chart-panel{height:320px}</style></head><body>
<div class="chart-panel"><canvas id="trendChart"></canvas></div><script>
new Chart(document.getElementById('trendChart'), {options:{maintainAspectRatio:false}});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("bounded chart or canvas height");
	});

	it("accepts Chart.js canvases inside explicitly bounded responsive containers", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.chart-container{position:relative;height:clamp(240px,32vh,360px)}</style></head><body>
<div class="chart-container"><canvas id="trendChart"></canvas></div><script src="./app.js"></script></body></html>`,
			"app.js": `new Chart(document.getElementById('trendChart'), {type:'bar',data:{labels:[],datasets:[]},options:{responsive:true,maintainAspectRatio:false}});`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a canvas-only Chart.js parent with a semantic chart-height class", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.chart-height{position:relative;height:300px}</style></head><body>
<section class="chart-card"><h2>Yield Trend</h2><div class="chart-height"><canvas id="trendChart"></canvas></div></section>
<script>new Chart(document.getElementById('trendChart'), {options:{responsive:true,maintainAspectRatio:false}});</script>
</body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("keeps externally styled Chart.js viewport bounds advisory instead of assuming they are absent", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><link rel="stylesheet" href="https://example.test/ui.css"></head><body>
<div class="chart-height relative h-72"><canvas id="trendChart"></canvas></div><script>
new Chart(document.getElementById('trendChart'), {options:{responsive:true,maintainAspectRatio:false}});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("could not be verified");
	});

	it("accepts a canvas inside a bounded inline relative wrapper", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div style="position:relative;height:300px"><canvas id="trend"></canvas></div><script>
new Chart(document.getElementById('trend'), {options:{maintainAspectRatio:false}});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects the reproduced native Canvas DPR layout bug with source evidence", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.card{padding:16px}.chart-panel{height:320px;position:relative}
</style></head><body><div class="card chart-panel"><div class="card-title">Yield Trend</div>
<canvas id="canvasYield"></canvas></div><script>
const canvas = document.getElementById('canvasYield');
function renderYieldChart() {
  const ctx = canvas.getContext('2d');
  const parent = canvas.parentElement;
  const width = parent.clientWidth;
  const height = parent.clientHeight;
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);
  ctx.moveTo(0, height); ctx.lineTo(width, 0); ctx.fillText('100', 24, 16);
}
renderYieldChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("static.canvas_css_bitmap_mismatch"),
				expect.stringContaining("static.canvas_layout_unbounded"),
				expect.stringContaining("static.canvas_resize_unhandled"),
			]),
		);
		expect(result.errors.join("\n")).toContain("#canvasYield");
		expect(result.errors.join("\n")).toMatch(/index\.html:\d+/u);
	});

	it("applies the same DPR mismatch rule to a responsive network visualization", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.network-viewport{height:clamp(260px,40vw,440px)}
</style></head><body><section><h2>Service dependencies</h2><div class="network-viewport">
<canvas id="dependencyNetwork"></canvas></div></section><script>
const canvas=document.getElementById('dependencyNetwork');
function drawNetwork(){const box=canvas.parentElement.getBoundingClientRect();const dpr=devicePixelRatio||1;
canvas.width=box.width*dpr;canvas.height=box.height*dpr;
const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
ctx.moveTo(40,40);ctx.lineTo(box.width-40,box.height-40);ctx.arc(40,40,12,0,Math.PI*2);ctx.fillText('API',20,20);}
new ResizeObserver(drawNetwork).observe(canvas.parentElement);drawNetwork();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("#dependencyNetwork");
	});

	it("accepts a bounded native Canvas chart with CSS sizing, DPR bitmap sizing, and ResizeObserver", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:clamp(240px,32vh,360px)}
.chart-viewport canvas{display:block;width:100%;height:100%}
</style></head><body><article class="card"><h2>Yield Trend</h2><div class="chart-viewport">
<canvas id="yieldTrend"></canvas></div></article><script>
const canvas = document.getElementById('yieldTrend');
function drawChart() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
new ResizeObserver(drawChart).observe(canvas.parentElement);
drawChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a semantic empty-state overlay inside an otherwise bounded Canvas viewport", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{position:relative;height:clamp(220px,30vh,340px)}
.chart-viewport canvas{display:block;width:100%;height:100%}
.empty-state{position:absolute;inset:0;display:grid;place-items:center}
</style></head><body><article class="card"><h2>Quality Trend</h2><div class="chart-viewport">
<canvas id="qualityTrend"></canvas><div class="empty-state" hidden>No data</div></div></article><script>
const canvas = document.getElementById('qualityTrend');
function drawChart() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
new ResizeObserver(drawChart).observe(canvas.parentElement);
drawChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.canvas_layout_unbounded");
	});

	it("associates object-member Canvas bindings with their ids for valid DPR sizing", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><link rel="stylesheet" href="./src/main.css"></head><body>
<section><h2>Throughput Trend</h2><div class="chart-viewport"><canvas id="throughputTrend"></canvas></div></section>
<section><h2>Latency Plot</h2><div class="chart-viewport"><canvas id="latencyPlot"></canvas></div></section>
<script src="./src/main.js"></script></body></html>`,
			"src/main.css": `.chart-viewport{position:relative;width:100%;height:clamp(240px,32vh,360px)}
.chart-viewport canvas{display:block;width:100%;height:100%}`,
			"src/main.js": `const elements = {
  throughput: document.getElementById('throughputTrend'),
  latency: document.querySelector('#latencyPlot')
};
function drawThroughput() {
  const rect = elements.throughput.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  elements.throughput.width = Math.round(rect.width * dpr);
  elements.throughput.height = Math.round(rect.height * dpr);
  const ctx = elements.throughput.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
function drawLatency() {
  const rect = elements.latency.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  elements.latency.width = Math.round(rect.width * dpr);
  elements.latency.height = Math.round(rect.height * dpr);
  const ctx = elements.latency.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('250', 24, 16);
}
function drawAll() { drawThroughput(); drawLatency(); }
const observer = new ResizeObserver(drawAll);
observer.observe(elements.throughput.parentElement);
observer.observe(elements.latency.parentElement);
drawAll();`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.canvas_css_bitmap_mismatch");
	});

	it("keeps ambiguous nested Canvas member association advisory instead of blocking generation", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{position:relative;height:clamp(240px,32vh,360px)}
.chart-viewport canvas{display:block;width:100%;height:100%}
</style></head><body><h1>Operations dashboard</h1>
<div class="chart-viewport"><canvas id="throughputTrend"></canvas></div>
<div class="chart-viewport"><canvas id="latencyTrend"></canvas></div><script>
const ui={charts:{throughput:document.getElementById('throughputTrend'),latency:document.getElementById('latencyTrend')}};
function drawAll(){const dpr=devicePixelRatio||1;
const a=ui.charts.throughput.parentElement.getBoundingClientRect();ui.charts.throughput.width=a.width*dpr;ui.charts.throughput.height=a.height*dpr;
const ac=ui.charts.throughput.getContext('2d');ac.setTransform(dpr,0,0,dpr,0,0);ac.moveTo(0,a.height);ac.lineTo(a.width,0);ac.fillText('100',8,16);
const b=ui.charts.latency.parentElement.getBoundingClientRect();ui.charts.latency.width=b.width*dpr;ui.charts.latency.height=b.height*dpr;
const bc=ui.charts.latency.getContext('2d');bc.setTransform(dpr,0,0,dpr,0,0);bc.moveTo(0,b.height);bc.lineTo(b.width,0);bc.fillText('250',8,16);}
const observer=new ResizeObserver(drawAll);observer.observe(ui.charts.throughput.parentElement);observer.observe(ui.charts.latency.parentElement);drawAll();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.canvas_css_bitmap_mismatch");
		expect(result.warnings.join("\n")).toContain("could not be associated");
	});

	it("does not borrow CSS display sizing from a sibling renderer that reuses the local canvas name", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:280px}.donut-viewport{height:200px}
</style></head><body><h1>Yield Dashboard</h1>
<div class="chart-viewport"><canvas id="yieldTrendChart"></canvas></div>
<div class="donut-viewport"><canvas id="departmentDonutChart"></canvas></div><script>
function drawTrend() {
  const canvas = document.getElementById('yieldTrendChart'); const rect = canvas.parentElement.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('95%', 10, 10);
}
function drawDonut() {
  const canvas = document.getElementById('departmentDonutChart'); const size = 200; const dpr = devicePixelRatio || 1;
  canvas.width = size * dpr; canvas.height = size * dpr; canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d'); ctx.arc(100, 100, 80, 0, Math.PI * 2); ctx.fillText('AOI', 80, 100);
}
new ResizeObserver(() => { drawTrend(); drawDonut(); }).observe(document.body); drawTrend(); drawDonut();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("#yieldTrendChart");
		expect(result.errors.join("\n")).not.toMatch(/mismatch[^\n]*#departmentDonutChart/iu);
	});

	it("requires ResizeObserver for a responsive native chart even when window resize redraws it", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:280px}.chart-viewport canvas{width:100%;height:100%}
</style></head><body><h1>Yield Dashboard</h1><div class="chart-viewport"><canvas id="yieldTrendChart"></canvas></div><script>
function drawTrend() { const canvas = document.getElementById('yieldTrendChart'); const rect = canvas.parentElement.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; const ctx = canvas.getContext('2d'); ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('95%', 10, 10); }
window.addEventListener('resize', drawTrend); drawTrend();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).toContain("static.canvas_resize_unhandled");
		expect(result.errors.join("\n")).toContain("window resize listener alone");
	});

	it("does not accept a ResizeObserver name that exists only in a comment", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:280px}.chart-viewport canvas{width:100%;height:100%}
</style></head><body><h1>Yield Dashboard</h1><div class="chart-viewport"><canvas id="yieldTrendChart"></canvas></div><script>
function drawTrend() { const canvas = document.getElementById('yieldTrendChart'); const rect = canvas.parentElement.getBoundingClientRect(); const dpr = devicePixelRatio || 1;
canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; const ctx = canvas.getContext('2d'); ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('95%', 10, 10); }
// TODO: new ResizeObserver(drawTrend).observe(viewport)
drawTrend();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).toContain("static.canvas_resize_unhandled");
	});

	it("rejects a responsive native chart that stretches the default bitmap instead of sizing it for DPR", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
canvas{width:100% !important;height:100% !important}.chart-container{position:relative;height:300px;width:100%}
</style></head><body><article><h2>Finished Overall Trend</h2><div class="chart-container"><canvas id="heroChart"></canvas></div></article><script>
function renderHeroChart() {
  const ctx = document.getElementById('heroChart').getContext('2d');
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.moveTo(0, height); ctx.lineTo(width, 0); ctx.fillText('95%', 20, 20);
}
new ResizeObserver(renderHeroChart).observe(document.querySelector('.chart-container'));
renderHeroChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("bitmap dimensions are never synchronized");
		expect(result.errors.join("\n")).toContain("#heroChart");
	});

	it("rejects a stretched chart when a responsive viewport displays a fixed square DPR bitmap", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-grid{display:grid;grid-template-columns:1fr 1fr}.chart-viewport{height:300px}
.chart-viewport canvas{display:block;width:100%;height:100%}
</style></head><body><section class="chart-grid">
<div class="chart-viewport"><canvas id="yieldTrend"></canvas></div>
<div class="chart-viewport"><canvas id="departmentDonut"></canvas></div></section><script>
const yieldCanvas=document.getElementById('yieldTrend');
const donutCanvas=document.getElementById('departmentDonut');
function drawTrend(){const rect=yieldCanvas.parentElement.getBoundingClientRect();const dpr=devicePixelRatio||1;
yieldCanvas.width=rect.width*dpr;yieldCanvas.height=rect.height*dpr;const ctx=yieldCanvas.getContext('2d');
ctx.setTransform(dpr,0,0,dpr,0,0);ctx.moveTo(0,rect.height);ctx.lineTo(rect.width,0);ctx.fillText('95%',20,20);}
function drawDonut(){const dpr=devicePixelRatio||1;donutCanvas.width=150*dpr;donutCanvas.height=150*dpr;
const ctx=donutCanvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.arc(75,75,70,0,Math.PI*2);ctx.fillText('AOI',70,75);}
window.addEventListener('resize',()=>{drawTrend();drawDonut();});drawTrend();drawDonut();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("#departmentDonut");
		expect(result.errors.join("\n")).toContain("stretches rendered chart pixels");
	});

	it("accepts a fixed square DPR bitmap when its chart viewport is explicitly square", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{width:150px;height:150px}.chart-viewport canvas{width:100%;height:100%}
</style></head><body><div class="chart-viewport"><canvas id="departmentDonut"></canvas></div><script>
const canvas=document.getElementById('departmentDonut');const dpr=devicePixelRatio||1;
function draw(){canvas.width=150*dpr;canvas.height=150*dpr;const ctx=canvas.getContext('2d');
ctx.setTransform(dpr,0,0,dpr,0,0);ctx.arc(75,75,70,0,Math.PI*2);ctx.fillText('AOI',70,75);}
window.addEventListener('resize',draw);draw();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects min-height as the only Canvas viewport bound because grid siblings can stretch it", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.dashboard-grid{display:grid;grid-template-columns:2fr 1fr}.chart-card{display:flex;flex-direction:column}
.chart-container{position:relative;flex:1;min-height:300px}.chart-container canvas{width:100%;height:100%}
</style></head><body><div class="dashboard-grid"><article class="chart-card"><h2>Finished Overall Trend</h2>
<div class="chart-container"><canvas id="trendChart"></canvas></div></article><aside>${"<p>KPI</p>".repeat(40)}</aside></div><script>
const canvas=document.getElementById('trendChart');
function drawTrend(){const rect=canvas.parentElement.getBoundingClientRect();const dpr=devicePixelRatio||1;
canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;canvas.style.width=rect.width+'px';canvas.style.height=rect.height+'px';
const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.moveTo(0,rect.height);ctx.lineTo(rect.width,0);ctx.fillText('95%',20,20);}
new ResizeObserver(drawTrend).observe(canvas.parentElement);drawTrend();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_layout_unbounded");
		expect(result.errors.join("\n")).toContain("min-height alone");
	});

	it("accepts a chart tooltip overlay inside an otherwise dedicated bounded Canvas viewport", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-container{position:relative;height:300px}.chart-container canvas{width:100%;height:100%}
.tooltip{position:absolute;pointer-events:none}
</style></head><body><article class="card"><h2>Yield Trend</h2><div class="chart-container">
<canvas id="yieldTrend"></canvas><div class="tooltip" id="trendTooltip"></div></div></article><script>
const canvas = document.getElementById('yieldTrend');
function drawChart() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
new ResizeObserver(drawChart).observe(canvas.parentElement); drawChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.canvas_layout_unbounded");
	});

	it("finds missing redraw handling when a responsive chart canvas is injected from a script template", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-wrap{position:relative;width:100%;height:280px}.chart-wrap canvas{width:100%;height:100%}
</style></head><body><main id="app"></main><script>
app.innerHTML='<section><h2>Yield Trend</h2><div class="chart-wrap"><canvas id="trendChart"></canvas></div></section>';
function drawTrend(){
  const canvas=document.getElementById('trendChart');
  const width=canvas.parentElement.clientWidth;
  const height=canvas.parentElement.clientHeight;
  const dpr=window.devicePixelRatio||1;
  canvas.width=width*dpr; canvas.height=height*dpr;
  canvas.style.width=width+'px'; canvas.style.height=height+'px';
  const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.moveTo(0,height); ctx.lineTo(width,0); ctx.fillText('100',0,10);
}
drawTrend();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.canvas_resize_unhandled")]);
		expect(result.errors.join("\n")).toContain("#trendChart");
	});

	it("accepts a native Canvas chart bounded by a resolved CSS custom property", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
:root{--chart-height:300px}
.chart-container{position:relative;height:var(--chart-height);width:100%}
.chart-container canvas{display:block;width:100%;height:100%}
</style></head><body><article class="card"><h2>Yield Trend</h2><div class="chart-container">
<canvas id="yieldTrend"></canvas></div></article><script>
const canvas = document.getElementById('yieldTrend');
function drawChart() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
new ResizeObserver(drawChart).observe(canvas.parentElement);
drawChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("associates shared DPR renderer calls and rejects only canvases missing CSS display sizing", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:300px}.chart-viewport canvas#stableTrend{width:100%;height:100%}
</style></head><body>
<div class="chart-viewport"><canvas id="stableTrend"></canvas></div>
<div class="chart-viewport"><canvas id="reviewTrend"></canvas></div><script>
function drawChart(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.moveTo(0, rect.height); ctx.lineTo(rect.width, 0); ctx.fillText('100', 24, 16);
}
function drawAll(){drawChart(document.getElementById('stableTrend'));drawChart(document.getElementById('reviewTrend'));}
new ResizeObserver(drawAll).observe(document.body);drawAll();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("#reviewTrend");
		expect(result.errors.join("\n")).not.toContain("Canvases: #stableTrend");
	});

	it("maps Canvas variables passed to a shared DPR renderer back to every explicit id", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport{height:300px}
</style></head><body>
<div class="chart-viewport"><canvas id="canvasYield"></canvas></div>
<div class="chart-viewport"><canvas id="canvasFpy"></canvas></div><script>
const canvasYield = document.getElementById('canvasYield');
const canvasFpy = document.getElementById('canvasFpy');
function renderSentenceChart(canvas) {
  const parent = canvas.parentElement;
  const width = parent.clientWidth || 300;
  const height = parent.clientHeight || 240;
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2); ctx.moveTo(0, height); ctx.lineTo(width, 0); ctx.fillText('100', 8, 16);
}
function drawAll(){renderSentenceChart(canvasYield);renderSentenceChart(canvasFpy)}
new ResizeObserver(drawAll).observe(document.body);drawAll();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.canvas_css_bitmap_mismatch");
		expect(result.errors.join("\n")).toContain("#canvasYield, #canvasFpy");
		expect(result.warnings.join("\n")).not.toContain("could not be associated");
	});

	it("does not classify a fixed-size game Canvas as a responsive chart", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main id="arcade"><h1>Snake</h1>
<canvas id="gameCanvas" width="480" height="320"></canvas></main><script>
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.moveTo(20, 20); ctx.lineTo(80, 20); ctx.arc(90, 20, 10, 0, Math.PI * 2); ctx.stroke();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("does not classify a single fixed game HUD Canvas as a chart when the game uses DPR scaling", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="arcade game-hud"><h1>Telemetry training game</h1>
<canvas id="metricGraph" width="480" height="320"></canvas></main><script>
const canvas = document.getElementById('metricGraph');
const logicalWidth = 480; const logicalHeight = 320; const dpr = window.devicePixelRatio || 1;
canvas.width = logicalWidth * dpr; canvas.height = logicalHeight * dpr;
const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.moveTo(20, 280); ctx.lineTo(220, 60); ctx.fillText('Score', 8, 16);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("#metricGraph");
	});

	it("does not borrow responsive chart signals for a fixed game HUD Canvas on a mixed page", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-viewport { height: 260px; position: relative; }
#yieldTrend { width: 100%; height: 100%; }
</style></head><body><h1>Yield dashboard and training game</h1>
<section class="chart-card"><h2>Yield trend</h2><div class="chart-viewport"><canvas id="yieldTrend"></canvas></div></section>
<section><h2>Training game HUD</h2><canvas id="metricGraph" width="480" height="320"></canvas></section>
<script>
const chartCanvas = document.getElementById('yieldTrend');
const chartBox = chartCanvas.parentElement.getBoundingClientRect();
chartCanvas.style.width = chartBox.width + 'px';
chartCanvas.style.height = chartBox.height + 'px';
const dpr = window.devicePixelRatio || 1;
chartCanvas.width = Math.round(chartBox.width * dpr);
chartCanvas.height = Math.round(chartBox.height * dpr);
const chartContext = chartCanvas.getContext('2d');
chartContext.moveTo(0, 0); chartContext.lineTo(chartBox.width, chartBox.height); chartContext.fillText('Yield', 8, 16);
new ResizeObserver(() => {}).observe(chartCanvas.parentElement);
const gameContext = document.getElementById('metricGraph').getContext('2d');
gameContext.moveTo(0, 0); gameContext.lineTo(10, 10); gameContext.fillText('Score', 8, 16);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("#metricGraph");
		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a bounded responsive SVG chart", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>.chart-viewport{height:300px}.chart-viewport svg{width:100%;height:100%}</style></head><body>
<article><h2>Yield Trend</h2><div class="chart-viewport"><svg viewBox="0 0 600 300" role="img" aria-label="Yield trend"><polyline points="20,240 180,120 340,160 580,40" fill="none" stroke="blue"/></svg></div></article>
</body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a bounded responsive SVG map without requiring a conventional chart name", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.regional-map-viewport{height:clamp(240px,35vw,420px)}
.regional-map-viewport svg{width:100%;height:100%}
</style></head><body><section><h2>Regional coverage</h2><div class="regional-map-viewport">
<svg id="territoryMap" viewBox="0 0 800 420" role="img" aria-label="Regional coverage map">
<path d="M40 40 H360 V360 H40 Z"/><path d="M440 60 H760 V380 H440 Z"/>
</svg></div></section></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects a responsive SVG drawn with a fixed logical height that conflicts with its CSS viewport", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-box{height:260px}.chart-box svg{width:100%;height:100%}
</style></head><body><section><h2>Department Attribution Chart</h2><div class="chart-box"><svg id="deptChart"></svg></div></section><script>
const byId=(id)=>document.getElementById(id);
function drawDonut(svg,data,width,height){svg.innerHTML='';const cy=height/2;const r=Math.min(width,height)/2-20;svg.innerHTML='<path d="M0 '+(cy+r)+'"/>'}
const bounds=byId('deptChart').getBoundingClientRect();
drawDonut(byId('deptChart'),{Etching:45},bounds.width,360);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.svg_coordinate_space_mismatch");
		expect(result.errors.join("\n")).toContain("#deptChart");
		expect(result.errors.join("\n")).toContain("260px viewport");
		expect(result.errors.join("\n")).toContain("fixed 360px coordinate height");
	});

	it("accepts a responsive SVG that measures both CSS dimensions", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-box{height:260px}.chart-box svg{width:100%;height:100%}
</style></head><body><div class="chart-box"><svg id="yieldChart"></svg></div><script>
const svg=document.getElementById('yieldChart');const bounds=svg.getBoundingClientRect();draw(svg,bounds.width,bounds.height);
function draw(target,width,height){target.innerHTML='<path d="M0 '+height+' L'+width+' 0"/>'}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts a responsive SVG with an explicit matching viewBox even when draw helpers use literals", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.chart-box{height:260px}.chart-box svg{width:100%;height:100%}
</style></head><body><div class="chart-box"><svg id="yieldChart" viewBox="0 0 600 360"></svg></div><script>
const svg=document.getElementById('yieldChart');const bounds=svg.getBoundingClientRect();draw(svg,bounds.width,360);
function draw(target,width,height){target.innerHTML='<path d="M0 '+height+' L'+width+' 0"/>'}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects a canvas height attribute as the only bound when Chart.js disables aspect ratio", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<canvas id="trend" height="300"></canvas><script>
new Chart(document.getElementById('trend'), {options:{maintainAspectRatio:false}});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("dedicated position:relative chart container");
	});

	it("rejects a flex-growing card body as the Chart.js height boundary", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div class="card-body h-100" style="position:relative;height:400px"><canvas id="trend"></canvas></div><script>
new Chart(document.getElementById('trend'), {options:{maintainAspectRatio:false}});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("dedicated position:relative chart container");
	});

	it("rejects visible select controls that are never read by application JavaScript", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="customer"><option>全部</option><option>Alpha</option></select>
<select id="plant"><option>全部</option><option>Fab A</option></select>
<div id="result">Ready</div><script>
document.getElementById('customer').addEventListener('change', () => {
  document.getElementById('result').textContent = document.getElementById('customer').value;
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Select control #plant is never referenced by local JavaScript and cannot affect rendered data.",
		);
		expect(result.errors.join("\n")).not.toContain("#customer is never referenced");
	});

	it("accepts select controls wired through a parent delegated change handler", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><div id="filters">
<select id="filter-customer"><option value="All">All</option><option value="C01">Customer A</option></select>
</div><div id="result"></div><script>
document.getElementById('filters').addEventListener('change', (event) => {
  const id = event.target.id;
  const value = event.target.value;
  if (id === 'filter-customer') renderDashboard(value);
});
function renderDashboard(value) { document.getElementById('result').textContent = value; }
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("filter-customer is never referenced");
	});

	it("accepts external select wiring through an explicit id collection and direct dynamic lookup", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filter-customer"><option value="All">All</option><option value="C01">Customer A</option></select>
<select id="filter-plant"><option value="All">All</option><option value="P01">Plant A</option></select>
<output id="result">All / All</output><script src="app.js"></script></body></html>`,
			"app.js": `const filterIds = ['filter-customer', 'filter-plant'];
const state = { filters: { customer: 'All', plant: 'All' } };
filterIds.forEach(id => {
  const select = document.getElementById(id);
  select.addEventListener('change', event => {
    const stateKey = id.replace('filter-', '');
    state.filters[stateKey] = event.target.value;
    document.getElementById('result').textContent = state.filters.customer + ' / ' + state.filters.plant;
  });
});`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("is never referenced by local JavaScript");
	});

	it("recognizes parent-delegated select wiring even when ids are converted to state keys", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><div id="filter-bar">
<select id="date-type"><option>Weekly</option><option>Monthly</option></select>
<select id="customer"><option>All</option><option>A</option></select></div><div id="result"></div><script>
document.getElementById('filter-bar').addEventListener('change', (event) => {
  if (event.target.tagName === 'SELECT') {
    updateDashboard(event.target.id.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase()), event.target.value);
  }
});
function updateDashboard(key, value) { document.getElementById('result').textContent = key + value; }
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("is never referenced by local JavaScript");
	});

	it("rejects delegated filters when the data getter returns the source dataset unchanged", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><div id="filter-bar">
<select id="date-type"><option>Weekly</option><option>Monthly</option></select>
<select id="customer"><option>All</option><option>A</option></select></div>
<output id="kpi">95%</output><canvas id="yieldChart" width="600" height="300"></canvas><table><tbody></tbody></table><script>
const State = {
  filters: { dateType: 'Weekly', customer: 'All' },
  dataset: [{ customer: 'A', yield: 95 }], listeners: [],
  updateFilter(key, value) { this.filters[key] = value; this.notify(); },
  notify() { this.listeners.forEach(fn => fn(this.filters)); },
  getFilteredData() {
    // A real app would filter based on this.filters.
    return this.dataset;
  },
  subscribe(fn) { this.listeners.push(fn); }
};
document.getElementById('filter-bar').addEventListener('change', (event) => {
  State.updateFilter(event.target.id.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase()), event.target.value);
});
function render() { const rows = State.getFilteredData(); document.getElementById('kpi').textContent = String(rows.length); }
State.subscribe(() => render()); render();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).toContain("static.filter_value_unused: Select #date-type");
		expect(result.errors.join("\n")).toContain("static.filter_value_unused: Select #customer");
		expect(result.errors.join("\n")).not.toContain("is never referenced by local JavaScript");
	});

	it("fails open when a delegated filter getter actually consumes filter state", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><div id="filter-bar">
<select id="customer"><option>All</option><option>A</option></select></div><output id="kpi">95%</output><script>
const State = {
  filters: { customer: 'All' }, dataset: [{ customer: 'A' }], listeners: [],
  updateFilter(key, value) { this.filters[key] = value; this.notify(); },
  notify() { this.listeners.forEach(fn => fn()); }, subscribe(fn) { this.listeners.push(fn); },
  getFilteredData() { return this.filters.customer === 'All' ? this.dataset : this.dataset.filter(row => row.customer === this.filters.customer); }
};
document.getElementById('filter-bar').addEventListener('change', event => State.updateFilter(event.target.id, event.target.value));
function render() { document.getElementById('kpi').textContent = String(State.getFilteredData().length); }
State.subscribe(() => render()); render();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.filter_value_unused");
	});

	it("accepts select controls wired through an explicit dynamic id map", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div id="loading" class="loading">加载中</div>
<select id="filterCustomer"></select><select id="filterPlant"></select><script>
const filterOptions = { filterCustomer: ['全部', 'Alpha'], filterPlant: ['全部', 'Fab A'] };
Object.entries(filterOptions).forEach(([id, values]) => {
  const element = document.getElementById(id);
  element.addEventListener('change', (event) => updateData(id, event.target.value));
});
document.getElementById('loading').style.display = 'none';
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("recognizes an explicit object binding map and blocks only an omitted sibling filter", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><div class="filter-bar">
<div><select id="filter-customer"><option>ALL</option><option>A</option></select></div>
<div><select id="filter-plant"><option>ALL</option><option>Fab 1</option></select></div>
<div><select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select></div></div>
<output id="kpi">1</output><script src="app.js"></script></body></html>`,
			"app.js": `const rows=[{customer:'A',plant:'Fab 1'}];const state={filters:{customer:'ALL',plant:'ALL',dateType:'Weekly'}};
function getFilteredData(){return rows.filter(row=>(state.filters.customer==='ALL'||row.customer===state.filters.customer)&&(state.filters.plant==='ALL'||row.plant===state.filters.plant));}
function render(){document.getElementById('kpi').textContent=String(getFilteredData().length);}
function bindFilters(){const binds=[{id:'filter-customer',key:'customer'},{id:'filter-plant',key:'plant'}];binds.forEach(b=>{const el=document.getElementById(b.id);el.addEventListener('change',e=>{state.filters[b.key]=e.target.value;render();});});}bindFilters();render();`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).toContain(
			"static.filter_value_unused: Select #filter-date-type is omitted from the explicit filter binding map",
		);
		expect(result.errors.join("\n")).not.toContain(
			"Select control #filter-date-type is never referenced by local JavaScript",
		);
		expect(result.errors.join("\n")).not.toContain("#filter-customer is never referenced");
		expect(result.errors.join("\n")).not.toContain("#filter-plant is never referenced");
	});

	it("accepts an explicit object binding map when every mapped property drives rendered data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><div class="filter-bar">
<select id="filter-customer"><option>ALL</option><option>A</option></select>
<select id="filter-plant"><option>ALL</option><option>Fab 1</option></select></div>
<output id="kpi">1</output><script src="app.js"></script></body></html>`,
			"app.js": `const rows=[{customer:'A',plant:'Fab 1'}];const state={filters:{customer:'ALL',plant:'ALL'}};
function render(){const filtered=rows.filter(row=>(state.filters.customer==='ALL'||row.customer===state.filters.customer)&&(state.filters.plant==='ALL'||row.plant===state.filters.plant));document.getElementById('kpi').textContent=String(filtered.length);}
const binds=[{id:'filter-customer',key:'customer'},{id:'filter-plant',key:'plant'}];binds.forEach(b=>{const el=document.getElementById(b.id);el.addEventListener('change',e=>{state.filters[b.key]=e.target.value;render();});});render();`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("accepts select controls wired through a compound selector and shared change handler", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div class="filter-group">
  <select id="filterCustomer"><option>All</option><option>Alpha</option></select>
  <select id="filterPlant"><option>All</option><option>Fab A</option></select>
</div>
<div id="result">Ready</div><script>
const state = { filters: {} };
document.querySelectorAll('.filter-group select').forEach((select) => {
  select.addEventListener('change', (event) => {
    state.filters[event.target.id] = event.target.value;
    document.getElementById('result').textContent = JSON.stringify(state.filters);
  });
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("is never referenced");
	});

	it("treats a compound select query with a named change handler as wired without assuming it is effective", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<div class="filter-group">
  <select id="filter-customer"><option>All</option><option>Alpha</option></select>
  <select id="filter-plant"><option>All</option><option>Fab A</option></select>
</div><div id="result">Ready</div><script>
function handleFilterChange(event) {
  document.getElementById('result').textContent = event.target.value;
}
document.querySelectorAll('.filter-group select').forEach((select) => {
  select.addEventListener('change', handleFilterChange);
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("is never referenced");
	});

	it("rejects a select value captured into a local variable that is never used", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filter-date-type"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<div id="result">Ready</div><script>
function applyFilters() {
  const dateType = document.getElementById('filter-date-type').value;
  document.getElementById('result').textContent = 'unchanged';
}
applyFilters();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.filter_value_unused");
		expect(result.errors.join("\n")).toContain("#filter-date-type");
		expect(result.errors.join("\n")).toMatch(/index\.html:\d+/u);
	});

	it("accepts a captured select value used by a real filter predicate", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body>
<select id="filter-date-type"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<div id="result">Ready</div><script>
const rows = [{ DateType: 'Weekly' }, { DateType: 'Monthly' }];
function applyFilters() {
  const dateType = document.getElementById('filter-date-type').value;
  document.getElementById('result').textContent = String(rows.filter((row) => row.DateType === dateType).length);
}
applyFilters();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects an unused captured select value even when the control also has a change listener", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="filterDateType"><option>Weekly</option><option>Monthly</option></select>
<output id="yield">95%</output><script>
function renderAll() {
  const dateType = document.getElementById('filterDateType').value;
  document.getElementById('yield').textContent = '95%';
}
document.getElementById('filterDateType').addEventListener('change', renderAll);
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(
			expect.stringContaining("Select #filterDateType reads its value into dateType but never uses that value"),
		);
	});

	it("rejects a select stored by a bulk filter assignment but omitted from rendered-data predicates", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="fCustomer"><option value="All">All</option><option value="A">A</option></select>
<select id="fDateType"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<output id="result">Ready</output><script>
const MOCK_DATA = [{ customer: 'A', dateType: 'Weekly' }];
const state = { filters: {}, filteredData: MOCK_DATA };
function applyFilters() {
  state.filters = {
    customer: document.getElementById('fCustomer').value,
    dateType: document.getElementById('fDateType').value
  };
  state.filteredData = MOCK_DATA.filter((row) =>
    state.filters.customer === 'All' || row.customer === state.filters.customer
  );
  document.getElementById('result').textContent = String(state.filteredData.length);
}
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.stringContaining(
				"static.filter_value_unused: Select #fDateType writes state.filters.dateType in a bulk filter assignment",
			),
		]);
	});

	it("accepts bulk filter state when the complete object is delegated to rendered-data code", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<select id="fCustomer"><option value="All">All</option><option value="A">A</option></select>
<select id="fDateType"><option value="Weekly">Weekly</option><option value="Monthly">Monthly</option></select>
<output id="result">Ready</output><script>
const state = { filters: {} };
function queryRows(filters) { return filters.customer + filters.dateType; }
function applyFilters() {
  state.filters = {
    customer: document.getElementById('fCustomer').value,
    dateType: document.getElementById('fDateType').value
  };
  document.getElementById('result').textContent = queryRows(state.filters);
}
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects dashboard selects that are only reset while Apply redraws unchanged data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1>
<select id="plantFilter"><option value="all">All</option><option value="P1">P1</option></select>
<button id="applyFilters">Apply Filters</button><button id="resetFilters">Reset</button>
<canvas id="yieldTrend"></canvas><script>
const MOCK_DATA = [120, 95];
function renderDashboard() { return MOCK_DATA; }
document.getElementById('applyFilters').onclick = () => renderDashboard();
document.getElementById('resetFilters').onclick = () => {
  document.getElementById('plantFilter').selectedIndex = 0;
};
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.stringContaining("static.filter_value_unused: Select #plantFilter is only reset"),
		]);
	});

	it("accepts a resettable dashboard select when Apply reads its value", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1>
<select id="plantFilter"><option value="all">All</option><option value="P1">P1</option></select>
<button id="applyFilters">Apply Filters</button><button id="resetFilters">Reset</button>
<output id="kpiYield">95%</output><script>
document.getElementById('applyFilters').onclick = () => {
  const plant = document.getElementById('plantFilter').value;
  document.getElementById('kpiYield').textContent = plant === 'P1' ? '93%' : '95%';
};
document.getElementById('resetFilters').onclick = () => {
  document.getElementById('plantFilter').selectedIndex = 0;
};
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects an Apply Filters handler that only logs and alerts captured select values", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard"><label>Customer<select id="customer"><option>All</option><option>A</option></select></label>
<label>Plant<select id="plant"><option>All</option><option>P1</option></select></label>
<button onclick="applyFilters()">Apply Filters</button><div class="kpi-card"><span class="value">95%</span></div><table><tr><th>Lot</th></tr><tr><td>L1</td></tr></table></main><script>
function applyFilters(){
 const customer=document.getElementById('customer').value;
 const plant=document.getElementById('plant').value;
 console.log('Applying filters (simulated)', {customer,plant});
 // A real implementation would fetch filtered data.
 alert(\`Customer: \${customer} Plant: \${plant}\`);
}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.filter_value_unused");
		expect(result.errors.join("\n")).toContain("advisory-only handler applyFilters");
		expect(result.errors.join("\n")).toContain("#customer");
		expect(result.errors.join("\n")).toContain("#plant");
	});

	it("accepts an Apply Filters handler that passes captured values to dashboard rendering", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard"><label>Customer<select id="customer"><option>All</option><option>A</option></select></label>
<button onclick="applyFilters()">Apply Filters</button><div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
function applyFilters(){
 const customer=document.getElementById('customer').value;
 renderDashboard({customer});
}
function renderDashboard(filters){document.getElementById('yield').textContent=filters.customer==='A'?'91%':'95%';}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects an explicitly placeholder Apply Filters handler that only redraws existing data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard"><label>Customer<select id="customer"><option>All</option><option>A</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div><canvas id="yieldChart"></canvas></main><script>
const filters = { customer: 'All' };
const yieldChart = { update() {} };
function applyFilters() {
  // Logic to filter data based on the filters state would go here.
  // For simulated data, just update the current data.
  updateKPIs(dashboardData[selectedWeekIndex]);
  yieldChart.update();
}
document.getElementById('customer').addEventListener('change', event => {
  filters.customer = event.target.value;
  applyFilters();
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("explicitly leaves filtering unimplemented")]);
	});

	it("accepts delegated filtering even when simulated data is mentioned in a comment", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard"><label>Customer<select id="customer"><option>All</option><option>A</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
const filters = { customer: 'All' };
function applyFilters() {
  // Simulated data is transformed locally rather than fetched.
  const filteredRows = getRowsForFilters(filters);
  renderDashboard(filteredRows);
}
document.getElementById('customer').addEventListener('change', event => {
  filters.customer = event.target.value;
  applyFilters();
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects one select whose generic change handler redraws without ever reading its value", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Customer<select id="filterCustomer"><option>All</option><option>A</option></select></label>
<label>Date Type<select id="filterDateType"><option>Weekly</option><option>Monthly</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
function renderAll() {
  const customer = document.getElementById('filterCustomer').value;
  document.getElementById('yield').textContent = customer === 'A' ? '93%' : '95%';
}
['filterCustomer', 'filterDateType'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => renderAll());
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(
			expect.stringContaining("Select #filterDateType is bound through a generic change handler"),
		);
	});

	it("accepts a generic select change handler that delegates the changed value", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="filterDateType"><option>Weekly</option><option>Monthly</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
['filterDateType'].forEach(id => {
  document.getElementById(id).addEventListener('change', event => renderDashboard(id, event.target.value));
});
function renderDashboard(id, value) { document.getElementById('yield').textContent = id + value; }
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects prefix-only state keys for hyphenated dashboard filter ids", () => {
		const root = writeProject({
			"index.html": `<!doctype html><select id="customer-filter"><option>All</option><option>A</option></select>
<select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select>
<select id="lot-type-filter"><option>HVM</option><option>LVM</option></select><output id="kpi">1</output><script>
let state={customer:'all',dateType:'Weekly',lotType:'HVM'};
const filters=['customer-filter','date-type-filter','lot-type-filter'];
filters.forEach(id=>document.getElementById(id).addEventListener('change',e=>{const key=id.split('-')[0];state[key]=e.target.value;render()}));
function render(){document.getElementById('kpi').textContent=state.customer+state.dateType+state.lotType}
</script>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.filter_state_key_mismatch");
		expect(result.errors.join("\n")).toContain("#date-type-filter=>state.date (expected state.dateType)");
		expect(result.errors.join("\n")).toContain("#lot-type-filter=>state.lot (expected state.lotType)");
	});

	it("accepts an explicit filter-id to render-state mapping", () => {
		const root = writeProject({
			"index.html": `<!doctype html><select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select>
<select id="lot-type-filter"><option>HVM</option><option>LVM</option></select><output id="kpi">1</output><script>
let state={dateType:'Weekly',lotType:'HVM'};const map={'date-type-filter':'dateType','lot-type-filter':'lotType'};
Object.keys(map).forEach(id=>document.getElementById(id).addEventListener('change',e=>{state[map[id]]=e.target.value;render(state)}));
function render(filters){document.getElementById('kpi').textContent=filters.dateType+filters.lotType}
</script>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("static.filter_state_key_mismatch");
	});

	it("rejects a filter state property that is assigned by change but never used by rendered data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select></label>
<label>Lot Type<select id="filter-lot-type"><option>HVM</option><option>LVM</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
const state = { filters: { dateType: 'Weekly', lotType: 'HVM' } };
function filteredData() { return rows.filter(row => row.lotType === state.filters.lotType); }
function render() { document.getElementById('yield').textContent = String(filteredData().length); }
document.getElementById('filter-date-type').addEventListener('change', e => {
  state.filters.dateType = e.target.value;
  render();
});
document.getElementById('filter-lot-type').addEventListener('change', e => {
  state.filters.lotType = e.target.value;
  render();
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(
			expect.stringContaining("Select #filter-date-type writes state.filters.dateType"),
		);
		expect(result.errors.join("\n")).not.toContain("filter-lot-type writes state.filters.lotType");
	});

	it("rejects a cached DOM alias whose filter state is used only by UI defaults and export messaging", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Customer<select id="customerFilter"><option>All</option><option>A</option></select></label>
<label>Date Type<select id="dateTypeFilter"><option>Weekly</option><option>Monthly</option></select></label>
<button id="applyFilters">Apply Filters</button><output id="yield">95%</output></main><script>
const rows = [{ customer: 'A', dateType: 'Weekly' }];
const state = { filters: { customer: 'All', dateType: 'Weekly' } };
const elements = {};
elements.customerFilter = document.getElementById('customerFilter');
elements.dateTypeFilter = document.getElementById('dateTypeFilter');
elements.applyFilters = document.getElementById('applyFilters');
elements.dateTypeFilter.value = state.filters.dateType;
elements.applyFilters.addEventListener('click', function () {
  state.filters.customer = elements.customerFilter.value;
  state.filters.dateType = elements.dateTypeFilter.value;
  const filtered = rows.filter((row) => state.filters.customer === 'All' || row.customer === state.filters.customer);
  document.getElementById('yield').textContent = String(filtered.length);
  alert('Date Type: ' + state.filters.dateType);
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(
			expect.stringContaining(
				"Select #dateTypeFilter writes state.filters.dateType through DOM alias elements.dateTypeFilter",
			),
		);
		expect(result.errors.join("\n")).not.toContain("#customerFilter writes state.filters.customer through DOM alias");
	});

	it("fails open when the entire filter state is delegated to another data layer", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select></label>
<div class="kpi-card"><span class="value" id="yield">95%</span></div></main><script>
const state = { filters: { dateType: 'Weekly' } };
function render() { renderDashboard(queryRows(state.filters)); }
document.getElementById('filter-date-type').addEventListener('change', event => {
  state.filters.dateType = event.target.value;
  render();
});
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects a flat filter state property assigned by a shared select handler but never read", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select></label>
<label>Plant<select id="plant-filter"><option>All</option><option>P1</option></select></label>
<output id="kpi">1</output><script>
const rows = [{ plant: 'P1', value: 1 }];
const state = { dateType: 'Weekly', plant: 'All' };
function render() { document.getElementById('kpi').textContent = rows.filter(row => state.plant === 'All' || row.plant === state.plant).length; }
document.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
  const id = sel.id;
  if (id === 'date-type-filter') state.dateType = sel.value;
  else if (id === 'plant-filter') state.plant = sel.value;
  render();
}));
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(expect.stringContaining("Select #date-type-filter writes state.dateType"));
		expect(result.errors.join("\n")).not.toContain("#plant-filter writes state.plant");
	});

	it("rejects unread flat filter state written by cached DOM onchange handlers without flagging consumed peers", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="dateTypeFilter"><option>Weekly</option><option>Monthly</option></select></label>
<label>Customer<select id="customerFilter"><option>All</option><option>CUST-A</option></select></label>
<output id="kpi">1</output><script>
const rows = [{ customer: 'CUST-A', value: 1 }];
const state = { dateType: 'Weekly', customer: 'All' };
const els = {
  dateTypeFilter: document.getElementById('dateTypeFilter'),
  customerFilter: document.getElementById('customerFilter')
};
function updateDashboard() {
  document.getElementById('kpi').textContent = rows.filter(row => state.customer === 'All' || row.customer === state.customer).length;
}
els.dateTypeFilter.onchange = (event) => { state.dateType = event.target.value; updateDashboard(); };
els.customerFilter.onchange = (event) => { state.customer = event.target.value; updateDashboard(); };
updateDashboard();
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(expect.stringContaining("Select #dateTypeFilter writes state.dateType"));
		expect(result.errors.join("\n")).not.toContain("#customerFilter writes state.customer");
	});

	it("does not classify a one-option cached DOM select as a broken interactive filter", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="dateTypeFilter"><option>Weekly</option></select></label>
<output id="kpi">1</output><script>
const state = { dateType: 'Weekly' };
const els = { dateTypeFilter: document.getElementById('dateTypeFilter') };
function updateDashboard() { document.getElementById('kpi').textContent = '1'; }
els.dateTypeFilter.onchange = event => { state.dateType = event.target.value; updateDashboard(); };
updateDashboard();
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("static.filter_value_unused");
	});

	it("rejects an unread nested filter property assigned by a derived-key shared handler", () => {
		const root = writeProject({
			"index.html": `<!doctype html><main class="dashboard">
<select id="filter-date-type"><option>Weekly</option><option>Monthly</option></select>
<select id="filter-plant"><option>All</option><option>P1</option></select><output id="kpi">1</output>
<script>const rows=[{plant:'P1'}]; const state={filters:{dateType:'Weekly',plant:'All'}};
function render(){document.getElementById('kpi').textContent=rows.filter(row=>state.filters.plant==='All'||row.plant===state.filters.plant).length;}
document.querySelectorAll('select').forEach(el=>el.addEventListener('change', event=>{
  const key=el.id.replace('filter-','');
  if(key==='date-type') state.filters.dateType=event.target.value;
  else if(key==='plant') state.filters.plant=event.target.value;
  render();
}));</script></main>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toContainEqual(
			expect.stringContaining(
				"Select #filter-date-type writes state.filters.dateType through a shared change handler",
			),
		);
		expect(result.errors.join("\n")).not.toContain("#filter-plant writes state.filters.plant");
	});

	it("accepts flat filter state when the whole state is delegated to rendered-data code", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main class="dashboard">
<label>Date Type<select id="date-type-filter"><option>Weekly</option><option>Monthly</option></select></label>
<output id="kpi">1</output><script>
const state = { dateType: 'Weekly' };
function render() { renderDashboard(queryRows(state)); }
document.getElementById('date-type-filter').addEventListener('change', event => {
  state.dateType = event.target.value;
  render();
});
</script></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("static.filter_value_unused");
	});

	it("rejects random values used as rendered chart data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="trend"></canvas><script>
new Chart(document.getElementById('trend'), { data: { datasets: [{ data: [Math.random()] }] } });
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.nondeterministic_data");
	});

	it("rejects unseeded Math.random inside a mock-data generator used by initial rendering", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><output id="kpiYield">--</output><script>
function generateMockData(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index, yield: Math.random() * 100 }));
}
const rows = generateMockData(20);
document.getElementById('kpiYield').textContent = rows[0].yield.toFixed(1);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("static.nondeterministic_data");
		expect(result.errors.join("\n")).toMatch(/index\.html:\d+/u);
	});

	it("rejects the production-shaped mock generator with literal dimensions and trailing comments", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Finished Lot Yield Dashboard</h1>
<output id="kpiYield">--</output><table><tbody id="lotTableBody"></tbody></table><script>
function generateMockData(count = 120) {
  const families = ["Semiconductor", "Consumer Electronics", "Automotive", "Medical"]; // 4 families
  const steps = ["SMT", "AOI", "Reflow", "Test", "Packaging"]; // 5 steps
  const statuses = ["Pass", "Fail", "Scrap"];
  const data = [];
  for (let i = 1; i <= count; i++) {
    const family = families[Math.floor(Math.random() * families.length)];
    const step = steps[Math.floor(Math.random() * steps.length)];
    data.push({ lotId: \`LOT-\${String(i).padStart(5, '0')}\`, family, step });
  }
  return data;
}
function escapeHtml(value) {
  return String(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const previewRow = \`<td>\${escapeHtml("LOT-00001")}</td><td>\${true ? "Yes" : "No"}</td>\`;
const state = { raw: generateMockData(120) };
document.getElementById('kpiYield').textContent = String(state.raw.length);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("rejects unseeded Math.random inside a once-invoked arrow mock-data generator", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><output id="kpiYield">--</output><script>
const generateMockData = () => [{ yield: Math.random() * 100 }];
const rows = generateMockData();
document.getElementById('kpiYield').textContent = rows[0].yield.toFixed(1);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("does not trust a seed-data function name when first-render dashboard data still uses Math.random", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><output id="kpi">--</output><script>
function generateSeedData() { return [{ yield: Math.random() * 100 }]; }
const MOCK_DB = generateSeedData();
document.getElementById('kpi').textContent = MOCK_DB[0].yield.toFixed(1);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("Context: dashboard-first-render")]);
	});

	it("rejects unseeded Math.random inside a generic generateData dashboard fixture", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1>
<label>Customer<select id="customerFilter"><option>All</option><option>A</option></select></label>
<output id="kpiYield">--</output><svg id="yieldTrend"></svg><table id="details"><tbody></tbody></table><script>
function generateData(filters) {
  const seed = filters.customer.length;
  return { yield: 94 + seed, trend: [1, 2, 3].map(() => Math.random() * 5) };
}
function refreshDashboard() {
  const data = generateData({ customer: document.getElementById('customerFilter').value });
  document.getElementById('kpiYield').textContent = data.yield.toFixed(1);
  document.getElementById('yieldTrend').dataset.points = data.trend.join(',');
}
document.getElementById('customerFilter').addEventListener('change', refreshDashboard);
refreshDashboard();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("rejects unseeded random data in an invoked object-style weekly generator from a local script", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><script src="app.js" defer></script></head><body>
<h1>Finished Lot Yield Dashboard</h1><output id="kpiYield">--</output><svg id="yieldTrend"></svg><table><tbody></tbody></table>
</body></html>`,
			"app.js": `const MockData = {
  generateWeeklyData: function() {
    return [{ week: '202621', yield: 94 + Math.random() * 4, output: Math.floor(150 + Math.random() * 30) }];
  },
  filterData: function() { return this.generateWeeklyData(); }
};
const rows = MockData.filterData();
document.getElementById('kpiYield').textContent = rows[0].yield.toFixed(2) + '%';`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("app.js:3");
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("rejects unseeded random data in invoked object method shorthand", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Finished Lot Yield Dashboard</h1>
<output id="kpiYield">--</output><table><tbody></tbody></table><script>
const MOCK_DB = {
  generateDataset() { return [{ yield: 94 + Math.random() * 4, output: 150 + Math.floor(Math.random() * 30) }]; }
};
const rows = MOCK_DB.generateDataset();
document.getElementById('kpiYield').textContent = rows[0].yield.toFixed(2) + '%';
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toMatch(/index\.html:\d+/u);
	});

	it("rejects unseeded random rows reached through a first-render object method call chain", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Operations Dashboard</h1><output id="kpi">--</output><script src="app.js"></script></body></html>`,
			"app.js": `const MOCK_DATA = {
  periods: ['P1', 'P2'],
  generateRow(period, index) {
    return { period, index, count: Math.floor(Math.random() * 50) + 10 };
  },
  generateFullDataset() {
    return this.periods.flatMap((period, index) => [this.generateRow(period, index)]);
  }
};
const rows = MOCK_DATA.generateFullDataset();
document.getElementById('kpi').textContent = String(rows[0].count);`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("app.js:4");
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("does not block an unused random object fixture that is unreachable from first rendering", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Operations Dashboard</h1><output id="kpi">42</output><script>
const UNUSED_MOCK_DATA = {
  generateRow() { return { count: Math.random() * 50 }; },
  generateFullDataset() { return [this.generateRow()]; }
};
const rows = [{ count: 42 }];
document.getElementById('kpi').textContent = String(rows[0].count);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.nondeterministic_data");
	});

	it("does not reject deterministic dashboard data merely because comments or strings mention Math.random", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><output id="kpi">--</output><script>
function generateData() {
  // Keep this fixture deterministic: never call Math.random().
  const guidance = "Math.random() is forbidden for demo values";
  const escaped = guidance.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const ratio = [190][0] / 2;
  const note = \`deterministic: \${escaped}\`;
  return [{ yield: ratio, guidance, note }];
}
const rows = generateData(); document.getElementById('kpi').textContent = String(rows[0].yield);
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.nondeterministic_data");
	});

	it("rejects unseeded random data created directly inside a dashboard render function", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Yield Dashboard</h1><output id="kpiYield">--</output><canvas id="yield-chart"></canvas><script>
function render() {
  const yieldData = Array.from({ length: 8 }, () => 94 + Math.random() * 4);
  document.getElementById('kpiYield').textContent = yieldData.at(-1).toFixed(2) + '%';
  drawYieldChart(document.getElementById('yield-chart'), yieldData);
}
function drawYieldChart(canvas, data) { canvas.dataset.points = String(data.length); }
render();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
		expect(result.errors.join("\n")).toContain("Context: dashboard-first-render");
	});

	it("does not treat random values in an ordinary game loop as dashboard demo data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Asteroid Game</h1><canvas id="game" width="800" height="600"></canvas><script>
function render() {
  const asteroidX = Math.random() * 800;
  document.getElementById('game').dataset.asteroidX = String(asteroidX);
}
render();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects unseeded random data inside an arrow renderDashboard function", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Defect Analytics Dashboard</h1><output id="kpiLoss">--</output><script>
const renderDashboard = () => {
  const loss = 1 + Math.random();
  document.getElementById('kpiLoss').textContent = loss.toFixed(2) + '%';
};
renderDashboard();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
	});

	it("rejects unseeded random data inside an invoked business-prefixed chart renderer", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><h1>Defect Yield Dashboard</h1>
<canvas id="defectTrendChart"></canvas><script>
function renderDefectTrendChart() {
  const trendData = [1, 2, 3].map(() => 15 + Math.random() * 5);
  new Chart(document.getElementById('defectTrendChart'), { data: { datasets: [{ data: trendData }] } });
}
renderDefectTrendChart();
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors).toEqual([expect.stringContaining("static.nondeterministic_data")]);
	});

	it("does not reject an ordinary long table or long page", () => {
		const rows = Array.from({ length: 400 }, (_, index) => `<tr><td>${index + 1}</td><td>Stable row</td></tr>`).join(
			"",
		);
		const root = writeProject({
			"index.html": `<!doctype html><html><body><main><h1>Audit log</h1><table><tbody>${rows}</tbody></table></main></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects Canvas intrinsic-width feedback in bare fractional dashboard Grid tracks", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.chart-card{padding:20px}.chart-viewport{position:relative;width:100%;height:250px;overflow:hidden}
.chart-canvas{display:block;width:100%;height:100%}
</style></head><body><h1>Operations Trend Dashboard</h1><section class="charts-grid">
<article class="chart-card"><h2>Throughput Trend</h2><div class="chart-viewport"><canvas id="trend-chart" class="chart-canvas"></canvas></div></article>
<article class="chart-card"><h2>Defect Summary</h2><p>Deterministic summary content</p></article>
</section><script src="./src/main.js"></script></body></html>`,
			"src/main.js": `function drawTrend(){
  const canvas=document.getElementById('trend-chart');
  const container=canvas.parentElement;
  const dpr=window.devicePixelRatio||1;
  canvas.width=container.offsetWidth*dpr;
  canvas.height=container.offsetHeight*dpr;
  canvas.style.width=container.offsetWidth+'px';
  canvas.style.height=container.offsetHeight+'px';
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.moveTo(0,container.offsetHeight);ctx.lineTo(container.offsetWidth,0);ctx.fillText('Trend',8,16);
}
new ResizeObserver(drawTrend).observe(document.getElementById('trend-chart').parentElement);
drawTrend();`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.page_horizontal_overflow")]);
		expect(result.errors[0]).toContain("section.charts-grid");
		expect(result.errors[0]).toContain("#trend-chart");
		expect(result.errors[0]).toMatch(/src\/main\.js:\d+/u);
	});

	it("accepts shrink-safe dashboard Grid tracks and one-snapshot Canvas DPR sizing", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.charts-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.chart-card{min-width:0;padding:20px}.chart-viewport{position:relative;width:100%;height:250px;overflow:hidden}
.chart-canvas{display:block;width:100%;height:100%;max-width:100%}
@media(max-width:700px){.charts-grid{grid-template-columns:minmax(0,1fr)}}
</style></head><body><h1>Operations Trend Dashboard</h1><section class="charts-grid">
<article class="chart-card"><h2>Throughput Trend</h2><div class="chart-viewport"><canvas id="trend-chart" class="chart-canvas"></canvas></div></article>
<article class="chart-card"><h2>Defect Pareto</h2><div class="chart-viewport"><canvas id="pareto-chart" class="chart-canvas"></canvas></div></article>
</section><script src="./src/main.js"></script></body></html>`,
			"src/main.js": `function drawChart(canvas){
  const rect=canvas.parentElement.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(rect.width*dpr);
  canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.moveTo(0,rect.height);ctx.lineTo(rect.width,0);ctx.fillText('Trend',8,16);
}
const canvases=[document.getElementById('trend-chart'),document.getElementById('pareto-chart')];
const observer=new ResizeObserver(()=>canvases.forEach(drawChart));
canvases.forEach(canvas=>{observer.observe(canvas.parentElement);drawChart(canvas)});`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.page_horizontal_overflow");
	});

	it("keeps all-page non-wrapping pagination advisory without proven desktop overflow", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.pagination{display:flex;justify-content:center;gap:8px}
</style></head><body><h1>Customer Records Dashboard</h1><div id="pagination" class="pagination"></div>
<script src="./src/main.js"></script></body></html>`,
			"src/main.js": `const pagination=document.getElementById('pagination');
const totalPages=15;
for(let page=1;page<=totalPages;page++){
  const button=document.createElement('button');
  button.textContent=String(page);
  pagination.appendChild(button);
}`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("static.page_horizontal_overflow")]);
		expect(result.warnings[0]).toContain("div#pagination.pagination");
		expect(result.warnings[0]).toMatch(/src\/main\.js:\d+/u);
	});

	it("accepts responsive wrapping pagination even when every page is rendered", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.pagination{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
</style></head><body><h1>Customer Records Dashboard</h1><div id="pagination" class="pagination"></div>
<script>const pagination=document.getElementById('pagination');const totalPages=15;
for(let page=1;page<=totalPages;page++){const button=document.createElement('button');button.textContent=String(page);pagination.appendChild(button)}</script>
</body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.errors.join("\n")).not.toContain("static.page_horizontal_overflow");
	});

	it("rejects a source-proven wide table that can expand a multi-column dashboard grid beyond the page", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.detail-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}.card{padding:20px}table{width:100%;min-width:900px}
</style></head><body><h1>Yield Dashboard</h1><section class="detail-grid">
<article class="card"><h2>Pareto Chart</h2></article>
<article class="card"><table><thead><tr><th>Defect Code</th><th>Description</th><th>Count</th><th>Loss Ratio</th><th>Department</th></tr></thead></table></article>
<article class="card"><h2>Department Chart</h2></article>
</section></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([expect.stringContaining("static.page_horizontal_overflow")]);
		expect(result.errors[0]).toContain("section.detail-grid");
		expect(result.errors[0]).toMatch(/index\.html:\d+/u);
	});

	it("keeps an ordinary multi-column table advisory when intrinsic overflow is not proven", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{padding:20px}table{width:100%}
</style></head><body><h1>Operations Dashboard</h1><section class="detail-grid"><article class="card">Summary</article><article class="card">
<table><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Owner</th><th>Date</th></tr></thead></table>
</article></section></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
		expect(result.warnings.join("\n")).toContain("source does not prove intrinsic width pressure");
	});

	it("keeps externally styled responsive table containment advisory", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head>
<link rel="stylesheet" href="https://cdn.example.test/bootstrap.css"><style>
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{padding:20px}table{width:100%}
</style></head><body><h1>Yield Dashboard</h1><section class="detail-grid">
<article class="card"><h2>Pareto Chart</h2></article>
<article class="card"><div class="table-responsive"><table><thead><tr><th>Defect</th><th>Description</th><th>Count</th><th>Loss</th><th>Department</th></tr></thead></table></div></article>
</section></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("static.page_horizontal_overflow");
		expect(result.warnings.join("\n")).toContain("containment could not be verified");
	});

	it("accepts a contained wide table inside a multi-column dashboard grid", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
.detail-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}.card{min-width:0;padding:20px}.table-scroll{overflow-x:auto}table{width:100%}
</style></head><body><h1>Yield Dashboard</h1><section class="detail-grid">
<article class="card"><h2>Pareto Chart</h2></article>
<article class="card"><div class="table-scroll"><table><thead><tr><th>Defect Code</th><th>Description</th><th>Count</th><th>Loss Ratio</th><th>Department</th></tr></thead></table></div></article>
<article class="card"><h2>Department Chart</h2></article>
</section></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("rejects an effectively invisible control label caused by CSS cascade", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
button { background:#2563eb; color:#fff }
.filter-btn { background:#fff; border:1px solid #ddd }
.filter-btn.active { background:#2563eb; color:#fff }
</style></head><body>
<button class="filter-btn active">全部</button><button class="filter-btn">待完成</button>
</body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("待完成");
		expect(result.errors.join("\n")).toContain("effectively unreadable");
	});

	it("accepts explicitly contrasting inactive and active control states", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
button { background:#2563eb; color:#fff }
.filter-btn { background:#fff; color:#1f2937; border:1px solid #ddd }
.filter-btn.active { background:#2563eb; color:#fff }
</style></head><body>
<button class="filter-btn active">全部</button><button class="filter-btn">待完成</button>
</body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("does not borrow a lower-cascade color when a CSS variable declaration shadows it", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><head><style>
:root { --primary:#1e88e5 }
.pagination-btn { background:white; color:#1f2937 }
.pagination-btn.active { background:var(--primary); color:white }
</style></head><body><button id="page-1" class="pagination-btn active">1</button></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.errors.join("\n")).not.toContain("effectively unreadable");
	});

	it("rejects a Chart instance stored on window under the same name as a canvas id", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="yieldTrendChart" height="300"></canvas><script>
function renderChart() {
  const ctx = document.getElementById('yieldTrendChart').getContext('2d');
  if (window.yieldTrendChart) window.yieldTrendChart.destroy();
  window.yieldTrendChart = new Chart(ctx, { data: { datasets: [] } });
}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("collides with HTML id #yieldTrendChart");
	});

	it("accepts a Chart destroy guarded against browser named properties", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="yieldTrendChart" height="300"></canvas><script>
function renderChart() {
  const ctx = document.getElementById('yieldTrendChart').getContext('2d');
  if (window.yieldTrendChart instanceof Chart) window.yieldTrendChart.destroy();
  window.yieldTrendChart = new Chart(ctx, { data: { datasets: [] } });
}
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid, result.errors.join("\n")).toBe(true);
	});

	it("authorizes nested native paths after stripping URL query and hash", () => {
		const root = writeProject({
			"index.html":
				'<!doctype html><html><body><h1>Ready</h1><script src="./js/nested/app.js?v=1#boot"></script></body></html>',
			"js/nested/app.js": "document.querySelector('h1').textContent = 'Ready';",
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.checkedFiles).toContain("js/nested/app.js");
	});

	it("fails closed when an explicit index escapes the serve root", () => {
		const parent = tempServeRoot();
		const root = join(parent, "site");
		mkdirSync(root);
		writeFileSync(join(parent, "outside.html"), "<h1>outside</h1>", "utf8");

		const result = assessStaticPreviewQuality({ serveRoot: root, indexFile: "../outside.html" });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("index.html");
	});

	it("rejects a missing unquoted local script", () => {
		const root = writeProject({
			"index.html": "<!doctype html><html><body><h1>Ready</h1><script src=missing.js></script></body></html>",
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("missing.js");
	});

	it.each(["https://cdn.example/app.js", "data:text/javascript,document.body.dataset.ready='yes'"])(
		"does not classify an unquoted external or data script as local: %s",
		(src) => {
			const root = writeProject({
				"index.html": `<!doctype html><html><body><h1>Ready</h1><script src=${src}></script></body></html>`,
			});

			const result = assessStaticPreviewQuality({ serveRoot: root });

			expect(result.valid).toBe(true);
			expect(result.checkedFiles).toEqual(["index.html"]);
		},
	);

	it("authorizes an unquoted local script after stripping query and hash", () => {
		const root = writeProject({
			"index.html":
				"<!doctype html><html><body><h1>Ready</h1><script src=js/app.js?v=1#boot></script></body></html>",
			"js/app.js": "document.querySelector('h1').textContent = 'Ready';",
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(true);
		expect(result.checkedFiles).toContain("js/app.js");
	});

	it("rejects an unquoted local script that escapes the serve root", () => {
		const parent = tempServeRoot();
		const root = join(parent, "site");
		mkdirSync(root);
		writeFileSync(join(root, "index.html"), "<h1>Ready</h1><script src=../outside.js></script>", "utf8");
		writeFileSync(join(parent, "outside.js"), "document.body.textContent = 'outside';", "utf8");

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("../outside.js");
	});
});
