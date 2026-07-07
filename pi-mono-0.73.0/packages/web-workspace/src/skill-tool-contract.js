import { Type } from "typebox";
export const skillLoadSchema = Type.Object({
    name: Type.String({
        description: "Only use a name listed in <available_skills>; do not invent or infer unlisted skill names.",
    }),
}, { additionalProperties: false });
export const skillResourceSchema = Type.Object({
    name: Type.String({
        description: "Configured global skill name that owns the resource.",
    }),
    path: Type.String({
        description: "Must exactly match one of the resource paths returned by skill_load for this skill. Do not invent, infer, or guess unlisted paths.",
    }),
}, { additionalProperties: false });
export function prepareSkillLoadArguments(args) {
    const raw = coerceRecord(args);
    const name = readString(raw, "name", "skill", "skillName", "skill_name");
    if (!name)
        throw new Error('skill_load requires: {"name":"skill-name"}');
    return { name };
}
export function prepareSkillResourceArguments(args) {
    const raw = coerceRecord(args);
    const name = readString(raw, "name", "skill", "skillName", "skill_name");
    const path = readString(raw, "path", "resource", "resourcePath", "resource_path", "file", "filename");
    if (!name || !path) {
        throw new Error('skill_resource requires: {"name":"skill-name","path":"references/file.md"}');
    }
    return { name, path };
}
export function formatSkillLoadResult(result) {
    const resources = result.resources.length > 0
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
        "Use skill_resource only for exact paths listed under Available skill resources below. Do not infer or invent unlisted references paths.",
        "",
        `<skill name="${escapeXml(result.name)}" location="${escapeXml(result.location)}">`,
        result.content,
        "</skill>",
        resources,
    ]
        .filter(Boolean)
        .join("\n");
}
function coerceRecord(args) {
    if (typeof args === "string") {
        try {
            const parsed = JSON.parse(args);
            if (isRecord(parsed))
                return parsed;
        }
        catch {
            return {};
        }
    }
    if (!isRecord(args))
        return {};
    const nested = args.arguments;
    if (!("name" in args) && isRecord(nested))
        return nested;
    return args;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(raw, ...keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
//# sourceMappingURL=skill-tool-contract.js.map