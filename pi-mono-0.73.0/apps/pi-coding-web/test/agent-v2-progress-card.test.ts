import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedAgentV2TerminalRunPresentation } from "../src/runtime/agent-v2-run-presentation.js";

describe("Agent v2 progress card", () => {
	beforeEach(() => {
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("customElements", { define: vi.fn(), get: vi.fn(() => undefined) });
	});

	afterEach(() => vi.useRealTimers());

	it("projects one current status, five real phases, current action, elapsed time, and one controlled section", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const view = createAgentV2ProgressCardView(successPresentation(), {
			expandedSection: "files",
			now: Date.parse("2026-07-16T00:02:00.000Z"),
		});

		expect(view.status).toMatchObject({ text: "Completed", icon: "check", tone: "success" });
		expect(view.stages.map((stage) => stage.id)).toEqual([
			"understanding",
			"planning",
			"implementation",
			"validation",
			"delivery",
		]);
		expect(view.currentAction).toBe("Dashboard delivered.");
		expect(view.elapsedLabel).toBe("2m");
		expect(view.sections.filter((section) => section.expanded).map((section) => section.id)).toEqual(["files"]);
		expect(view.sections.every((section) => section.controlId.includes("run-success"))).toBe(true);
	});

	it("keeps the compact card to status, phase, action, elapsed time, and one detail button", async () => {
		const { AgentV2ProgressCard } = await import("../src/runtime/agent-v2-progress-card.js");
		const card = Object.create(AgentV2ProgressCard.prototype) as AgentV2ProgressCard;
		Object.defineProperties(card, {
			presentation: { configurable: true, value: successPresentation() },
			terminal: { configurable: true, value: true },
			detailsExpanded: { configurable: true, value: false },
			expandedSection: { configurable: true, value: null },
			now: { configurable: true, value: Date.parse("2026-07-16T00:02:00.000Z") },
		});

		const rendered = card.render();
		const markup = templateMarkup(rendered);
		expect(markup).toContain("agent-v2-progress-card__detail-toggle");
		expect(markup).not.toContain("agent-v2-progress-card__stages");
		expect(markup).not.toContain("agent-v2-progress-card__sections");
		expect(templateValues(rendered)).toContain("Delivery · stage 5 of 5");
	});

	it("shows stages and grouped evidence only in detail mode", async () => {
		const { AgentV2ProgressCard } = await import("../src/runtime/agent-v2-progress-card.js");
		const card = Object.create(AgentV2ProgressCard.prototype) as AgentV2ProgressCard;
		Object.defineProperties(card, {
			presentation: { configurable: true, value: successPresentation() },
			terminal: { configurable: true, value: true },
			detailsExpanded: { configurable: true, value: true },
			expandedSection: { configurable: true, value: "files" },
			now: { configurable: true, value: Date.parse("2026-07-16T00:02:00.000Z") },
		});
		const markup = templateMarkup(card.render());
		expect(markup).toContain("agent-v2-progress-card__stages");
		expect(markup).toContain("agent-v2-progress-card__sections");
	});

	it("renders repair as a validation sub-state with its reason and attempt", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const presentation = successPresentation();
		presentation.status = "running";
		presentation.phase = "repair";
		presentation.stage = "validation";
		presentation.active = true;
		presentation.repairing = true;
		presentation.repairReason = "Script initialization failed.";
		presentation.repairAttempt = 2;
		const view = createAgentV2ProgressCardView(presentation, {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
		});
		expect(view.status.text).toBe("Repairing");
		expect(view.currentStage).toBe("Validation · stage 4 of 5");
		expect(view.currentAction).toBe("Repairing (attempt 2): Script initialization failed.");
	});

	it("renders a safe new-page delivery link only for a succeeded run with a safe URL", async () => {
		const { AgentV2ProgressCard } = await import("../src/runtime/agent-v2-progress-card.js");
		const card = Object.create(AgentV2ProgressCard.prototype) as AgentV2ProgressCard;
		Object.defineProperties(card, {
			presentation: { configurable: true, value: successPresentation() },
			terminal: { configurable: true, value: true },
			expandedSection: { configurable: true, value: null },
			now: { configurable: true, value: Date.parse("2026-07-16T00:02:00.000Z") },
		});

		const rendered = card.render();
		const markup = templateMarkup(rendered);
		expect(templateValues(rendered)).toContain("https://example.test/preview/demo/");
		expect(markup).toContain('target="_blank"');
		expect(markup).toContain('rel="noopener noreferrer"');

		const unsafe = successPresentation();
		unsafe.deliveryReport = { ...unsafe.deliveryReport!, previewUrl: "javascript:alert(1)" };
		Object.defineProperty(card, "presentation", { configurable: true, value: unsafe });
		expect(templateValues(card.render())).not.toContain("javascript:alert(1)");
		unsafe.deliveryReport = { ...unsafe.deliveryReport, previewUrl: "//evil.example/preview" };
		expect(templateValues(card.render())).not.toContain("//evil.example/preview");

		const failed = failurePresentation();
		failed.deliveryReport = successPresentation().deliveryReport;
		Object.defineProperty(card, "presentation", { configurable: true, value: failed });
		expect(templateValues(card.render())).not.toContain("https://example.test/preview/demo/");
	});

	it("shows a concrete failure cause and retry safety without auto-opening technical details", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const view = createAgentV2ProgressCardView(failurePresentation(), {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
		});

		expect(view.failure).toEqual({
			cause: "Validation entry point is missing.",
			retrySafety: "Safe to retry",
			completedWork: "1 task completed; 1 file created or updated.",
			nextAction: "Retry this run.",
		});
		expect(view.sections.find((section) => section.id === "technical")?.expanded).toBe(false);
		expect(view.deliveryHref).toBeUndefined();
	});

	it("shows terminal validation, build, file counts, and usage while gating delivery on readiness", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const presentation = successPresentation();
		const view = createAgentV2ProgressCardView(presentation, {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
		});
		expect(view.completion).toEqual({
			validation: "Passed",
			build: "Not required",
			files: "1 created, 0 modified",
			usageInstructions: "Open the preview.",
		});
		expect(view.deliveryHref).toBe("https://example.test/preview/demo/");

		presentation.deliveryReport = {
			...presentation.deliveryReport!,
			previewReadiness: { verified: true, ready: false, reasonCode: "http_not_ok" },
		};
		expect(
			createAgentV2ProgressCardView(presentation, {
				expandedSection: null,
				now: Date.parse("2026-07-16T00:02:00.000Z"),
			}).deliveryHref,
		).toBeUndefined();
	});

	it("ticks only for an active connected card and stops after disconnect", async () => {
		vi.useFakeTimers();
		const { createAgentV2ElapsedTicker } = await import("../src/runtime/agent-v2-progress-card.js");
		const updates: number[] = [];
		const ticker = createAgentV2ElapsedTicker((now) => updates.push(now), 1000);
		ticker.start();
		await vi.advanceTimersByTimeAsync(2100);
		expect(updates).toHaveLength(2);
		ticker.stop();
		await vi.advanceTimersByTimeAsync(2000);
		expect(updates).toHaveLength(2);
	});
});

