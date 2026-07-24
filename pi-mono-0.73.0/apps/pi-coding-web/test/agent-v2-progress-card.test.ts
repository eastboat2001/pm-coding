import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentV2RunPresentation,
	SerializedAgentV2TerminalRunPresentation,
} from "../src/runtime/agent-v2-run-presentation.js";

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

	it("keeps live stage progress and counters visible in the compact card", async () => {
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
		expect(templateValues(rendered)).toContain("agent-v2-progress-card--details-collapsed");
		expect(markup).toContain("agent-v2-progress-card__detail-toggle");
		expect(markup).toContain("agent-v2-progress-card__stages");
		expect(markup).toContain("agent-v2-progress-card__metrics");
		expect(markup).not.toContain("agent-v2-progress-card__sections");
		expect(templateValues(rendered)).toContain("Delivery · stage 5 of 5");
	});

	it("explains active work and upcoming evidence instead of showing an empty card", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const presentation = activePresentation();
		const view = createAgentV2ProgressCardView(presentation, {
			expandedSection: "files",
			now: Date.parse("2026-07-16T00:00:45.000Z"),
			responseLanguage: "zh",
		});

		expect(view.currentAction).toBe("正在生成应用代码并准备写入项目文件。");
		expect(view.metrics.map((metric) => [metric.id, metric.value])).toEqual([
			["tasks", "0"],
			["files", "0"],
			["validation", "0"],
			["skills", "0"],
		]);
		expect(view.sections.find((section) => section.id === "files")?.emptyText).toBe(
			"模型完成当前步骤后，文件变更会显示在这里。",
		);

	});

	it("shows delivery as the terminal stage even when the final stored event still names implementation", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const presentation = successPresentation();
		presentation.phase = "implementation";
		presentation.stage = "implementation";
		presentation.deliveryReport = undefined;

		const view = createAgentV2ProgressCardView(presentation, {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
		});

		expect(view.currentStage).toBe("Delivery · stage 5 of 5");
		expect(view.stages.every((stage) => stage.state === "complete")).toBe(true);
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
		const rendered = card.render();
		const markup = templateMarkup(rendered);
		expect(templateValues(rendered)).toContain("agent-v2-progress-card--details-expanded");
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

	it("keeps Chinese runs Chinese in the terminal progress card", async () => {
		const { AgentV2ProgressCard, createAgentV2ProgressCardView } = await import(
			"../src/runtime/agent-v2-progress-card.js"
		);
		const view = createAgentV2ProgressCardView(failurePresentation(), {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
			responseLanguage: "zh",
		});
		expect(view.status.text).toBe("失败");
		expect(view.currentStage).toBe("交付 · 第 5/5 阶段");
		expect(view.failure).toMatchObject({
			retrySafety: "可以安全重试",
			completedWork: "已完成 1 个任务，创建或更新了 1 个文件",
		});

		const card = Object.create(AgentV2ProgressCard.prototype) as AgentV2ProgressCard;
		Object.defineProperties(card, {
			presentation: { configurable: true, value: failurePresentation() },
			responseLanguage: { configurable: true, value: "zh" },
			terminal: { configurable: true, value: true },
			detailsExpanded: { configurable: true, value: false },
			expandedSection: { configurable: true, value: null },
			now: { configurable: true, value: Date.parse("2026-07-16T00:02:00.000Z") },
		});
		expect(templateValues(card.render())).toContain("查看详情");
	});

	it("localizes known provider and model protocol failures for Chinese runs", async () => {
		const { createAgentV2ProgressCardView } = await import("../src/runtime/agent-v2-progress-card.js");
		const timeout = failurePresentation();
		timeout.error = {
			code: "agent_v2.model.provider_timeout",
			message:
				"Agent v2 model provider timed out before producing a complete result. No provider chunks were received within 180000ms (2 provider attempts).",
			retryable: true,
		};
		const timeoutView = createAgentV2ProgressCardView(timeout, {
			expandedSection: null,
			now: Date.parse("2026-07-16T00:02:00.000Z"),
			responseLanguage: "zh",
		});
		expect(timeoutView.currentAction).toBe(
			"模型服务在连续 2 次尝试中均未返回任何响应数据（每次等待 180 秒），因此本次生成已停止。",
		);
		expect(timeoutView.failure?.cause).toBe(timeoutView.currentAction);

		const protocol = failurePresentation();
		protocol.error = {
			code: "agent_v2.model_contract.invalid_protocol",
			message: "Agent v2 model response does not follow the required JSON protocol.",
			retryable: true,
		};
		expect(
			createAgentV2ProgressCardView(protocol, {
				expandedSection: null,
				now: Date.parse("2026-07-16T00:02:00.000Z"),
				responseLanguage: "zh",
			}).failure?.cause,
		).toBe("模型回复未遵循应用生成所需的 JSON 协议，自动修复后仍未成功。");
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

function activePresentation(): AgentV2RunPresentation {
	return {
		runId: "run-active",
		status: "running",
		phase: "implementation",
		stage: "implementation",
		active: true,
		repairing: false,
		startedAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:00:30.000Z",
		tasks: new Map(),
		artifacts: new Map(),
		validations: new Map(),
		diagnostics: new Map(),
		outputs: new Map(),
		skills: new Map(),
		resources: new Map(),
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
