import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessStaticPreviewQuality } from "../src/static-preview-quality-gate.js";

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

	it("rejects random values used as rendered chart data", () => {
		const root = writeProject({
			"index.html": `<!doctype html><html><body><canvas id="trend"></canvas><script>
new Chart(document.getElementById('trend'), { data: { datasets: [{ data: [Math.random()] }] } });
</script></body></html>`,
		});

		const result = assessStaticPreviewQuality({ serveRoot: root });

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Rendered chart or application data uses Math.random(); interactive results must be deterministic.",
		);
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
