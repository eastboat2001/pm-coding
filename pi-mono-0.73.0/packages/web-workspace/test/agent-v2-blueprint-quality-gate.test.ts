import { describe, expect, it } from "vitest";
import { inspectAgentV2BlueprintQuality } from "../src/agent-v2-blueprint-quality-gate.js";
import type { AgentV2ProductBlueprint, AgentV2ProductBlueprintItem } from "../src/agent-v2-types.js";

describe("agent v2 source-backed blueprint quality gate", () => {
	it("finds missing chart inventory, universal defaults, and chart drill-down with source evidence", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
				item("filter-1", "Customer | Dropdown | All selected | All charts", 42),
				item("filter-2", "Project Type | Dropdown | Overall | All charts", 43),
			]),
			sources: [
				{
					path: "index.html",
					content: `
						<label>Customer <select><option disabled selected>Select customer</option><option>CustomerA</option><option>CustomerB</option></select></label>
						<section><h2>Finished Yield Trend</h2><svg id="trendChart"></svg></section>
						<button id="apply">Apply</button>
						<script>apply.addEventListener('click', renderDashboard);</script>
					`,
				},
			],
		});

		expect(result.map((issue) => issue.code)).toEqual([
			"static.blueprint_chart_missing",
			"static.blueprint_table_missing",
			"static.blueprint_default_missing",
			"static.blueprint_filter_missing",
			"static.blueprint_chart_interaction_missing",
		]);
		expect(result[0]?.data).toMatchObject({
			requiredCharts: ["Defect Loss Ratio"],
			blueprintItemIds: ["chart-2"],
			sourceEvidence:
				"requirements.md:81 CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut",
		});
	});

	it("accepts named responsive SVG charts, an explicit All default, and mark interaction", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
				item("filter-1", "Customer | Dropdown | All selected | All charts", 42),
				item("filter-2", "Project Type | Dropdown | Overall | All charts", 43),
			]),
			sources: [
				{
					path: "index.html",
					content: `
						<label>Customer <select id="customer"><option value="all" selected>All</option><option>CustomerA</option></select></label>
						<label>Project Type <select id="projectType"><option selected>Overall</option><option>Project A</option></select></label>
						<h2>Finished Overall Trend</h2><svg id="finishedChart"></svg>
						<h2>Defect Loss Ratio</h2><svg id="defectChart"></svg>
						<table id="detail-table"><tbody><tr><td>Week 12</td></tr></tbody></table>
						<script>
							const defectBar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
							defectBar.addEventListener('click', updateDepartmentDonut);
						</script>
					`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("rejects one unimplemented empty chart mount when sibling chart mounts are rendered", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("donut", "**Donut Chart:** Department attribution for the selected defect code", 55),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Trend</h2><div id="chart-trend"></div>
<h2>Donut Chart</h2><div id="chart-donut"></div><script>
const trend=document.getElementById('chart-trend');trend.appendChild(document.createElementNS('http://www.w3.org/2000/svg','svg'));
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_missing",
				data: expect.objectContaining({ requiredCharts: ["Donut Chart"] }),
			}),
		]);
	});

	it("requires interaction on each semantic chart renderer instead of borrowing a sibling click", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><div id="chart-trend"></div>
<h2>Defect Loss Ratio</h2><div id="chart-pareto"></div><table><tbody></tbody></table><script>
function renderTrend(){const container=document.getElementById('chart-trend');const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.addEventListener('click',selectWeek);container.appendChild(rect);}
function renderPareto(){const container=document.getElementById('chart-pareto');const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');container.appendChild(rect);}
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_interaction_missing",
				data: expect.objectContaining({ interactiveCharts: ["Defect Loss Ratio"] }),
			}),
		]);
	});

	it("rejects a concrete source-backed dropdown with only its default option", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([item("filter-date", "Date Type | Dropdown | Weekly | All charts", 71)]),
			sources: [
				{
					path: "index.html",
					content: `<label for="date-type-filter">Date Type</label>
<select id="date-type-filter" onchange="applyFilters()"><option selected>Weekly</option></select>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_filter_option_missing",
				data: expect.objectContaining({ requiredFilters: ["Date Type"] }),
			}),
		]);
	});

	it("fails open for a source-backed select whose alternatives are populated dynamically", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([item("filter-date", "Date Type | Dropdown | Weekly | All charts", 71)]),
			sources: [
				{
					path: "index.html",
					content: `<label for="date-type-filter">Date Type</label><select id="date-type-filter"><option>Weekly</option></select>
<script>const monthlyOption = document.createElement('option'); monthlyOption.value = 'Monthly'; document.getElementById('date-type-filter').add(monthlyOption);</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("rejects an explicit all-charts filter path that forwards filtered rows to only one chart", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("filter-customer", "Customer | Dropdown | All selected | All charts", 69),
				item("filter-date", "Date Type | Dropdown | Weekly | All charts", 70),
			]),
			sources: [
				{
					path: "app.js",
					content: `<label>Customer<select><option>All selected</option><option>A</option></select></label>
<label>Date Type<select><option>Weekly</option><option>Monthly</option></select></label>
function getFilteredData(){ return rows.filter(row => row.customer === state.filters.customer); }
function renderTrendChart(data){ drawTrend(data); }
function renderParetoChart(){ drawPareto(defectData); }
function renderDepartmentDonut(){ drawDonut(departmentData); }
function renderAll(){ const data = getFilteredData(); renderTrendChart(data); renderParetoChart(); renderDepartmentDonut(); }`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_filter_scope_incomplete",
				path: "app.js",
				data: expect.objectContaining({
					requiredFilters: ["Customer", "Date Type"],
					unfilteredCharts: ["renderDepartmentDonut", "renderParetoChart"],
				}),
			}),
		]);
	});

	it("accepts explicit all-charts filters when every chart receives filtered rows or derives them itself", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([item("filter-customer", "Customer | Dropdown | All selected | All charts", 69)]),
			sources: [
				{
					path: "app.js",
					content: `<label>Customer<select><option>All selected</option><option>A</option></select></label>
function getFilteredData(){ return rows.filter(row => row.customer === state.filters.customer); }
function renderTrendChart(data){ drawTrend(data); }
function renderParetoChart(data){ drawPareto(data); }
function renderDepartmentDonut(){ drawDonut(getFilteredData()); }
function renderAll(){ const data = getFilteredData(); renderTrendChart(data); renderParetoChart(data); renderDepartmentDonut(); }`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("associates dense adjacent filter labels only with their own select", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("filter-customer", "Customer | Dropdown | All selected | All charts", 70),
				item("filter-plant", "Plant | Dropdown | All selected | All charts", 71),
				item("filter-date", "Date Type | Dropdown | Weekly | All charts", 72),
				item("filter-lot", "Lot Type | Dropdown | HVM | All charts", 73),
				item("filter-unit", "Unit Type | Dropdown | NSQM | All charts", 74),
				item("filter-project", "Project Type | Dropdown | Overall | All charts", 75),
			]),
			sources: [
				{
					path: "index.html",
					content: `<div><label>Customer</label><select id="customer-filter"><option>All selected</option><option>Customer A</option></select></div>
<div><label>Plant</label><select id="plant-filter"><option>All selected</option><option>Plant 1</option></select></div>
<div><label>Date Type</label><select id="date-type-filter"><option>Weekly</option></select></div>
<div><label>Lot Type</label><select id="lot-type-filter"><option>HVM</option><option>NVM</option></select></div>
<div><label>Unit Type</label><select id="unit-type-filter"><option>NSQM</option><option>SQM</option></select></div>
<div><label>Project Type</label><select id="project-type-filter"><option>Overall</option></select></div>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_filter_option_missing",
				data: expect.objectContaining({ requiredFilters: ["Date Type", "Project Type"] }),
			}),
		]);
	});

	it("accepts click interaction on a dynamically created SVG mark with a generic variable name", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><svg id="defect-chart"></svg><script>
const totalRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
totalRect.addEventListener('click', function () {
  selectedDefect = this.dataset.code;
  renderDefectChart();
  renderDepartmentDonut();
});
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("accepts chart-mark clicks created through a proven SVG element factory", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><div id="trend-chart"></div><table><tbody></tbody></table><script>
const state = { selectedWeek: null };
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}
function renderTrendChart(data) {
  const rect = svgEl('rect', { 'data-week': data.week, cursor: 'pointer' });
  rect.addEventListener('click', () => { state.selectedWeek = data.week; renderDetailTable(); });
  document.getElementById('trend-chart').appendChild(rect);
}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("does not trust an SVG element factory when the created chart mark is inert", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><div id="trend-chart"></div><table><tbody></tbody></table><script>
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs || {}).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}
function renderTrendChart(data) {
  const rect = svgEl('rect', { 'data-week': data.week });
  document.getElementById('trend-chart').appendChild(rect);
}
</script>`,
				},
			],
		});

		expect(result).toEqual([expect.objectContaining({ code: "static.blueprint_chart_interaction_missing" })]);
	});

	it("accepts semantic inline handlers on div-based chart marks without trusting generic buttons", () => {
		const required = blueprint([
			item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
		]);
		const shared = `<h2>Finished Overall Trend</h2><div id="trend-chart-container"></div><table><tbody></tbody></table>`;

		expect(
			inspectAgentV2BlueprintQuality({
				blueprint: required,
				sources: [
					{
						path: "index.html",
						content: `${shared}<script>
function renderTrend(data) {
  return data.map(d => \`<div class="bar" style="cursor:pointer" onclick="selectWeek('\${d.week}')"></div>\`).join('');
}
function selectWeek(week) { state.selectedWeek = week; renderDetailTable(); }
</script>`,
					},
				],
			}),
		).toEqual([]);

		expect(
			inspectAgentV2BlueprintQuality({
				blueprint: required,
				sources: [
					{
						path: "index.html",
						content: `${shared}<button onclick="applyFilters()">Apply</button>`,
					},
				],
			}),
		).toEqual([expect.objectContaining({ code: "static.blueprint_chart_interaction_missing" })]);
	});

	it("accepts a generic DOM alias when its selector identifies a chart and it binds a click", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><canvas id="chart-trend"></canvas><table><tbody></tbody></table><script>
function drawTrend() {
  const c = document.getElementById('chart-trend');
  c.onclick = (event) => selectWeek(event.clientX);
}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("accepts chart clicks registered through a proven addEventListener forwarding helper", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "app.js",
					content: `<h2>Finished Overall Trend</h2><canvas id="trendChart"></canvas><table><tbody></tbody></table>
<h2>Defect Loss Ratio</h2><canvas id="defectChart"></canvas><script>
function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
function renderTrend() {
  var canvas = document.getElementById('trendChart');
  on(canvas, "click", function (event) { selectWeek(event.clientX); renderTable(); });
}
function renderDefects() {
  on(document.getElementById('defectChart'), "click", function (event) {
    state.selectedDefect = hitTestDefect(event.clientY);
    renderDepartmentDonut(state.selectedDefect);
  });
}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("does not trust a helper-shaped call unless its implementation forwards to addEventListener", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><canvas id="trendChart"></canvas><table><tbody></tbody></table><script>
function on(el, ev, fn) { console.log(el, ev, fn); }
var canvas = document.getElementById('trendChart');
on(canvas, 'click', renderTable);
</script>`,
				},
			],
		});

		expect(result).toEqual([expect.objectContaining({ code: "static.blueprint_chart_interaction_missing" })]);
	});

	it("requires a concrete table only when a chart interaction explicitly targets a detail table", () => {
		const required = blueprint([
			item("chart-1", "CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table", 80),
		]);
		const sourceWithoutTable = `<h2>Finished Overall Trend</h2><canvas id="trendChart"></canvas><script>
document.getElementById('trendChart').addEventListener('click', selectWeek);
</script>`;

		expect(
			inspectAgentV2BlueprintQuality({
				blueprint: required,
				sources: [{ path: "index.html", content: sourceWithoutTable }],
			}),
		).toEqual([
			expect.objectContaining({
				code: "static.blueprint_table_missing",
				data: expect.objectContaining({
					requiredTables: ["Finished Overall Trend detail table"],
					blueprintItemIds: ["chart-1"],
				}),
			}),
		]);
		expect(
			inspectAgentV2BlueprintQuality({
				blueprint: required,
				sources: [
					{
						path: "index.html",
						content: `${sourceWithoutTable}<div class="table-scroll"><table><tbody id="details"></tbody></table></div>`,
					},
				],
			}),
		).toEqual([]);
	});

	it("rejects a cross-chart drill-down whose selection is only used to highlight the originating chart", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><canvas id="defectChart"></canvas><script>
const state = { selectedDefect: null };
function resetFilters(){ state.selectedDefect = null; }
function renderDefectChart(data){
  const canvas = document.getElementById('defectChart');
  if (data.code === state.selectedDefect) canvas.dataset.highlighted = 'true';
  canvas.onclick = function(){ state.selectedDefect = data.code; renderDashboard(); };
}
function renderDashboard(){ renderDefectChart({ code: 'ED25' }); renderDepartmentDonut(); }
function renderDepartmentDonut(){ document.body.dataset.department = 'all'; }
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				data: expect.objectContaining({ interactiveCharts: ["Defect Loss Ratio"] }),
			}),
		]);
	});

	it("rejects generated SVG handlers that route a selection through renderAll but do not use it in documented targets", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item(
					"chart-1",
					"CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table/defect analysis",
					80,
				),
				item(
					"chart-2",
					"CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update trend/department donut",
					81,
				),
			]),
			sources: [
				{
					path: "app.js",
					content: `<h2>Finished Overall Trend</h2><div id="trend-chart"></div>
<h2>Defect Loss Ratio</h2><div id="pareto-chart"></div><table><tbody></tbody></table><script>
const state={selectedWeek:null,selectedDefect:null};
function renderTrendChart(data){ return \`<rect onclick="selectWeek('202621')" class="\${state.selectedWeek?'selected':''}"></rect>\`; }
function renderParetoChart(){ return \`<rect onclick="selectDefect('ED25')" class="\${state.selectedDefect?'selected':''}"></rect>\`; }
function renderDepartmentDonut(){ drawDonut(departmentData); }
function renderTable(data){ drawRows(data); }
function updateKPIs(data,week){ drawKpis(data,week); }
function renderAll(){ const data=getFilteredData(); updateKPIs(data,state.selectedWeek); renderTrendChart(data); renderParetoChart(); renderDepartmentDonut(); renderTable(data); }
function selectWeek(week){state.selectedWeek=week;renderAll();}
function selectDefect(code){state.selectedDefect=code;renderParetoChart();}
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				path: "app.js",
				data: expect.objectContaining({ interactiveCharts: ["Defect Loss Ratio", "Finished Overall Trend"] }),
			}),
		]);
	});

	it("accepts a cross-chart drill-down when the selection participates in downstream data", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><canvas id="defectChart"></canvas><script>
const state = { selectedDefect: null };
function renderDefectChart(data){
  const canvas = document.getElementById('defectChart');
  if (data.code === state.selectedDefect) canvas.dataset.highlighted = 'true';
  canvas.onclick = function(){ state.selectedDefect = data.code; renderDashboard(); };
}
function renderDepartmentDonut(data){
  const departments = data.filter(row => row.defect === state.selectedDefect);
  document.body.dataset.departmentCount = departments.length;
}
function renderDashboard(){ renderDefectChart({ code: 'ED25' }); renderDepartmentDonut([]); }
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("reports only the documented downstream target that does not consume a trend selection", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item(
					"chart-1",
					"CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table/defect analysis",
					80,
				),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><svg id="trend-chart"></svg>
<h2>Defect Analysis Pareto</h2><svg id="pareto-chart"></svg><table><tbody id="detail-table-body"></tbody></table><script>
const state={selectedWeek:'202621'};
function renderTrendChart(data){const svg=document.getElementById('trend-chart');svg.onclick=()=>{state.selectedWeek='202620';renderAll()};highlight(state.selectedWeek)}
function renderParetoChart(data){const weekRow=data.find(row=>row.week===state.selectedWeek);drawPareto(weekRow.defects)}
function renderTable(data){data.forEach(row=>drawRow(row,row.week===state.selectedWeek?'selected':''))}
function renderAll(){const data=getFilteredData();renderTrendChart(data);renderParetoChart(data);renderTable(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				message: expect.stringContaining("detail table"),
				data: expect.objectContaining({
					interactiveCharts: ["Finished Overall Trend"],
					missingTargets: ["detail table"],
				}),
			}),
		]);
	});

	it("accepts Pareto and detail table consumers of the selected trend period", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item(
					"chart-1",
					"CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail table/defect analysis",
					80,
				),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Finished Overall Trend</h2><svg id="trend-chart"></svg>
<h2>Defect Analysis Pareto</h2><svg id="pareto-chart"></svg><table><tbody id="detail-table-body"></tbody></table><script>
const state={selectedWeek:'202621'};
function renderTrendChart(data){document.getElementById('trend-chart').onclick=()=>{state.selectedWeek='202620';renderAll()};highlight(state.selectedWeek)}
function renderParetoChart(data){const weekRow=data.find(row=>row.week===state.selectedWeek);drawPareto(weekRow.defects)}
function renderTable(data){const rows=data.filter(row=>row.week===state.selectedWeek);rows.forEach(drawRow)}
function renderAll(){const data=getFilteredData();renderTrendChart(data);renderParetoChart(data);renderTable(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("reports a missing trend update even when the department donut uses the selected defect", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item(
					"chart-2",
					"CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update trend/department donut",
					81,
				),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><svg id="defect-chart"></svg>
<h2>Finished Overall Trend</h2><svg id="trend-chart"></svg><h2>Department Donut</h2><svg id="donut-chart"></svg><script>
const state={selectedDefect:null};
function renderDefectChart(){document.getElementById('defect-chart').onclick=()=>{state.selectedDefect='ED25';renderAll()};highlight(state.selectedDefect)}
function renderTrendChart(data){drawTrend(data)}
function renderDepartmentDonut(data){const rows=data.filter(row=>row.defect===state.selectedDefect);drawDonut(rows)}
function renderAll(){const data=getFilteredData();renderDefectChart();renderTrendChart(data);renderDepartmentDonut(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				data: expect.objectContaining({ missingTargets: ["trend"] }),
			}),
		]);
	});

	it("derives arbitrary downstream target names from each PM blueprint instead of requiring dashboard-specific charts", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-9", "CH-09 | Regional Sales Map | Map | Click region to update order list/risk matrix", 91),
			]),
			sources: [
				{
					path: "regional-app.js",
					content: `<h2>Regional Sales Map</h2><svg id="regional-sales-map"></svg>
<section id="order-list"></section><section id="risk-matrix"></section><script>
const state={selectedRegion:null};
function renderRegionalSalesMap(){map.onclick=()=>{state.selectedRegion='north';renderAll()};highlight(state.selectedRegion)}
function renderOrderList(data){const orders=data.filter(row=>row.region===state.selectedRegion);drawOrders(orders)}
function renderRiskMatrix(data){drawRiskMatrix(data)}
function renderAll(){const data=getSales();renderRegionalSalesMap();renderOrderList(data);renderRiskMatrix(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_drilldown_incomplete",
				path: "regional-app.js",
				data: expect.objectContaining({ missingTargets: ["risk matrix"] }),
			}),
		]);
	});

	it("fails open when selected state feeds a shared data derivation with architecture-specific fan-out", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-9", "CH-09 | Regional Sales Map | Map | Click region to update order list/risk matrix", 91),
			]),
			sources: [
				{
					path: "regional-app.js",
					content: `<h2>Regional Sales Map</h2><svg id="regional-sales-map"></svg>
<section id="order-list"></section><section id="risk-matrix"></section><script>
const state={selectedRegion:null};
function renderRegionalSalesMap(){map.onclick=()=>{state.selectedRegion='north';renderAll()};highlight(state.selectedRegion)}
function getFilteredData(){return sourceRows.filter(row=>row.region===state.selectedRegion)}
function renderOrderList(rows){drawOrders(rows)}
function renderRiskMatrix(rows){drawRiskMatrix(rows)}
function renderAll(){const rows=getFilteredData();renderRegionalSalesMap();renderOrderList(rows);renderRiskMatrix(rows)}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("accepts a target that materializes selected state through a local alias", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-9", "CH-09 | Regional Sales Map | Map | Click region to update order list", 91),
			]),
			sources: [
				{
					path: "regional-app.js",
					content: `<h2>Regional Sales Map</h2><svg id="regional-sales-map"></svg><section id="order-list"></section><script>
const state={selectedRegion:null};
function renderRegionalSalesMap(){map.onclick=()=>{state.selectedRegion='north';renderAll()};highlight(state.selectedRegion)}
function renderOrderList(data){const region=state.selectedRegion;const rows=data.filter(row=>row.region===region);drawOrders(rows)}
function renderAll(){const data=getSales();renderRegionalSalesMap();renderOrderList(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("rejects a cross-chart drill-down whose downstream filter result is discarded", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><svg id="defect-chart"><rect onclick="selectDefect('ED25')"></rect></svg>
<h2>Department Donut Chart</h2><div id="donut"></div><script>
const state={selectedDefect:null};
function selectDefect(code){state.selectedDefect=code;renderDepartmentDonut()}
function renderDepartmentDonut(){const data=getRows();if(state.selectedDefect) data.filter(row=>row.defect===state.selectedDefect);drawDonut(data)}
</script>`,
				},
			],
		});

		expect(result).toEqual([expect.objectContaining({ code: "static.blueprint_chart_drilldown_incomplete" })]);
	});

	it("rejects a chart-instance selection that only redraws the originating Pareto chart", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><canvas id="defect-chart"></canvas><script>
class SimpleChart { constructor(){ this.selectedDefect = null; } drawDefectChart(){ if (this.selectedDefect) highlight(); } draw(){} }
const defectChart = new SimpleChart();
const defectCanvas = document.getElementById('defect-chart');
defectCanvas.addEventListener('click', (event) => {
  const index = event.clientY > 0 ? 1 : 0;
  defectChart.selectedDefect = index;
  defectChart.draw();
});
</script>`,
				},
			],
		});

		expect(result).toEqual([expect.objectContaining({ code: "static.blueprint_chart_drilldown_incomplete" })]);
	});

	it("fails open when a chart-instance selection delegates to a downstream synchronization function", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update department donut", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><canvas id="defect-chart"></canvas><script>
const defectChart = { selectedDefect: null, draw(){} };
document.getElementById('defect-chart').addEventListener('click', () => {
  defectChart.selectedDefect = 1;
  defectChart.draw();
  synchronizeDepartmentAndTable(defectChart.selectedDefect);
});
function synchronizeDepartmentAndTable(selection){ renderDepartmentDonut(selection); renderTable(selection); }
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("does not require cross-surface data changes for an explicitly local selection highlight", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("chart-2", "CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to highlight selected bar", 81),
			]),
			sources: [
				{
					path: "index.html",
					content: `<h2>Defect Loss Ratio</h2><canvas id="defectChart"></canvas><script>
const state = { selectedDefect: null };
function renderDefectChart(data){
  const canvas = document.getElementById('defectChart');
  if (data.code === state.selectedDefect) canvas.dataset.highlighted = 'true';
  canvas.onclick = function(){ state.selectedDefect = data.code; renderDefectChart(data); };
}
</script>`,
				},
			],
		});

		expect(result).toEqual([]);
	});

	it("treats an explicitly named distinctive subchart as a required surface", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("donut", "**Donut Chart:** Department attribution for the selected defect code", 55),
			]),
			sources: [{ path: "index.html", content: "<h2>Defect detail</h2><p>Department: DEP-A</p>" }],
		});

		expect(result).toEqual([
			expect.objectContaining({
				code: "static.blueprint_chart_missing",
				data: expect.objectContaining({ requiredCharts: ["Donut Chart"] }),
			}),
		]);
	});

	it("does not promote ambiguous, deferred, or mixed detail rows into blockers", () => {
		const result = inspectAgentV2BlueprintQuality({
			blueprint: blueprint([
				item("prose", "The dashboard should look professional and useful", 10),
				item("future", "CH-08 | Future Forecast | Line | Optional future enhancement", 11),
				item("detail", "CH-03 | Detail Panel | Table/Line/Pie | Supports pagination", 12),
			]),
			sources: [{ path: "index.html", content: "<main>Current application</main>" }],
		});

		expect(result).toEqual([]);
	});

	it("fails open when there is no source-backed blueprint or inspectable project source", () => {
		expect(
			inspectAgentV2BlueprintQuality({
				blueprint: { ...blueprint([]), sourceDocuments: [] },
				sources: [{ path: "index.html", content: "<main />" }],
			}),
		).toEqual([]);
		expect(inspectAgentV2BlueprintQuality({ blueprint: blueprint([]), sources: [] })).toEqual([]);
	});
});

function item(id: string, text: string, line: number): AgentV2ProductBlueprintItem {
	return {
		id,
		text,
		sourceInputId: "prd",
		sourcePath: "requirements.md",
		sourceChecksum: "sha256:prd",
		line,
		categories: ["requirement", "visual"],
	};
}

function blueprint(items: AgentV2ProductBlueprintItem[]): AgentV2ProductBlueprint {
	return {
		kind: "product_blueprint",
		version: 1,
		title: "Dashboard blueprint",
		summary: "Dashboard",
		responseLanguage: "en",
		sourceDocuments: [{ inputId: "prd", path: "requirements.md", checksum: "sha256:prd", lineCount: 100 }],
		items,
		categoryItemIds: {
			requirement: items.map((entry) => entry.id),
			page: [],
			interaction: [],
			state: [],
			permission: [],
			visual: items.map((entry) => entry.id),
			acceptance: [],
		},
	};
}
