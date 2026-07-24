import { describe, expect, it } from "vitest";
import { classifyAgentV2ValidationPolicy } from "../src/agent-v2-validation-policy.js";

describe("agent v2 validation policy", () => {
	it("creates stable fingerprints from rule evidence rather than presentation text", () => {
		const first = classifyAgentV2ValidationPolicy({
			code: "static.loading_visible",
			source: "static_quality",
			retryable: true,
			path: ".\\index.html",
			data: { selector: "#loading", sourceMessage: "first wording" },
		});
		const second = classifyAgentV2ValidationPolicy({
			code: "static.loading_visible",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { selector: "#loading", sourceMessage: "changed wording and timestamp 2026-07-17" },
		});

		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first).toMatchObject({
			severity: "warning",
			confidence: 0.55,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("uses a tighter repair budget for deterministic chart layout findings", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.canvas_layout_unbounded",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { canvasIds: ["sales", "trend"] },
		});

		expect(policy.evidence).toHaveLength(2);
		expect(policy.evidence).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "layout", path: "index.html" })]),
		);
		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.95,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("blocks only structured source-backed blueprint omissions with a bounded repair budget", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_chart_missing",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: {
				requiredCharts: ["Defect Loss Ratio"],
				sourceEvidence: "requirements.md:81 CH-02 | Defect Loss Ratio | Horizontal Bar",
			},
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.97,
			blocking: true,
			evidence: [expect.objectContaining({ kind: "policy", path: "index.html" })],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("blocks a source-backed missing detail table without generalizing database tables", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_table_missing",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: {
				requiredTables: ["Finished Overall Trend detail table"],
				sourceEvidence: "requirements.md:80 CH-01 | Finished Overall Trend | Click bar to filter detail table",
			},
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			evidence: [expect.objectContaining({ kind: "policy", path: "index.html" })],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("blocks a source-proven highlight-only implementation of a required cross-chart drill-down", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_chart_drilldown_incomplete",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: {
				interactiveCharts: ["Defect Loss Ratio"],
				sourceEvidence: "requirements.md:81 Click code to update department donut",
				highConfidence: true,
			},
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.97,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("keeps an unproven drill-down association advisory when generic interaction code exists", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_chart_drilldown_incomplete",
			source: "static_quality",
			retryable: true,
			path: "app.js",
			data: {
				interactiveCharts: ["Regional Sales Map"],
				missingTargets: ["risk matrix"],
				highConfidence: false,
			},
		});

		expect(policy).toMatchObject({
			severity: "warning",
			confidence: 0.72,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("uses the specific missing drill-down targets in the repair fingerprint", () => {
		const tableOnly = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_chart_drilldown_incomplete",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { interactiveCharts: ["Finished Overall Trend"], missingTargets: ["detail table"] },
		});
		const defectOnly = classifyAgentV2ValidationPolicy({
			code: "static.blueprint_chart_drilldown_incomplete",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { interactiveCharts: ["Finished Overall Trend"], missingTargets: ["defect analysis"] },
		});

		expect(tableOnly.fingerprint).not.toBe(defectOnly.fingerprint);
	});

	it("keeps unclassified static quality heuristics advisory by default", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.validation_failed",
			source: "static_quality",
			retryable: true,
			path: "index.html",
		});

		expect(policy).toMatchObject({
			severity: "warning",
			blocking: false,
			confidence: 0.55,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("blocks high-confidence responsive chart Canvas without any resize redraw path", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.canvas_resize_unhandled",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { canvasIds: ["trend"] },
		});

		expect(policy).toMatchObject({
			severity: "error",
			blocking: true,
			confidence: 0.96,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("blocks a source-backed intrinsic dashboard width overflow with a bounded repair budget", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.page_horizontal_overflow",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { selector: "section.detail-grid", sourceEvidence: "index.html:8 grid-template-columns" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			blocking: true,
			confidence: 0.97,
			evidence: [expect.objectContaining({ kind: "layout", path: "index.html" })],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("projects source-backed DPR mismatch evidence for every affected canvas", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.canvas_css_bitmap_mismatch",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: {
				canvasIds: ["yieldTrend", "scrapTrend"],
				sourceEvidence: "index.html:42 canvas.width = width * 2",
			},
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
		expect(policy.evidence).toEqual([
			expect.objectContaining({ selector: "#scrapTrend", summary: expect.stringContaining("canvas.width") }),
			expect.objectContaining({ selector: "#yieldTrend", summary: expect.stringContaining("canvas.width") }),
		]);
	});

	it("blocks a source-backed responsive SVG coordinate mismatch with a bounded layout budget", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.svg_coordinate_space_mismatch",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { selector: "#deptChart", sourceEvidence: "index.html:160 drawDonut(..., width, 360)" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			blocking: true,
			confidence: 0.99,
			evidence: [expect.objectContaining({ kind: "layout", path: "index.html", selector: "#deptChart" })],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("keeps deterministic structural failures authoritative and repairable", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.local_script_missing",
			source: "static_validate",
			retryable: true,
			path: "index.html",
			data: { script: "app.js" },
		});

		expect(policy).toMatchObject({ severity: "error", confidence: 0.99, blocking: true });
		expect(policy.repairBudget.maxAttempts).toBeGreaterThan(0);
	});

	it("allows a missing build manifest repair to create both manifest and lockfile", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.build_manifest_missing",
			source: "static_validate",
			retryable: true,
			path: "package.json",
			data: { sourceEntry: "src/main.tsx" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			evidence: [expect.objectContaining({ kind: "build", path: "package.json" })],
			repairBudget: { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("keeps synthetic no-effect observations advisory", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.control_no_effect",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: { selector: "#dateType" },
		});

		expect(policy).toMatchObject({
			severity: "warning",
			confidence: 0.75,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("blocks only an explicitly high-confidence deterministic no-effect observation", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.control_no_effect",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: { selector: "#unitType", highConfidence: true },
			blocking: true,
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.97,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});

	it("keeps a synthetic default-Apply inconsistency advisory without source evidence", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.default_filter_inconsistent",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: { selector: "button, [type=submit]" },
		});

		expect(policy).toMatchObject({
			severity: "warning",
			confidence: 0.95,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("blocks a source-proven deterministic default-Apply inconsistency", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.default_filter_inconsistent",
			source: "static_smoke",
			retryable: true,
			path: "main.js",
			data: { selector: "button, [type=submit]", highConfidence: true, field: "DateType" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.95,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});

	it("keeps synthetic loading and metric placeholder observations advisory", () => {
		for (const code of ["static.loading_visible", "static.metric_placeholder"]) {
			const policy = classifyAgentV2ValidationPolicy({
				code,
				source: "static_smoke",
				retryable: true,
				path: "index.html",
			});
			expect(policy).toMatchObject({ severity: "warning", blocking: false });
		}
	});

	it("blocks invalid rendered dashboard data only with specific runtime evidence", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.invalid_rendered_data",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: {
				selector: "#detailWeekLabel",
				token: "undefined",
				highConfidence: true,
				sourceEvidence: "Rendered evidence: Week 202620-undefined",
			},
			blocking: true,
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			evidence: [
				expect.objectContaining({
					kind: "runtime",
					path: "index.html",
					selector: "#detailWeekLabel",
					summary: "Rendered evidence: Week 202620-undefined",
				}),
			],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});

	it("blocks only an explicit empty-state and stale-chart runtime contradiction", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.filter_empty_state_inconsistent",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: {
				selector: "#detail-body",
				chartSelectors: ["#yield-chart", "#defect-chart"],
				highConfidence: true,
				sourceEvidence:
					"Empty result #detail-body; non-empty charts #yield-chart, #defect-chart after select #customer changed.",
			},
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			evidence: [
				expect.objectContaining({
					kind: "runtime",
					path: "index.html",
					selector: "#detail-body",
				}),
			],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});

	it("blocks a provably unused filter value with a narrow repair budget", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.filter_value_unused",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { selector: "#filter-date-type", variable: "dateType" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.98,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});

	it("blocks a proven hyphenated filter state-key mismatch with one-file repair", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.filter_state_key_mismatch",
			source: "static_quality",
			retryable: true,
			path: "app.js",
			data: { selector: "#date-type-filter", sourceEvidence: "app.js:232 id.split('-')[0]" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			blocking: true,
			confidence: 0.99,
			evidence: [expect.objectContaining({ path: "app.js", selector: "#date-type-filter" })],
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 },
		});
	});
});
