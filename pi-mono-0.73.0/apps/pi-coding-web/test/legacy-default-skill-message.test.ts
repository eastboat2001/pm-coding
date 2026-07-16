import { describe, expect, it } from "vitest";

describe("legacy default skill load messages", () => {
	it("registers a read-only renderer without exposing message creation helpers", async () => {
		stubBrowserCanvasGlobals();
		const legacy = await import("../src/skill-tools/legacy-default-skill-message.js");
		const { getMessageRenderer } = await import("@mariozechner/pi-web-ui");

		legacy.registerLegacyDefaultSkillLoadMessageRenderer();

		expect(getMessageRenderer("default-skill-load")).toBeDefined();
		expect(legacy).not.toHaveProperty("createDefaultSkillLoadMessage");
		expect(legacy).not.toHaveProperty("loadDefaultSkillLoadMessages");
		expect(legacy).not.toHaveProperty("enqueueDefaultSkillLoadMessages");
	});
});

function stubBrowserCanvasGlobals(): void {
	if (!globalThis.DOMMatrix) {
		(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {};
	}
}
