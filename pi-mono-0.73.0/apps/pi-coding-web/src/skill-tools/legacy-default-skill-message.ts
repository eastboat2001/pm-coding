import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { type MessageRenderer, registerMessageRenderer, renderTool } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import type { SkillLoadDetails } from "./schemas.js";

export type LegacyDefaultSkillLoadMessage = {
	role: "default-skill-load";
	name: string;
	toolCallId: string;
	details: SkillLoadDetails;
	timestamp: number;
};

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"default-skill-load": LegacyDefaultSkillLoadMessage;
	}
}

let registered = false;

export function registerLegacyDefaultSkillLoadMessageRenderer(): void {
	if (registered) return;
	registered = true;
	registerMessageRenderer("default-skill-load", new LegacyDefaultSkillLoadMessageRenderer());
}

class LegacyDefaultSkillLoadMessageRenderer implements MessageRenderer<LegacyDefaultSkillLoadMessage> {
	render(message: LegacyDefaultSkillLoadMessage) {
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
