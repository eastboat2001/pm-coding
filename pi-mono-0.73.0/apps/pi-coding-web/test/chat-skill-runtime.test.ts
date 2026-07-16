import { describe, expect, it, vi } from "vitest";
import { createChatSkillRuntime, type ChatSkillLoader } from "../src/skill-tools/chat-skill-runtime.js";
import type { SkillLoadDetails, SkillSummary } from "../src/skill-tools/schemas.js";

vi.mock("../src/skill-tools/renderers.js", () => ({ registerSkillToolRenderers: vi.fn() }));

function summary(name: string, allowImplicitInvocation: boolean): SkillSummary {
	return {
		name,
		description: `Use when ${name} matches. Do not use for unrelated work.`,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation,
	};
}

function loaded(name: string): SkillLoadDetails {
	return {
		...summary(name, false),
		content: `# ${name}\n\nApply this skill.`,
		resources: [{ path: "references/guide.md", size: 10 }],
	};
}

describe("Chat skill runtime snapshot", () => {
	it("creates a tool-free snapshot for an empty catalog", async () => {
		const loadSkill = vi.fn<ChatSkillLoader>();
		const runtime = await createChatSkillRuntime({
			skills: [],
			input: "生成贪吃蛇游戏",
			contextWindowTokens: 128_000,
			loadSkill,
		});

		expect(runtime.tools).toEqual([]);
		expect(runtime.systemPrompt).not.toContain("skill_load");
		expect(loadSkill).not.toHaveBeenCalled();
	});

	it("preloads an explicit-only skill once and exposes resource only", async () => {
		const loadSkill = vi.fn<ChatSkillLoader>().mockResolvedValue(loaded("explicit-only"));
		const runtime = await createChatSkillRuntime({
			skills: [summary("explicit-only", false)],
			input: "/skill:explicit-only build the page",
			contextWindowTokens: 128_000,
			loadSkill,
		});
		const transformed = await runtime.transformMessages([
			{ role: "user", content: "/skill:explicit-only build the page" },
		]);

		expect(runtime.explicitSkillNames).toEqual(["explicit-only"]);
		expect(runtime.tools.map((tool) => tool.name)).toEqual(["skill_resource"]);
		expect(transformed[0].content).toContain("# explicit-only");
		expect(loadSkill).toHaveBeenCalledTimes(1);
	});

	it("rejects an unknown explicit name before loading", async () => {
		const loadSkill = vi.fn<ChatSkillLoader>();

		await expect(
			createChatSkillRuntime({
				skills: [summary("known", true)],
				input: "/skill:invented build",
				contextWindowTokens: 128_000,
				loadSkill,
			}),
		).rejects.toThrow(/unknown selected skill: invented/i);
		expect(loadSkill).not.toHaveBeenCalled();
	});

	it("keeps disclosure and authorization on an immutable catalog copy", async () => {
		const skills = [summary("stable", true)];
		const runtime = await createChatSkillRuntime({
			skills,
			input: "plain request",
			contextWindowTokens: 128_000,
			loadSkill: vi.fn<ChatSkillLoader>(),
		});
		skills[0] = summary("mutated", true);

		expect(runtime.systemPrompt).toContain("stable");
		expect(runtime.systemPrompt).not.toContain("mutated");
		expect(runtime.tools.find((tool) => tool.name === "skill_load")?.description).toContain("stable");
	});
});
