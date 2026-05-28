import { describe, expect, it } from "vitest";
import { formatProjectTaskResult } from "../src/project-tools/result-format.js";

describe("project_task result formatting", () => {
	it("adds a skill audit reminder to preview results when explicit skills are active", () => {
		const formatted = formatProjectTaskResult(
			{
				task: "preview",
				status: "ok",
				previewUrl: "http://localhost:5173/preview/example/",
			},
			{ activeSkillNames: ["frontend-design", "style-neon-console"] },
		);

		expect(formatted).toContain("Preview URL: http://localhost:5173/preview/example/");
		expect(formatted).toContain("Before finalizing, audit the generated project against all active selected skills:");
		expect(formatted).toContain("- frontend-design");
		expect(formatted).toContain("- style-neon-console");
		expect(formatted).toContain("If any selected skill is not reflected in the current project, update the files and run preview again.");
	});

	it("does not add a skill audit reminder to non-preview results", () => {
		const formatted = formatProjectTaskResult(
			{
				task: "validate",
				status: "ok",
				valid: true,
			},
			{ activeSkillNames: ["frontend-design"] },
		);

		expect(formatted).not.toContain("audit the generated project");
	});
});
