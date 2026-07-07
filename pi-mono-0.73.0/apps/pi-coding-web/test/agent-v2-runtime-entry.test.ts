import { describe, expect, it } from "vitest";
import { selectApplicationGenerationRuntime } from "../src/agent-v2/runtime-entry.js";

describe("application generation runtime entry", () => {
	it("selects v2 by default", () => {
		expect(selectApplicationGenerationRuntime({})).toMatchObject({
			version: "v2",
			v1Disabled: true,
		});
	});

	it("rejects v1 as a product runtime", () => {
		expect(() => selectApplicationGenerationRuntime({ requestedVersion: "v1" })).toThrow(
			"v1 is retired",
		);
	});

	it("does not expose v1 as a stable version option", () => {
		expect(selectApplicationGenerationRuntime({ requestedVersion: "v2" })).toMatchObject({
			version: "v2",
			v1Disabled: true,
		});
	});
});
