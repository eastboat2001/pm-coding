import { describe, expect, it } from "vitest";
import { formatSkillCatalog, implicitSkills, skillCatalogBudgetChars } from "../src/skill-tools/catalog.js";
import type { SkillSummary } from "../src/skill-tools/schemas.js";

function skill(name: string, allowImplicitInvocation = true, description = `Use when handling ${name}.`): SkillSummary {
	return {
		name,
		description,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation,
	};
}

describe("Chat skill catalog", () => {
	it("derives a deterministic implicit catalog", () => {
		expect(implicitSkills([skill("zeta"), skill("explicit-only", false), skill("alpha")])).toEqual([
			expect.objectContaining({ name: "alpha" }),
			expect.objectContaining({ name: "zeta" }),
		]);
	});

	it("emits no catalog when no skill allows implicit invocation", () => {
		expect(formatSkillCatalog([skill("explicit-only", false)], 128_000)).toBe("");
	});

	it("discloses metadata only and escapes structured values", () => {
		const output = formatSkillCatalog(
			[skill("safe-skill", true, "Use when A < B & the task matches. Do not expose full instructions.")],
			128_000,
		);

		expect(output).toContain("safe-skill");
		expect(output).not.toContain("skill://safe-skill/SKILL.md");
		expect(output).toContain("A &lt; B &amp; the task matches");
		expect(output).not.toContain("resources");
		expect(output).not.toContain("SKILL.md content");
	});

	it("stays inside the exact budget and omits only complete trailing entries", () => {
		const skills = Array.from({ length: 30 }, (_, index) =>
			skill(`skill-${String(index).padStart(2, "0")}`, true, `Use when task ${index} matches. ${"detail ".repeat(20)}`),
		);
		const contextWindowTokens = 10_000;
		const budget = skillCatalogBudgetChars(contextWindowTokens);
		const output = formatSkillCatalog(skills, contextWindowTokens);

		expect(budget).toBe(800);
		expect(output.length).toBeLessThanOrEqual(budget);
		expect(output).toContain("skills omitted");
		expect(output.match(/<skill>/g)?.length).toBe(output.match(/<\/skill>/g)?.length);
		expect(output).toBe(formatSkillCatalog([...skills].reverse(), contextWindowTokens));
	});

	it("caps large context windows at 8000 characters", () => {
		expect(skillCatalogBudgetChars(1_000_000)).toBe(8_000);
	});
});
