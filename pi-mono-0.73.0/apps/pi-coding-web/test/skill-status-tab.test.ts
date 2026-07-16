import { describe, expect, it } from "vitest";
import { createSkillDiagnosticPresentation, summarizeSkillStatus } from "../src/skill-tools/skill-status-summary.js";

describe("SkillStatusTab", () => {
	it("summarizes configured skills and diagnostics", () => {
		const summary = summarizeSkillStatus({
			skills: [
				{
					name: "frontend-design",
					description: "Use this skill when creating frontend pages. Do not use for backend-only tasks.",
					location: "skill://frontend-design/SKILL.md",
					allowImplicitInvocation: true,
				},
				{
					name: "explicit-design",
					description: "Use this skill only when explicitly selected for design work.",
					location: "skill://explicit-design/SKILL.md",
					allowImplicitInvocation: false,
				},
			],
			diagnostics: [
				{ type: "warning", message: "description is vague", path: "frontend-design/SKILL.md" },
				{ type: "error", message: "name is required", path: "broken/SKILL.md" },
			],
		});

		expect(summary).toEqual({
			availableCount: 2,
			implicitCount: 1,
			explicitOnlyCount: 1,
			issueCount: 2,
			errorCount: 1,
			warningCount: 1,
			collisionCount: 0,
		});
	});

	it("creates expandable diagnostic presentation details with severity styling", () => {
		const warning = createSkillDiagnosticPresentation(
			{
				type: "warning",
				message: 'description should describe non-use boundaries, for example: "Do not use for backend-only tasks."',
				path: "frontend-design/SKILL.md",
			},
			0,
		);
		const error = createSkillDiagnosticPresentation(
			{
				type: "error",
				message: "name is required in SKILL.md YAML frontmatter",
				path: "broken/SKILL.md",
			},
			1,
		);

		expect(warning.key).toBe("warning:frontend-design/SKILL.md:0");
		expect(warning.icon).toBe("warning");
		expect(warning.toneClass).toBe("skill-diagnostic--warning");
		expect(warning.suggestion).toContain("Do not use for");
		expect(error.icon).toBe("error");
		expect(error.toneClass).toBe("skill-diagnostic--error");
		expect(error.suggestion).toContain("YAML frontmatter");
	});
});
