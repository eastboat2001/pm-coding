import { createHash } from "node:crypto";

export type AgentV2ValidationSeverity = "info" | "warning" | "error" | "critical";
export type AgentV2ValidationEvidenceKind = "source" | "runtime" | "layout" | "build" | "policy";

export interface AgentV2ValidationEvidence {
	kind: AgentV2ValidationEvidenceKind;
	summary: string;
	path?: string;
	selector?: string;
}

export interface AgentV2ValidationRepairBudget {
	maxAttempts: number;
	maxSameFingerprintAttempts: number;
	maxChangedFiles: number;
}

export interface AgentV2ValidationPolicyMetadata {
	severity: AgentV2ValidationSeverity;
	confidence: number;
	blocking: boolean;
	fingerprint: string;
	evidence: AgentV2ValidationEvidence[];
	repairBudget: AgentV2ValidationRepairBudget;
	ruleVersion: "agent-v2-validation-policy-v2";
}

export interface ClassifyAgentV2ValidationPolicyInput {
	code: string;
	source: "static_validate" | "static_quality" | "static_smoke" | "preview";
	retryable: boolean;
	path?: string;
	data?: Record<string, unknown>;
	blocking?: boolean;
}

const RULE_VERSION = "agent-v2-validation-policy-v2" as const;

const STATIC_QUALITY_BLOCKING_CODES = new Set([
	"static.blueprint_chart_missing",
	"static.blueprint_table_missing",
	"static.blueprint_default_missing",
	"static.blueprint_filter_missing",
	"static.blueprint_filter_option_missing",
	"static.blueprint_filter_scope_incomplete",
	"static.canvas_css_bitmap_mismatch",
	"static.canvas_layout_unbounded",
	"static.canvas_resize_unhandled",
	"static.svg_coordinate_space_mismatch",
	"static.page_horizontal_overflow",
	"static.filter_value_unused",
	"static.filter_state_key_mismatch",
	"static.local_script_missing",
]);

const STATIC_SMOKE_BLOCKING_CODES = new Set([
	"static.invalid_rendered_data",
	"static.local_script_missing",
	"static.local_asset_missing",
	"static.script_error",
]);

export function classifyAgentV2ValidationPolicy(
	input: ClassifyAgentV2ValidationPolicyInput,
): AgentV2ValidationPolicyMetadata {
	const path = normalizePath(input.path);
	const selector = stringData(input.data, "selector");
	const identity = {
		ruleVersion: RULE_VERSION,
		code: input.code,
		source: input.source,
		path,
		selector,
		canvasIds: stringArrayData(input.data, "canvasIds"),
		detectedPath: normalizePath(stringData(input.data, "detectedPath")),
		sourceEntry: normalizePath(stringData(input.data, "sourceEntry")),
		scripts: stringArrayData(input.data, "scripts")
			.map(normalizePath)
			.filter((value): value is string => Boolean(value)),
		sourceEntries: stringArrayData(input.data, "sourceEntries")
			.map(normalizePath)
			.filter((value): value is string => Boolean(value)),
		requiredCharts: stringArrayData(input.data, "requiredCharts"),
		requiredFilters: stringArrayData(input.data, "requiredFilters"),
		interactiveCharts: stringArrayData(input.data, "interactiveCharts"),
		missingTargets: stringArrayData(input.data, "missingTargets"),
		highConfidence: input.data?.highConfidence === true,
	};
	const blocking = input.blocking ?? blockingFor(input.code, input.source, identity.highConfidence);
	return {
		severity: severityFor(input.code, input.retryable, blocking),
		confidence: confidenceFor(input.code, input.source, identity.highConfidence),
		blocking,
		fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
		evidence: validationEvidence(input, path, selector),
		repairBudget: repairBudgetFor(input.code, input.retryable, blocking),
		ruleVersion: RULE_VERSION,
	};
}

function blockingFor(
	code: string,
	source: ClassifyAgentV2ValidationPolicyInput["source"],
	highConfidence: boolean,
): boolean {
	// Regex/source inspection is useful for repair hints, but it cannot prove the
	// rendered browser state. Runtime validation may still promote the same
	// finding to a blocking failure with stronger evidence.
	// Keep static-quality rules fail-open by default: adding a new source heuristic
	// must not silently turn it into a delivery blocker. Only the explicit
	// high-confidence allowlist above can block generation.
	if (source === "static_quality") {
		if (
			code === "static.blueprint_chart_drilldown_incomplete" ||
			code === "static.blueprint_chart_interaction_missing"
		) {
			return highConfidence;
		}
		return STATIC_QUALITY_BLOCKING_CODES.has(code);
	}
	// The synthetic smoke DOM cannot prove every visible or asynchronous state.
	// Fail open unless a rule is explicitly allowlisted, or the rule carries
	// deterministic source evidence. This keeps loading/placeholder heuristics
	// advisory and prevents new smoke checks from silently blocking generation.
	if (source === "static_smoke") {
		if (
			code === "static.control_no_effect" ||
			code === "static.default_filter_inconsistent" ||
			code === "static.filter_partial_update" ||
			code === "static.filter_empty_state_inconsistent"
		) {
			return highConfidence;
		}
		return STATIC_SMOKE_BLOCKING_CODES.has(code);
	}
	return true;
}

