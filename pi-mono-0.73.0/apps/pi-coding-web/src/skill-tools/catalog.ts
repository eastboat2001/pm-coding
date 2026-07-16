import type { SkillSummary } from "./schemas.js";

const MAX_CATALOG_CHARS = 8_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const CATALOG_CONTEXT_RATIO = 0.02;
const MAX_DISCLOSED_DESCRIPTION_CHARS = 240;

export function implicitSkills(skills: readonly SkillSummary[]): SkillSummary[] {
	return skills
		.filter((skill) => skill.allowImplicitInvocation)
		.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function skillCatalogBudgetChars(contextWindowTokens: number): number {
	if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return 0;
	return Math.min(
		Math.floor(contextWindowTokens * CATALOG_CONTEXT_RATIO * ESTIMATED_CHARS_PER_TOKEN),
		MAX_CATALOG_CHARS,
	);
}

export function formatSkillCatalog(skills: readonly SkillSummary[], contextWindowTokens: number): string {
	const catalog = implicitSkills(skills);
	if (catalog.length === 0) return "";
	const budget = skillCatalogBudgetChars(contextWindowTokens);
	const header = "<available_skills>\n";
	const footer = "</available_skills>";
	const entries: string[] = [];

	for (let index = 0; index < catalog.length; index++) {
		const entry = formatSkillEntry(catalog[index]);
		const remaining = catalog.length - index - 1;
		const omission = remaining > 0 ? formatOmission(remaining) : "";
		const candidate = `${header}${entries.join("")}${entry}${omission}${footer}`;
		if (candidate.length > budget) break;
		entries.push(entry);
	}

	const omitted = catalog.length - entries.length;
	const output = `${header}${entries.join("")}${omitted > 0 ? formatOmission(omitted) : ""}${footer}`;
	return output.length <= budget ? output : "";
}

function formatSkillEntry(skill: SkillSummary): string {
	const description = truncateDescription(skill.description);
	return [
		"<skill>",
		`<name>${escapeXml(skill.name)}</name>`,
		`<description>${escapeXml(description)}</description>`,
		`<location>${escapeXml(skill.location)}</location>`,
		"</skill>",
		"",
	].join("\n");
}

function formatOmission(count: number): string {
	return `<omitted>${count} skills omitted due to catalog budget.</omitted>\n`;
}

function truncateDescription(description: string): string {
	const normalized = description.trim().replace(/\s+/g, " ");
	if (normalized.length <= MAX_DISCLOSED_DESCRIPTION_CHARS) return normalized;
	return `${normalized.slice(0, MAX_DISCLOSED_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
