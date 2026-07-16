import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type MessageRenderer, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import "./agent-v2-progress-card.js";
import type { AgentV2ProgressSection } from "./agent-v2-progress-card.js";
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

export interface AgentV2RunResultRendererOptions {
	detailOpenForRun: (runId: string) => boolean;
	expandedSectionForRun: (runId: string) => AgentV2ProgressSection | null;
	onDetailChange: (runId: string, expanded: boolean) => void;
	onSectionChange: (runId: string, section: AgentV2ProgressSection | null) => void;
}

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

export function registerAgentV2RunResultMessageRenderer(options?: AgentV2RunResultRendererOptions): void {
	if (resultRendererRegistered) return;
	resultRendererRegistered = true;
	registerMessageRenderer("agent-v2-run-result", new AgentV2RunResultMessageRenderer(options));
}

class AgentV2RunResultMessageRenderer implements MessageRenderer<AgentV2RunResultMessage> {
	constructor(private readonly options?: AgentV2RunResultRendererOptions) {}

	render(message: AgentV2RunResultMessage): TemplateResult {
		return renderAgentV2RunResultMessage(message, this.options);
	}
}

export function renderAgentV2RunResultMessage(
	message: AgentV2RunResultMessage,
	options?: AgentV2RunResultRendererOptions,
): TemplateResult {
	return html`
		<agent-v2-progress-card
			.presentation=${message.presentation}
			.terminal=${true}
			.detailsExpanded=${options?.detailOpenForRun(message.runId) ?? false}
			.expandedSection=${options?.expandedSectionForRun(message.runId) ?? null}
			.onDetailChange=${options ? (expanded: boolean) => options.onDetailChange(message.runId, expanded) : undefined}
			.onSectionChange=${options ? (section: AgentV2ProgressSection | null) => options.onSectionChange(message.runId, section) : undefined}
		></agent-v2-progress-card>
	`;
}

function terminalTimestamp(presentation: SerializedAgentV2TerminalRunPresentation): number {
	const endedAt = Date.parse(presentation.endedAt);
	if (Number.isFinite(endedAt)) return endedAt;
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
