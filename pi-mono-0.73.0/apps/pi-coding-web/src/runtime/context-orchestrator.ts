import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import {
	type ProjectContextCompactionSummary,
	type ProjectContextPreparationOptions,
	prepareProjectContextMessages,
} from "../project-tools/context-manifest.js";
import type { CapabilityPlan } from "./capability-planner.js";

export interface ContextPacket {
	schemaVersion: 1;
	currentObjective: string;
	requirementsSummary: string[];
	designDecisions: string[];
	activeFileSet: string[];
	openProblems: string[];
	currentErrors: string[];
	requiredRereads: string[];
	taskState: ContextTaskState;
	nextBestStep: string;
	compactedToolHistory: {
		strategy: "project_tool_history";
		requiredRereadsBeforeEdit: boolean;
	};
}

export interface ContextTaskState {
	validationFailures: string[];
	lastValidationStatus?: string;
}

export interface ContextOrchestratorDecision {
	inputMessageCount: number;
	outputMessageCount: number;
	droppedMessageCount: number;
	providerPayloadBudgetChars?: number;
	providerPayloadFixedOverheadChars?: number;
	retained: {
		currentObjective: boolean;
		requirementsSummary: boolean;
		activeFileSet: boolean;
		nextBestStep: boolean;
		taskState: boolean;
	};
	compactions: ProjectContextCompactionSummary[];
	packet: ContextPacket;
}

export interface ContextOrchestrationResult {
	messages: AgentMessage[];
	packet: ContextPacket;
	decision: ContextOrchestratorDecision;
}

export interface ContextOrchestratorOptions extends ProjectContextPreparationOptions {
	capabilityPlan?: CapabilityPlan;
	currentObjective?: string;
	requirementsSummary?: string[];
	onDecision?: (decision: ContextOrchestratorDecision) => void;
}

const PACKET_MARKER = "[Context packet]";
const MAX_SUMMARY_ITEMS = 6;
const MAX_ACTIVE_FILES = 12;
const MAX_TEXT_CHARS = 220;

export async function prepareContextPacket(
	messages: AgentMessage[],
	options: ContextOrchestratorOptions = {},
): Promise<ContextOrchestrationResult> {
	const packet = buildContextPacket(
		messages,
		options.capabilityPlan,
		options.currentObjective,
		options.requirementsSummary,
	);
	const messagesWithPacket = appendContextPacket(messages, packet);
	const compactions: ProjectContextCompactionSummary[] = [];
	const preparedMessages = await prepareProjectContextMessages(messagesWithPacket, {
		...options,
		onCompaction: (summary) => {
			compactions.push(summary);
			options.onCompaction?.(summary);
		},
	});
	const decision: ContextOrchestratorDecision = {
		inputMessageCount: messages.length,
		outputMessageCount: preparedMessages.length,
		droppedMessageCount: Math.max(0, messagesWithPacket.length - preparedMessages.length),
		providerPayloadBudgetChars: options.providerPayloadBudgetChars,
		providerPayloadFixedOverheadChars: options.providerPayloadFixedOverheadChars,
		retained: {
			currentObjective: packet.currentObjective.length > 0,
			requirementsSummary: packet.requirementsSummary.length > 0,
			activeFileSet: packet.activeFileSet.length > 0,
			nextBestStep: packet.nextBestStep.length > 0,
			taskState: packet.taskState.validationFailures.length > 0,
		},
		compactions,
		packet,
	};
	options.onDecision?.(decision);
	return { messages: preparedMessages, packet, decision };
}

export function contextDecisionDiagnosticData(decision: ContextOrchestratorDecision): Record<string, unknown> {
	return {
		inputMessageCount: decision.inputMessageCount,
		outputMessageCount: decision.outputMessageCount,
		droppedMessageCount: decision.droppedMessageCount,
		providerPayloadBudgetChars: decision.providerPayloadBudgetChars,
		providerPayloadFixedOverheadChars: decision.providerPayloadFixedOverheadChars,
		retained: decision.retained,
		compactions: decision.compactions,
		packet: decision.packet,
	};
}

