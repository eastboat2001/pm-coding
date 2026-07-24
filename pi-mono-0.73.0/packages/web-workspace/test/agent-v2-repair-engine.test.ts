import { describe, expect, it } from "vitest";
import { planAgentV2RepairActions } from "../src/agent-v2-repair-engine.js";
import type { AgentV2ValidationFailure } from "../src/agent-v2-validation-gate.js";
import { classifyAgentV2ValidationPolicy } from "../src/agent-v2-validation-policy.js";

describe("agent v2 repair engine", () => {
	it("plans task-scoped repair actions for repairable static failures", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", path: "index.html", source: "static_smoke" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.script_error:index.html",
				taskId: "validate",
				type: "file_patch",
				retryable: true,
				reason: "Client script errors must be fixed before delivery. Runtime evidence: static.script_error",
				targetPath: "index.html",
				validationCode: "static.script_error",
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("regenerates a coherent application when the selected packaging lacks its build manifest", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.build_manifest_missing",
					path: "package.json",
					source: "static_validate",
				}),
			],
			attempt: 1,
			maxAttempts: 5,
		});

		expect(action).toMatchObject({
			type: "regenerate_app",
			targetPath: "package.json",
			retryable: true,
			validationCode: "static.build_manifest_missing",
		});
	});

	it("regenerates instead of patching build dependencies that violate a locked static delivery mode", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "build.policy_rejected", source: "static_validate" })],
			attempt: 1,
			maxAttempts: 5,
			deliveryMode: "static_simulation",
		});

		expect(action).toMatchObject({
			type: "regenerate_app",
			retryable: true,
			validationCode: "build.policy_rejected",
		});
	});

	it("keeps a missing lockfile as a local repair for a build-static frontend", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "build.policy_rejected", source: "static_validate" })],
			attempt: 1,
			maxAttempts: 5,
			deliveryMode: "build_static_frontend",
		});

		expect(action).toMatchObject({ type: "file_patch", validationCode: "build.policy_rejected" });
	});

	it("blocks when max repair attempts are exhausted", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", source: "static_smoke" })],
			attempt: 3,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			expect.objectContaining({
				type: "block_task",
				retryable: false,
				validationCode: "repair.max_attempts_exceeded",
			}),
		]);
	});

	it("reruns validation only for a transient failure with no target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "build.timeout", path: undefined, source: "static_validate" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:build.timeout:run",
				taskId: "validate",
				type: "rerun_validation",
				retryable: true,
				reason: "build.timeout",
				targetPath: undefined,
				validationCode: "build.timeout",
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("uses full application regeneration for pathless structural failures that require new files", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.workspace_empty", path: undefined, source: "static_validate" })],
			attempt: 1,
			maxAttempts: 5,
		});

		expect(action).toMatchObject({ type: "regenerate_app", targetPath: undefined, retryable: true });
	});

	it("provides a focused repair instruction for unbounded responsive charts", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.canvas_layout_unbounded", path: "index.html", source: "static_quality" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			reason: expect.stringMatching(/construct the observer, call observe\(viewport\).*1440→1280→1440/u),
		});
	});

	it("routes responsive SVG coordinate mismatch evidence into bounded file repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.svg_coordinate_space_mismatch",
					path: "index.html",
					data: { selector: "#deptChart", sourceEvidence: "index.html:160" },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "index.html",
			validationCode: "static.svg_coordinate_space_mismatch",
		});
	});

	it("routes a native Canvas CSS/bitmap mismatch into bounded file repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.canvas_css_bitmap_mismatch",
					path: "index.html",
					data: { canvasIds: ["yieldTrend"] },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "index.html",
			validationCode: "static.canvas_css_bitmap_mismatch",
		});
	});

	it("repairs explicit determinism violations without deleting gameplay or other requested behavior", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.nondeterministic_data",
					path: "index.html",
					blocking: true,
					data: {
						highConfidence: true,
						requirementKind: "explicit_determinism",
						sourceEvidence: "index.html:42 Math.random()",
					},
				}),
			],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.nondeterministic_data",
			reason: expect.stringMatching(/seeded deterministic PRNG.*Preserve the requested gameplay/u),
		});
	});

	it("repairs dashboard intrinsic-width overflow without masking or deleting content", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.page_horizontal_overflow", path: "index.html" })],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "index.html",
			validationCode: "static.page_horizontal_overflow",
			reason:
				"Repair desktop horizontal overflow without hiding document overflow or shrinking content to unreadable sizes: use minmax(0, 1fr) for flexible Grid tracks and min-width:0 on affected direct Grid/Flex items; keep wide tables inside a local overflow-x:auto wrapper; for Canvas, measure the dedicated viewport once before changing bitmap dimensions and keep CSS size at 100% instead of feeding a DPR-expanded or remeasured intrinsic width back into the Grid; when pagination can exceed the desktop page width, make it wrap or render a compact bounded page window with previous/next and ellipses. Preserve readable chart, KPI, filter, pagination, and table dimensions at 1440x900.",
		});
	});

	it("repairs a highlight-only chart drill-down by wiring downstream data selection", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.blueprint_chart_drilldown_incomplete",
					path: "index.html",
					source: "static_quality",
					data: { missingTargets: ["detail table"], highConfidence: true },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.blueprint_chart_drilldown_incomplete",
			reason: expect.stringMatching(/every target explicitly documented.*Specifically repair: detail table\./),
		});
	});

	it("routes an inconsistent default Apply result into one-file repair with concrete schema guidance", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.default_filter_inconsistent",
					path: "main.js",
					source: "static_smoke",
					data: { highConfidence: true, field: "DateType" },
				}),
			],
			attempt: 1,
			maxAttempts: 2,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "main.js",
			validationCode: "static.default_filter_inconsistent",
			reason: expect.stringContaining("DateType"),
		});
	});

	it("routes a provably unused filter value into one-file synchronized-render repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.filter_value_unused",
					path: "index.html",
					data: { selector: "#filter-date-type", variable: "dateType" },
				}),
			],
			attempt: 1,
			maxAttempts: 2,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.filter_value_unused",
			reason: expect.stringContaining("shared data derivation"),
		});
	});

	it("repairs a hyphenated filter id with an explicit render-state mapping", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.filter_state_key_mismatch", path: "app.js" })],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "app.js",
			validationCode: "static.filter_state_key_mismatch",
			reason: expect.stringContaining("explicit map from each disclosed control id"),
		});
	});

	it("repairs an inert filter with an option-specific observable-data check", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.control_no_effect",
					path: "index.html",
					source: "static_smoke",
					blocking: true,
					data: { selector: "#filterPlant" },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.control_no_effect",
			reason: expect.stringContaining("next enabled option"),
		});
		expect(action?.reason).toContain("separate lookup branches containing identical values");
		expect(action?.reason).toContain("without replacing the working dashboard");
		expect(action?.reason).toContain("Test every existing filter");
		expect(action?.reason).toContain("before reading rows[0]");
	});

	it("repairs a source-backed one-option dropdown without inventing an unrelated control", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.blueprint_filter_option_missing",
					path: "index.html",
					source: "static_quality",
					blocking: true,
					data: { requiredFilters: ["Date Type"] },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.blueprint_filter_option_missing",
			reason: expect.stringContaining("meaningful enabled alternative"),
		});
		expect(action?.reason).toContain("deterministic representative fixture data");
	});

	it("routes a partial global dashboard update into bounded synchronized repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.filter_partial_update",
					path: "index.html",
					source: "static_smoke",
					blocking: true,
					data: {
						selector: "#filter-customer",
						unchangedSurfaces: "result #detail-table/#detail-tbody",
					},
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.filter_partial_update",
			retryable: true,
			reason: expect.stringContaining("one coherent data derivation"),
		});
		expect(action?.reason).toContain("Do not update one view while reusing unchanged defaults");
		expect(action?.reason).toContain("do not silently fall back to the default dataset");
	});

	it("repairs invalid aggregation output with bounded index and rendered-value guidance", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.invalid_rendered_data",
					path: "index.html",
					source: "static_smoke",
					blocking: true,
					data: { selector: "#detailWeekLabel", token: "undefined" },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.invalid_rendered_data",
			retryable: true,
		});
		expect(action?.reason).toContain("clamp the final bucket");
		expect(action?.reason).toContain("last row actually included");
		expect(action?.reason).toContain("Do not hide");
	});

	it("repairs a stale-chart empty state as one synchronized render transaction", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.filter_empty_state_inconsistent",
					path: "index.html",
					source: "static_smoke",
					blocking: true,
					data: { selector: "#detail-body", chartSelectors: ["#yield-chart", "#defect-chart"] },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			validationCode: "static.filter_empty_state_inconsistent",
			retryable: true,
		});
		expect(action?.reason).toContain("clear every affected KPI");
		expect(action?.reason).toContain("same render transaction");
		expect(action?.reason).toContain("chart-level empty state");
		expect(action?.reason).toContain("instead of hiding overflow or deleting the charts");
	});

	it("routes source-backed chart omissions into bounded evidence-specific repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.blueprint_chart_missing",
					path: "index.html",
					data: { requiredCharts: ["Defect Loss Ratio"] },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "index.html",
			validationCode: "static.blueprint_chart_missing",
			reason: expect.stringContaining("explicitly named chart"),
		});
	});

	it("routes an explicit detail-table omission into bounded accessible table repair", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.blueprint_table_missing",
					path: "index.html",
					data: { requiredTables: ["Finished Overall Trend detail table"] },
				}),
			],
			attempt: 1,
			maxAttempts: 6,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			targetPath: "index.html",
			validationCode: "static.blueprint_table_missing",
			reason: expect.stringContaining("real accessible table"),
		});
		expect(action?.reason).toContain("synchronized filters and chart drill-down selection");
		expect(action?.reason).toContain("local overflow-x:auto wrapper");
	});

	it("blocks non-retryable failures and normalizes the public target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({
					code: "static.preview_build_required",
					retryable: false,
					path: ".//dist\\\\//index.html",
					source: "static_validate",
				}),
			],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.preview_build_required:block",
				taskId: "validate",
				type: "block_task",
				retryable: false,
				reason: "static.preview_build_required",
				targetPath: "dist/index.html",
				validationCode: "static.preview_build_required",
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("normalizes retryable target paths before deriving action identity", () => {
		const [normalized] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", path: "./src\\\\//main.ts", source: "static_smoke" })],
			attempt: 1,
			maxAttempts: 3,
		});
		const [canonical] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", path: "src/main.ts", source: "static_smoke" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(normalized).toEqual(canonical);
		expect(normalized).toMatchObject({
			actionId: "repair:validate:static.script_error:src/main.ts",
			targetPath: "src/main.ts",
		});
	});

	it("ignores non-blocking findings and deduplicates identical blocking fingerprints", () => {
		const blocking = failure({ code: "static.script_error", path: "index.html", source: "static_smoke" });
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [blocking, blocking, failure({ code: "static.selector_missing", blocking: false })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ validationFingerprint: blocking.fingerprint, retryable: true });
	});

	it("blocks a repeated identical finding when its fingerprint budget is exhausted", () => {
		const repeated = failure({ code: "static.script_error", path: "index.html", source: "static_smoke" });
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [repeated],
			attempt: 2,
			maxAttempts: 3,
			previousFingerprintAttempts: { [repeated.fingerprint]: 3 },
		});

		expect(actions).toEqual([
			expect.objectContaining({
				type: "block_task",
				retryable: false,
				validationFingerprint: repeated.fingerprint,
				reason: expect.stringContaining("Repair budget exhausted"),
			}),
		]);
	});

	it("allows a newly introduced fingerprint to use its local repair budget on a later validation attempt", () => {
		const introducedAfterRegeneration = failure({
			code: "static.canvas_layout_unbounded",
			path: "index.html",
			data: { canvasIds: ["replacementTrend"] },
		});
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [introducedAfterRegeneration],
			attempt: 4,
			maxAttempts: 6,
			previousFingerprintAttempts: {},
		});

		expect(action).toMatchObject({
			type: "file_patch",
			retryable: true,
			validationFingerprint: introducedAfterRegeneration.fingerprint,
		});
	});
});

function failure(input: Partial<AgentV2ValidationFailure> & { code: string }): AgentV2ValidationFailure {
	const source = input.source ?? "static_quality";
	const retryable = input.retryable ?? true;
	const policy = classifyAgentV2ValidationPolicy({
		code: input.code,
		source,
		retryable,
		path: input.path,
		data: input.data,
		blocking: input.blocking,
	});
	return {
		code: input.code,
		message: input.message ?? input.code,
		retryable,
		taskId: input.taskId ?? "validate",
		path: input.path,
		data: input.data ?? {},
		source,
		...policy,
	};
}
