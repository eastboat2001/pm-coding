import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Model,
	ModelThinkingLevel,
	ThinkingBudgets,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@mariozechner/pi-ai";
import { compactProjectToolHistory, type ProjectToolHistoryCompactionOptions } from "./history.js";

export type ProjectContextCompactionSummary = {
	reason: "provider_payload_budget_exceeded";
	budgetChars: number;
	beforeProviderPayloadChars: number;
	afterProviderPayloadChars: number;
	droppedMessages: number;
	droppedAssistantMessages: number;
	droppedToolResultMessages: number;
};

export interface ProjectContextPreparationOptions extends ProjectToolHistoryCompactionOptions {
	providerPayloadBudgetChars?: number;
	providerPayloadFixedOverheadChars?: number;
	onCompaction?: (summary: ProjectContextCompactionSummary) => void;
}

export type ProjectContextProviderPayloadBudget = {
	providerPayloadBudgetChars: number;
	providerPayloadFixedOverheadChars: number;
	providerPayloadMessageBudgetChars: number;
	contextWindowTokens: number;
	reservedOutputTokens: number;
	reservedReasoningTokens: number;
	safetyMarginTokens: number;
};

export type ProjectContextProviderPayloadBudgetInput = {
	model?: Pick<Model<Api>, "contextWindow" | "maxTokens" | "reasoning">;
	maxTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	systemPrompt?: string;
	tools?: readonly unknown[];
	providerPayloadBudgetChars?: number;
};

type ProjectFileState = {
	filename: string;
	command: string;
	contentChars?: number;
	contentLines?: number;
	contentHash?: string;
};

type ProjectTaskState = {
	task: string;
	status?: string;
	previewUrl?: string;
	fileCount?: number;
	files: string[];
};

type ProjectManifestState = {
	files: Map<string, ProjectFileState>;
	recentFileOperations: string[];
	projectTasks: ProjectTaskState[];
	projectTaskCalls: Map<string, string>;
};

const MANIFEST_MARKER = "[Project context manifest]";
const MAX_FILES = 12;
const MAX_RECENT_FILE_OPERATIONS = 12;
const MAX_PROJECT_TASKS = 6;
const MAX_TASK_FILES = 8;
const DEFAULT_PROVIDER_PAYLOAD_BUDGET_CHARS = 100_000;
const MIN_PROVIDER_PAYLOAD_BUDGET_CHARS = 8_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_DEFAULT_OUTPUT_TOKENS = 32_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const CONTEXT_SAFETY_RATIO = 0.08;
const MIN_CONTEXT_SAFETY_TOKENS = 1_024;
const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
	minimal: 1_024,
	low: 2_048,
	medium: 8_192,
	high: 16_384,
};

export function resolveProjectContextProviderPayloadBudget(
	input: ProjectContextProviderPayloadBudgetInput = {},
): ProjectContextProviderPayloadBudget {
	const contextWindowTokens = positiveInteger(input.model?.contextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS);
	const reservedOutputTokens = resolveReservedOutputTokens(input, contextWindowTokens);
	const reservedReasoningTokens = resolveReservedReasoningTokens(input, contextWindowTokens);
	const safetyMarginTokens = Math.max(
		MIN_CONTEXT_SAFETY_TOKENS,
		Math.ceil(contextWindowTokens * CONTEXT_SAFETY_RATIO),
	);
	const availableInputTokens = Math.max(
		0,
		contextWindowTokens - reservedOutputTokens - reservedReasoningTokens - safetyMarginTokens,
	);
	const dynamicBudgetChars = availableInputTokens * ESTIMATED_CHARS_PER_TOKEN;
	const maxProviderPayloadBudgetChars = Math.max(
		MIN_PROVIDER_PAYLOAD_BUDGET_CHARS,
		positiveInteger(input.providerPayloadBudgetChars, DEFAULT_PROVIDER_PAYLOAD_BUDGET_CHARS),
	);
	const providerPayloadBudgetChars = clampInteger(
		dynamicBudgetChars,
		MIN_PROVIDER_PAYLOAD_BUDGET_CHARS,
		maxProviderPayloadBudgetChars,
	);
	const providerPayloadFixedOverheadChars = estimateProviderPayloadFixedOverheadChars(input);
	return {
		providerPayloadBudgetChars,
		providerPayloadFixedOverheadChars,
		providerPayloadMessageBudgetChars: Math.max(0, providerPayloadBudgetChars - providerPayloadFixedOverheadChars),
		contextWindowTokens,
		reservedOutputTokens,
		reservedReasoningTokens,
		safetyMarginTokens,
	};
}

