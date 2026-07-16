import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	appendAgentV2ActivityMessage,
	createAgentV2ActivityMessage,
	formatAgentV2DeliveryReport,
	formatAgentV2FailureReport,
} from "../src/runtime/agent-v2-activity-message.js";
import type { SerializedAgentV2TerminalRunPresentation } from "../src/runtime/agent-v2-run-presentation.js";

const NOW = "2026-07-15T00:00:00.000Z";

beforeAll(() => {
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

describe("Agent v2 activity messages", () => {
	it("creates durable custom-role activity records and de-duplicates replay by event identity", () => {
		const event = {
			type: "agent_v2.artifact_indexed" as const,
			artifactId: "file:index.html",
			path: "index.html",
			validationStatus: "passed" as const,
			revision: `sha256:${"a".repeat(64)}`,
			checksum: `sha256:${"a".repeat(64)}`,
			action: "created" as const,
			sourceTaskId: "implement",
			at: NOW,
		};
		const first = createAgentV2ActivityMessage(event, "run-1");
		const replay = createAgentV2ActivityMessage(event, "run-1");
		const messages = appendAgentV2ActivityMessage([] as AgentMessage[], first);

		expect(first).toMatchObject({
			role: "agent-v2-activity",
			runId: "run-1",
			activity: event,
			timestamp: Date.parse(NOW),
		});
		expect(replay.id).toBe(first.id);
		expect(appendAgentV2ActivityMessage(messages, replay)).toBe(messages);
		expect(JSON.stringify(first)).not.toMatch(/toolCall|toolResult|agent_start|message_end|agent_end/);
	});

	it("formats a localized, fact-based successful delivery report", () => {
		const text = formatAgentV2DeliveryReport(
			{
				type: "agent_v2.delivery_reported",
				taskId: "deliver",
				completedSummary: "已完成静态仪表盘。",
				appliedSkills: ["ui-polish"],
				createdFiles: ["index.html"],
				updatedFiles: ["src/app.js"],
				validationStatus: "passed",
				buildStatus: "not_required",
				previewStatus: "running",
				previewUrl: "http://localhost/preview/demo/",
				projectId: "demo",
				usageInstructions: "Open the preview URL to use and review the generated application.",
				at: NOW,
			},
			"zh-CN",
		);

		expect(text).toContain("完成摘要");
		expect(text).toContain("所用 Skills：ui-polish");
		expect(text).toContain("创建文件：index.html");
		expect(text).toContain("修改文件：src/app.js");
		expect(text).toContain("校验状态：通过");
		expect(text).toContain("构建状态：无需构建");
		expect(text).toContain("预览 URL：http://localhost/preview/demo/");
		expect(text).toContain("使用说明：打开预览 URL 即可使用和检查已生成的应用。");
	});

	it("formats failure progress, cause, remaining work, and suggestions without inventing success", () => {
		const text = formatAgentV2FailureReport(
			{
				failureStage: "validation",
				failureTask: "validate",
				completedItems: ["实现：已完成", "校验：失败"],
				failureCause: "index.html 缺少入口脚本。",
				repairAttempts: 1,
				diagnostics: ["static.missing_entry: 缺少入口"],
				unpassedValidations: ["static validation: failed"],
				safeToRetry: true,
				remainingItems: ["修复入口脚本", "重新校验", "发布预览"],
				nextSuggestions: ["检查 script src 路径后重试。"],
				appliedSkills: ["ui-polish"],
				createdFiles: ["index.html"],
				updatedFiles: [],
			},
			"zh",
		);

		expect(text).toContain("执行失败");
		expect(text).toContain("已完成进度");
		expect(text).toContain("失败阶段：validation");
		expect(text).toContain("失败任务：validate");
		expect(text).toContain("失败原因：index.html 缺少入口脚本。");
		expect(text).toContain("Repair 次数：1");
		expect(text).toContain("可安全重试：是");
		expect(text).toContain("剩余事项：修复入口脚本、重新校验、发布预览");
		expect(text).toContain("后续建议：检查 script src 路径后重试。");
		expect(text).not.toContain("预览已就绪");
	});
});

describe("Agent v2 durable run results", () => {
	it("uses a stable run ID and appends or replaces one JSON-safe terminal presentation", async () => {
		const {
			appendOrReplaceAgentV2RunResultMessage,
			createAgentV2RunResultMessage,
			renderAgentV2RunResultMessage,
		} = await import(
			"../src/runtime/agent-v2-run-result-message.js"
		);
		const presentation = terminalPresentation("succeeded");
		const first = createAgentV2RunResultMessage(presentation);
		const replacement = createAgentV2RunResultMessage({ ...presentation, status: "failed" });
		const appended = appendOrReplaceAgentV2RunResultMessage([] as AgentMessage[], first);
		const replaced = appendOrReplaceAgentV2RunResultMessage(appended, replacement);

		expect(first).toMatchObject({
			role: "agent-v2-run-result",
			id: "agent-v2-run-result:run-1",
			runId: "run-1",
		});
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatchObject({ id: first.id, presentation: { status: "failed" } });
		expect(() => JSON.stringify(replaced[0])).not.toThrow();
		expect(JSON.stringify(replaced[0])).not.toContain("Map");
		const rendered = renderAgentV2RunResultMessage(first) as unknown as { strings: readonly string[]; values: unknown[] };
		expect(rendered.strings.join("")).toContain("<agent-v2-progress-card");
		expect(rendered.values).toContain(presentation);
		expect(rendered.values).toContain(true);
	});

	it("routes historical detail expansion through renderer coordination callbacks", async () => {
		const { createAgentV2RunResultMessage, renderAgentV2RunResultMessage } = await import(
			"../src/runtime/agent-v2-run-result-message.js"
		);
		const message = createAgentV2RunResultMessage(terminalPresentation("succeeded"));
		const onSectionChange = vi.fn();
		const rendered = renderAgentV2RunResultMessage(message, {
			expandedSectionForRun: (runId) => (runId === "run-1" ? "technical" : null),
			onSectionChange,
		}) as unknown as { values: unknown[] };

		expect(rendered.values).toContain("technical");
		const callback = rendered.values.find((value) => typeof value === "function") as
			| ((section: string | null) => void)
			| undefined;
		callback?.("files");
		expect(onSectionChange).toHaveBeenCalledWith("run-1", "files");
	});

	it("keeps an explicitly named legacy read-only activity renderer registration", async () => {
		const { registerLegacyAgentV2ActivityMessageRenderer } = await import(
			"../src/runtime/agent-v2-activity-renderer.js"
		);
		expect(registerLegacyAgentV2ActivityMessageRenderer).toBeTypeOf("function");
	});
});

function terminalPresentation(
	status: SerializedAgentV2TerminalRunPresentation["status"],
): SerializedAgentV2TerminalRunPresentation {
	return {
		runId: "run-1",
		status,
		phase: status === "failed" ? "failed" : "delivery",
		stage: "delivery",
		active: false,
		startedAt: NOW,
		updatedAt: NOW,
		endedAt: NOW,
		tasks: [],
		artifacts: [],
		validations: [],
		diagnostics: [],
		outputs: [],
		skills: [],
		resources: [],
	};
}
