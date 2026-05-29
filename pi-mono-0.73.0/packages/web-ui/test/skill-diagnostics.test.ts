import { describe, expect, it } from "vitest";
import {
	countSkillDiagnostics,
	formatSkillDiagnosticDetail,
	highestSkillDiagnosticType,
} from "../src/components/skill-diagnostics.js";

describe("skill diagnostics", () => {
	it("counts diagnostics by type and returns the highest severity", () => {
		const diagnostics = [
			{ type: "warning", message: "description is vague", path: "vague/SKILL.md" },
			{ type: "collision", message: "name collision", path: "duplicate/SKILL.md" },
			{ type: "error", message: "description is required", path: "broken/SKILL.md" },
		] as const;

		expect(countSkillDiagnostics(diagnostics)).toEqual({
			error: 1,
			warning: 1,
			collision: 1,
			total: 3,
		});
		expect(highestSkillDiagnosticType(diagnostics)).toBe("error");
	});

	it("formats full diagnostic details without truncating long messages", () => {
		const longMessage =
			'description should describe non-use boundaries, such as "Do not use for backend-only tasks, data-only tasks, or documentation-only tasks unless UI behavior is explicitly requested."';
		const detail = formatSkillDiagnosticDetail({
			type: "warning",
			message: longMessage,
			path: "frontend-design/SKILL.md",
		});

		expect(detail).toContain(longMessage);
		expect(detail).toContain("frontend-design/SKILL.md");
	});
});