export async function prepareProjectContextMessages(
	messages: AgentMessage[],
	options: ProjectContextPreparationOptions = {},
): Promise<AgentMessage[]> {
	const replayableMessages = dropNonReplayableAssistantMessages(messages);
	const manifest = buildProjectContextManifest(replayableMessages);
	const compacted = appendProjectContextManifest(
		await compactProjectToolHistory(replayableMessages, options),
		manifest,
	);
	return compactProjectContextToBudget(compacted, options);
}

function dropNonReplayableAssistantMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message) => !isThinkingOnlyLengthAssistantMessage(message));
}

function isThinkingOnlyLengthAssistantMessage(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant" || message.stopReason !== "length") return false;
	const hasToolCall = message.content.some((block) => block.type === "toolCall");
	const hasVisibleText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
	const hasThinking = message.content.some((block) => block.type === "thinking" && block.thinking.trim().length > 0);
	return hasThinking && !hasToolCall && !hasVisibleText;
}

export function appendProjectContextManifest(
	messages: AgentMessage[],
	manifest = buildProjectContextManifest(messages),
): AgentMessage[] {
	if (hasProjectContextManifest(messages)) return messages;
	if (!manifest) return messages;
	const insertIndex = latestUserMessageIndex(messages);
	const manifestMessage: UserMessage = {
		role: "user",
		content: manifest,
		timestamp: Date.now(),
	};
	if (insertIndex < 0) return [...messages, manifestMessage];
	return [...messages.slice(0, insertIndex), manifestMessage, ...messages.slice(insertIndex)];
}

function buildProjectContextManifest(messages: AgentMessage[]): string | undefined {
	const state: ProjectManifestState = {
		files: new Map(),
		recentFileOperations: [],
		projectTasks: [],
		projectTaskCalls: new Map(),
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			recordAssistantToolCalls(state, message);
			continue;
		}
		if (message.role === "toolResult") {
			recordToolResult(state, message);
		}
	}
	if (state.files.size === 0 && state.recentFileOperations.length === 0 && state.projectTasks.length === 0) {
		return undefined;
	}
	const lines = [
		MANIFEST_MARKER,
		"Generated from prior project tool history. Use this compact state instead of replaying old logs.",
		"Call project_file get when full file content is needed.",
		"",
	];
	appendFileSection(lines, state);
	appendTaskSection(lines, state);
	return lines.join("\n").trimEnd();
}

