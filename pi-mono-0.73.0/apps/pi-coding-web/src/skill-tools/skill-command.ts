import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { requestSkillApi } from "./client.js";
import type { SkillLoadDetails } from "./schemas.js";

type ParsedSkillCommandPrefix = {
	skillNames: string[];
	args: string;
};

type ExpandSkillCommandOptions = {
	defaultSkillNames?: string[];
};

export async function expandSkillCommandsInMessages(
	messages: AgentMessage[],
	options: ExpandSkillCommandOptions = {},
): Promise<AgentMessage[]> {
	let changed = false;
	const expandedMessages: AgentMessage[] = [];
	const latestExpandableMessageIndex = findLatestExpandableMessageIndex(messages);
	const defaultSkillNames = uniqueNames(options.defaultSkillNames ?? []);
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const content = readExpandableTextContent(message);
		if (content === undefined) {
			expandedMessages.push(message);
			continue;
		}
		const expanded = await expandSkillCommandText(
			content,
			index === latestExpandableMessageIndex ? defaultSkillNames : [],
		);
		if (expanded === content) {
			expandedMessages.push(message);
		} else {
			changed = true;
			expandedMessages.push(writeExpandableTextContent(message, expanded));
		}
	}
	return changed ? expandedMessages : messages;
}

export function getLatestRequiredSkillNames(messages: AgentMessage[], defaultSkillNames: string[] = []): string[] {
	return uniqueNames([...defaultSkillNames, ...getLatestExplicitSkillNames(messages)]);
}

export function getLatestExplicitSkillNames(messages: AgentMessage[]): string[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const content = readExpandableTextContent(messages[index]);
		if (content === undefined) continue;
		return parseSkillCommandPrefix(content)?.skillNames ?? [];
	}
	return [];
}

async function expandSkillCommandText(text: string, defaultSkillNames: string[] = []): Promise<string> {
	const parsed = parseSkillCommandPrefix(text);
	if (!parsed && defaultSkillNames.length === 0) return text;

	const defaultSkills = await loadSkills(defaultSkillNames);
	const explicitSkills = await loadSkills(parsed?.skillNames ?? [], new Set(defaultSkills.map((skill) => skill.name)));

	if (defaultSkills.length > 0) {
		return formatRequiredSkillSelection(defaultSkills, explicitSkills, parsed?.args ?? text);
	}
	return formatExplicitSkillSelection(explicitSkills, parsed?.args ?? text);
}

