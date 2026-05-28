import type { AgentTool } from "@mariozechner/pi-agent-core";
import { requestSkillApi } from "./client.js";
import { registerDefaultSkillLoadMessageRenderer } from "./default-skill-message.js";
import { registerSkillToolRenderers } from "./renderers.js";
import {
	prepareSkillLoadArguments,
	prepareSkillResourceArguments,
	type SkillLoadDetails,
	type SkillResourceDetails,
	skillLoadSchema,
	skillResourceSchema,
} from "./schemas.js";

export function createServerSkillTools(): AgentTool[] {
	registerSkillToolRenderers();
	registerDefaultSkillLoadMessageRenderer();
	return [createSkillLoadTool(), createSkillResourceTool()];
}

function createSkillLoadTool(): AgentTool<typeof skillLoadSchema, SkillLoadDetails> {
	return {
		label: "Skill Load",
		name: "skill_load",
		description:
			"Load the SKILL.md instructions for a configured global skill by name. Use this when the task matches a skill listed in the system prompt. This tool only reads server-configured skill instructions and cannot read arbitrary files.",
		parameters: skillLoadSchema,
		prepareArguments: prepareSkillLoadArguments,
		execute: async (_toolCallId, args, signal) => {
			const result = await requestSkillApi<SkillLoadDetails>("/load", { body: args, signal });
			if (!result) throw new Error(`Skill not found: ${args.name}`);
			return {
				content: [{ type: "text", text: formatSkillLoadResult(result) }],
				details: result,
			};
		},
	};
}

function createSkillResourceTool(): AgentTool<typeof skillResourceSchema, SkillResourceDetails> {
	return {
		label: "Skill Resource",
		name: "skill_resource",
		description:
			"Read a text resource referenced by a loaded global skill. Parameters are the skill name and a relative path inside that skill directory. This tool is read-only, cannot execute scripts, and cannot access project files or arbitrary server files.",
		parameters: skillResourceSchema,
		prepareArguments: prepareSkillResourceArguments,
		execute: async (_toolCallId, args, signal) => {
			const result = await requestSkillApi<SkillResourceDetails>("/resource", { body: args, signal });
			if (!result) throw new Error(`Skill resource not found: ${args.name}/${args.path}`);
			return {
				content: [{ type: "text", text: result.content }],
				details: result,
			};
		},
	};
}

function formatSkillLoadResult(result: SkillLoadDetails): string {
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

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
