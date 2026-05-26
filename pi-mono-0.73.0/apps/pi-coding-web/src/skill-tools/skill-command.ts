import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { requestSkillApi } from "./client.js";
import type { SkillLoadDetails } from "./schemas.js";

type ParsedSkillCommandPrefix = {
	skillNames: string[];
	args: string;
};

export async function expandSkillCommandsInMessages(messages: AgentMessage[]): Promise<AgentMessage[]> {
	let changed = false;
	const expandedMessages: AgentMessage[] = [];
	for (const message of messages) {
		const content = getExpandableTextContent(message);
		if (content === undefined) {
			expandedMessages.push(message);
			continue;
		}
		const expanded = await expandSkillCommandText(content);
		if (expanded === content) {
			expandedMessages.push(message);
		} else {
			changed = true;
			expandedMessages.push({ ...message, content: expanded } as AgentMessage);
		}
	}
	return changed ? expandedMessages : messages;
}

async function expandSkillCommandText(text: string): Promise<string> {
	const parsed = parseSkillCommandPrefix(text);
	if (!parsed) return text;

	const blocks: string[] = [];
	for (const skillName of parsed.skillNames) {
		const skill = await requestSkillApi<SkillLoadDetails>("/load", {
			body: { name: skillName },
			allowMissing: true,
		});
		if (!skill) return text;
		blocks.push(formatSkillBlock(skill));
	}

	const expandedSkills = blocks.join("\n\n");
	return parsed.args ? `${expandedSkills}\n\n${parsed.args}` : expandedSkills;
}

export function parseSkillCommandPrefix(text: string): ParsedSkillCommandPrefix | undefined {
	let remaining = text;
	const skillNames: string[] = [];
	const seen = new Set<string>();

	while (remaining.startsWith("/skill:")) {
		const match = remaining.match(/^\/skill:([^\s]+)(?:\s+|$)/);
		if (!match) break;
		const skillName = match[1].trim();
		if (!skillName) break;
		if (!seen.has(skillName)) {
			skillNames.push(skillName);
			seen.add(skillName);
		}
		remaining = remaining.slice(match[0].length);
	}

	if (skillNames.length === 0) return undefined;
	return { skillNames, args: remaining.trimStart() };
}

function formatSkillBlock(skill: SkillLoadDetails): string {
	return [
		`<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">`,
		"References are relative to this skill. Use skill_resource to read listed relative resources when needed.",
		"",
		skill.content,
		"</skill>",
	].join("\n");
}

function getExpandableTextContent(message: AgentMessage): string | undefined {
	const role = (message as { role?: unknown }).role;
	if (role !== "user" && role !== "user-with-attachments") return undefined;
	const content = (message as { content?: unknown }).content;
	return typeof content === "string" ? content : undefined;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
