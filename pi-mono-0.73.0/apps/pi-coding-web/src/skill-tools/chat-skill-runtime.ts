import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { createChatSystemPrompt } from "./chat-system-prompt.js";
import { requestSkillApi } from "./client.js";
import type { SkillLoadDetails, SkillSummary } from "./schemas.js";
import {
	expandSkillCommandsInMessages,
	getLatestExplicitSkillNames,
	validateSelectedSkillNames,
} from "./skill-command.js";
import { createServerSkillTools } from "./tools.js";

export type ChatPromptInput = string | AgentMessage | AgentMessage[];
export type ChatSkillLoader = (name: string, signal?: AbortSignal) => Promise<SkillLoadDetails>;

export type ChatSkillRuntimeSnapshot = {
	readonly skills: readonly SkillSummary[];
	readonly explicitSkillNames: readonly string[];
	readonly preloadedSkills: readonly SkillLoadDetails[];
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
	transformMessages(messages: AgentMessage[]): Promise<AgentMessage[]>;
};

export async function createChatSkillRuntime(input: {
	skills: readonly SkillSummary[];
	input: ChatPromptInput;
	contextWindowTokens: number;
	loadSkill?: ChatSkillLoader;
	signal?: AbortSignal;
}): Promise<ChatSkillRuntimeSnapshot> {
	const skills = input.skills.map((skill) => ({ ...skill }));
	const availableSkillNames = skills.map((skill) => skill.name);
	const explicitSkillNames = validateSelectedSkillNames(
		getLatestExplicitSkillNames(promptInputMessages(input.input)),
		availableSkillNames,
	);

	const loadSkill = input.loadSkill ?? loadServerSkill;
	const preloadedSkills: SkillLoadDetails[] = [];
	const preloadedByName = new Map<string, SkillLoadDetails>();
	for (const name of explicitSkillNames) {
		const loaded = await loadSkill(name, input.signal);
		if (loaded.name !== name) throw new Error(`Skill catalog became stale: ${name}`);
		preloadedSkills.push(loaded);
		preloadedByName.set(name, loaded);
	}

	const systemPrompt = createChatSystemPrompt(skills, input.contextWindowTokens);
	const tools = createServerSkillTools({
		skills,
		explicitSkillNames,
		preloadedSkills,
	});
	return Object.freeze({
		skills: Object.freeze(skills),
		explicitSkillNames: Object.freeze([...explicitSkillNames]),
		preloadedSkills: Object.freeze([...preloadedSkills]),
		systemPrompt,
		tools: Object.freeze([...tools]),
		transformMessages: async (messages: AgentMessage[]) =>
			await expandSkillCommandsInMessages(messages, {
				availableSkillNames,
				loadSkill: async (name) => {
					const loaded = preloadedByName.get(name);
					if (!loaded) throw new Error(`Selected skill is not active in this prompt: ${name}`);
					return loaded;
				},
				...(input.signal ? { signal: input.signal } : {}),
			}),
	});
}

function promptInputMessages(input: ChatPromptInput): AgentMessage[] {
	if (typeof input === "string") return [{ role: "user", content: input, timestamp: Date.now() }];
	return Array.isArray(input) ? input : [input];
}

async function loadServerSkill(name: string, signal?: AbortSignal): Promise<SkillLoadDetails> {
	return await requestSkillApi<SkillLoadDetails>("/load", { body: { name }, signal });
}
