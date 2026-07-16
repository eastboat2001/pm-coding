import { describe, expect, it } from "vitest";
import {
	formatSkillLoadResult,
	prepareSkillLoadArguments,
	prepareSkillResourceArguments,
	skillLoadSchema,
	skillResourceSchema,
} from "../src/skill-tool-contract.js";
import type { SkillLoadResult } from "../src/types.js";

describe("skill tool contract", () => {
	it("prepares skill_load arguments from nested aliases", () => {
		expect(prepareSkillLoadArguments({ arguments: { skillName: "ui-polish" } })).toEqual({
			name: "ui-polish",
		});
	});

	it("tells models to use only listed skill names", () => {
		const description = schemaDescription(skillLoadSchema.properties.name);
		expect(description).toContain("Only use a name listed in <available_skills>");
		expect(description).not.toContain("ui-polish");
	});

	it("prepares skill_resource arguments from JSON aliases", () => {
		expect(
			prepareSkillResourceArguments(
				JSON.stringify({
					skill: "ui-polish",
					resourcePath: "references/rules.md",
				}),
			),
		).toEqual({
			name: "ui-polish",
			path: "references/rules.md",
		});
	});

	it("tells models to read only exact resource paths returned by skill_load", () => {
		const description = schemaDescription(skillResourceSchema.properties.path);

		expect(description).toContain("exactly match one of the resource paths returned by skill_load");
		expect(description).toContain("Do not invent");
		expect(description).not.toContain("such as references/rules.md");
	});

	it("rejects missing skill tool arguments with stable messages", () => {
		expect(() => prepareSkillLoadArguments({ arguments: {} })).toThrow('skill_load requires: {"name":"skill-name"}');
		expect(() => prepareSkillResourceArguments({ name: "ui-polish" })).toThrow(
			'skill_resource requires: {"name":"skill-name","path":"references/file.md"}',
		);
	});

	it("formats skill load results for both server-direct and app tools", () => {
		const result: SkillLoadResult = {
			name: 'ui<&"polish',
			description: "Improve UI",
			location: 'C:\\Skills\\ui<&"polish',
			allowImplicitInvocation: true,
			interface: {
				displayName: "UI Polish",
				shortDescription: "Make the interface production ready.",
				defaultPrompt: "Audit visible screens.",
			},
			content: "# Skill\nUse careful spacing.",
			resources: [{ path: "references/rules.md", size: 42 }],
		};

		expect(formatSkillLoadResult(result)).toBe(
			[
				'Skill: ui<&"polish',
				"Display name: UI Polish",
				"Short description: Make the interface production ready.",
				"Default prompt: Audit visible screens.",
				"Use skill_resource only for exact paths listed under Available skill resources below. The Skill location and SKILL.md are not resource paths.",
				'<skill name="ui&lt;&amp;&quot;polish">',
				"# Skill\nUse careful spacing.",
				"</skill>",
				"",
				"",
				"Available skill resources:",
				"- references/rules.md (42 bytes)",
			].join("\n"),
		);
	});

	it("explicitly forbids resource calls when a loaded skill lists no resources", () => {
		const result: SkillLoadResult = {
			name: "no-resources",
			description: "No resources",
			location: "skill://no-resources/SKILL.md",
			allowImplicitInvocation: true,
			content: "# Skill\nFollow these instructions.",
			resources: [],
		};

		const formatted = formatSkillLoadResult(result);

		expect(formatted).toContain("Available skill resources: none");
		expect(formatted).toContain("Do not call skill_resource for this Skill");
		expect(formatted).not.toContain("skill://no-resources/SKILL.md");
	});
});

function schemaDescription(schema: object): string {
	const description = "description" in schema ? schema.description : undefined;
	return typeof description === "string" ? description : "";
}