function successPresentation(): SerializedAgentV2TerminalRunPresentation {
	return {
		runId: "run-success",
		status: "succeeded",
		phase: "delivery",
		stage: "delivery",
		active: false,
		repairing: false,
		startedAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:02:00.000Z",
		endedAt: "2026-07-16T00:02:00.000Z",
		tasks: [
			{
				type: "agent_v2.task_updated",
				taskId: "implement",
				kind: "implementation",
				status: "succeeded",
				phase: "implementation",
				at: "2026-07-16T00:00:00.000Z",
			},
		],
		artifacts: [
			{
				type: "agent_v2.artifact_indexed",
				artifactId: "index",
				path: "index.html",
				validationStatus: "passed",
				revision: "revision-1",
				checksum: `sha256:${"a".repeat(64)}`,
				action: "created",
				sourceTaskId: "implement",
				at: "2026-07-16T00:01:00.000Z",
			},
		],
		validations: [],
		diagnostics: [],
		outputs: [],
		skills: [],
		resources: [],
		deliveryReport: {
			type: "agent_v2.delivery_reported",
			taskId: "deliver",
			completedSummary: "Dashboard delivered.",
			appliedSkills: [],
			createdFiles: ["index.html"],
			updatedFiles: [],
			validationStatus: "passed",
			buildStatus: "not_required",
			previewStatus: "running",
			previewReadiness: { verified: true, ready: true, reasonCode: "ready" },
			previewUrl: "https://example.test/preview/demo/",
			projectId: "demo",
			usageInstructions: "Open the preview.",
			at: "2026-07-16T00:02:00.000Z",
		},
	};
}

function failurePresentation(): SerializedAgentV2TerminalRunPresentation {
	return {
		...successPresentation(),
		runId: "run-failure",
		status: "failed",
		phase: "failed",
		deliveryReport: undefined,
		error: {
			code: "static.missing_entry",
			message: "Validation entry point is missing.",
			retryable: true,
		},
	};
}

function templateValues(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const values = Array.isArray((value as { values?: unknown[] }).values)
		? (value as { values: unknown[] }).values
		: [];
	return values.flatMap((entry) => [entry, ...templateValues(entry)]);
}

function templateMarkup(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const template = value as { strings?: readonly string[]; values?: unknown[] };
	const values = Array.isArray(template.values) ? template.values : [];
	return `${template.strings?.join("") ?? ""}${values.map(templateMarkup).join("")}`;
}
