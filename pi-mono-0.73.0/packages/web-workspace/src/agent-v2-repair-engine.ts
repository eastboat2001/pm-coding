import type { AgentV2CapabilityDeliveryMode } from "./agent-v2-types.js";
import type { AgentV2ValidationFailure } from "./agent-v2-validation-gate.js";

export type AgentV2RepairActionType = "file_patch" | "regenerate_app" | "rerun_validation" | "block_task";

export interface AgentV2RepairAction {
	actionId: string;
	taskId: string;
	type: AgentV2RepairActionType;
	retryable: boolean;
	reason: string;
	targetPath?: string;
	validationCode: string;
	validationFingerprint: string;
}

export interface PlanAgentV2RepairActionsInput {
	taskId: string;
	failures: AgentV2ValidationFailure[];
	attempt: number;
	maxAttempts: number;
	previousFingerprintAttempts?: Readonly<Record<string, number>>;
	deliveryMode?: AgentV2CapabilityDeliveryMode;
}

export function planAgentV2RepairActions(input: PlanAgentV2RepairActionsInput): AgentV2RepairAction[] {
	if (input.attempt >= input.maxAttempts) {
		return [
			{
				actionId: `repair:${input.taskId}:max_attempts`,
				taskId: input.taskId,
				type: "block_task",
				retryable: false,
				reason: `Repair attempts exhausted (${input.attempt}/${input.maxAttempts}).`,
				validationCode: "repair.max_attempts_exceeded",
				validationFingerprint: "repair:max_attempts",
			},
		];
	}

	const uniqueFailures = [
		...new Map(
			input.failures.filter((failure) => failure.blocking).map((failure) => [failure.fingerprint, failure]),
		).values(),
	];
	return uniqueFailures.map((failure) =>
		repairActionForFailure(
			input.taskId,
			failure,
			input.previousFingerprintAttempts?.[failure.fingerprint] ?? 0,
			input.deliveryMode,
		),
	);
}

function repairActionForFailure(
	taskId: string,
	failure: AgentV2ValidationFailure,
	previousFingerprintAttempts: number,
	deliveryMode: AgentV2CapabilityDeliveryMode | undefined,
): AgentV2RepairAction {
	const targetPath = normalizeRepairTargetPath(failure.path);
	const fingerprintAttempts = previousFingerprintAttempts + 1;

	if (
		!failure.retryable ||
		fingerprintAttempts > failure.repairBudget.maxAttempts ||
		fingerprintAttempts > failure.repairBudget.maxSameFingerprintAttempts
	) {
		return {
			actionId: `repair:${taskId}:${failure.code}:block`,
			taskId,
			type: "block_task",
			retryable: false,
			reason: !failure.retryable
				? failure.message
				: `Repair budget exhausted for ${failure.code} (${fingerprintAttempts} identical findings).`,
			targetPath,
			validationCode: failure.code,
			validationFingerprint: failure.fingerprint,
		};
	}

	const type = requiresFullRegeneration(failure.code, deliveryMode)
		? "regenerate_app"
		: targetPath || !isTransientRevalidationFailure(failure.code)
			? "file_patch"
			: "rerun_validation";
	return {
		actionId: `repair:${taskId}:${failure.code}:${targetPath ?? "run"}`,
		taskId,
		type,
		retryable: true,
		reason: reasonForFailure(failure),
		targetPath,
		validationCode: failure.code,
		validationFingerprint: failure.fingerprint,
	};
}

function requiresFullRegeneration(code: string, deliveryMode: AgentV2CapabilityDeliveryMode | undefined): boolean {
	return (
		code === "static.workspace_empty" ||
		code === "static.preview_missing_entry" ||
		code === "static.build_manifest_missing" ||
		code === "build.output_missing" ||
		((deliveryMode === "static_app" || deliveryMode === "static_simulation") &&
			(code.startsWith("build.") || code === "static.build_manifest_missing"))
	);
}

function isTransientRevalidationFailure(code: string): boolean {
	return /(?:^|\.)(?:timeout|network|rate_limit|server_error|temporarily_unavailable|unavailable)$/u.test(code);
}

