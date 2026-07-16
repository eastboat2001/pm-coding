import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type MessageRenderer, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import "./agent-v2-progress-card.js";
import type { SerializedAgentV2TerminalRunPresentation } from "./agent-v2-run-presentation.js";

export interface AgentV2RunResultMessage {
	role: "agent-v2-run-result";
	id: string;
	runId: string;
	presentation: SerializedAgentV2TerminalRunPresentation;
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"agent-v2-run-result": AgentV2RunResultMessage;
	}
}

let resultRendererRegistered = false;

export function createAgentV2RunResultMessage(
	presentation: SerializedAgentV2TerminalRunPresentation,
): AgentV2RunResultMessage {
	return {
		role: "agent-v2-run-result",
		id: `agent-v2-run-result:${presentation.runId}`,
		runId: presentation.runId,
		presentation,
		timestamp: terminalTimestamp(presentation),
	};
}

export function appendOrReplaceAgentV2RunResultMessage(
	messages: readonly AgentMessage[],
	message: AgentV2RunResultMessage,
): AgentMessage[] {
	const index = messages.findIndex(
		(candidate) => candidate.role === "agent-v2-run-result" && candidate.id === message.id,
	);
	if (index < 0) return [...messages, message];
	const next = [...messages];
	next[index] = message;
	return next;
}

export function registerAgentV2RunResultMessageRenderer(): void {
	if (resultRendererRegistered) return;
	resultRendererRegistered = true;
	registerMessageRenderer("agent-v2-run-result", new AgentV2RunResultMessageRenderer());
}

class AgentV2RunResultMessageRenderer implements MessageRenderer<AgentV2RunResultMessage> {
	render(message: AgentV2RunResultMessage): TemplateResult {
		return renderAgentV2RunResultMessage(message);
	}
}

export function renderAgentV2RunResultMessage(message: AgentV2RunResultMessage): TemplateResult {
	return html`
		<agent-v2-progress-card
			.presentation=${message.presentation}
			.terminal=${true}
			.expandedSection=${null}
		></agent-v2-progress-card>
	`;
}

function terminalTimestamp(presentation: SerializedAgentV2TerminalRunPresentation): number {
	const events = [
		...presentation.tasks,
		...presentation.artifacts,
		...presentation.validations.flatMap((validation) => validation.attempts),
		...presentation.diagnostics,
		...presentation.outputs,
		...presentation.skills,
		...presentation.resources,
		...(presentation.deliveryReport ? [presentation.deliveryReport] : []),
	];
	const timestamps = events.map((event) => Date.parse(event.at)).filter(Number.isFinite);
	return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}
