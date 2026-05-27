import { describe, expect, it } from "vitest";
import {
	applySlashSuggestionToState,
	applySlashSuggestionToValue,
	buildSlashSuggestionState,
	getSlashSelection,
	getSlashSelections,
	getSlashSuggestionSkills,
	resolveSlashSuggestionCursorPosition,
	resolveTextareaCursorPosition,
	type SlashSuggestionItem,
	shouldStackSlashSelections,
	toggleSlashSelection,
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

	it("shows slash commands after whitespace in normal text", () => {
		const state = buildSlashSuggestionState("please use /skill", suggestions);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
	});

	it("does not show suggestions when slash is attached to normal text", () => {
		const state = buildSlashSuggestionState("please use/skill", suggestions);

		expect(state.open).toBe(false);
		expect(state.items).toEqual([]);
	});

	it("uses the cursor position to trigger slash commands in the middle of normal text", () => {
		const value = "please / continue";
		const state = buildSlashSuggestionState(value, suggestions, "please /".length);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["skill"]);
	});

	it("shows slash commands inside a multiline handoff prompt", () => {
		const value = "PM implementation prompt\n\n---\n\nPlease build /skill";
		const state = buildSlashSuggestionState(value, suggestions, value.length);

		expect(state.open).toBe(true);
		expect(state.items.map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
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

	it("expands a slash command token without dropping surrounding text", () => {
		const result = applySlashSuggestionToValue("please use /", suggestions[0], suggestions);

		expect(result.value).toBe("please use /skill");
		expect(result.cursor).toBe("please use /skill".length);
	});

	it("moves a selected skill from normal text into the skill prefix", () => {
		const result = applySlashSuggestionToValue("please use /skill", suggestions[1], suggestions);

		expect(result.value).toBe("/skill:ui-polish please use");
		expect(result.cursor).toBe("please use".length);
	});

	it("applies a suggestion using the rendered menu state when the DOM cursor is stale", () => {
		const value = "please use /skill";
		const state = buildSlashSuggestionState(value, suggestions, value.length);
		const result = applySlashSuggestionToState(value, suggestions[1], suggestions, state);

		expect(result.value).toBe("/skill:ui-polish please use");
		expect(result.cursor).toBe("please use".length);
	});

	it("uses the pending cursor after a keep-open suggestion changes the value", () => {
		const value = "please use /";
		const state = buildSlashSuggestionState(value, suggestions, value.length);
		const result = applySlashSuggestionToState(value, suggestions[0], suggestions, state);
		const staleDomCursor = value.length;

		const cursor = resolveSlashSuggestionCursorPosition(result.value, staleDomCursor, suggestions, result.cursor);
		const nextState = buildSlashSuggestionState(result.value, suggestions, cursor);

		expect(result.value).toBe("please use /skill");
		expect(nextState.open).toBe(true);
		expect(nextState.items.map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
	});

	it("converts a full-value cursor to the visible textarea cursor after an existing skill prefix", () => {
		const value = "/skill:ui-polish please / continue";
		const state = buildSlashSuggestionState(value, suggestions, "/skill:ui-polish please /".length);
		const result = applySlashSuggestionToState(value, suggestions[0], suggestions, state);

		const textareaCursor = resolveTextareaCursorPosition(result.value, result.cursor, suggestions);

		expect(result.value).toBe("/skill:ui-polish please /skill continue");
		expect(textareaCursor).toBe("please /skill".length);
	});

	it("moves a selected skill from a multiline handoff prompt into the skill prefix", () => {
		const value = "PM implementation prompt\n\n---\n\nPlease build /skill";
		const state = buildSlashSuggestionState(value, suggestions, value.length);
		const result = applySlashSuggestionToState(value, suggestions[1], suggestions, state);

		expect(result.value).toBe("/skill:ui-polish PM implementation prompt\n\n---\n\nPlease build");
		expect(result.cursor).toBe("PM implementation prompt\n\n---\n\nPlease build".length);
	});

	it("stacks selected skill pills above multiline text", () => {
		expect(shouldStackSlashSelections("single line prompt")).toBe(false);
		expect(shouldStackSlashSelections("PM implementation prompt\n\n---\n\nPlease build")).toBe(true);
	});

	it("lists only concrete skill suggestions for extension menus", () => {
		expect(getSlashSuggestionSkills(suggestions).map((item) => item.label)).toEqual(["ui-polish", "api-mock"]);
	});

	it("adds a selected skill from the extension menu without changing user text", () => {
		const result = toggleSlashSelection(
			"PM implementation prompt\n\n---\n\nPlease build",
			suggestions[1],
			suggestions,
		);

		expect(result).toBe("/skill:ui-polish PM implementation prompt\n\n---\n\nPlease build");
	});

	it("removes an already selected skill from the extension menu", () => {
		const result = toggleSlashSelection("/skill:ui-polish /skill:api-mock Please build", suggestions[1], suggestions);

		expect(result).toBe("/skill:api-mock Please build");
	});
});
