import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";

export interface ProjectToolHistoryCompactionOptions {
	maxContentChars?: number;
	keepRecentToolCalls?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 1200;
const DEFAULT_KEEP_RECENT_TOOL_CALLS = 1;

export async function compactProjectToolHistory(
	messages: AgentMessage[],
	options: ProjectToolHistoryCompactionOptions = {},
): Promise<AgentMessage[]> {
	const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
	const keepRecentToolCalls = options.keepRecentToolCalls ?? DEFAULT_KEEP_RECENT_TOOL_CALLS;
	const keepToolCallIds = findRecentProjectFileToolCallIds(messages, keepRecentToolCalls);

	let changed = false;
	const compacted = messages.map((message) => {
		if (message.role !== "assistant") return message;
		const nextContent = message.content.map((block) => {
			if (!isProjectFileToolCall(block) || keepToolCallIds.has(block.id)) return block;
			const content = block.arguments.content;
			if (typeof content !== "string" || content.length <= maxContentChars) return block;
			changed = true;
			return {
				...block,
				arguments: {
					...block.arguments,
					content: summarizeProjectFileContent(block, content),
				},
			} satisfies ToolCall;
		});
		if (nextContent.every((block, index) => block === message.content[index])) return message;
		return { ...message, content: nextContent } satisfies AssistantMessage;
	});

	return changed ? compacted : messages;
}

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
			if (isProjectFileToolCall(block)) ids.add(block.id);
		}
	}
	return ids;
}

function isProjectFileToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall" && block.name === "project_file";
}

function summarizeProjectFileContent(block: ToolCall, content: string): string {
	const filename = typeof block.arguments.filename === "string" ? block.arguments.filename : "unknown file";
	const lineCount = content.split(/\r?\n/).length;
	return `[project_file content omitted: ${content.length} chars, ${lineCount} lines from ${filename}]`;
}
