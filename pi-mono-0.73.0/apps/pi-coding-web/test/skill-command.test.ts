import { afterEach, describe, expect, it, vi } from "vitest";
import {
	expandSkillCommandsInMessages,
	getLatestExplicitSkillNames,
	parseSkillCommandPrefix,
} from "../src/skill-tools/skill-command.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseSkillCommandPrefix", () => {
	it("parses multiple skill prefixes before user text", () => {
		const parsed = parseSkillCommandPrefix("/skill:ui-polish /skill:api-mock please improve this");

		expect(parsed?.skillNames).toEqual(["ui-polish", "api-mock"]);
		expect(parsed?.args).toBe("please improve this");
	});

	it("returns undefined when the message does not start with a skill prefix", () => {
		expect(parseSkillCommandPrefix("please use /skill:ui-polish")).toBeUndefined();
	});

	it("expands explicitly selected skills as mandatory multi-skill instructions", async () => {
		vi.stubGlobal("window", { location: { origin: "http://pi.test" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body || "{}")) as { name: string };
				const skills = {
					"ui-polish": {
						name: "ui-polish",
						location: "skill://ui-polish/SKILL.md",
						content: "# UI Polish\n\nUse refined layout and spacing.",
						resources: [],
					},
					"brand-style": {
						name: "brand-style",
						location: "skill://brand-style/SKILL.md",
						content: "# Brand Style\n\nUse the brand visual system.",
						resources: [],
					},
				};
				const skill = skills[body.name as keyof typeof skills];
				return new Response(JSON.stringify(skill), {
					status: skill ? 200 : 404,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const expanded = await expandSkillCommandsInMessages([
			{ role: "user", content: "/skill:ui-polish /skill:brand-style build the page" },
		]);
		const content = expanded[0].content as string;

		expect(content).toContain("<explicitly_selected_skills>");
		expect(content).toContain("The user explicitly selected these PI global skills. They are mandatory");
		expect(content).toContain("- ui-polish");
		expect(content).toContain("- brand-style");
		expect(content).toContain("You must apply every selected skill");
		expect(content.indexOf('<skill name="ui-polish"')).toBeLessThan(content.indexOf('<skill name="brand-style"'));
		expect(content).toContain("<active_skill_checklist>");
		expect(content).toContain("- ui-polish: identify and apply the relevant instructions from this skill.");
		expect(content).toContain("User request:\nbuild the page");
	});

	it("extracts the latest explicit skill names from user messages", () => {
		expect(
			getLatestExplicitSkillNames([
				{ role: "user", content: "/skill:old-skill old task" },
				{ role: "assistant", content: "done" },
				{ role: "user", content: "/skill:frontend-design /skill:style-neon-console build a page" },
			]),
		).toEqual(["frontend-design", "style-neon-console"]);
	});

	it("injects default forced skills into a plain user message", async () => {
		vi.stubGlobal("window", { location: { origin: "http://pi.test" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body || "{}")) as { name: string };
				return new Response(
					JSON.stringify({
						name: body.name,
						location: `skill://${body.name}/SKILL.md`,
						content: "# Platform Defaults\n\nAlways apply PI platform defaults.",
						resources: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const expanded = await expandSkillCommandsInMessages(
			[{ role: "user", content: "build a page" }],
			{ defaultSkillNames: ["platform-defaults"] },
		);
		const content = expanded[0].content as string;

		expect(content).toContain("<required_skills>");
		expect(content).toContain("Server default skills:");
		expect(content).toContain("- platform-defaults");
		expect(content).toContain("These default skills are configured by the PI server and are not user-selectable.");
		expect(content).toContain("User request:\nbuild a page");
	});

	it("injects default forced skills into agent-normalized text content arrays", async () => {
		vi.stubGlobal("window", { location: { origin: "http://pi.test" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body || "{}")) as { name: string };
				return new Response(
					JSON.stringify({
						name: body.name,
						location: `skill://${body.name}/SKILL.md`,
						content: "# Platform Defaults\n\nAlways apply PI platform defaults.",
						resources: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const expanded = await expandSkillCommandsInMessages(
			[
				{
					role: "user",
					content: [{ type: "text", text: "/skill:style-luxury-minimal build a page" }],
					timestamp: 123,
				},
			],
			{ defaultSkillNames: ["platform-defaults"] },
		);
		const content = expanded[0].content as Array<{ type: "text"; text: string }>;

		expect(content[0].text).toContain("<required_skills>");
		expect(content[0].text).toContain("Server default skills:");
		expect(content[0].text).toContain("- platform-defaults");
		expect(content[0].text).toContain("User-selected skills:");
		expect(content[0].text).toContain("- style-luxury-minimal");
		expect(content[0].text).toContain("User request:\nbuild a page");
	});
});
