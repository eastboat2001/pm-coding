import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createAgentV2BrowserRunSink } from "../src/runtime/agent-v2-browser-run-sink.js";
import type { AgentV2RunPresentation } from "../src/runtime/agent-v2-run-presentation.js";

vi.hoisted(() => {
	vi.stubGlobal("HTMLElement", class {});
	vi.stubGlobal("DOMMatrix", class {});
	vi.stubGlobal("ImageData", class {});
	vi.stubGlobal("Path2D", class {});
	vi.stubGlobal("customElements", { define: vi.fn(), get: vi.fn(() => undefined) });
	vi.stubGlobal("document", {
		addEventListener: vi.fn(),
		createTreeWalker: vi.fn(() => ({})),
		removeEventListener: vi.fn(),
	});
});

const START = "2026-07-16T00:00:00.000Z";
const VALIDATE = "2026-07-16T00:01:00.000Z";
const REPAIR = "2026-07-16T00:02:00.000Z";
const OUTPUT = "2026-07-16T00:03:00.000Z";
const END = "2026-07-16T00:04:00.000Z";

describe("Agent v2 browser run sink", () => {
	it("projects a successful run into one active presentation, natural narration, and one durable result", () => {
		const browserAgent = createBrowserAgent();
		const presentations: Array<AgentV2RunPresentation | undefined> = [];
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
			onPresentationChange: (presentation) => presentations.push(presentation),
		});

		projectSuccessfulRun(sink);

		const assistants = browserAgent.state.messages.filter((message) => message.role === "assistant");
		const outputMessages = assistants.filter(
			(message) => message.provider === "openai" && message.model === "gpt-test",
		);
		expect(outputMessages).toHaveLength(1);
		expect(outputMessages[0]).toMatchObject({
			usage: { input: 12, output: 34, totalTokens: 46, cost: { total: 0.25 } },
			timestamp: Date.parse(OUTPUT),
		});
		expect(assistantText(outputMessages[0] as AgentMessage)).toContain("Dashboard implementation complete.");
		expect(assistantText(outputMessages[0] as AgentMessage)).toContain("1 file was created or updated: index.html.");
		expect(assistants.map(assistantText)).toHaveLength(6);
		expect(assistants.map(assistantText)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Here is how I understand the task"),
				expect.stringContaining("Implementation is now underway"),
				expect.stringContaining("The code is now being checked"),
				expect.stringContaining("Validation passed"),
				expect.stringContaining("The checks are complete"),
			]),
		);
		expect(browserAgent.state.messages.filter((message) => message.role === "agent-v2-run-result")).toHaveLength(1);
		expect(browserAgent.state.messages.some((message) => message.role === "agent-v2-activity")).toBe(false);
		expect(presentations.at(-1)).toBeUndefined();
		expect(browserAgent.state).toMatchObject({ isStreaming: false, errorMessage: undefined });
	});

	it("narrates the initial validated snapshot with the run objective", () => {
		const browserAgent = createBrowserAgent();
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
			onPresentationChange: vi.fn(),
		});

		sink.beginRun("run-snapshot", START, "Build an inventory dashboard");
		sink.setPhase("validation", "running", VALIDATE);
		expect(browserAgent.state.messages.filter((message) => message.role === "assistant").map(assistantText)).toEqual([
			expect.stringContaining("Goal: Build an inventory dashboard"),
		]);
		sink.setPhase("implementation", "running", REPAIR);
		expect(browserAgent.state.messages.filter((message) => message.role === "assistant").map(assistantText)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Goal: Build an inventory dashboard"),
				expect.stringContaining("Implementation is now underway"),
			]),
		);
	});

	it("reconciles validation failure, repair, and pass without duplicating indexed state", () => {
		const browserAgent = createBrowserAgent();
		let active: AgentV2RunPresentation | undefined;
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
			onPresentationChange: (presentation) => {
				active = presentation;
			},
		});

		sink.beginRun("run-repair", START);
		sink.setPhase("intake", "running", START);
		sink.setPhase("validation", "running", VALIDATE);
		sink.setValidation(validation(1, "failed", VALIDATE));
		sink.setPhase("repair", "running", REPAIR);
		sink.setValidation(validation(2, "passed", END));
		sink.setValidation(validation(2, "passed", END));
		sink.setPhase("validation", "running", END);

		expect(Array.from(active?.validations.get("validation-1")?.values() ?? [])).toMatchObject([
			{ attempt: 1, status: "failed" },
			{ attempt: 2, status: "passed" },
		]);
		const narration = browserAgent.state.messages.filter((message) => message.role === "assistant").map(assistantText);
		expect(narration).toHaveLength(5);
		expect(narration).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Here is how I understand the task"),
				expect.stringContaining("This validation attempt found an issue"),
				expect.stringContaining("repairable issue"),
				expect.stringContaining("Validation passed"),
			]),
		);
	});

	it("uses a specific terminal error before diagnostic fallback", () => {
		const browserAgent = createBrowserAgent();
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
			onPresentationChange: vi.fn(),
		});
		sink.beginRun("run-failure", START);
		sink.setPhase("validation", "running", VALIDATE);
		sink.appendDiagnostic({
			type: "agent_v2.diagnostic_recorded",
			diagnosticId: "diagnostic-1",
			severity: "error",
			code: "generic.validation_failed",
			message: "Generic diagnostic fallback.",
			at: VALIDATE,
		});
		sink.settle("failed", END, {
			code: "static.missing_entry",
			message: "Validation entry point is missing.",
			retryable: true,
		});

		const result = browserAgent.state.messages.find((message) => message.role === "agent-v2-run-result");
		expect(result).toMatchObject({
			presentation: {
				status: "failed",
				error: { code: "static.missing_entry", message: "Validation entry point is missing.", retryable: true },
			},
		});
		expect(browserAgent.state.errorMessage).toBe("Validation entry point is missing.");
	});

	it("falls back to the latest diagnostic when terminal failure has no specific error", () => {
		const browserAgent = createBrowserAgent();
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
			onPresentationChange: vi.fn(),
		});
		sink.beginRun("run-diagnostic-failure", START);
		sink.setPhase("validation", "running", VALIDATE);
		sink.appendDiagnostic({
			type: "agent_v2.diagnostic_recorded",
			diagnosticId: "diagnostic-1",
			severity: "error",
			code: "static.invalid_html",
			message: "Generated HTML is invalid.",
			at: VALIDATE,
		});
		sink.settle("failed", END);

		expect(browserAgent.state.messages.find((message) => message.role === "agent-v2-run-result")).toMatchObject({
			timestamp: Date.parse(END),
			presentation: {
				error: { code: "static.invalid_html", message: "Generated HTML is invalid.", retryable: false },
			},
		});
		expect(browserAgent.state.errorMessage).toBe("Generated HTML is invalid.");
	});

	it("keeps output narration and terminal projection idempotent across full replay", () => {
		const browserAgent = createBrowserAgent();
		for (let replay = 0; replay < 2; replay += 1) {
			const sink = createAgentV2BrowserRunSink({
				browserAgent,
				responseLanguage: "en",
				onPresentationChange: vi.fn(),
			});
			projectSuccessfulRun(sink);
		}

		expect(
			browserAgent.state.messages.filter(
				(message) => message.role === "assistant" && message.provider === "openai" && message.model === "gpt-test",
			),
		).toHaveLength(1);
		expect(browserAgent.state.messages.filter((message) => message.role === "agent-v2-run-result")).toHaveLength(1);
		expect(browserAgent.state.messages.some((message) => message.role === "agent-v2-activity")).toBe(false);
	});

	it("keeps Chinese narration and the durable result language fixed for the whole run", () => {
		const browserAgent = createBrowserAgent();
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "zh",
			onPresentationChange: vi.fn(),
		});

		projectSuccessfulRun(sink);

		const narration = browserAgent.state.messages.filter((message) => message.role === "assistant").map(assistantText);
		expect(narration).toHaveLength(6);
		expect(narration.join("\n")).toContain("我正在按以下方式理解这次任务");
		expect(narration.join("\n")).toContain("现在开始实现");
		expect(narration.join("\n")).toContain("校验已经通过");
		expect(narration.join("\n")).toContain("已生成或更新 1 个文件：index.html");
		expect(narration.join("\n")).not.toContain("Dashboard implementation complete");
		expect(browserAgent.state.messages.find((message) => message.role === "agent-v2-run-result")).toMatchObject({
			responseLanguage: "zh",
		});
	});

	it("types curated narration through streamingMessage and flushes it before settlement", () => {
		vi.useFakeTimers();
		try {
			const browserAgent = createBrowserAgent();
			const onNarrationChange = vi.fn();
			const sink = createAgentV2BrowserRunSink({
				browserAgent,
				responseLanguage: "zh",
				narrationTypingIntervalMs: 10,
				onNarrationChange,
				onPresentationChange: vi.fn(),
			});

			sink.beginRun("run-streaming", START, "生成一个中文仪表盘");
			sink.setPhase("intake", "running", START);
			expect(browserAgent.state.streamingMessage?.role).toBe("assistant");
			expect(assistantText(browserAgent.state.streamingMessage as AgentMessage).length).toBeGreaterThan(0);
			expect(browserAgent.state.messages).toEqual([]);

			vi.advanceTimersByTime(10_000);
			expect(browserAgent.state.streamingMessage).toBeUndefined();
			expect(browserAgent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
			expect(onNarrationChange).toHaveBeenCalled();

			sink.settle("cancelled", END);
			expect(browserAgent.state.isStreaming).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

type BrowserAgentState = {
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: ReadonlySet<string>;
	errorMessage?: string;
};

function createBrowserAgent(): { state: BrowserAgentState } {
	return {
		state: {
			messages: [],
			isStreaming: false,
			pendingToolCalls: new Set(),
		},
	};
}

function projectSuccessfulRun(sink: ReturnType<typeof createAgentV2BrowserRunSink>): void {
	sink.beginRun("run-success", START, "Build a dashboard");
	sink.setPhase("intake", "queued", START);
	sink.setPhase("implementation", "running", START);
	sink.setTask({
		type: "agent_v2.task_updated",
		taskId: "implement",
		kind: "implementation",
		status: "succeeded",
		phase: "implementation",
		at: VALIDATE,
	});
	sink.setPhase("validation", "running", VALIDATE);
	sink.setValidation(validation(1, "passed", VALIDATE));
	sink.setArtifact({
		type: "agent_v2.artifact_indexed",
		artifactId: "artifact-index",
		path: "index.html",
		validationStatus: "passed",
		revision: "1",
		checksum: `sha256:${"a".repeat(64)}`,
		action: "created",
		sourceTaskId: "implement",
		at: VALIDATE,
	});
	sink.appendOutput({
		type: "agent_v2.output_recorded",
		taskId: "implement",
		summary: "Dashboard implementation complete.",
		provider: "openai",
		model: "gpt-test",
		usage: { input: 12, output: 34, totalTokens: 46, costTotal: 0.25 },
		at: OUTPUT,
	});
	sink.setPhase("delivery", "running", OUTPUT);
	sink.setDeliveryReport({
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
		previewUrl: "https://example.test/preview/dashboard/",
		projectId: "dashboard",
		usageInstructions: "Open the preview.",
		at: END,
	});
	sink.settle("succeeded", END);
}

function validation(attempt: number, status: "failed" | "passed", at: string) {
	return {
		type: "agent_v2.validation_recorded" as const,
		validationId: "validation-1",
		taskId: "validate",
		attempt,
		status,
		summary: `${status} validation`,
		at,
	};
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const first = message.content[0];
	return first?.type === "text" ? first.text : "";
}
