export const HANDOFF_LANGUAGES = ["en", "zh", "de", "ms"] as const;

export type HandoffLanguage = (typeof HANDOFF_LANGUAGES)[number];

export function normalizeHandoffLanguage(language?: unknown): HandoffLanguage {
	const normalized = String(language || "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
	if (normalized === "de" || normalized.startsWith("de-")) return "de";
	if (normalized === "ms" || normalized.startsWith("ms-")) return "ms";
	return "en";
}
