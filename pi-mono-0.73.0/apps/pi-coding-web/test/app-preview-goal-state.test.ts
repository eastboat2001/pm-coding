import { describe, expect, it } from "vitest";
import {
	appPreviewGoalActionState,
	appPreviewGoalContinuationProgress,
	appPreviewGoalStageDetailLabel,
	appPreviewGoalStageLabel,
	appPreviewGoalToggleLabel,
	appPreviewGoalContinuationRunId,
	isAppPreviewGoalEnabled,
	isAppPreviewGoalSettledForRun,
} from "../src/app/app-preview-goal-state.js";

describe("app preview goal state", () => {
	it("maps the extension action to a pure enabled or not-enabled toggle label", () => {
		expect(appPreviewGoalToggleLabel(undefined)).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel(undefined, true)).toBe("Enabled");
		expect(appPreviewGoalToggleLabel({ status: "active" })).toBe("Enabled");
		expect(appPreviewGoalToggleLabel({ status: "preview_ready" })).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel({ status: "budget_limited" })).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel({ status: "blocked" })).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel({ status: "failed" })).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel({ status: "cancelled" })).toBe("Not enabled");
		expect(appPreviewGoalToggleLabel({ status: "disabled" })).toBe("Not enabled");
	});

	it("maps goal progress to a separate stage label", () => {
		expect(appPreviewGoalStageLabel(undefined)).toBeUndefined();
		expect(appPreviewGoalStageLabel(undefined, true)).toBeUndefined();
		expect(appPreviewGoalStageLabel({ status: "active" })).toBeUndefined();
		expect(appPreviewGoalStageLabel({ status: "active", lastRunId: "run-1" })).toBe("Generating preview");
		expect(appPreviewGoalStageLabel({ status: "active", lastRunId: "run-2", continuationRunsUsed: 1 })).toBe(
			"Recovering preview generation",
		);
		expect(appPreviewGoalStageLabel({ status: "preview_ready" })).toBe("Preview ready");
		expect(appPreviewGoalStageLabel({ status: "budget_limited" })).toBe("Preview generation limit reached");
		expect(appPreviewGoalStageLabel({ status: "blocked" })).toBe("Preview generation needs attention");
		expect(appPreviewGoalStageLabel({ status: "failed" })).toBe("Preview generation failed");
		expect(appPreviewGoalStageLabel({ status: "cancelled" })).toBe("Preview generation cancelled");
		expect(appPreviewGoalStageLabel({ status: "disabled" })).toBeUndefined();
	});

	it("maps preview readiness reason codes to professional stage detail labels", () => {
		expect(appPreviewGoalStageDetailLabel({ status: "active", lastFailureReason: "preview_url_missing" })).toBe(
			"No preview URL detected.",
		);
		expect(appPreviewGoalStageDetailLabel({ status: "active", lastFailureReason: "http_not_ok" })).toBe(
			"Preview URL was not reachable.",
		);
		expect(appPreviewGoalStageDetailLabel({ status: "active", lastFailureReason: "index_html_missing" })).toBe(
			"index.html is missing.",
		);
		expect(appPreviewGoalStageDetailLabel({ status: "active", lastFailureReason: "static_resource_missing" })).toBe(
			"Static resources are missing.",
		);
		expect(appPreviewGoalStageDetailLabel({ status: "blocked", lastFailureReason: "provider_transient_error" })).toBe(
			"Model provider connection failed after retries.",
		);
		expect(appPreviewGoalStageDetailLabel({ status: "active", lastFailureReason: "unknown_reason" })).toBeUndefined();
	});

	it("does not show stale failure details once the preview is ready", () => {
		expect(
			appPreviewGoalStageDetailLabel({
				status: "preview_ready",
				lastPreviewUrl: "http://localhost:5173/preview/project-client-a-session-1/",
				lastFailureReason: "missing_project_metadata",
			}),
		).toBeUndefined();
	});

	it("enables preview when there is no active goal", () => {
		expect(appPreviewGoalActionState(undefined)).toEqual({
			nextAction: "enable",
			active: false,
			disabled: false,
		});
	});

	it("disables preview while manual preview is pending for a new session", () => {
		expect(appPreviewGoalActionState(undefined, true)).toEqual({
			nextAction: "disable",
			active: true,
			disabled: false,
		});
	});

	it("shows PM handoff pending preview as enabled before the first run exists", () => {
		expect(appPreviewGoalToggleLabel(undefined, true)).toBe("Enabled");
		expect(appPreviewGoalActionState(undefined, true)).toEqual({
			nextAction: "disable",
			active: true,
			disabled: false,
		});
	});

	it("disables preview while a goal is active", () => {
		expect(appPreviewGoalActionState({ status: "active" })).toEqual({
			nextAction: "disable",
			active: true,
			disabled: false,
		});
	});

	it("keeps the extension action as a toggle when a preview is ready", () => {
		expect(appPreviewGoalActionState({ status: "preview_ready", lastPreviewUrl: "/preview/session-1" })).toEqual({
			nextAction: "enable",
			active: false,
			disabled: false,
		});
		expect(appPreviewGoalActionState({ status: "preview_ready" })).toEqual({
			nextAction: "enable",
			active: false,
			disabled: false,
		});
	});

	it("falls back to enabling preview for inactive states", () => {
		for (const status of ["budget_limited", "blocked", "failed", "cancelled", "disabled"] as const) {
			expect(appPreviewGoalActionState({ status })).toEqual({
				nextAction: "enable",
				active: false,
				disabled: false,
			});
		}
	});

	it("keeps automatic preview enabled for persisted goals until the user disables it", () => {
		for (const status of ["active", "preview_ready", "budget_limited", "blocked", "failed", "cancelled"] as const) {
			expect(isAppPreviewGoalEnabled({ source: "manual", status })).toBe(true);
			expect(isAppPreviewGoalEnabled({ source: "pm_handoff", status })).toBe(true);
		}
		expect(isAppPreviewGoalEnabled({ source: "manual", status: "disabled" })).toBe(false);
		expect(isAppPreviewGoalEnabled(undefined)).toBe(false);
	});

	it("treats a terminal run goal as unsettled while it is still active for that run", () => {
		expect(isAppPreviewGoalSettledForRun(undefined, "run-1")).toBe(true);
		expect(isAppPreviewGoalSettledForRun({ status: "preview_ready", lastRunId: "run-1" }, "run-1")).toBe(true);
		expect(isAppPreviewGoalSettledForRun({ status: "active", lastRunId: "run-2" }, "run-1")).toBe(false);
		expect(isAppPreviewGoalSettledForRun({ status: "active", lastRunId: "run-1" }, "run-1")).toBe(false);
	});

	it("identifies a continuation run that should be attached after a terminal run", () => {
		expect(appPreviewGoalContinuationRunId(undefined, "run-1")).toBeUndefined();
		expect(appPreviewGoalContinuationRunId({ status: "preview_ready", lastRunId: "run-2" }, "run-1")).toBeUndefined();
		expect(appPreviewGoalContinuationRunId({ status: "active", lastRunId: "run-1" }, "run-1")).toBeUndefined();
		expect(appPreviewGoalContinuationRunId({ status: "active", lastRunId: "run-2" }, "run-1")).toBe("run-2");
	});

	it("exposes continuation progress while preview recovery is active", () => {
		expect(appPreviewGoalContinuationProgress(undefined)).toBeUndefined();
		expect(appPreviewGoalContinuationProgress({ status: "preview_ready", continuationRunsUsed: 1 })).toBeUndefined();
		expect(appPreviewGoalContinuationProgress({ status: "active", continuationRunsUsed: 0 })).toBeUndefined();
		expect(
			appPreviewGoalContinuationProgress({
				status: "active",
				continuationRunsUsed: 1,
				maxContinuationRuns: 8,
			}),
		).toEqual({ used: 1, max: 8 });
	});
});
