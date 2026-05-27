import { describe, expect, it } from "vitest";
import {
	buildCodingSystemPrompt,
	DEFAULT_SYSTEM_PROMPT,
	PI_CODING_HANDOFF_INSTRUCTIONS_BY_LANGUAGE,
} from "../src/prompts/coding-system-prompt.js";

describe("coding system prompt", () => {
	it("tells the model to read omitted project file content before editing existing files", () => {
		const prompts = [
			["default", DEFAULT_SYSTEM_PROMPT],
			...Object.entries(PI_CODING_HANDOFF_INSTRUCTIONS_BY_LANGUAGE),
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
});
