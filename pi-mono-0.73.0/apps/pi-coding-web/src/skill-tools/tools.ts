import type { AgentTool } from "@mariozechner/pi-agent-core";
import { implicitSkills } from "./catalog.js";
import { requestSkillApi } from "./client.js";
import { registerSkillToolRenderers } from "./renderers.js";
import {
	formatSkillLoadResult,
	prepareSkillLoadArguments,
	prepareSkillResourceArguments,
	type SkillLoadDetails,
	type SkillResourceDetails,
	type SkillSummary,
	skillLoadSchema,
	skillResourceSchema,
} from "./schemas.js";

type SkillLoadBody = { name: string };
type SkillResourceBody = { name: string; path: string };
type SkillToolRequestOptions<TBody> = { body: TBody; signal?: AbortSignal };

export interface SkillToolRequest {
	(path: "/load", options: SkillToolRequestOptions<SkillLoadBody>): Promise<SkillLoadDetails>;
	(path: "/resource", options: SkillToolRequestOptions<SkillResourceBody>): Promise<SkillResourceDetails>;
}

export type ServerSkillToolsOptions = {
	skills: readonly SkillSummary[];
	explicitSkillNames?: readonly string[];
	preloadedSkills?: readonly SkillLoadDetails[];
	request?: SkillToolRequest;
};

export function createServerSkillTools(options: ServerSkillToolsOptions = { skills: [] }): AgentTool[] {
	const implicitCatalog = implicitSkills(options.skills);
	const implicitNames = new Set(implicitCatalog.map((skill) => skill.name));
	const completeNames = new Set(options.skills.map((skill) => skill.name));
	const explicitNames = new Set(options.explicitSkillNames ?? []);
	const activated = new Map<string, SkillLoadDetails>();
	for (const skill of options.preloadedSkills ?? []) {
		if (completeNames.has(skill.name) && explicitNames.has(skill.name)) activated.set(skill.name, skill);
	}
	if (implicitNames.size === 0 && activated.size === 0) return [];

	registerSkillToolRenderers();
	const request = options.request ?? defaultSkillToolRequest;
	const activationRequests = new Map<string, Promise<SkillLoadDetails>>();
	const resourceCache = new Map<string, SkillResourceDetails>();
	const resourceRequests = new Map<string, Promise<SkillResourceDetails>>();
	const tools: AgentTool[] = [];
	if (implicitNames.size > 0) {
		tools.push(createSkillLoadTool({ implicitNames, activated, activationRequests, request }));
	}
	tools.push(createSkillResourceTool({ activated, resourceCache, resourceRequests, request }));
	return tools;
}

function createSkillLoadTool(input: {
	implicitNames: ReadonlySet<string>;
	activated: Map<string, SkillLoadDetails>;
	activationRequests: Map<string, Promise<SkillLoadDetails>>;
	request: SkillToolRequest;
}): AgentTool<typeof skillLoadSchema, SkillLoadDetails> {
	const allowedNames = [...input.implicitNames].sort((left, right) => left.localeCompare(right));
	return {
		label: "Skill Load",
		name: "skill_load",
		description: `Load one configured skill by its exact disclosed name. Authorized names: ${allowedNames.join(", ")}. Never invent or infer another name.`,
		parameters: skillLoadSchema,
		prepareArguments: prepareSkillLoadArguments,
		execute: async (_toolCallId, args, signal) => {
			if (!input.implicitNames.has(args.name)) {
				throw new Error(`Skill is not authorized for implicit activation: ${args.name}`);
			}
			const cached = input.activated.get(args.name);
			if (cached) return skillLoadToolResult(cached);
			let pending = input.activationRequests.get(args.name);
			if (!pending) {
				pending = input.request("/load", { body: { name: args.name }, signal }).then((result) => {
					if (result.name !== args.name) throw new Error(`Skill catalog became stale: ${args.name}`);
					input.activated.set(args.name, result);
					return result;
				});
				input.activationRequests.set(args.name, pending);
				void pending.finally(() => input.activationRequests.delete(args.name)).catch(() => undefined);
			}
			return skillLoadToolResult(await pending);
		},
	};
}

function createSkillResourceTool(input: {
	activated: ReadonlyMap<string, SkillLoadDetails>;
	resourceCache: Map<string, SkillResourceDetails>;
	resourceRequests: Map<string, Promise<SkillResourceDetails>>;
	request: SkillToolRequest;
}): AgentTool<typeof skillResourceSchema, SkillResourceDetails> {
	return {
		label: "Skill Resource",
		name: "skill_resource",
		description:
			"Read a text resource only after its skill is active. The name and relative path must exactly match the active skill and one of the paths returned with its instructions.",
		parameters: skillResourceSchema,
		prepareArguments: prepareSkillResourceArguments,
		execute: async (_toolCallId, args, signal) => {
			const skill = input.activated.get(args.name);
			if (!skill) throw new Error(`Skill is not active: ${args.name}`);
			if (!skill.resources.some((resource) => resource.path === args.path)) {
				throw new Error(`Skill resource path is not listed: ${args.name}/${args.path}`);
			}
			const cacheKey = `${args.name}\u0000${args.path}`;
			const cached = input.resourceCache.get(cacheKey);
			if (cached) return skillResourceToolResult(cached);
			let pending = input.resourceRequests.get(cacheKey);
			if (!pending) {
				pending = input.request("/resource", { body: { name: args.name, path: args.path }, signal }).then((result) => {
					if (result.name !== args.name || result.path !== args.path) {
						throw new Error(`Skill resource catalog became stale: ${args.name}/${args.path}`);
					}
					input.resourceCache.set(cacheKey, result);
					return result;
				});
				input.resourceRequests.set(cacheKey, pending);
				void pending.finally(() => input.resourceRequests.delete(cacheKey)).catch(() => undefined);
			}
			return skillResourceToolResult(await pending);
		},
	};
}

function skillLoadToolResult(result: SkillLoadDetails) {
	return {
		content: [{ type: "text" as const, text: formatSkillLoadResult(result) }],
		details: result,
	};
}

function skillResourceToolResult(result: SkillResourceDetails) {
	return {
		content: [{ type: "text" as const, text: result.content }],
		details: result,
	};
}

function defaultSkillToolRequest(
	path: "/load",
	options: SkillToolRequestOptions<SkillLoadBody>,
): Promise<SkillLoadDetails>;
function defaultSkillToolRequest(
	path: "/resource",
	options: SkillToolRequestOptions<SkillResourceBody>,
): Promise<SkillResourceDetails>;
function defaultSkillToolRequest(
	path: "/load" | "/resource",
	options: SkillToolRequestOptions<SkillLoadBody | SkillResourceBody>,
): Promise<SkillLoadDetails | SkillResourceDetails> {
	return requestSkillApi<SkillLoadDetails | SkillResourceDetails>(path, options);
}