async function loadSkills(skillNames: string[], seen = new Set<string>()): Promise<SkillLoadDetails[]> {
	const skills: SkillLoadDetails[] = [];
	for (const skillName of skillNames) {
		if (seen.has(skillName)) continue;
		const skill = await requestSkillApi<SkillLoadDetails>("/load", {
			body: { name: skillName },
		});
		skills.push(skill);
		seen.add(skill.name);
	}
	return skills;
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

function formatExplicitSkillSelection(skills: SkillLoadDetails[], userRequest: string): string {
	const skillNames = skills.map((skill) => skill.name);
	const lines = [
		"<explicitly_selected_skills>",
		"The user explicitly selected these PI global skills. They are mandatory implementation instructions, not optional suggestions.",
		"You must apply every selected skill before creating, editing, validating, or previewing project files.",
		"When multiple skills are selected, merge their non-conflicting requirements into one implementation plan. Do not ignore one selected skill because another selected skill seems more relevant.",
		"If selected skill instructions conflict, preserve the user or PM product requirements first, then follow the more specific selected skill instruction.",
		"Skill files and resources may be written in a different language from the user request. Follow their technical/style instructions without switching the assistant response language or generated user-facing app text away from the user request language.",
		"",
		"Selected skills:",
		...skillNames.map((name) => `- ${name}`),
		"",
		...skills.map(formatSkillBlock),
		"</explicitly_selected_skills>",
		"",
		"<active_skill_checklist>",
		"Before acting, ensure:",
		...skillNames.map((name) => `- ${name}: identify and apply the relevant instructions from this skill.`),
		"</active_skill_checklist>",
	];
	if (!userRequest) return lines.join("\n");
	return `${lines.join("\n")}\n\n${formatUserRequestSection(userRequest)}`;
}

function formatRequiredSkillSelection(
	defaultSkills: SkillLoadDetails[],
	explicitSkills: SkillLoadDetails[],
	userRequest: string,
): string {
	const defaultSkillNames = defaultSkills.map((skill) => skill.name);
	const explicitSkillNames = explicitSkills.map((skill) => skill.name);
	const skillNames = uniqueNames([...defaultSkillNames, ...explicitSkillNames]);
	const defaultSkillLines =
		defaultSkillNames.length > 0
			? [
					"Server default skills:",
					...defaultSkillNames.map((name) => `- ${name}`),
					"These default skills are configured by the PI server and are not user-selectable.",
					"",
				]
			: [];
	const explicitSkillLines =
		explicitSkillNames.length > 0
			? [
					"User-selected skills:",
					...explicitSkillNames.map((name) => `- ${name}`),
					"The user explicitly selected these PI global skills.",
					"",
				]
			: [];
	const lines = [
		"<required_skills>",
		"These PI skills are mandatory implementation instructions, not optional suggestions.",
		"You must apply every required skill before creating, editing, validating, or previewing project files.",
		"When multiple skills are required, merge their non-conflicting requirements into one implementation plan. Do not ignore one required skill because another required skill seems more relevant.",
		"If required skill instructions conflict, preserve the user or PM product requirements first, then follow the more specific skill instruction.",
		"Skill files and resources may be written in a different language from the user request. Follow their technical/style instructions without switching the assistant response language or generated user-facing app text away from the user request language.",
		"",
		...defaultSkillLines,
		...explicitSkillLines,
		...defaultSkills.map(formatSkillBlock),
		...explicitSkills.map(formatSkillBlock),
		"</required_skills>",
		"",
		"<active_skill_checklist>",
		"Before acting, ensure:",
		...skillNames.map((name) => `- ${name}: identify and apply the relevant instructions from this skill.`),
		"</active_skill_checklist>",
	];
	if (!userRequest) return lines.join("\n");
	return `${lines.join("\n")}\n\n${formatUserRequestSection(userRequest)}`;
}

function formatSkillBlock(skill: SkillLoadDetails): string {
	const resources =
		skill.resources.length > 0
			? [
					"",
					"Available skill resources:",
					...skill.resources.map((resource) => `- ${resource.path} (${resource.size} bytes)`),
				]
			: [];
	return [
		`<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">`,
		skill.interface?.displayName ? `Display name: ${skill.interface.displayName}` : "",
		skill.interface?.shortDescription ? `Short description: ${skill.interface.shortDescription}` : "",
		skill.interface?.defaultPrompt ? `Default prompt: ${skill.interface.defaultPrompt}` : "",
		"References are relative to this skill. Use skill_resource to read listed relative resources when needed.",
		"",
		skill.content,
		...resources,
		"</skill>",
	]
		.filter(Boolean)
		.join("\n");
}

function readExpandableTextContent(message: AgentMessage): string | undefined {
	const role = (message as { role?: unknown }).role;
	if (role !== "user" && role !== "user-with-attachments") return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const textBlock = content.find(isTextContentBlock);
	return textBlock?.text;
}

function writeExpandableTextContent(message: AgentMessage, text: string): AgentMessage {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return { ...message, content: text } as AgentMessage;
	if (!Array.isArray(content)) return message;
	let replaced = false;
	const nextContent = content.map((block) => {
		if (!replaced && isTextContentBlock(block)) {
			replaced = true;
			return { ...block, text };
		}
		return block;
	});
	return replaced ? ({ ...message, content: nextContent } as AgentMessage) : message;
}

function isTextContentBlock(value: unknown): value is { type: "text"; text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

function findLatestExpandableMessageIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (readExpandableTextContent(messages[index]) !== undefined) return index;
	}
	return -1;
}

function uniqueNames(names: string[]): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const rawName of names) {
		const name = rawName.trim();
		if (!name || seen.has(name)) continue;
		unique.push(name);
		seen.add(name);
	}
	return unique;
}

function formatUserRequestSection(userRequest: string): string {
	const languageHint = hasHanText(userRequest)
		? "Detected user request language: Chinese. Reply in Chinese and generate Chinese user-facing app UI text unless the user explicitly asks for another language."
		: "Use the same natural language as the user request unless the user explicitly asks for another language.";
	return [
		"<response_language_policy>",
		"Use the user request language for assistant prose, final responses, and generated user-facing app UI text.",
		"Skill files, skill resources, and platform instructions are technical references; their language must not override the user request language.",
		languageHint,
		"</response_language_policy>",
		"",
		"User request:",
		userRequest,
	].join("\n");
}

function hasHanText(value: string): boolean {
	return /[\u3400-\u9fff]/.test(value);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
