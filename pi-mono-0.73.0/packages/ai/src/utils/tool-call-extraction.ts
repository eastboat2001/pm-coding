import { parseJsonWithRepair } from "./json-parse.js";

export interface ExtractedTextToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolCallExtractionResult {
	calls: ExtractedTextToolCall[];
	text: string;
}

const TOOL_CALL_TAG_RE = /<tool[_-]?call>\s*([\s\S]*?)\s*<\/tool[_-]?call>/gi;
const FENCED_RE = /```(?:json|tool_?call)?\s*\n?([\s\S]*?)\n?```/gi;
const LEADING_JSON_RE = /^\s*([{[][\s\S]+[}\]])\s*$/;

export function extractToolCallsFromText(text: string, knownToolNames?: ReadonlySet<string>): ToolCallExtractionResult {
	const calls: ExtractedTextToolCall[] = [];
	const consumedRanges: Array<[number, number]> = [];

	for (const match of text.matchAll(TOOL_CALL_TAG_RE)) {
		const parsed = parseToolCallJson(match[1]);
		const normalized = normalizeToolCalls(parsed, knownToolNames);
		if (normalized.length > 0) {
			calls.push(...normalized);
			consumedRanges.push([match.index, match.index + match[0].length]);
		}
	}

	if (calls.length === 0) {
		for (const match of text.matchAll(FENCED_RE)) {
			const parsed = parseToolCallJson(match[1]);
			const normalized = normalizeToolCalls(parsed, knownToolNames);
			if (normalized.length > 0) {
				calls.push(...normalized);
				consumedRanges.push([match.index, match.index + match[0].length]);
			}
		}
	}

	if (calls.length === 0) {
		const match = text.match(LEADING_JSON_RE);
		if (match) {
			const parsed = parseToolCallJson(match[1]);
			const normalized = normalizeToolCalls(parsed, knownToolNames);
			if (normalized.length > 0) {
				calls.push(...normalized);
				consumedRanges.push([0, text.length]);
			}
		}
	}

	if (calls.length === 0) {
		return { calls, text };
	}

	let remainingText = text;
	for (const [start, end] of consumedRanges.sort((a, b) => b[0] - a[0])) {
		remainingText = `${remainingText.slice(0, start)}${remainingText.slice(end)}`;
	}

	return { calls, text: remainingText.trim() };
}

function parseToolCallJson(raw: string): unknown {
	const cleaned = raw.trim().replace(/,(\s*[}\]])/g, "$1");
	try {
		return parseJsonWithRepair<unknown>(cleaned);
	} catch {
		const parsedLines: unknown[] = [];
		for (const line of cleaned
			.split(/\n+/)
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			try {
				parsedLines.push(parseJsonWithRepair<unknown>(line.replace(/,(\s*[}\]])/g, "$1")));
			} catch {
				return undefined;
			}
		}
		return parsedLines.length > 0 ? parsedLines : undefined;
	}
}

function normalizeToolCalls(parsed: unknown, knownToolNames?: ReadonlySet<string>): ExtractedTextToolCall[] {
	const items = Array.isArray(parsed) ? parsed : [parsed];
	const calls: ExtractedTextToolCall[] = [];
	for (const item of items) {
		const call = normalizeToolCall(item);
		if (!call) continue;
		if (knownToolNames && knownToolNames.size > 0 && !knownToolNames.has(call.name)) continue;
		calls.push(call);
	}
	return calls;
}

function normalizeToolCall(item: unknown): ExtractedTextToolCall | undefined {
	if (!isRecord(item)) return undefined;

	if (typeof item.name === "string") {
		return { name: item.name, arguments: normalizeArguments(item.arguments ?? item.parameters) };
	}

	if (isRecord(item.function) && typeof item.function.name === "string") {
		return {
			name: item.function.name,
			arguments: normalizeArguments(item.function.arguments),
		};
	}

	if (typeof item.tool === "string") {
		return { name: item.tool, arguments: normalizeArguments(item.args ?? item.arguments) };
	}

	return undefined;
}

function normalizeArguments(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			const parsed = parseJsonWithRepair<unknown>(value);
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