function buildContextPacket(
	messages: AgentMessage[],
	capabilityPlan?: CapabilityPlan,
	currentObjectiveOverride?: string,
	requirementsSummaryOverride?: string[],
): ContextPacket {
	const latestObjective = normalizeWhitespace(currentObjectiveOverride ?? "") || latestUserObjective(messages);
	const activeFileSet = collectActiveFiles(messages);
	const currentErrors = collectCurrentErrors(messages);
	const requiredRereads = collectRequiredRereads(messages);
	const taskState = buildContextTaskState(messages);
	const designDecisions = capabilityPlan ? [capabilityDecisionText(capabilityPlan)] : [];
	const openProblems = [
		...(capabilityPlan?.requiresClarification ? ["Capability request needs clarification before execution."] : []),
		...(currentErrors.length > 0 ? ["Current project/tool errors must be resolved before final preview."] : []),
		...(taskState.validationFailures.length > 0
			? ["Validation failures must be resolved before final preview."]
			: []),
	];
	return {
		schemaVersion: 1,
		currentObjective: latestObjective,
		requirementsSummary: summarizeRequirements(latestObjective, requirementsSummaryOverride),
		designDecisions,
		activeFileSet,
		openProblems,
		currentErrors,
		requiredRereads,
		taskState,
		nextBestStep: nextBestStep(activeFileSet, currentErrors, requiredRereads, taskState),
		compactedToolHistory: {
			strategy: "project_tool_history",
			requiredRereadsBeforeEdit: requiredRereads.length > 0,
		},
	};
}

function appendContextPacket(messages: AgentMessage[], packet: ContextPacket): AgentMessage[] {
	if (hasContextPacket(messages)) return messages;
	const packetText = formatContextPacket(packet);
	const latestUserIndex = findLatestUserMessageIndex(messages);
	if (latestUserIndex < 0) {
		return [
			...messages,
			{
				role: "user",
				content: [{ type: "text", text: packetText }],
				timestamp: Date.now(),
			} as AgentMessage,
		];
	}
	return messages.map((message, index) => {
		if (index !== latestUserIndex) return message;
		const record = message as unknown as Record<string, unknown>;
		if (record.llmContent !== undefined) {
			return {
				...record,
				llmContent: appendTextContent(record.llmContent, packetText),
			} as unknown as AgentMessage;
		}
		return {
			...record,
			content: appendTextContent(record.content, packetText),
		} as unknown as AgentMessage;
	});
}

function formatContextPacket(packet: ContextPacket): string {
	return [
		PACKET_MARKER,
		`schema_version: ${packet.schemaVersion}`,
		`current_objective: ${packet.currentObjective || "unknown"}`,
		formatList("requirements_summary", packet.requirementsSummary),
		formatList("design_decisions", packet.designDecisions),
		formatList("active_file_set", packet.activeFileSet),
		formatList("open_problems", packet.openProblems),
		formatList("current_errors", packet.currentErrors),
		formatList("required_rereads", packet.requiredRereads),
		formatTaskState(packet.taskState),
		`next_best_step: ${packet.nextBestStep}`,
		`compacted_tool_history: ${packet.compactedToolHistory.strategy}; required_rereads_before_edit=${packet.compactedToolHistory.requiredRereadsBeforeEdit}`,
		"[/Context packet]",
	].join("\n");
}

function formatList(label: string, values: string[]): string {
	if (values.length === 0) return `${label}: none`;
	return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

function formatTaskState(taskState: ContextTaskState): string {
	if (taskState.validationFailures.length === 0) return "task_state: none";
	return [
		"task_state:",
		taskState.lastValidationStatus ? `last_validation_status: ${taskState.lastValidationStatus}` : undefined,
		formatList("validation_failures", taskState.validationFailures),
	]
		.filter((line): line is string => typeof line === "string")
		.join("\n");
}

function latestUserObjective(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isUserLikeMessage(message)) continue;
		const text = normalizeWhitespace(messageText(message));
		if (text) return truncateText(text, MAX_TEXT_CHARS);
	}
	return "";
}

function summarizeRequirements(objective: string, requirementsSummaryOverride?: string[]): string[] {
	if (requirementsSummaryOverride?.length) {
		return unique(
			requirementsSummaryOverride
				.map((item) => truncateText(normalizeWhitespace(item), MAX_TEXT_CHARS))
				.filter(Boolean),
		).slice(0, MAX_SUMMARY_ITEMS);
	}
	const parts = objective
		.split(/(?:\r?\n|[.;])/)
		.map((part) => truncateText(normalizeWhitespace(part), MAX_TEXT_CHARS))
		.filter(Boolean);
	if (parts.length === 0) return [];
	return unique(parts).slice(0, MAX_SUMMARY_ITEMS);
}

function collectActiveFiles(messages: AgentMessage[]): string[] {
	const files: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type !== "toolCall" || block.name !== "project_file") continue;
			const filename = readString(block.arguments, "filename");
			if (filename) files.push(filename);
		}
	}
	return unique(files).slice(-MAX_ACTIVE_FILES);
}

function collectCurrentErrors(messages: AgentMessage[]): string[] {
	const errors: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultMessage;
		if (toolResult.isError) {
			errors.push(truncateText(textBlocks(toolResult.content).join(" "), MAX_TEXT_CHARS));
			continue;
		}
		const text = textBlocks(toolResult.content).join("\n");
		if (/status:\s*(failed|error)/i.test(text)) errors.push(truncateText(normalizeWhitespace(text), MAX_TEXT_CHARS));
	}
	return unique(errors).slice(-MAX_SUMMARY_ITEMS);
}

