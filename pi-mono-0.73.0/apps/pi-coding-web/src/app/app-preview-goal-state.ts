import type { AppPreviewGoalRecord } from "@mariozechner/pi-web-workspace";

export type AppPreviewGoalAction = "enable" | "disable";
type AppPreviewGoalStateInput = Partial<
	Pick<
		AppPreviewGoalRecord,
		| "source"
		| "status"
		| "lastPreviewUrl"
		| "lastRunId"
		| "continuationRunsUsed"
		| "maxContinuationRuns"
		| "lastFailureReason"
	>
>;

export interface AppPreviewGoalActionState {
	active: boolean;
	disabled: boolean;
	nextAction: AppPreviewGoalAction;
}

export function appPreviewGoalToggleLabel(goal: AppPreviewGoalStateInput | undefined, previewPending = false): string {
	return previewPending || goal?.status === "active" ? "Enabled" : "Not enabled";
}

export function appPreviewGoalStageLabel(
	goal: AppPreviewGoalStateInput | undefined,
	previewPending = false,
): string | undefined {
	if (!goal && previewPending) return undefined;
	switch (goal?.status) {
		case "active":
			if (!goal.lastRunId) return undefined;
			return goal.continuationRunsUsed && goal.continuationRunsUsed > 0
				? "Recovering preview generation"
				: "Generating preview";
		case "preview_ready":
			return "Preview ready";
		case "budget_limited":
			return "Preview generation limit reached";
		case "blocked":
			return "Preview generation needs attention";
		case "failed":
			return "Preview generation failed";
		case "cancelled":
			return "Preview generation cancelled";
		default:
			return undefined;
	}
}

export function appPreviewGoalStageDetailLabel(goal: AppPreviewGoalStateInput | undefined): string | undefined {
	if (goal?.status === "preview_ready") return undefined;
	switch (goal?.lastFailureReason) {
		case "missing_project_metadata":
		case "preview_url_missing":
			return "No preview URL detected.";
		case "http_not_ok":
			return "Preview URL was not reachable.";
		case "serve_root_missing":
		case "static_resource_missing":
			return "Static resources are missing.";
		case "index_html_missing":
			return "index.html is missing.";
		case "index_html_empty":
		case "html_no_basic_content":
			return "Preview page is empty.";
		case "html_error_page":
			return "Preview page did not pass validation.";
		case "queue_unavailable":
			return "Preview run queue is unavailable.";
		case "run_cancelled":
			return "Run was cancelled.";
		case "run_interrupted":
			return "Run was interrupted.";
		case "provider_transient_error":
		case "transient_provider_error":
			return "Model provider connection failed after retries.";
		default:
			return undefined;
	}
}

export function appPreviewGoalActionState(
	goal: AppPreviewGoalStateInput | undefined,
	previewPending = false,
): AppPreviewGoalActionState {
	if (previewPending || goal?.status === "active") {
		return { nextAction: "disable", active: true, disabled: false };
	}
	return { nextAction: "enable", active: false, disabled: false };
}

export function isAppPreviewGoalEnabled(goal: AppPreviewGoalStateInput | undefined): boolean {
	return goal !== undefined && goal.status !== "disabled";
}

export function appPreviewGoalContinuationProgress(
	goal: AppPreviewGoalStateInput | undefined,
): { used: number; max: number } | undefined {
	if (goal?.status !== "active") return undefined;
	const used = positiveInteger(goal.continuationRunsUsed);
	if (used === undefined || used === 0) return undefined;
	const max = positiveInteger(goal.maxContinuationRuns) ?? used;
	return { used, max };
}

export function appPreviewGoalContinuationRunId(
	goal: AppPreviewGoalStateInput | undefined,
	terminalRunId: string,
): string | undefined {
	if (goal?.status !== "active") return undefined;
	if (!goal.lastRunId || goal.lastRunId === terminalRunId) return undefined;
	return goal.lastRunId;
}

export function isAppPreviewGoalSettledForRun(goal: AppPreviewGoalStateInput | undefined, _runId: string): boolean {
	return !goal || goal.status !== "active";
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
