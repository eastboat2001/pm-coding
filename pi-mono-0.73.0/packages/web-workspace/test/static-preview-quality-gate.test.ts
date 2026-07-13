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
