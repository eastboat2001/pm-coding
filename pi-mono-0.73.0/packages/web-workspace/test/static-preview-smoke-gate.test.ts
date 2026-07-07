import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
});
