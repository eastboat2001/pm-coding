export type ConversationSnapshotRole = "user" | "assistant";

export interface ConversationSnapshotMessage {
	role: ConversationSnapshotRole;
	content: string;
}

export interface ConversationSnapshot {
	compactedSummary: string;
	recentMessages: ConversationSnapshotMessage[];
	currentObjective: string;
}

export interface ConversationSnapshotState {
	summarizedMessageCount: number;
	snapshot: ConversationSnapshot;
}

export type ConversationSnapshotWarning = "earlier_context_incomplete";

export interface ConversationSnapshotBudget {
	totalChars: number;
	recentChars: number;
	summaryChars: number;
	safetyChars: number;
	triggerChars: number;
}

export interface ConversationSnapshotSummarizeInput {
	previousSummary: string;
	exitedMessages: ConversationSnapshotMessage[];
}

export interface BuildConversationSnapshotOptions {
	messages: unknown[];
	currentObjective: string;
	contextWindowTokens: number;
	previousState?: ConversationSnapshotState;
	summarize?: (input: ConversationSnapshotSummarizeInput) => Promise<string>;
}

export interface BuildConversationSnapshotResult {
	snapshot: ConversationSnapshot;
	state: ConversationSnapshotState;
	compacted: boolean;
	warning?: ConversationSnapshotWarning;
}

const MAX_TEXT_CHARS = 32_768;
export const CONVERSATION_SNAPSHOT_MESSAGE_MAX_CHARS = 8_192;

export function conversationSnapshotBudget(contextWindowTokens: number): ConversationSnapshotBudget {
	// Four characters per token, with one quarter of the context reserved for the snapshot.
	const totalChars = Math.min(
		60_000,
		Math.max(400, Math.floor(Number.isFinite(contextWindowTokens) ? contextWindowTokens : 0)),
	);
	const recentChars = Math.floor(totalChars * 0.55);
	const summaryChars = Math.floor(totalChars * 0.35);
	const safetyChars = totalChars - recentChars - summaryChars;
	return {
		totalChars,
		recentChars,
		summaryChars,
		safetyChars,
		triggerChars: Math.floor(totalChars * 0.75),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function sanitizeText(value: string, maxChars = MAX_TEXT_CHARS): string {
	return value
		.replace(
			/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[REDACTED]",
		)
		.replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[REDACTED_PATH]")
		.replace(/\/(?:home|Users|var|tmp|opt|srv)\/[^\s,;]*/g, "[REDACTED_PATH]")
		.trim()
		.slice(0, maxChars);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part): part is Record<string, unknown> =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text as string)
		.join("\n");
}

function toNaturalLanguageMessage(value: unknown): ConversationSnapshotMessage | undefined {
	if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
		return undefined;
	}
	if (
		value.role === "assistant" &&
		[value.api, value.provider, value.model].some((identity) => identity === "agent-v2")
	) {
		return undefined;
	}
	const content = sanitizeText(textFromContent(value.content), CONVERSATION_SNAPSHOT_MESSAGE_MAX_CHARS);
	if (!content) {
		return undefined;
	}
	return { role: value.role, content };
}

function normalizeSnapshotMessage(value: unknown): ConversationSnapshotMessage | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["role", "content"])) {
		return undefined;
	}
	if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") {
		return undefined;
	}
	const content = sanitizeText(value.content, CONVERSATION_SNAPSHOT_MESSAGE_MAX_CHARS);
	return content ? { role: value.role, content } : undefined;
}

