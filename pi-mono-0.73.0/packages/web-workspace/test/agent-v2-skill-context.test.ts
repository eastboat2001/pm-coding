import { describe, expect, it, vi } from "vitest";
import { AgentV2SkillContextError, loadAgentV2SkillContext } from "../src/agent-v2-skill-context.js";

function skill(name: string, content: string, resources: Array<{ path: string; size: number }> = []) {
	return {
		name,
		description: `${name} description`,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation: false,
		content,
		resources,
	};
}

describe("agent v2 skill context", () => {
	it("loads only explicitly selected skills including explicit-only entries", () => {
		const load = vi.fn(() =>
			skill("ui-polish", "Use the palette in references/colors.md", [
				{ path: "references/colors.md", size: 20 },
				{ path: "references/unused.md", size: 20 },
			]),
		);
		const readResource = vi.fn(({ name, path }: { name: string; path: string }) => ({
			name,
			path,
			content: "Primary color is blue.",
			size: 22,
		}));
		const context = loadAgentV2SkillContext({
			selectedSkillNames: ["ui-polish", "ui-polish"],
			skills: {
				list: () => ({
					skills: [
						{ ...skill("ui-polish", ""), content: undefined },
						{ ...skill("unselected-skill", ""), content: undefined },
					],
					diagnostics: [],
				}),
				load,
				readResource,
			},
		});

		expect(context.skills.map((item) => item.name)).toEqual(["ui-polish"]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith({ name: "ui-polish" });
		expect(context.resources).toEqual([
			expect.objectContaining({
				skillName: "ui-polish",
				path: "references/colors.md",
				content: "Primary color is blue.",
			}),
		]);
		expect(readResource).toHaveBeenCalledTimes(1);
		expect(readResource).not.toHaveBeenCalledWith(expect.objectContaining({ path: "references/unused.md" }));
	});

	it("fails explicitly when a browser-selected skill is not server-authorized", () => {
		expect(() =>
			loadAgentV2SkillContext({
				selectedSkillNames: ["attacker-skill"],
				skills: {
					list: () => ({ skills: [], diagnostics: [] }),
					load: vi.fn(),
					readResource: vi.fn(),
				},
			}),
		).toThrow(AgentV2SkillContextError);
		try {
			loadAgentV2SkillContext({
			selectedSkillNames: ["attacker-skill"],
			skills: {
				list: () => ({ skills: [], diagnostics: [] }),
					load: vi.fn(),
					readResource: vi.fn(),
				},
			});
		} catch (error) {
			expect(error).toMatchObject({ code: "skill_not_authorized" });
			expect(String(error)).not.toContain("SKILL.md content");
		}
	});
});
