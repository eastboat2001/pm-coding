import { describe, expect, it } from "vitest";
import {
	formatSkillLoadResult,
	prepareSkillLoadArguments,
	prepareSkillResourceArguments,
} from "../src/skill-tool-contract.js";
import type { SkillLoadResult } from "../src/types.js";

describe("skill tool contract", () => {
	it("prepares skill_load arguments from nested aliases", () => {
		expect(prepareSkillLoadArguments({ arguments: { skillName: "ui-polish" } })).toEqual({
			name: "ui-polish",
		});
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
			disableModelInvocation: false,
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
				'Location: C:\\Skills\\ui<&"polish',
				"Default prompt: Audit visible screens.",
				"References are relative to this skill. Use skill_resource to read listed relative resources when needed.",
				'<skill name="ui&lt;&amp;&quot;polish" location="C:\\Skills\\ui&lt;&amp;&quot;polish">',
				"# Skill\nUse careful spacing.",
				"</skill>",
				"",
				"",
				"Available skill resources:",
				"- references/rules.md (42 bytes)",
			].join("\n"),
		);
	});
});