export function normalizeConversationSnapshotState(value: unknown): ConversationSnapshotState | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["summarizedMessageCount", "snapshot"])) {
		return undefined;
	}
	if (!Number.isSafeInteger(value.summarizedMessageCount) || (value.summarizedMessageCount as number) < 0) {
		return undefined;
	}
	if (
		!isRecord(value.snapshot) ||
		!hasOnlyKeys(value.snapshot, ["compactedSummary", "recentMessages", "currentObjective"])
	) {
		return undefined;
	}
	const { compactedSummary, recentMessages, currentObjective } = value.snapshot;
	if (typeof compactedSummary !== "string" || !Array.isArray(recentMessages) || typeof currentObjective !== "string") {
		return undefined;
	}
	const normalizedMessages = recentMessages.map(normalizeSnapshotMessage);
	if (normalizedMessages.some((message) => message === undefined)) {
		return undefined;
	}
	return {
		summarizedMessageCount: value.summarizedMessageCount as number,
		snapshot: {
			compactedSummary: sanitizeText(compactedSummary),
			recentMessages: normalizedMessages as ConversationSnapshotMessage[],
			currentObjective: sanitizeText(currentObjective),
		},
	};
}

function takeRecentWindow(
	messages: ConversationSnapshotMessage[],
	maximumChars: number,
): { messages: ConversationSnapshotMessage[]; startIndex: number } {
	const recent: ConversationSnapshotMessage[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = [messages[index] as ConversationSnapshotMessage, ...recent];
		if (JSON.stringify(candidate).length <= maximumChars) {
			recent.unshift(messages[index] as ConversationSnapshotMessage);
			continue;
		}
		break;
	}
	if (recent.length === 0 && messages.length > 0) {
		const last = messages.at(-1) as ConversationSnapshotMessage;
		const overhead = JSON.stringify([{ role: last.role, content: "" }]).length;
		recent.push({ ...last, content: last.content.slice(-Math.max(1, maximumChars - overhead)) });
	}
	return { messages: recent, startIndex: messages.length - recent.length };
}

async function deterministicSummary({
	previousSummary,
	exitedMessages,
}: ConversationSnapshotSummarizeInput): Promise<string> {
	return [
		previousSummary,
		...exitedMessages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`),
	]
		.filter(Boolean)
		.join("\n");
}

export async function buildConversationSnapshot(
	options: BuildConversationSnapshotOptions,
): Promise<BuildConversationSnapshotResult> {
	const budget = conversationSnapshotBudget(options.contextWindowTokens);
	const history = options.messages.map(toNaturalLanguageMessage).filter((message) => message !== undefined);
	const objective = sanitizeText(options.currentObjective);
	const previousState = normalizeConversationSnapshotState(options.previousState);
	const previousSummary = previousState?.snapshot.compactedSummary ?? "";
	const shouldCompact = JSON.stringify(history).length > budget.triggerChars || Boolean(previousSummary);

	if (!shouldCompact) {
		const snapshot: ConversationSnapshot = {
			compactedSummary: "",
			recentMessages: history,
			currentObjective: objective,
		};
		return {
			snapshot,
			state: { summarizedMessageCount: 0, snapshot },
			compacted: false,
		};
	}

	const recent = takeRecentWindow(history, budget.recentChars);
	const previousCount = Math.min(previousState?.summarizedMessageCount ?? 0, recent.startIndex);
	const exitedMessages = history.slice(previousCount, recent.startIndex);
	let compactedSummary = previousSummary;
	let warning: ConversationSnapshotWarning | undefined;
	try {
		if (exitedMessages.length > 0) {
			compactedSummary = await (options.summarize ?? deterministicSummary)({
				previousSummary,
				exitedMessages,
			});
		}
		compactedSummary = sanitizeText(compactedSummary).slice(0, budget.summaryChars);
	} catch {
		compactedSummary = "";
		warning = "earlier_context_incomplete";
	}
	const snapshot: ConversationSnapshot = {
		compactedSummary,
		recentMessages: recent.messages,
		currentObjective: objective,
	};
	return {
		snapshot,
		state: {
			summarizedMessageCount: warning ? previousCount : recent.startIndex,
			snapshot,
		},
		compacted: recent.startIndex > 0 || Boolean(compactedSummary),
		...(warning ? { warning } : {}),
	};
}