function compactProjectContextToBudget(
	messages: AgentMessage[],
	options: ProjectContextPreparationOptions,
): AgentMessage[] {
	const budgetChars = positiveInteger(options.providerPayloadBudgetChars, DEFAULT_PROVIDER_PAYLOAD_BUDGET_CHARS);
	const fixedOverheadChars = nonNegativeInteger(options.providerPayloadFixedOverheadChars, 0);
	const beforeProviderPayloadChars = fixedOverheadChars + estimateAgentMessagesProviderPayloadChars(messages);
	if (beforeProviderPayloadChars <= budgetChars) return messages;

	const protectedIndexes = findProtectedMessageIndexes(messages);
	const candidates = findDroppableProjectHistoryCandidates(messages, protectedIndexes);
	if (candidates.length === 0) return messages;

	const droppedIndexes = new Set<number>();
	let afterProviderPayloadChars = beforeProviderPayloadChars;
	for (const candidate of candidates) {
		for (const index of candidate.indexes) {
			droppedIndexes.add(index);
		}
		afterProviderPayloadChars =
			fixedOverheadChars +
			estimateAgentMessagesProviderPayloadChars(messages.filter((_message, index) => !droppedIndexes.has(index)));
		if (afterProviderPayloadChars <= budgetChars) break;
	}
	if (droppedIndexes.size === 0 || afterProviderPayloadChars >= beforeProviderPayloadChars) return messages;

	let droppedAssistantMessages = 0;
	let droppedToolResultMessages = 0;
	const compacted = messages.filter((message, index) => {
		if (!droppedIndexes.has(index)) return true;
		if (message.role === "assistant") droppedAssistantMessages += 1;
		if (message.role === "toolResult") droppedToolResultMessages += 1;
		return false;
	});
	options.onCompaction?.({
		reason: "provider_payload_budget_exceeded",
		budgetChars,
		beforeProviderPayloadChars,
		afterProviderPayloadChars,
		droppedMessages: droppedIndexes.size,
		droppedAssistantMessages,
		droppedToolResultMessages,
	});
	return compacted;
}

type DroppableProjectHistoryCandidate = {
	indexes: number[];
};

function findDroppableProjectHistoryCandidates(
	messages: AgentMessage[],
	protectedIndexes: Set<number>,
): DroppableProjectHistoryCandidate[] {
	const candidates: DroppableProjectHistoryCandidate[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (protectedIndexes.has(index)) continue;
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const toolCallIds = projectToolCallIds(message);
		if (toolCallIds.length === 0 || hasNonProjectToolCall(message)) continue;
		const resultIndexes = toolResultIndexesForCalls(messages, toolCallIds, protectedIndexes);
		const latestCandidateIndex = Math.max(index, ...resultIndexes);
		if (!hasLaterAssistantMessage(messages, latestCandidateIndex)) continue;
		candidates.push({ indexes: [index, ...resultIndexes] });
	}
	return candidates;
}

function projectToolCallIds(message: AssistantMessage): string[] {
	return message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.filter((block) => block.name === "project_file" || block.name === "project_task")
		.map((block) => block.id);
}

function hasNonProjectToolCall(message: AssistantMessage): boolean {
	return message.content.some(
		(block) => block.type === "toolCall" && block.name !== "project_file" && block.name !== "project_task",
	);
}

function toolResultIndexesForCalls(
	messages: AgentMessage[],
	toolCallIds: string[],
	protectedIndexes: Set<number>,
): number[] {
	const ids = new Set(toolCallIds);
	const indexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (protectedIndexes.has(index)) continue;
		const message = messages[index];
		if (message?.role === "toolResult" && ids.has(message.toolCallId)) indexes.push(index);
	}
	return indexes;
}

function findProtectedMessageIndexes(messages: AgentMessage[]): Set<number> {
	const protectedIndexes = new Set<number>();
	const latestUserIndex = latestUserMessageIndex(messages);
	if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex);
	for (let index = 0; index < messages.length; index++) {
		if (isProjectContextManifestMessage(messages[index])) protectedIndexes.add(index);
	}
	protectFinalToolResultCycle(messages, protectedIndexes);
	return protectedIndexes;
}

function protectFinalToolResultCycle(messages: AgentMessage[], protectedIndexes: Set<number>): void {
	if (messages.at(-1)?.role !== "toolResult") return;
	let firstFinalToolResultIndex = messages.length - 1;
	while (firstFinalToolResultIndex > 0 && messages[firstFinalToolResultIndex - 1]?.role === "toolResult") {
		firstFinalToolResultIndex -= 1;
	}
	for (let index = firstFinalToolResultIndex; index < messages.length; index++) {
		protectedIndexes.add(index);
	}
	for (let index = firstFinalToolResultIndex - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			protectedIndexes.add(index);
			return;
		}
	}
}

function hasLaterAssistantMessage(messages: AgentMessage[], messageIndex: number): boolean {
	for (let index = messageIndex + 1; index < messages.length; index++) {
		if (messages[index]?.role === "assistant") return true;
	}
	return false;
}

