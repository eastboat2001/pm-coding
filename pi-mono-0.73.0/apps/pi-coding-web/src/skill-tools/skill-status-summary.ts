import type { SkillListDetails } from "./schemas.js";

export type SkillStatusData = Pick<SkillListDetails, "skills" | "defaultSkills" | "diagnostics">;

export interface SkillStatusSummary {
	selectableCount: number;
	defaultCount: number;
	issueCount: number;
	errorCount: number;
	warningCount: number;
	collisionCount: number;
}

type SkillDiagnostic = SkillStatusData["diagnostics"][number];

export type SkillDiagnosticIcon = "error" | "warning" | "collision";

export interface SkillDiagnosticPresentation {
	key: string;
	icon: SkillDiagnosticIcon;
	toneClass: string;
	suggestion: string;
}

export function summarizeSkillStatus(data: SkillStatusData): SkillStatusSummary {
	const summary: SkillStatusSummary = {
		selectableCount: data.skills.length,
		defaultCount: data.defaultSkills.length,
		issueCount: data.diagnostics.length,
		errorCount: 0,
		warningCount: 0,
		collisionCount: 0,
	};
	for (const diagnostic of data.diagnostics) {
		if (diagnostic.type === "error") summary.errorCount += 1;
		if (diagnostic.type === "warning") summary.warningCount += 1;
		if (diagnostic.type === "collision") summary.collisionCount += 1;
	}
	return summary;
}

export function createSkillDiagnosticPresentation(
	diagnostic: SkillDiagnostic,
	index: number,
): SkillDiagnosticPresentation {
	const type = diagnostic.type;
	return {
		key: `${type}:${diagnostic.path || ""}:${index}`,
		icon: type,
		toneClass: diagnosticToneClass(type),
		suggestion: createSkillDiagnosticSuggestion(diagnostic),
	};
}

function diagnosticToneClass(type: SkillDiagnostic["type"]): string {
	if (type === "error") return "skill-diagnostic--error";
	if (type === "collision") return "skill-diagnostic--collision";
	return "skill-diagnostic--warning";
}

function createSkillDiagnosticSuggestion(diagnostic: SkillDiagnostic): string {
	const message = diagnostic.message.toLowerCase();
	if (diagnostic.type === "collision") {
		return "Rename one of the conflicting skill folders or frontmatter names so every selectable/default skill name is unique.";
	}
	if (message.includes("frontmatter")) {
		return "Add YAML frontmatter at the top of SKILL.md with name and description fields before the Markdown body.";
	}
	if (message.includes("does not match skill path")) {
		return "Rename the skill folder to match the YAML name, or change the YAML name to match the folder name.";
	}
	if (message.includes("invalid characters") || message.includes("hyphen")) {
		return "Use a lowercase kebab-case skill name with only a-z, 0-9, and single hyphens.";
	}
	if (message.includes("explicit trigger wording")) {
		return 'Start the description with a clear trigger, for example: "Use this skill when creating production UI pages."';
	}
	if (message.includes("non-use boundaries")) {
		return 'Add a boundary sentence, for example: "Do not use for backend-only, data-only, or pure documentation tasks."';
	}
	if (message.includes("specific enough")) {
		return "Describe the target tasks, trigger phrases, expected output style, and non-use boundaries in the description.";
	}
	if (message.includes("exceeds")) {
		return "Shorten the skill description or move detailed guidance into the SKILL.md body or referenced files.";
	}
	return "Open the referenced SKILL.md and update it to match the PI skill format requirements.";
}
