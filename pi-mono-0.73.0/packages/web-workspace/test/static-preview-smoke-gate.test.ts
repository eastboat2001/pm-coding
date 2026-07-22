import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runStaticPreviewSmokeGate } from "../src/static-preview-smoke-gate.js";

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
		expect(result.errors.join("\n")).toContain("chartLoading");
		expect(result.errors.join("\n")).toContain("kpiYieldValue");
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
  ctx.arc(10, 10, 5, 0, Math.PI * 2);
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

	it("rejects a select handler that redraws without changing observable data", async () => {
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

		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("select #plant changed value but did not change rendered metrics");
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
});