function recordAssistantToolCalls(state: ProjectManifestState, message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		if (block.name === "project_file") {
			recordProjectFileCall(state, block);
			continue;
		}
		if (block.name === "project_task") {
			const task = readString(block.arguments, "task") ?? "unknown";
			state.projectTaskCalls.set(block.id, task);
		}
	}
}

function recordProjectFileCall(state: ProjectManifestState, block: ToolCall): void {
	const command = readString(block.arguments, "command") ?? "unknown";
	const filename = readString(block.arguments, "filename");
	if (!filename) {
		if (command === "list")
			appendCapped(state.recentFileOperations, "list project files", MAX_RECENT_FILE_OPERATIONS);
		return;
	}
	const content = readString(block.arguments, "content");
	const fileState: ProjectFileState = {
		filename,
		command,
		...(content !== undefined
			? {
					contentChars: content.length,
					contentLines: lineCount(content),
					contentHash: contentFingerprint(content),
				}
			: {}),
	};
	state.files.set(filename, fileState);
	const operationParts = [`${command} ${filename}`];
	if (content !== undefined) {
		operationParts.push(`${content.length} chars`);
		operationParts.push(`hash ${contentFingerprint(content)}`);
	}
	appendCapped(state.recentFileOperations, operationParts.join(" | "), MAX_RECENT_FILE_OPERATIONS);
}

function recordToolResult(state: ProjectManifestState, message: ToolResultMessage): void {
	if (message.toolName !== "project_task") return;
	const text = firstTextBlock(message);
	const details: unknown = message.details;
	const task =
		readString(details, "task") ??
		state.projectTaskCalls.get(message.toolCallId) ??
		parseLineValue(text, "Task") ??
		"unknown";
	const projectTask: ProjectTaskState = {
		task,
		status: readString(details, "status") ?? parseLineValue(text, "Status"),
		previewUrl: readString(details, "previewUrl") ?? parseLineValue(text, "Preview URL"),
		fileCount: readNumber(details, "fileCount") ?? parseNumberLine(text, "Files"),
		files: readStringArray(details, "files").slice(0, MAX_TASK_FILES),
	};
	appendCapped(state.projectTasks, projectTask, MAX_PROJECT_TASKS);
}

function appendFileSection(lines: string[], state: ProjectManifestState): void {
	const files = [...state.files.values()].slice(-MAX_FILES);
	if (files.length > 0) {
		lines.push("Files:");
		for (const file of files) {
			const parts = [`${file.filename}: ${file.command}`];
			if (file.contentChars !== undefined) parts.push(`${file.contentChars} chars`);
			if (file.contentLines !== undefined) parts.push(`${file.contentLines} lines`);
			if (file.contentHash) parts.push(`hash ${file.contentHash}`);
			lines.push(`- ${parts.join(", ")}`);
		}
		lines.push("");
	}
	if (state.recentFileOperations.length > 0) {
		lines.push("Recent project_file operations:");
		for (const operation of state.recentFileOperations.slice(-MAX_RECENT_FILE_OPERATIONS)) {
			lines.push(`- ${operation}`);
		}
		lines.push("");
	}
}

function appendTaskSection(lines: string[], state: ProjectManifestState): void {
	const tasks = state.projectTasks.slice(-MAX_PROJECT_TASKS);
	if (tasks.length === 0) return;
	lines.push("Project tasks:");
	for (const task of tasks) {
		const parts = [`project_task: ${task.task}`];
		if (task.status) parts.push(`status ${task.status}`);
		if (task.previewUrl) parts.push(`Preview URL: ${task.previewUrl}`);
		if (task.fileCount !== undefined) parts.push(`files ${task.fileCount}`);
		lines.push(`- ${parts.join(", ")}`);
		if (task.files.length > 0) lines.push(`  Files: ${task.files.join(", ")}`);
	}
}

function latestUserMessageIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const role = (messages[index] as { role?: string }).role;
		if (role === "user" || role === "user-with-attachments") return index;
	}
	return -1;
}

