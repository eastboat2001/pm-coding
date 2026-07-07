import type { AssistantMessage, Context, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type { DiagnosticData } from "./diagnostic-client.js";

type CountedItem = {
	kind: string;
	label: string;
	chars: number;
};

type RoleStats = {
	count: number;
	chars: number;
	contentChars: number;
};

type ToolNameStats = {
	toolName: string;
	count: number;
	chars: number;
};

const MAX_LARGE_ITEMS = 12;

export function summarizeContextBudget(context: Context): DiagnosticData {
	const systemPromptChars = context.systemPrompt?.length ?? 0;
	const tools = context.tools ?? [];
	const toolItems = tools.map((tool) => ({
		kind: "tool",
		label: tool.name,
		chars: stableStringify(tool).length,
	}));
	const toolsChars = sumChars(toolItems);
	const roleStats: Record<string, RoleStats> = {};
	const toolResultStats = new Map<string, ToolNameStats>();
	const assistantToolCallStats = new Map<string, ToolNameStats>();
	const largeItems: CountedItem[] = [];
	let messagesChars = 0;
	let messageContentChars = 0;
	let internalMessagesSerializedChars = 0;
	let internalDetailsChars = 0;
	let toolResultCount = 0;
	let toolResultChars = 0;
	let toolResultContentChars = 0;
	let assistantToolCallCount = 0;
	let assistantToolCallArgumentChars = 0;

	if (systemPromptChars > 0) {
		largeItems.push({ kind: "systemPrompt", label: "systemPrompt", chars: systemPromptChars });
	}
	largeItems.push(...toolItems);

	context.messages.forEach((message, index) => {
		const messageChars = providerMessageChars(message);
		const internalMessageChars = stableStringify(message).length;
		const contentChars = messageContentLength(message);
		messagesChars += messageChars;
		internalMessagesSerializedChars += internalMessageChars;
		messageContentChars += contentChars;
		addRoleStats(roleStats, message.role, messageChars, contentChars);
		largeItems.push({ kind: "message", label: `${index}:${message.role}`, chars: messageChars });

		if (message.role === "toolResult") {
			internalDetailsChars += message.details === undefined ? 0 : stableStringify(message.details).length;
			toolResultCount += 1;
			toolResultChars += messageChars;
			toolResultContentChars += contentChars;
			addToolNameStats(toolResultStats, message.toolName, messageChars);
			largeItems.push({ kind: "toolResult", label: message.toolName, chars: messageChars });
			return;
		}

		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const argumentChars = stableStringify(block.arguments).length;
				assistantToolCallCount += 1;
				assistantToolCallArgumentChars += argumentChars;
				addToolNameStats(assistantToolCallStats, block.name, argumentChars);
				largeItems.push({ kind: "assistantToolCallArguments", label: block.name, chars: argumentChars });
			}
		}
	});

	const totalChars = systemPromptChars + toolsChars + messagesChars;
	return {
		totalChars,
		providerPayloadChars: totalChars,
		approximateTokens: Math.ceil(totalChars / 4),
		providerApproximateTokens: Math.ceil(totalChars / 4),
		internalSerializedChars: systemPromptChars + toolsChars + internalMessagesSerializedChars,
		internalDetailsChars,
		systemPromptChars,
		toolCount: tools.length,
		toolsChars,
		messageCount: context.messages.length,
		messagesChars,
		messageContentChars,
		byRole: roleStats,
		toolResults: {
			count: toolResultCount,
			chars: toolResultChars,
			contentChars: toolResultContentChars,
			byToolName: sortedToolNameStats(toolResultStats),
		},
		assistantToolCalls: {
			count: assistantToolCallCount,
			argumentChars: assistantToolCallArgumentChars,
			byToolName: sortedToolNameStats(assistantToolCallStats),
		},
		largeItems: largeItems
			.filter((item) => item.chars > 0)
			.sort((left, right) => right.chars - left.chars)
			.slice(0, MAX_LARGE_ITEMS),
	};
}

function addRoleStats(
	stats: Record<string, RoleStats>,
	role: Message["role"],
	chars: number,
	contentChars: number,
): void {
	const existing = stats[role] ?? { count: 0, chars: 0, contentChars: 0 };
	existing.count += 1;
	existing.chars += chars;
	existing.contentChars += contentChars;
	stats[role] = existing;
}

function addToolNameStats(stats: Map<string, ToolNameStats>, toolName: string, chars: number): void {
	const existing = stats.get(toolName) ?? { toolName, count: 0, chars: 0 };
	existing.count += 1;
	existing.chars += chars;
	stats.set(toolName, existing);
}

function sortedToolNameStats(stats: Map<string, ToolNameStats>): ToolNameStats[] {
	return [...stats.values()].sort(
		(left, right) => right.chars - left.chars || left.toolName.localeCompare(right.toolName),
	);
}

function sumChars(items: CountedItem[]): number {
	return items.reduce((total, item) => total + item.chars, 0);
}

function messageContentLength(message: Message): number {
	if (message.role === "user") return userContentLength(message.content);
	if (message.role === "assistant") return assistantContentLength(message);
	return toolResultContentLength(message);
}

function providerMessageChars(message: Message): number {
	if (message.role === "user") {
		return stableStringify({
			role: message.role,
			content: message.content,
		}).length;
	}
	if (message.role === "assistant") {
		return stableStringify({
			role: message.role,
			content: message.content,
		}).length;
	}
	return stableStringify({
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
		isError: message.isError,
	}).length;
}

function assistantContentLength(message: AssistantMessage): number {
	return message.content.reduce((total, block) => {
		if (block.type === "text") return total + block.text.length;
		if (block.type === "thinking") return total + block.thinking.length;
		return total + stableStringify(block.arguments).length;
	}, 0);
}

function toolResultContentLength(message: ToolResultMessage): number {
	return message.content.reduce((total, block) => {
		if (block.type === "text") return total + block.text.length;
		return total + block.data.length;
	}, 0);
}

function userContentLength(content: UserMessage["content"]): number {
	if (typeof content === "string") return content.length;
	return content.reduce((total, block) => {
		if (block.type === "text") return total + block.text.length;
		return total + block.data.length;
	}, 0);
}

function stableStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item) => {
			if (!isRecord(item)) return item;
			return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
		}) ?? ""
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
