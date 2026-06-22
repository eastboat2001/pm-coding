import { describe, expect, it } from "vitest";
import { runConnectionStatusText } from "../src/runtime/run-connection-status.js";

describe("run connection status", () => {
	it("formats offline and restored connection status text", () => {
		expect(runConnectionStatusText("offline")).toBe("Network connection lost. Waiting to reconnect...");
		expect(runConnectionStatusText("online_syncing")).toBe("Network restored. Syncing run status...");
		expect(runConnectionStatusText("run_reconnecting")).toBe(
			"Run connection interrupted. Restoring updates...",
		);
		expect(runConnectionStatusText("run_reconnected")).toBe(
			"Run updates reconnected. Syncing status...",
		);
		expect(runConnectionStatusText("offline", (label) => `ZH:${label}`)).toBe(
			"ZH:Network connection lost. Waiting to reconnect...",
		);
	});
});