function hasProjectContextManifest(messages: AgentMessage[]): boolean {
	return messages.some(isProjectContextManifestMessage);
}

function isProjectContextManifestMessage(message: AgentMessage | undefined): boolean {
	if (!message || (message as { role?: string }).role !== "user") return false;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.startsWith(MANIFEST_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some((block) => isRecord(block) && block.type === "text" && startsWithMarker(block.text));
}

function startsWithMarker(value: unknown): boolean {
	return typeof value === "string" && value.startsWith(MANIFEST_MARKER);
}

function appendCapped<T>(items: T[], item: T, maxItems: number): void {
	items.push(item);
	if (items.length > maxItems) items.splice(0, items.length - maxItems);
}

function firstTextBlock(message: ToolResultMessage): string {
	return message.content.find((block) => block.type === "text")?.text ?? "";
}

function parseLineValue(text: string, label: string): string | undefined {
	const prefix = `${label}:`;
	const line = text
		.split(/\r?\n/)
		.find((candidate) => candidate.trimStart().toLowerCase().startsWith(prefix.toLowerCase()));
	if (!line) return undefined;
	return line.slice(line.indexOf(":") + 1).trim() || undefined;
}

function parseNumberLine(text: string, label: string): number | undefined {
	const value = parseLineValue(text, label);
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const item = value[key];
	return typeof item === "string" ? item : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function readStringArray(value: unknown, key: string): string[] {
	if (!isRecord(value)) return [];
	const item = value[key];
	if (!Array.isArray(item)) return [];
	return item.filter((entry): entry is string => typeof entry === "string");
}

function lineCount(value: string): number {
	return value.split(/\r?\n/).length;
}

function contentFingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function estimateAgentMessagesProviderPayloadChars(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateAgentMessageProviderPayloadChars(message), 0);
}

function estimateAgentMessageProviderPayloadChars(message: AgentMessage): number {
	const role = (message as { role?: string }).role;
	if (role === "user" || role === "user-with-attachments") {
		const record = message as { role?: string; content?: unknown; llmContent?: unknown };
		return stableStringify({
			role: "user",
			content: record.llmContent ?? record.content,
		}).length;
	}
	if (message.role === "assistant") {
		return stableStringify({
			role: message.role,
			content: message.content,
		}).length;
	}
	if (message.role === "toolResult") {
		return stableStringify({
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		}).length;
	}
	return 0;
}

function stableStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item) => {
			if (!isRecord(item)) return item;
			return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
		}) ?? ""
	);
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveReservedOutputTokens(
	input: ProjectContextProviderPayloadBudgetInput,
	contextWindowTokens: number,
): number {
	const configuredMaxTokens =
		positiveInteger(input.maxTokens, 0) ||
		(input.model?.maxTokens ? Math.min(input.model.maxTokens, MAX_DEFAULT_OUTPUT_TOKENS) : DEFAULT_MAX_OUTPUT_TOKENS);
	return clampInteger(configuredMaxTokens, 0, Math.max(0, Math.floor(contextWindowTokens / 2)));
}

function resolveReservedReasoningTokens(
	input: ProjectContextProviderPayloadBudgetInput,
	contextWindowTokens: number,
): number {
	if (input.model?.reasoning !== true || !input.thinkingLevel || input.thinkingLevel === "off") return 0;
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...input.thinkingBudgets };
	const level = input.thinkingLevel === "xhigh" ? "high" : input.thinkingLevel;
	const budget = positiveInteger(budgets[level], DEFAULT_THINKING_BUDGETS[level]);
	return clampInteger(budget, 0, Math.max(0, Math.floor(contextWindowTokens / 4)));
}

function estimateProviderPayloadFixedOverheadChars(input: ProjectContextProviderPayloadBudgetInput): number {
	const systemPromptChars = input.systemPrompt?.length ?? 0;
	const toolsChars = (input.tools ?? []).reduce<number>((total, tool) => total + stableStringify(tool).length, 0);
	return systemPromptChars + toolsChars;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
