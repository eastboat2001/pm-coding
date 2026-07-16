import { describe, expect, it } from "vitest";
import { createChatSystemPrompt } from "../src/skill-tools/chat-system-prompt.js";
import type { SkillSummary } from "../src/skill-tools/schemas.js";

const implicitSkill: SkillSummary = {
	name: "page-style",
	description: "Use when styling a page. Do not use for backend-only work.",
	location: "skill://page-style/SKILL.md",
	allowImplicitInvocation: true,
};

describe("Chat system prompt", () => {
	it("keeps permanent platform rules without advertising unavailable skill tools", () => {
		const prompt = createChatSystemPrompt([], 128_000);

		expect(prompt).toContain("PI Coding Chat");
		expect(prompt).toContain("Follow the user's requested response language");
		expect(prompt).not.toContain("skill_load");
		expect(prompt).not.toContain("<available_skills>");
	});

	it("adds bounded progressive-disclosure instructions only for implicit skills", () => {
		const prompt = createChatSystemPrompt(
			[
				implicitSkill,
				{ ...implicitSkill, name: "explicit-only", location: "skill://explicit-only/SKILL.md", allowImplicitInvocation: false },
			],
			128_000,
		);

		expect(prompt).toContain("skill_load");
		expect(prompt).toContain("page-style");
		expect(prompt).not.toContain("explicit-only");
	});
});