function reasonForFailure(failure: AgentV2ValidationFailure): string {
	if (failure.code === "static.loading_visible") {
		return "Visible loading state must be hidden or resolved before delivery.";
	}
	if (failure.code === "static.metric_placeholder") {
		return "Metric placeholders must be replaced with rendered values or an explicit empty state.";
	}
	if (failure.code === "static.script_error") {
		return `Client script errors must be fixed before delivery. Runtime evidence: ${failure.message}`;
	}
	if (
		failure.code === "static.canvas_css_bitmap_mismatch" ||
		failure.code === "static.canvas_layout_unbounded" ||
		failure.code === "static.canvas_resize_unhandled" ||
		failure.code === "static.svg_coordinate_space_mismatch"
	) {
		return "Repair the responsive chart without hiding overflow or deleting/compressing the visualization: add a dedicated chart viewport with an explicit height, max-height, or aspect-ratio (min-height alone is not bounded and may be stretched by flex/grid siblings); make chart Grid tracks shrink-safe with minmax(0, 1fr) and direct Grid/Flex items min-width:0; for SVG, use a viewBox matching the drawing coordinate system or measure both CSS width and height from the viewport so marks cannot be clipped or stretched; for Canvas, read the viewport rectangle once before changing canvas.width/canvas.height, keep CSS width/height at 100% (or set them from that one captured logical size), never re-read parent offsetWidth/clientWidth after changing the bitmap to derive inline CSS pixels, keep CSS and DPR-scaled bitmap dimensions separate, use devicePixelRatio with ctx.setTransform, and install one ResizeObserver after DOM initialization that observes every responsive chart viewport and schedules the synchronized render function through requestAnimationFrame. Do not return Canvas code containing only window resize, ctx.scale, or a ResizeObserver name in a comment: construct the observer, call observe(viewport), and verify 1440→1280→1440 desktop redraw. Keep Y-axis tick direction consistent with plotted data coordinates.";
	}
	if (failure.code === "static.page_horizontal_overflow") {
		return "Repair desktop horizontal overflow without hiding document overflow or shrinking content to unreadable sizes: use minmax(0, 1fr) for flexible Grid tracks and min-width:0 on affected direct Grid/Flex items; keep wide tables inside a local overflow-x:auto wrapper; for Canvas, measure the dedicated viewport once before changing bitmap dimensions and keep CSS size at 100% instead of feeding a DPR-expanded or remeasured intrinsic width back into the Grid; when pagination can exceed the desktop page width, make it wrap or render a compact bounded page window with previous/next and ellipses. Preserve readable chart, KPI, filter, pagination, and table dimensions at 1440x900.";
	}
	if (failure.code === "static.control_unwired") {
		return "Every visible select must read its selected value and use it to deterministically change KPIs, charts, tables, or an explicit empty state.";
	}
	if (failure.code === "static.control_no_effect") {
		return "Patch the disclosed select and its shared data-derivation path without replacing the working dashboard or regressing controls that are absent from this diagnostic. Test every existing filter from its default to its next enabled option after the patch, not only the failing selector. Use the exact selected value to change at least one representative numeric KPI or chart datum and the synchronized table/detail result, or show one synchronized explicit empty state. If fixture combinations are generated programmatically, incorporate this filter dimension into values or rows that actually differ; separate lookup branches containing identical values and redrawing identical data are not sufficient. Guard the empty-result branch before reading rows[0] or any selected record property, clear all dependent surfaces together, and never rewrite an already-working filter as an unrelated multi-select merely to repair one control.";
	}
	if (failure.code === "static.default_filter_inconsistent") {
		return "Applying the unchanged documented defaults must preserve representative KPI, chart, and table data. Exclude empty multi-select sentinels, ensure every filter predicate reads an exact field present on fixture rows (including DateType or equivalent), and verify matching default values through the real Apply handler.";
	}
	if (failure.code === "static.filter_value_unused") {
		return "Patch the shared data derivation (including getFilteredData or its equivalent) so every existing filter property is consumed by real predicates/aggregation before one synchronized render updates KPIs, every applicable chart, and the detail table. Add exact matching deterministic fixture fields and representative values when needed; repair all disclosed selectors together, do not remove, hide, or rename controls, and do not special-case only the first diagnostic.";
	}
	if (failure.code === "static.filter_state_key_mismatch") {
		return "Replace prefix-only id.split('-')[0] state assignment with an explicit map from each disclosed control id to its existing PM-defined render-state property. Then use every mapped property in the documented filtering or aggregation path so the next enabled option changes all downstream surfaces named by that control's Blueprint scope or produces a coherent explicit empty state. Do not rename, remove, or hide the controls.";
	}
	if (failure.code === "static.filter_partial_update") {
		return "Use the disclosed filter value in one coherent data derivation for every downstream surface explicitly named by its source-backed Blueprint scope. The same option change must update each required metric, visualization, detail, list, or table target (or clear those targets into one coherent explicit empty state). Do not update one view while reusing unchanged defaults in another required target; do not silently fall back to the default dataset for unlisted combinations; format displayed numbers to readable bounded precision.";
	}
	if (failure.code === "static.filter_empty_state_inconsistent") {
		return "When a filter produces an explicit empty result, clear every affected KPI, SVG/Canvas/chart-library dataset, detail panel, and table in the same render transaction. Never leave stale chart marks visible beside empty KPIs or a no-data table; preserve the controls and show a readable chart-level empty state instead of hiding overflow or deleting the charts.";
	}
	if (failure.code === "static.invalid_rendered_data") {
		return "Repair the disclosed dashboard data surface so every exercised filter option renders finite, defined values across KPI, chart, detail, and table output. For time-window aggregation, clamp the final bucket to the available array/row boundary and derive the displayed end label from the last row actually included; never concatenate an out-of-range array lookup into a label. Do not hide the invalid text, remove the filter/chart/table, or replace it with fabricated static output.";
	}
	if (failure.code === "static.blueprint_chart_missing") {
		return "Restore every explicitly named chart from the source-backed chart inventory, including its documented chart type and readable visible title. Implement the missing visualization with deterministic representative data; do not rename it into an unrelated chart, delete another required surface, or add a text-only placeholder.";
	}
	if (failure.code === "static.blueprint_table_missing") {
		return "Restore the explicitly targeted detail table/data grid from the source-backed interaction inventory. Render a real accessible table (or semantic grid) with deterministic rows, synchronized filters and chart drill-down selection, a readable empty state, and the documented sorting/pagination/export behavior. Keep wide columns inside a local overflow-x:auto wrapper; do not substitute another chart, a text-only panel, or a hidden placeholder.";
	}
	if (failure.code === "static.blueprint_default_missing") {
		return "Restore the source-backed universal filter default with an explicit selectable All/全选 option and representative data for that default. The unchanged default Apply path must keep KPIs, every applicable chart, and the detail table synchronized; do not use a disabled placeholder as the effective default.";
	}
	if (failure.code === "static.blueprint_filter_missing") {
		return "Restore every explicitly named control from the source-backed filter inventory with a visible accessible label, documented options/default, exact fixture field, and synchronized predicate/render path. Do not hide or rename a required filter, and do not add an inert control merely to satisfy source inspection.";
	}
	if (failure.code === "static.blueprint_filter_option_missing") {
		return "Populate each disclosed source-backed dropdown with at least one meaningful enabled alternative to its documented default and deterministic representative fixture data for both values. Wire the selected value into the shared KPI/chart/table derivation or a synchronized empty state; do not keep a decorative one-option select, invent an unrelated multi-select, or remove the control.";
	}
	if (failure.code === "static.blueprint_filter_scope_incomplete") {
		return "Honor the source-backed filter scope exactly: derive one deterministic filtered dataset or transformation, then pass that state into every visualization and other downstream target explicitly covered by the PM Blueprint. Do not impose a fixed dashboard component list, do not redraw an in-scope target from unchanged global constants, and preserve independent surfaces when the Blueprint says they are outside this control's scope.";
	}
	if (failure.code === "static.blueprint_chart_interaction_missing") {
		return "Implement the source-backed click/tap interaction on real marks of the disclosed visualization. Selection must visibly highlight and update exactly the PM-defined downstream target with deterministic synchronized data; an unrelated button handler or inert visualization is not sufficient.";
	}
	if (failure.code === "static.blueprint_chart_drilldown_incomplete") {
		const missingTargets = Array.isArray(failure.data?.missingTargets)
			? failure.data.missingTargets.filter((value): value is string => typeof value === "string").slice(0, 6)
			: [];
		const targetClause = missingTargets.length > 0 ? ` Specifically repair: ${missingTargets.join(", ")}.` : "";
		return `Complete the source-backed cross-surface drill-down: use the selected mark value in downstream data selection so every target explicitly documented by this PM Blueprint actually refreshes.${targetClause} A border/highlight on only the originating visualization is not sufficient; preserve the selection highlight as secondary feedback.`;
	}
	if (failure.code === "static.nondeterministic_data") {
		return "Replace unseeded Math.random() with stable source-backed data or a local seeded deterministic PRNG. Preserve the requested gameplay, simulation, chart, KPI, table, and interaction behavior; repair the random source instead of deleting the affected feature or hard-coding an inert screenshot.";
	}
	return failure.message;
}

function normalizeRepairTargetPath(path: string | undefined): string | undefined {
	if (!path) {
		return undefined;
	}

	const normalized = path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^(?:\.\/)+/, "");

	return normalized || undefined;
}
