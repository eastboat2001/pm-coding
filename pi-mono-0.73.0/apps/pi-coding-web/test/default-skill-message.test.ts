import { describe, expect, it } from "vitest";

describe("default skill load UI messages", () => {
	it(
		"creates a UI-only loaded-skill message that is not sent to the model",
		async () => {
			stubBrowserCanvasGlobals();
			const { createDefaultSkillLoadMessage } = await import("../src/skill-tools/default-skill-message.js");
			const message = createDefaultSkillLoadMessage(
				{
					name: "pi-default-test",
					description: "Use this skill when testing default skills. Do not use outside tests.",
					location: "skill://pi-default-test/SKILL.md",
					disableModelInvocation: false,
					content: "# PI Default Test",
					resources: [],
				},
				123,
			);

			expect(message).toMatchObject({
				role: "default-skill-load",
				name: "pi-default-test",
				timestamp: 123,
				details: {
					name: "pi-default-test",
					content: "# PI Default Test",
				},
			});
			expect(["user", "assistant", "toolResult"]).not.toContain(message.role);
		},
		10000,
	);

	it("registers a renderer for default skill load messages", async () => {
		stubBrowserCanvasGlobals();
		const { registerDefaultSkillLoadMessageRenderer } = await import(
			"../src/skill-tools/default-skill-message.js"
		);
		const { getMessageRenderer } = await import("@mariozechner/pi-web-ui");
		registerDefaultSkillLoadMessageRenderer();

		expect(getMessageRenderer("default-skill-load")).toBeDefined();
	});
});

function stubBrowserCanvasGlobals(): void {
	if (!globalThis.DOMMatrix) {
		(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {};
	}
}
