import { type Static, Type } from "typebox";
import type { SkillLoadResult } from "./types.js";

export const skillLoadSchema = Type.Object(
	{
		name: Type.String({
			description: "Only use a name listed in <available_skills>; do not invent or infer unlisted skill names.",
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

export function formatSkillLoadResult(result: SkillLoadResult): string {
	const resources =
		result.resources.length > 0
			? `\n\nAvailable skill resources:\n${result.resources
					.map((resource) => `- ${resource.path} (${resource.size} bytes)`)
					.join("\n")}`
			: "";
	return [
		`Skill: ${result.name}`,
		result.interface?.displayName ? `Display name: ${result.interface.displayName}` : "",
		result.interface?.shortDescription ? `Short description: ${result.interface.shortDescription}` : "",
		`Location: ${result.location}`,
		result.interface?.defaultPrompt ? `Default prompt: ${result.interface.defaultPrompt}` : "",
		"References are relative to this skill. Use skill_resource to read listed relative resources when needed.",
		"",
		`<skill name="${escapeXml(result.name)}" location="${escapeXml(result.location)}">`,
		result.content,
		"</skill>",
		resources,
	]
		.filter(Boolean)
		.join("\n");
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

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