function severityFor(code: string, retryable: boolean, blocking: boolean): AgentV2ValidationSeverity {
	if (!blocking) return "warning";
	if (!retryable && (code === "build.config_missing" || code === "build.output_escape")) return "critical";
	return "error";
}

function confidenceFor(
	code: string,
	source: ClassifyAgentV2ValidationPolicyInput["source"],
	highConfidence: boolean,
): number {
	if (code === "static.blueprint_chart_missing") return 0.97;
	if (code === "static.blueprint_table_missing") return 0.99;
	if (code === "static.blueprint_default_missing") return 0.98;
	if (code === "static.blueprint_filter_missing") return 0.98;
	if (code === "static.blueprint_filter_option_missing") return 0.99;
	if (code === "static.blueprint_filter_scope_incomplete") return 0.98;
	if (code === "static.blueprint_chart_interaction_missing") return highConfidence ? 0.96 : 0.72;
	if (code === "static.blueprint_chart_drilldown_incomplete") return highConfidence ? 0.97 : 0.72;
	if (code === "static.canvas_css_bitmap_mismatch") return 0.99;
	if (code === "static.canvas_layout_unbounded") return 0.95;
	if (code === "static.canvas_resize_unhandled") return 0.96;
	if (code === "static.svg_coordinate_space_mismatch") return 0.99;
	if (code === "static.page_horizontal_overflow") return 0.97;
	if (code === "static.default_filter_inconsistent") return 0.95;
	if (code === "static.filter_value_unused") return 0.98;
	if (code === "static.filter_state_key_mismatch") return 0.99;
	if (code === "static.filter_partial_update") return highConfidence ? 0.97 : 0.72;
	if (code === "static.filter_empty_state_inconsistent") return highConfidence ? 0.99 : 0.72;
	if (code === "static.invalid_rendered_data") return 0.99;
	if (code === "static.nondeterministic_data") return 0.97;
	if (code === "static.control_unwired" && highConfidence) return 0.97;
	if (code === "static.control_no_effect" && highConfidence) return 0.97;
	if (
		code === "static.workspace_empty" ||
		code === "static.preview_missing_entry" ||
		code === "static.build_manifest_missing" ||
		code === "static.local_script_missing" ||
		code === "static.local_asset_missing" ||
		code.startsWith("build.")
	) {
		return 0.99;
	}
	if (source === "static_quality") return 0.55;
	if (source === "static_smoke") return 0.75;
	if (source === "static_validate") return 0.9;
	return 0.95;
}

function evidenceKindFor(
	code: string,
	source: ClassifyAgentV2ValidationPolicyInput["source"],
): AgentV2ValidationEvidenceKind {
	if (code.startsWith("build.") || code === "static.build_manifest_missing") return "build";
	if (
		code.startsWith("static.canvas_") ||
		code === "static.svg_coordinate_space_mismatch" ||
		code === "static.page_horizontal_overflow"
	) {
		return "layout";
	}
	if (code.startsWith("static.blueprint_")) return "policy";
	if (source === "static_smoke") return "runtime";
	if (source === "preview") return "policy";
	return "source";
}

function validationEvidence(
	input: ClassifyAgentV2ValidationPolicyInput,
	path: string | undefined,
	selector: string | undefined,
): AgentV2ValidationEvidence[] {
	const kind = evidenceKindFor(input.code, input.source);
	const summary =
		stringData(input.data, "sourceEvidence") ?? `Validator rule ${input.code} produced reproducible evidence.`;
	const canvasIds = stringArrayData(input.data, "canvasIds");
	if (canvasIds.length > 0) {
		return canvasIds.slice(0, 8).map((canvasId) => ({
			kind,
			summary: summary.slice(0, 240),
			...(path ? { path } : {}),
			selector: canvasId.startsWith("#") ? canvasId : `#${canvasId}`,
		}));
	}
	return [
		{
			kind,
			summary: summary.slice(0, 240),
			...(path ? { path } : {}),
			...(selector ? { selector } : {}),
		},
	];
}

function repairBudgetFor(code: string, retryable: boolean, blocking: boolean): AgentV2ValidationRepairBudget {
	if (!retryable || !blocking) return { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 };
	if (
		code.startsWith("static.canvas_") ||
		code === "static.svg_coordinate_space_mismatch" ||
		code === "static.page_horizontal_overflow"
	) {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 };
	}
	if (code.startsWith("static.blueprint_")) {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 };
	}
	if (code === "static.default_filter_inconsistent") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.filter_value_unused") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.filter_state_key_mismatch") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.control_unwired") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.filter_partial_update") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.filter_empty_state_inconsistent") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.invalid_rendered_data") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.control_no_effect") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.nondeterministic_data") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 1 };
	}
	if (code === "static.script_error") {
		return { maxAttempts: 4, maxSameFingerprintAttempts: 3, maxChangedFiles: 2 };
	}
	if (code === "static.local_asset_missing") {
		return { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 };
	}
	if (code.startsWith("build.") || code === "static.build_manifest_missing") {
		return { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 };
	}
	return { maxAttempts: 4, maxSameFingerprintAttempts: 3, maxChangedFiles: 1 };
}

function stringData(data: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = data?.[key];
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : undefined;
}

function stringArrayData(data: Record<string, unknown> | undefined, key: string): string[] {
	const value = data?.[key];
	if (!Array.isArray(value)) return [];
	return [
		...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 512))),
	].sort();
}

function normalizePath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^(?:\.\/)+/, "");
	return normalized || undefined;
}
