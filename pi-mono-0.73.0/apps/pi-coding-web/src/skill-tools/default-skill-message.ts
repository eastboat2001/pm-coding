import type { Agent } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { type MessageRenderer, registerMessageRenderer, renderTool } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { requestSkillApi } from "./client.js";
import type { SkillLoadDetails, SkillSummary } from "./schemas.js";

export type DefaultSkillLoadMessage = {
	role: "default-skill-load";
	name: string;
	toolCallId: string;
	details: SkillLoadDetails;
	timestamp: number;
};

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"default-skill-load": DefaultSkillLoadMessage;
	}
}

let registered = false;

export function registerDefaultSkillLoadMessageRenderer(): void {
	if (registered) return;
	registered = true;
	registerMessageRenderer("default-skill-load", new DefaultSkillLoadMessageRenderer());
}

export async function enqueueDefaultSkillLoadMessages(agent: Agent, defaultSkills: SkillSummary[]): Promise<void> {
	for (const message of await loadDefaultSkillLoadMessages(defaultSkills)) {
		agent.steer(message);
	}
}

export async function loadDefaultSkillLoadMessages(defaultSkills: SkillSummary[]): Promise<DefaultSkillLoadMessage[]> {
	const messages: DefaultSkillLoadMessage[] = [];
	const seen = new Set<string>();
	for (const summary of defaultSkills) {
		if (seen.has(summary.name)) continue;
		seen.add(summary.name);
		const skill = await requestSkillApi<SkillLoadDetails>("/load", {
			body: { name: summary.name },
			allowMissing: true,
		});
		if (!skill) continue;
		messages.push(createDefaultSkillLoadMessage(skill));
	}
	return messages;
}

export function createDefaultSkillLoadMessage(
	skill: SkillLoadDetails,
	timestamp = Date.now(),
): DefaultSkillLoadMessage {
	return {
		role: "default-skill-load",
		name: skill.name,
		toolCallId: `default-skill-load-${encodeURIComponent(skill.name)}-${timestamp}`,
		details: skill,
		timestamp,
	};
}

class DefaultSkillLoadMessageRenderer implements MessageRenderer<DefaultSkillLoadMessage> {
	render(message: DefaultSkillLoadMessage) {
		const result: ToolResultMessage<SkillLoadDetails> = {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: "skill_load",
			content: [{ type: "text", text: message.details.content }],
			details: message.details,
			isError: false,
			timestamp: message.timestamp,
		};
		const rendered = renderTool("skill_load", { name: message.name }, result, false);
		if (rendered.isCustom) return rendered.content;
		return html`
			<div class="px-4 flex flex-col gap-3">
				<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
					${rendered.content}
				</div>
			</div>
		`;
	}
}
