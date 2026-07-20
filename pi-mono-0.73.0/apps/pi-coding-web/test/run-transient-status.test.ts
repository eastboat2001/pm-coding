import { describe, expect, it } from "vitest";
import {
	AGENT_V2_RUN_ACTIVITY_TICK_MS,
	AGENT_V2_RUN_NO_PROGRESS_WARNING_MS,
	agentV2RunActivityStatusText,
	providerStallStatusDelayMs,
	providerStallStatusText,
	selectRunTransientStatusText,
	shouldClearProviderStallStatusForRunEvent,
	shouldScheduleProviderStallStatusAfterRunEvent,
} from "../src/runtime/run-transient-status.js";

describe("run transient status", () => {
	it("shows immediate localized activity with an elapsed-time heartbeat for each generation phase", () => {
		expect(AGENT_V2_RUN_ACTIVITY_TICK_MS).toBe(1_000);
		expect(agentV2RunActivityStatusText("implementation", 12_900, "zh")).toBe(
			"模型正在生成页面结构和核心内容… (12s)",
		);
		expect(agentV2RunActivityStatusText("implementation", 20_000, "zh")).toContain("模拟数据和交互逻辑");
		expect(agentV2RunActivityStatusText("implementation", 50_000, "zh")).toContain("检查输出格式");
		expect(agentV2RunActivityStatusText("implementation", 95_000, "zh")).toContain("仍在生成完整结果");
		expect(agentV2RunActivityStatusText("validation", 5_000, "en")).toBe(
			"Checking the generated result and addressing issues… (5s)",
		);
		expect(agentV2RunActivityStatusText("delivery", Number.NaN, "de")).toContain("(0s)");
		expect(agentV2RunActivityStatusText("intake", -1, "ms")).toContain("(0s)");
	});

	it("stops claiming the model is still working after prolonged absence of progress", () => {
		expect(AGENT_V2_RUN_NO_PROGRESS_WARNING_MS).toBe(180_000);
		expect(agentV2RunActivityStatusText("implementation", 734_000, "zh")).toContain(
			"Worker 或模型连接可能已经中断",
		);
		expect(agentV2RunActivityStatusText("implementation", 734_000, "en")).not.toContain(
			"model is still completing",
		);
	});

	it("formats provider stalled status as neutral model processing feedback", () => {
		expect(providerStallStatusText()).toBe(
			"Model is still processing. Tool calls or long context steps may pause visible output briefly.",
		);
		expect(providerStallStatusText((label) => `ZH:${label}`)).toBe(
			"ZH:Model is still processing. Tool calls or long context steps may pause visible output briefly.",
		);
	});

	it("keeps connection and retry statuses above provider stalled status", () => {
		expect(
			selectRunTransientStatusText({
				providerStalled: "provider stalled",
			}),
		).toBe("provider stalled");

		expect(
			selectRunTransientStatusText({
				retry: "retrying",
				providerStalled: "provider stalled",
			}),
		).toBe("retrying");

		expect(
			selectRunTransientStatusText({
				connection: "run reconnecting",
				retry: "retrying",
				providerStalled: "provider stalled",
			}),
		).toBe("run reconnecting");
	});

	it("delays provider processing status relative to the backend stream idle timeout", () => {
		expect(providerStallStatusDelayMs(120_000)).toBe(30_000);
		expect(providerStallStatusDelayMs(60_000)).toBe(30_000);
		expect(providerStallStatusDelayMs(10_000)).toBe(5_000);
		expect(providerStallStatusDelayMs(2_000)).toBe(1_000);
	});

	it("does not schedule provider stalled status while a tool is executing", () => {
		expect(shouldClearProviderStallStatusForRunEvent("tool_execution_start")).toBe(true);
		expect(shouldScheduleProviderStallStatusAfterRunEvent("tool_execution_start")).toBe(false);
		expect(shouldScheduleProviderStallStatusAfterRunEvent("tool_execution_end")).toBe(true);
		expect(shouldScheduleProviderStallStatusAfterRunEvent("message_update")).toBe(true);
		expect(shouldScheduleProviderStallStatusAfterRunEvent("agent_end")).toBe(false);
	});
});
