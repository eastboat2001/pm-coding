import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SkillLoadDetails } from "./schemas.js";

type ParsedSkillCommandPrefix = {
	skillNames: string[];
	args: string;
};

export type SkillLoader = (name: string, signal?: AbortSignal) => Promise<SkillLoadDetails> | SkillLoadDetails;

export type ExpandSkillCommandOptions = {
	availableSkillNames?: readonly string[];
	loadSkill?: SkillLoader;
	signal?: AbortSignal;
};

const TOOL_REQUEST_TIMEOUT_MS = 5000;

export async function expandSkillCommandsInMessages(
	messages: AgentMessage[],
	options: ExpandSkillCommandOptions = {},
): Promise<AgentMessage[]> {
	let changed = false;
	const expandedMessages: AgentMessage[] = [];
	const latestExpandableMessageIndex = findLatestExpandableMessageIndex(messages);
	for (let index = 0; index < messages.length; index++) {
		throwIfAborted(options.signal);
		const message = messages[index];
		const content = readExpandableTextContent(message);
		if (content === undefined || index !== latestExpandableMessageIndex) {
			expandedMessages.push(message);
			continue;
		}
		const expanded = await expandSkillCommandText(content, options);
		if (expanded === content) {
			expandedMessages.push(message);
		} else {
			changed = true;
			expandedMessages.push(writeExpandableTextContent(message, expanded));
		}
	}
	return changed ? expandedMessages : messages;
}

export function getLatestExplicitSkillNames(messages: AgentMessage[]): string[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const content = readExpandableTextContent(messages[index]);
		if (content === undefined) continue;
		return parseSkillCommandPrefix(content)?.skillNames ?? [];
	}
	return [];
}

async function expandSkillCommandText(
	text: string,
	options: ExpandSkillCommandOptions = {},
): Promise<string> {
	const parsed = parseSkillCommandPrefix(text);
	if (!parsed) return text;
	if (options.availableSkillNames) {
		const availableNames = new Set(options.availableSkillNames);
		const unknownName = parsed.skillNames.find((name) => !availableNames.has(name));
		if (unknownName) throw new Error(`Unknown selected skill: ${unknownName}`);
	}

	const loadSkill = options.loadSkill ?? defaultLoadSkill;
	const explicitSkills = await loadSkills(parsed.skillNames, new Set(), loadSkill, options.signal);
	return formatExplicitSkillSelection(explicitSkills, parsed.args);
}

async function loadSkills(
	skillNames: string[],
	seen: Set<string>,
	loadSkill: SkillLoader,
	signal?: AbortSignal,
): Promise<SkillLoadDetails[]> {
	const skills: SkillLoadDetails[] = [];
	for (const skillName of skillNames) {
		throwIfAborted(signal);
		if (seen.has(skillName)) continue;
		const skill = await loadSkill(skillName, signal);
		throwIfAborted(signal);
		skills.push(skill);
		seen.add(skill.name);
	}
	return skills;
}

async function defaultLoadSkill(name: string, signal?: AbortSignal): Promise<SkillLoadDetails> {
	throwIfAborted(signal);
	const endpoint = new URL("/api/pi-skills/load", readBrowserOrigin()).toString();
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(() => timeoutController.abort(), TOOL_REQUEST_TIMEOUT_MS);
	const requestSignal = mergeAbortSignals(timeoutController.signal, signal);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
			signal: requestSignal,
		});
		const data = (await response.json().catch(() => ({}))) as SkillLoadDetails & { error?: string };
		if (!response.ok) throw new Error(data.error || `Skill API failed with HTTP ${response.status}`);
		return data;
	} catch (error) {
		if (isAbortError(error)) throw createAbortError();
		throw new Error(
			`无法连接 PI Skill API：${endpoint}。原始错误：${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeoutId);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
	const error = new Error("Skill command expansion aborted.");
	error.name = "AbortError";
	return error;
}

function readBrowserOrigin(): string {
	const globalValue = globalThis as {
		location?: { origin?: string };
		window?: { location?: { origin?: string } };
	};
	const origin = globalValue.location?.origin ?? globalValue.window?.location?.origin;
	if (!origin) throw new Error("PI Skill API requires a browser origin. Pass loadSkill outside the browser.");
	return origin;
}

function mergeAbortSignals(timeoutSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
	if (!callerSignal) return timeoutSignal;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (timeoutSignal.aborted || callerSignal.aborted) {
		controller.abort();
		return controller.signal;
	}
	timeoutSignal.addEventListener("abort", abort, { once: true });
	callerSignal.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
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
