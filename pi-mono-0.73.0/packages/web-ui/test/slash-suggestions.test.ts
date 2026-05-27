import { describe, expect, it } from "vitest";
import {
	buildSlashSuggestionState,
	getSlashSelection,
	getSlashSelections,
	type SlashSuggestionItem,
} from "../src/components/slash-suggestions.js";

const suggestions: SlashSuggestionItem[] = [
	{
		id: "command-skill",
		label: "skill",
		detail: "Select a global skill.",
		trigger: "/",
		insertText: "/skill",
		keepOpen: true,
		emptyLabel: "No skills available",
		emptyDetail: "Add SKILL.md files under the configured skills directory.",
	},
	{
		id: "skill-ui-polish",
		label: "ui-polish",
		detail: "Improve visual hierarchy.",
		trigger: "/skill",
		insertText: "/skill:ui-polish ",
	},
	{
		id: "skill-api-mock",
		label: "api-mock",
		detail: "Mock API behavior.",
		trigger: "/skill",
		insertText: "/skill:api-mock ",
	},
];

describe("buildSlashSuggestionState", () => {
	it("shows slash commands for /", () => {
		const state = buildSlashSuggestionState("/", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["skill"]);
		expect(state.items[0].insertText).toBe("/skill");
	});

	it("shows all matching skill suggestions for /skill", () => {
		const state = buildSlashSuggestionState("/skill", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
	});

	it("filters skill suggestions after /skill:", () => {
		const state = buildSlashSuggestionState("/skill:ui", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["ui-polish"]);
		expect(state.items[0].insertText).toBe("/skill:ui-polish ");
	});

	it("does not show suggestions after normal text", () => {
		const state = buildSlashSuggestionState("please use /skill", suggestions);

		expect(state.open).toBe(false);
		expect(state.items).toEqual([]);
	});

	it("shows an empty state for /skill when no skills are configured", () => {
		const state = buildSlashSuggestionState("/", suggestions);
		const emptySkillState = buildSlashSuggestionState(state.items[0].insertText, [suggestions[0]]);

		expect(emptySkillState.open).toBe(true);
		expect(emptySkillState.items).toEqual([]);
		expect(emptySkillState.emptyLabel).toBe("No skills available");
		expect(emptySkillState.emptyDetail).toBe("Add SKILL.md files under the configured skills directory.");
	});

	it("detects a selected skill and keeps the user text separate", () => {
		const selection = getSlashSelection("/skill:ui-polish please improve this", suggestions);

		expect(selection?.item.label).toBe("ui-polish");
		expect(selection?.text).toBe("please improve this");
	});

	it("does not keep showing suggestions after a skill is selected", () => {
		const state = buildSlashSuggestionState("/skill:ui-polish please improve this", suggestions);

		expect(state.open).toBe(false);
		expect(state.items).toEqual([]);
	});

	it("detects multiple selected skills and keeps the user text separate", () => {
		const selection = getSlashSelections("/skill:ui-polish /skill:api-mock please improve this", suggestions);

		expect(selection.items.map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
		expect(selection.text).toBe("please improve this");
		expect(selection.prefix).toBe("/skill:ui-polish /skill:api-mock ");
	});

	it("shows slash commands after an already selected skill when the text starts with /", () => {
		const state = buildSlashSuggestionState("/skill:ui-polish /", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["skill"]);
	});

	it("filters already selected skills when adding another skill", () => {
		const state = buildSlashSuggestionState("/skill:ui-polish /skill", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["api-mock"]);
	});
});
