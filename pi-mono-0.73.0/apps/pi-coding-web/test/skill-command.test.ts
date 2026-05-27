import { describe, expect, it } from "vitest";
import { parseSkillCommandPrefix } from "../src/skill-tools/skill-command.js";

describe("parseSkillCommandPrefix", () => {
	it("parses multiple skill prefixes before user text", () => {
		const parsed = parseSkillCommandPrefix("/skill:ui-polish /skill:api-mock please improve this");

		expect(parsed?.skillNames).toEqual(["ui-polish", "api-mock"]);
		expect(parsed?.args).toBe("please improve this");
	});

	it("returns undefined when the message does not start with a skill prefix", () => {
		expect(parseSkillCommandPrefix("please use /skill:ui-polish")).toBeUndefined();
	});
});
