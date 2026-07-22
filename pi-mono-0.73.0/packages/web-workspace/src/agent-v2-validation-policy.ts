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

const STATIC_QUALITY_ADVISORY_CODES = new Set([
	"static.selector_missing",
	"static.loading_visible",
	"static.metric_placeholder",
	"static.control_unwired",
	"static.nondeterministic_data",
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
	};
	const blocking = input.blocking ?? blockingFor(input.code, input.source);
	return {
		severity: severityFor(input.code, input.retryable, blocking),
		confidence: confidenceFor(input.code, input.source),
		blocking,
		fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
		evidence: [
			{
				kind: evidenceKindFor(input.code, input.source),
				summary: evidenceSummary(input.code),
				...(path ? { path } : {}),
				...(selector ? { selector } : {}),
			},
		],
		repairBudget: repairBudgetFor(input.code, input.retryable, blocking),
		ruleVersion: RULE_VERSION,
	};
}

function blockingFor(code: string, source: ClassifyAgentV2ValidationPolicyInput["source"]): boolean {
	// Regex/source inspection is useful for repair hints, but it cannot prove the
	// rendered browser state. Runtime validation may still promote the same
	// finding to a blocking failure with stronger evidence.
	// The static smoke runtime also cannot prove a control is inert in a real
	// browser: debounced updates, same-tick timestamps, external libraries and
	// network-backed rendering may all be invisible to its synthetic DOM. Keep
	// this signal for quality reporting without making delivery depend on it.
	if (source === "static_smoke" && code === "static.control_no_effect") return false;
	return source !== "static_quality" || !STATIC_QUALITY_ADVISORY_CODES.has(code);
}

function severityFor(code: string, retryable: boolean, blocking: boolean): AgentV2ValidationSeverity {
	if (!blocking) return "warning";
	if (!retryable && (code === "build.config_missing" || code === "build.output_escape")) return "critical";
	return "error";
}

function confidenceFor(code: string, source: ClassifyAgentV2ValidationPolicyInput["source"]): number {
	if (code === "static.canvas_layout_unbounded") return 0.95;
	if (
		code === "static.workspace_empty" ||
		code === "static.preview_missing_entry" ||
		code === "static.build_manifest_missing" ||
		code === "static.local_script_missing" ||
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
	if (code === "static.canvas_layout_unbounded") return "layout";
	if (source === "static_smoke") return "runtime";
	if (source === "preview") return "policy";
	return "source";
}

function evidenceSummary(code: string): string {
	return `Validator rule ${code} produced reproducible evidence.`.slice(0, 240);
}

function repairBudgetFor(code: string, retryable: boolean, blocking: boolean): AgentV2ValidationRepairBudget {
	if (!retryable || !blocking) return { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 };
	if (code === "static.canvas_layout_unbounded") {
		return { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 };
	}
	if (code === "static.script_error") {
		return { maxAttempts: 4, maxSameFingerprintAttempts: 3, maxChangedFiles: 2 };
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
