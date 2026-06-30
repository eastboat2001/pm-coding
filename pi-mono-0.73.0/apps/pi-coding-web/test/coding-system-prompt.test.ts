import { describe, expect, it } from "vitest";
import {
	buildCodingSystemPrompt,
	DEFAULT_SYSTEM_PROMPT,
	PI_CODING_HANDOFF_INSTRUCTIONS_EN,
} from "../src/prompts/coding-system-prompt.js";

describe("coding system prompt", () => {
	it("tells the model to read omitted project file content before editing existing files", () => {
		const prompts = [
			["default", DEFAULT_SYSTEM_PROMPT],
			["handoff", PI_CODING_HANDOFF_INSTRUCTIONS_EN],
		] as const;

		for (const [name, prompt] of prompts) {
			expect(prompt, name).toContain("project_file get");
			expect(prompt, name).toContain("project_file content omitted");
		}
	});

	it("includes OpenAI-style skill interface metadata when present", () => {
		const prompt = buildCodingSystemPrompt([
			{
				name: "page-style",
				description: "Create static pages with a distinctive visual system.",
				location: "skill://page-style/SKILL.md",
				interface: {
					displayName: "Page Style",
					shortDescription: "Distinctive static page design",
					defaultPrompt: "Use $page-style to design a static landing page.",
				},
			},
		]);

		expect(prompt).toContain("<display_name>Page Style</display_name>");
		expect(prompt).toContain("<short_description>Distinctive static page design</short_description>");
		expect(prompt).toContain("<default_prompt>Use $page-style to design a static landing page.</default_prompt>");
	});

	it("keeps assistant and generated UI language aligned with the user request", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Match the latest user request language");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("without switching the output language");
	});

	it("does not invite skill tool calls when no skills are listed", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Only call skill_load for skill names listed in <available_skills>");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("If there is no <available_skills> section");
	});

	it("tells the model to read document attachments from project workspace paths", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("User attachments are saved into the current session project workspace");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Ordinary document and image attachments are also included in the message context");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("attachments/*.md or docs/*.md");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("only when a prompt explicitly lists");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("attachments/original");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Do not call project_file get with an ordinary attachment filename");
	});
});
