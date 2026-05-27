import { type Static, Type } from "typebox";

export type SkillSummary = {
	name: string;
	description: string;
	location: string;
	disableModelInvocation: boolean;
};

export type SkillResourceSummary = {
	path: string;
	size: number;
};

export type SkillListDetails = {
	skills: SkillSummary[];
	promptSkills: SkillSummary[];
	diagnostics: Array<{
		type: "warning" | "collision";
		message: string;
		path?: string;
	}>;
};

export type SkillLoadDetails = SkillSummary & {
	content: string;
	resources: SkillResourceSummary[];
};

export type SkillResourceDetails = {
	name: string;
	path: string;
	content: string;
	size: number;
};

export const skillLoadSchema = Type.Object(
	{
		name: Type.String({
			description: "Configured global skill name, such as ui-polish.",
		}),
	},
	{ additionalProperties: false },
);

export const skillResourceSchema = Type.Object(
	{
		name: Type.String({
			description: "Configured global skill name that owns the resource.",
		}),
		path: Type.String({
			description: "Relative path inside the skill directory, such as references/rules.md.",
		}),
	},
	{ additionalProperties: false },
);

export type SkillLoadParams = Static<typeof skillLoadSchema>;
export type SkillResourceParams = Static<typeof skillResourceSchema>;

export function prepareSkillLoadArguments(args: unknown): SkillLoadParams {
	const raw = coerceRecord(args);
	const name = readString(raw, "name", "skill", "skillName", "skill_name");
	if (!name) throw new Error('skill_load requires: {"name":"skill-name"}');
	return { name };
}

export function prepareSkillResourceArguments(args: unknown): SkillResourceParams {
	const raw = coerceRecord(args);
	const name = readString(raw, "name", "skill", "skillName", "skill_name");
	const path = readString(raw, "path", "resource", "resourcePath", "resource_path", "file", "filename");
	if (!name || !path) {
		throw new Error('skill_resource requires: {"name":"skill-name","path":"references/file.md"}');
	}
	return { name, path };
}

function coerceRecord(args: unknown): Record<string, unknown> {
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (isRecord(parsed)) return parsed;
		} catch {
			return {};
		}
	}
	if (!isRecord(args)) return {};
	const nested = args.arguments;
	if (!("name" in args) && isRecord(nested)) return nested;
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}
