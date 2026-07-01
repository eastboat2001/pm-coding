import { describe, expect, it } from "vitest";
import {
	providerStallStatusDelayMs,
	providerStallStatusText,
	selectRunTransientStatusText,
	shouldClearProviderStallStatusForRunEvent,
	shouldScheduleProviderStallStatusAfterRunEvent,
} from "../src/runtime/run-transient-status.js";

describe("run transient status", () => {
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