function collectRequiredRereads(messages: AgentMessage[]): string[] {
	const rereads: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const text of textBlocks((message as ToolResultMessage).content)) {
			const omittedMatch = text.match(/\[project_file (?:content|get result) omitted:\s*([^\]\n]+)\]/i);
			if (omittedMatch?.[1]) rereads.push(omittedMatch[1].trim());
		}
	}
	return unique(rereads).slice(-MAX_ACTIVE_FILES);
}

function buildContextTaskState(messages: AgentMessage[]): ContextTaskState {
	const validationResults = collectValidationResults(messages);
	const latestValidation = validationResults.at(-1);
	return {
		validationFailures: latestValidation?.status === "failed" ? latestValidation.errors : [],
		...(latestValidation?.status ? { lastValidationStatus: latestValidation.status } : {}),
	};
}

type ValidationResult = {
	status: string;
	errors: string[];
};

function collectValidationResults(messages: AgentMessage[]): ValidationResult[] {
	const projectTaskCalls = new Map<string, string>();
	const results: ValidationResult[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of (message as AssistantMessage).content) {
				if (block.type !== "toolCall" || block.name !== "project_task") continue;
				projectTaskCalls.set(block.id, readString(block.arguments, "task") ?? "unknown");
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultMessage;
		if (toolResult.toolName !== "project_task") continue;
		const task = readString(toolResult.details, "task") ?? projectTaskCalls.get(toolResult.toolCallId) ?? "";
		if (task !== "validate") continue;
		const text = textBlocks(toolResult.content).join("\n");
		const status = readString(toolResult.details, "status") ?? parseLineValue(text, "Status");
		if (!status) continue;
		const errors = readStringArray(toolResult.details, "errors");
		results.push({
			status,
			errors:
				errors.length > 0
					? errors.map((error) => truncateText(error, MAX_TEXT_CHARS))
					: [truncateText(normalizeWhitespace(text), MAX_TEXT_CHARS)],
		});
	}
	return results;
}

function capabilityDecisionText(plan: CapabilityPlan): string {
	const unsupported = plan.unsupportedCapabilities.length > 0 ? plan.unsupportedCapabilities.join(",") : "none";
	return `delivery_mode=${plan.deliveryMode}; unsupported_capabilities=${unsupported}; requires_static_simulation=${plan.requiresSimulation}`;
}

function nextBestStep(
	activeFiles: string[],
	currentErrors: string[],
	requiredRereads: string[],
	taskState: ContextTaskState,
): string {
	if (requiredRereads.length > 0) return `Read required files before editing: ${requiredRereads.join(", ")}`;
	if (taskState.validationFailures.length > 0) {
		return `Fix validation failures: ${taskState.validationFailures[0]}`;
	}
	if (currentErrors.length > 0) return "Fix current project/tool errors before continuing.";
	if (activeFiles.length > 0) return `Continue from active files: ${activeFiles.join(", ")}`;
	return "Satisfy the latest user objective using the available project tools.";
}

function hasContextPacket(messages: AgentMessage[]): boolean {
	return messages.some((message) => messageText(message).includes(PACKET_MARKER));
}

function findLatestUserMessageIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isUserLikeMessage(messages[index])) return index;
	}
	return -1;
}

function isUserLikeMessage(message: AgentMessage | undefined): boolean {
	const role = (message as { role?: unknown } | undefined)?.role;
	return role === "user" || role === "user-with-attachments";
}

function appendTextContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return `${content}\n\n${text}`;
	if (Array.isArray(content)) return [...content, { type: "text", text }];
	return [{ type: "text", text }];
}

function messageText(message: AgentMessage | undefined): string {
	if (!message) return "";
	const record = message as unknown as Record<string, unknown>;
	return [contentText(record.llmContent), contentText(record.content)].filter(Boolean).join("\n");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return textBlocks(content).join("\n");
}

function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).filter(Boolean);
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()}...[truncated]`;
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function readString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const item = value[key];
	return typeof item === "string" ? item : undefined;
}

function readStringArray(value: unknown, key: string): string[] {
	if (!isRecord(value)) return [];
	const item = value[key];
	if (!Array.isArray(item)) return [];
	return item.filter((value): value is string => typeof value === "string");
}

function parseLineValue(text: string, label: string): string | undefined {
	const regex = new RegExp(`^\\s*${escapeRegExp(label)}\\s*:\\s*(.+?)\\s*$`, "im");
	return regex.exec(text)?.[1]?.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
