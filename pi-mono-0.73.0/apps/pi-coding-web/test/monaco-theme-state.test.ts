import { describe, expect, it } from "vitest";
import {
	MONACO_FILE_PREVIEW_DARK_THEME,
	MONACO_FILE_PREVIEW_LIGHT_THEME,
	monacoThemeForRoot,
} from "../src/app/monaco-theme-state.js";

function root(theme: string, darkClass = false): HTMLElement {
	return {
		classList: {
			contains(name: string) {
				return name === "dark" && darkClass;
			},
		},
		dataset: { theme },
	} as HTMLElement;
}

describe("monaco theme state", () => {
	it("uses a dark Monaco theme when the app is in dark mode", () => {
		expect(monacoThemeForRoot(root("dark"))).toBe(MONACO_FILE_PREVIEW_DARK_THEME);
		expect(monacoThemeForRoot(root("", true))).toBe(MONACO_FILE_PREVIEW_DARK_THEME);
	});

	it("uses the light Monaco theme when the app is in light mode", () => {
		expect(monacoThemeForRoot(root("light", true))).toBe(MONACO_FILE_PREVIEW_LIGHT_THEME);
		expect(monacoThemeForRoot(root(""))).toBe(MONACO_FILE_PREVIEW_LIGHT_THEME);
	});
});
