import { describe, expect, it } from "vitest";
import {
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
});
