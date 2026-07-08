import type { AgentV2RunInput } from "./agent-v2-types.js";

export interface AgentV2RunContextInput {
	sessionId: string;
	title: string;
}

export type AgentV2ExecutableRunInput = AgentV2RunInput & AgentV2RunContextInput;

export class AgentV2RunInputContractError extends Error {
	constructor(message = "Agent v2 run input must include non-empty string sessionId and title fields.") {
		super(message);
		this.name = "AgentV2RunInputContractError";
	}
}

export function parseAgentV2RunContext(input: unknown): AgentV2RunContextInput {
	if (!isRecord(input)) throw new AgentV2RunInputContractError();
	const sessionId = nonEmptyInputString(input.sessionId);
	const title = nonEmptyInputString(input.title);
	if (!sessionId || !title) throw new AgentV2RunInputContractError();
	return { sessionId, title };
}

export function validateAgentV2RunInput(input: unknown): AgentV2ExecutableRunInput {
	const context = parseAgentV2RunContext(input);
	return { ...(input as AgentV2RunInput), ...context };
}

function nonEmptyInputString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
