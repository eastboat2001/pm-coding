import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { isProjectFileOmittedContent } from "./omitted-content.js";

export interface ProjectToolHistoryCompactionOptions {
	maxContentChars?: number;
	maxRecentContentChars?: number;
	maxProjectFileGetResultChars?: number;
	keepRecentToolCalls?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 1200;
const DEFAULT_MAX_RECENT_CONTENT_CHARS = 12_000;
const DEFAULT_MAX_PROJECT_FILE_GET_RESULT_CHARS = 12_000;
const DEFAULT_KEEP_RECENT_TOOL_CALLS = 1;

export async function compactProjectToolHistory(
	messages: AgentMessage[],
	options: ProjectToolHistoryCompactionOptions = {},
): Promise<AgentMessage[]> {
	const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
	const maxRecentContentChars = options.maxRecentContentChars ?? DEFAULT_MAX_RECENT_CONTENT_CHARS;
	const maxProjectFileGetResultChars =
		options.maxProjectFileGetResultChars ?? DEFAULT_MAX_PROJECT_FILE_GET_RESULT_CHARS;
	const keepRecentToolCalls = options.keepRecentToolCalls ?? DEFAULT_KEEP_RECENT_TOOL_CALLS;
	const keepToolCallIds = findRecentProjectFileToolCallIds(messages, keepRecentToolCalls);
	const projectFileGetCallsById = findProjectFileGetCalls(messages);
	const projectTaskCallsById = findProjectTaskCalls(messages);
	const skillLoadCallsById = findSkillLoadCalls(messages);
	const skillResourceCallsById = findSkillResourceCalls(messages);

	let changed = false;
	const compacted = messages.map((message, messageIndex) => {
		if (message.role === "toolResult") {
			const getCall = projectFileGetCallsById.get(message.toolCallId);
			const taskCall = projectTaskCallsById.get(message.toolCallId);
			const skillLoadCall = skillLoadCallsById.get(message.toolCallId);
			const skillResourceCall = skillResourceCallsById.get(message.toolCallId);
			if (
				(!getCall && !taskCall && !skillLoadCall && !skillResourceCall) ||
				message.isError ||
				!hasLaterAssistantMessage(messages, messageIndex)
			) {
				return message;
			}
			const nextContent = message.content.map((block) => {
				const contentLimit = getCall ? maxProjectFileGetResultChars : maxContentChars;
				if (block.type !== "text" || block.text.length <= contentLimit) return block;
				if (getCall) {
					if (isProjectFileOmittedContent(block.text)) return block;
					changed = true;
					return {
						...block,
						text: summarizeProjectFileGetResult(getCall.filename, block.text),
					};
				}
				if (taskCall) {
					if (isProjectTaskOmittedResult(block.text)) return block;
					changed = true;
					return {
						...block,
						text: summarizeProjectTaskResult(taskCall.task, block.text),
					};
				}
				if (skillLoadCall) {
					if (isSkillToolOmittedResult(block.text)) return block;
					changed = true;
					return {
						...block,
						text: summarizeSkillLoadResult(skillLoadCall.name, block.text),
					};
				}
				if (!skillResourceCall || isSkillToolOmittedResult(block.text)) return block;
				changed = true;
				return {
					...block,
					text: summarizeSkillResourceResult(skillResourceCall.name, skillResourceCall.path, block.text),
				};
			});
			if (nextContent.every((block, index) => block === message.content[index])) return message;
			return { ...message, content: nextContent } satisfies ToolResultMessage;
		}
		if (message.role !== "assistant") return message;
		const nextContent = message.content.map((block) => {
			if (!isProjectFileToolCall(block)) return block;
			const content = block.arguments.content;
			const contentLimit = keepToolCallIds.has(block.id) ? maxRecentContentChars : maxContentChars;
			if (typeof content !== "string" || content.length <= contentLimit) return block;
			changed = true;
			return {
				...block,
				arguments: {
					...omitProjectFileContentArguments(block, content),
				},
			} satisfies ToolCall;
		});
		if (nextContent.every((block, index) => block === message.content[index])) return message;
		return { ...message, content: nextContent } satisfies AssistantMessage;
	});

	return changed ? compacted : messages;
}

type ProjectFileGetCall = {
	filename: string;
};

type ProjectTaskCall = {
	task: string;
};

type SkillLoadCall = {
	name: string;
};

type SkillResourceCall = {
	name: string;
	path: string;
};

function findRecentProjectFileToolCallIds(messages: AgentMessage[], keepRecentToolCalls: number): Set<string> {
	const ids = new Set<string>();
	if (keepRecentToolCalls <= 0) return ids;
	for (let messageIndex = messages.length - 1; messageIndex >= 0 && ids.size < keepRecentToolCalls; messageIndex--) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (
			let blockIndex = message.content.length - 1;
			blockIndex >= 0 && ids.size < keepRecentToolCalls;
			blockIndex--
		) {
			const block = message.content[blockIndex];
			if (isContentBearingProjectFileToolCall(block)) ids.add(block.id);
		}
	}
	return ids;
}

function isProjectFileToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall" && block.name === "project_file";
}

function findProjectFileGetCalls(messages: AgentMessage[]): Map<string, ProjectFileGetCall> {
	const calls = new Map<string, ProjectFileGetCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (!isProjectFileToolCall(block)) continue;
			if (block.arguments.command !== "get") continue;
			if (typeof block.arguments.filename !== "string") continue;
			calls.set(block.id, { filename: block.arguments.filename });
		}
	}
	return calls;
}

function findProjectTaskCalls(messages: AgentMessage[]): Map<string, ProjectTaskCall> {
	const calls = new Map<string, ProjectTaskCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "project_task") continue;
			const task = typeof block.arguments.task === "string" ? block.arguments.task : "unknown task";
			calls.set(block.id, { task });
		}
	}
	return calls;
}

function findSkillLoadCalls(messages: AgentMessage[]): Map<string, SkillLoadCall> {
	const calls = new Map<string, SkillLoadCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "skill_load") continue;
			const name = typeof block.arguments.name === "string" ? block.arguments.name : "unknown skill";
			calls.set(block.id, { name });
		}
	}
	return calls;
}

function findSkillResourceCalls(messages: AgentMessage[]): Map<string, SkillResourceCall> {
	const calls = new Map<string, SkillResourceCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "skill_resource") continue;
			const name = typeof block.arguments.name === "string" ? block.arguments.name : "unknown skill";
			const path = typeof block.arguments.path === "string" ? block.arguments.path : "unknown resource";
			calls.set(block.id, { name, path });
		}
	}
	return calls;
}

function hasLaterAssistantMessage(messages: AgentMessage[], messageIndex: number): boolean {
	for (let index = messageIndex + 1; index < messages.length; index++) {
		if (messages[index]?.role === "assistant") return true;
	}
	return false;
}

function isContentBearingProjectFileToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
	return (
		isProjectFileToolCall(block) &&
		typeof block.arguments.content === "string" &&
		!isProjectFileOmittedContent(block.arguments.content)
	);
}

function omitProjectFileContentArguments(block: ToolCall, content: string): Record<string, unknown> {
	const filename = typeof block.arguments.filename === "string" ? block.arguments.filename : "unknown file";
	const lineCount = content.split(/\r?\n/).length;
	const { content: _content, ...rest } = block.arguments;
	return {
		...rest,
		contentOmitted: true,
		omissionReason: "history_compaction",
		omittedChars: content.length,
		omittedLines: lineCount,
		filename,
	};
}

function summarizeProjectFileGetResult(filename: string, content: string): string {
	const lineCount = content.split(/\r?\n/).length;
	return `Project file content omitted from compacted history for ${filename}: ${content.length} chars, ${lineCount} lines. This is not file content. Call project_file get for ${filename} if full content is needed.`;
}

function summarizeProjectTaskResult(task: string, content: string): string {
	const lineCount = content.split(/\r?\n/).length;
	return `[project_task result omitted: ${content.length} chars, ${lineCount} lines from ${task}. Project status is retained in the project context manifest.]`;
}

function summarizeSkillLoadResult(name: string, content: string): string {
	const lineCount = content.split(/\r?\n/).length;
	return `[skill_load result omitted: ${content.length} chars, ${lineCount} lines from ${name}. Call skill_load for this skill if full instructions are needed again.]`;
}

function summarizeSkillResourceResult(name: string, path: string, content: string): string {
	const lineCount = content.split(/\r?\n/).length;
	return `[skill_resource result omitted: ${content.length} chars, ${lineCount} lines from ${name}/${path}. Call skill_resource for this skill resource if full content is needed again.]`;
}

function isProjectTaskOmittedResult(content: string): boolean {
	return /^\[project_task result omitted: \d+ chars, \d+ lines from .+\]/.test(content.trim());
}

function isSkillToolOmittedResult(content: string): boolean {
	return /^\[skill_(?:load|resource) result omitted: \d+ chars, \d+ lines from .+\]/.test(content.trim());
}
