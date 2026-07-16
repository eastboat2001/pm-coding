import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerSkillList } from "../src/skill-tools/client.js";
import {
	expandSkillCommandsInMessages,
	getLatestExplicitSkillNames,
	parseSkillCommandPrefix,
	validateSelectedSkillNames,
} from "../src/skill-tools/skill-command.js";
import type { SkillLoadDetails } from "../src/skill-tools/schemas.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function loadedSkill(name: string, content = `# ${name}\n\nApply ${name}.`): SkillLoadDetails {
	return {
		name,
		description: `Use when ${name} is explicitly selected.`,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation: false,
		content,
		resources: [],
	};
}

describe("parseSkillCommandPrefix", () => {
	it("parses multiple skill prefixes before user text", () => {
		const parsed = parseSkillCommandPrefix("/skill:ui-polish /skill:api-mock please improve this");

		expect(parsed?.skillNames).toEqual(["ui-polish", "api-mock"]);
		expect(parsed?.args).toBe("please improve this");
	});

	it("returns undefined when the message does not start with a skill prefix", () => {
		expect(parseSkillCommandPrefix("please use /skill:ui-polish")).toBeUndefined();
	});

	it("reports skill list API failures as diagnostics instead of an empty success state", async () => {
		vi.stubGlobal("window", { location: { origin: "http://pi.test" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "disk unavailable" }), {
					status: 500,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const skillList = await loadServerSkillList();

		expect(skillList.skills).toEqual([]);
		expect(skillList).not.toHaveProperty("defaultSkills");
		expect(skillList).not.toHaveProperty("promptSkills");
		expect(skillList.diagnostics).toEqual([
			expect.objectContaining({ type: "error", path: "/api/pi-skills", message: expect.stringContaining("disk unavailable") }),
		]);
	});

	it("expands explicitly selected skills as mandatory current-prompt instructions", async () => {
		const loadSkill = vi.fn((name: string) => loadedSkill(name));
		const expanded = await expandSkillCommandsInMessages(
			[{ role: "user", content: "/skill:ui-polish /skill:brand-style build the page" }],
			{
				availableSkillNames: ["ui-polish", "brand-style"],
				loadSkill,
			},
		);
		const content = expanded[0].content as string;

		expect(content).toContain("<explicitly_selected_skills>");
		expect(content).toContain("- ui-polish");
		expect(content).toContain("- brand-style");
		expect(content.indexOf('<skill name="ui-polish"')).toBeLessThan(content.indexOf('<skill name="brand-style"'));
		expect(content).toContain("User request:\nbuild the page");
		expect(content).toContain("Available skill resources: none");
		expect(content).not.toContain('location="skill://');
		expect(loadSkill).toHaveBeenCalledTimes(2);
	});

	it("rejects an unknown explicit name before calling the loader", async () => {
		const loadSkill = vi.fn((name: string) => loadedSkill(name));

		await expect(
			expandSkillCommandsInMessages([{ role: "user", content: "/skill:invented build the page" }], {
				availableSkillNames: ["known-skill"],
				loadSkill,
			}),
		).rejects.toThrow(/unknown selected skill: invented/i);
		expect(loadSkill).not.toHaveBeenCalled();
	});

	it("does not re-expand a historical explicit skill for a later plain prompt", async () => {
		const loadSkill = vi.fn((name: string) => loadedSkill(name));
		const messages = [
			{ role: "user" as const, content: "/skill:old-skill old task" },
			{ role: "assistant" as const, content: "done" },
			{ role: "user" as const, content: "new unrelated task" },
		];

		const expanded = await expandSkillCommandsInMessages(messages, {
			availableSkillNames: ["old-skill"],
			loadSkill,
		});

		expect(expanded).toBe(messages);
		expect(loadSkill).not.toHaveBeenCalled();
	});

	it("extracts explicit names only from the latest user message", () => {
		expect(
			getLatestExplicitSkillNames([
				{ role: "user", content: "/skill:old-skill old task" },
				{ role: "assistant", content: "done" },
				{ role: "user", content: "/skill:frontend-design /skill:style-neon-console build a page" },
			]),
		).toEqual(["frontend-design", "style-neon-console"]);
	});

	it("validates selected names against the complete catalog before submission", () => {
		expect(validateSelectedSkillNames(["explicit-only"], ["implicit", "explicit-only"])).toEqual([
			"explicit-only",
		]);
		expect(() => validateSelectedSkillNames(["invented"], ["implicit", "explicit-only"])).toThrow(
			/unknown selected skill: invented/i,
		);
	});

	it("adds a Chinese language hint for a Chinese current request", async () => {
		const expanded = await expandSkillCommandsInMessages(
			[{ role: "user", content: "/skill:style-neon-console 生成一个个人介绍" }],
			{
				availableSkillNames: ["style-neon-console"],
				loadSkill: (name) => loadedSkill(name),
			},
		);
		const content = expanded[0].content as string;

		expect(content).toContain("Detected user request language: Chinese. Reply in Chinese");
		expect(content).toContain("User request:\n生成一个个人介绍");
	});

	it("aborts explicit expansion without returning partial instructions", async () => {
		const controller = new AbortController();

		await expect(
			expandSkillCommandsInMessages(
				[{ role: "user", content: "/skill:first /skill:second build" }],
				{
					availableSkillNames: ["first", "second"],
					loadSkill: (name) => {
						if (name === "first") controller.abort();
						return loadedSkill(name);
					},
					signal: controller.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
