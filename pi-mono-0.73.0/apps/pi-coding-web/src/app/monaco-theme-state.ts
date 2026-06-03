export const MONACO_FILE_PREVIEW_LIGHT_THEME = "pi-file-preview-light";
export const MONACO_FILE_PREVIEW_DARK_THEME = "pi-file-preview-dark";

export function monacoThemeForRoot(root: HTMLElement = document.documentElement): string {
	const explicitTheme = root.dataset.theme;
	if (explicitTheme === "dark") return MONACO_FILE_PREVIEW_DARK_THEME;
	if (explicitTheme === "light") return MONACO_FILE_PREVIEW_LIGHT_THEME;
	return root.classList.contains("dark") ? MONACO_FILE_PREVIEW_DARK_THEME : MONACO_FILE_PREVIEW_LIGHT_THEME;
}
