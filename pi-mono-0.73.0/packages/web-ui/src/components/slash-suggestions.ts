export interface SlashSuggestionItem {
	id: string;
	label: string;
	detail?: string;
	trigger: string;
	insertText: string;
	keepOpen?: boolean;
	emptyLabel?: string;
	emptyDetail?: string;
}

export interface SlashSuggestionState {
	open: boolean;
	items: SlashSuggestionItem[];
	query: string;
	trigger: string;
	emptyLabel?: string;
	emptyDetail?: string;
	replacementStart?: number;
	replacementEnd?: number;
}

export interface SlashSelection {
	item: SlashSuggestionItem;
	text: string;
	prefix: string;
}

export interface SlashSelections {
	items: SlashSuggestionItem[];
	text: string;
	prefix: string;
}

export interface ApplySlashSuggestionResult {
	value: string;
	cursor: number;
}

export function buildSlashSuggestionState(
	value: string,
	suggestions: SlashSuggestionItem[],
	cursorPosition = value.length,
): SlashSuggestionState {
	const emptyState = { open: false, items: [], query: "", trigger: "" };

	const selections = getSlashSelections(value, suggestions);
	const selectedIds = new Set(selections.items.map((item) => item.id));
	const context = getSlashTokenContext(value, cursorPosition);
	if (!context) return emptyState;
	if (
		selections.items.length > 0 &&
		context.start < selections.prefix.length &&
		context.end <= selections.prefix.length
	) {
		return emptyState;
	}
	const activeValue = context.text;

	for (const trigger of orderedTriggers(suggestions)) {
		if (activeValue === trigger) {
			const items = suggestions.filter((item) => item.trigger === trigger && !selectedIds.has(item.id));
			if (items.length > 0) {
				return {
					open: true,
					items,
					query: "",
					trigger,
					replacementStart: context.start,
					replacementEnd: context.end,
				};
			}
			return emptyTriggerState(trigger, "", suggestions, context);
		}

		const queryPrefix = `${trigger}:`;
		if (activeValue.startsWith(queryPrefix)) {
			const query = activeValue.slice(queryPrefix.length).toLowerCase();
			const items = suggestions.filter(
				(item) =>
					item.trigger === trigger && !selectedIds.has(item.id) && item.label.toLowerCase().startsWith(query),
			);
			if (items.length > 0) {
				return {
					open: true,
					items,
					query,
					trigger,
					replacementStart: context.start,
					replacementEnd: context.end,
				};
			}
			return emptyTriggerState(trigger, query, suggestions, context);
		}
	}

	return emptyState;
}

export function applySlashSuggestionToValue(
	value: string,
	suggestion: SlashSuggestionItem,
	suggestions: SlashSuggestionItem[],
	cursorPosition = value.length,
): ApplySlashSuggestionResult {
	const state = buildSlashSuggestionState(value, suggestions, cursorPosition);
	return applySlashSuggestionToState(value, suggestion, suggestions, state);
}

export function applySlashSuggestionToState(
	value: string,
	suggestion: SlashSuggestionItem,
	suggestions: SlashSuggestionItem[],
	state: SlashSuggestionState,
): ApplySlashSuggestionResult {
	if (!state.open || state.replacementStart === undefined || state.replacementEnd === undefined) {
		return { value, cursor: value.length };
	}

	const beforeToken = value.slice(0, state.replacementStart);
	const afterToken = value.slice(state.replacementEnd);
	if (suggestion.keepOpen) {
		const nextValue = `${beforeToken}${suggestion.insertText}${afterToken}`;
		return {
			value: nextValue,
			cursor: beforeToken.length + suggestion.insertText.length,
		};
	}

	const withoutToken = joinAroundRemovedToken(beforeToken, afterToken);
	const selections = getSlashSelections(withoutToken, suggestions);
	const text = selections.text.trim();
	return {
		value: `${selections.prefix}${suggestion.insertText}${text}`,
		cursor: text.length,
	};
}

export function getSlashSelection(value: string, suggestions: SlashSuggestionItem[]): SlashSelection | undefined {
	const selections = getSlashSelections(value, suggestions);
	const item = selections.items[0];
	return item ? { item, text: selections.text, prefix: item.insertText } : undefined;
}

export function getSlashSelections(value: string, suggestions: SlashSuggestionItem[]): SlashSelections {
	const selectedItems: SlashSuggestionItem[] = [];
	const selectedIds = new Set<string>();
	let remaining = value;
	let prefix = "";

	while (remaining) {
		const item = selectableSuggestions(suggestions).find((candidate) => {
			if (selectedIds.has(candidate.id)) return false;
			return remaining === candidate.insertText.trimEnd() || remaining.startsWith(candidate.insertText);
		});
		if (!item) break;
		selectedItems.push(item);
		selectedIds.add(item.id);
		prefix += item.insertText;
		remaining = remaining === item.insertText.trimEnd() ? "" : remaining.slice(item.insertText.length);
	}

	return { items: selectedItems, text: remaining, prefix };
}

export function resolveSlashSuggestionCursorPosition(
	value: string,
	textareaCursorPosition: number,
	suggestions: SlashSuggestionItem[],
	pendingCursorPosition?: number,
): number {
	if (pendingCursorPosition !== undefined) return clampCursor(pendingCursorPosition, value);
	const selections = getSlashSelections(value, suggestions);
	if (selections.items.length > 0 && value.startsWith(selections.prefix)) {
		return clampCursor(selections.prefix.length + textareaCursorPosition, value);
	}
	return clampCursor(textareaCursorPosition, value);
}

export function resolveTextareaCursorPosition(
	value: string,
	fullCursorPosition: number,
	suggestions: SlashSuggestionItem[],
): number {
	const selections = getSlashSelections(value, suggestions);
	if (selections.items.length > 0 && value.startsWith(selections.prefix)) {
		return clampCursor(fullCursorPosition - selections.prefix.length, selections.text);
	}
	return clampCursor(fullCursorPosition, value);
}

export function shouldStackSlashSelections(text: string): boolean {
	return text.includes("\n");
}

function emptyTriggerState(
	trigger: string,
	query: string,
	suggestions: SlashSuggestionItem[],
	context: SlashTokenContext,
): SlashSuggestionState {
	const emptySource = suggestions.find((item) => item.insertText === trigger && item.emptyLabel);
	if (!emptySource) return { open: false, items: [], query: "", trigger: "" };
	return {
		open: true,
		items: [],
		query,
		trigger,
		emptyLabel: emptySource.emptyLabel,
		emptyDetail: emptySource.emptyDetail,
		replacementStart: context.start,
		replacementEnd: context.end,
	};
}

interface SlashTokenContext {
	text: string;
	start: number;
	end: number;
}

function getSlashTokenContext(value: string, cursorPosition: number): SlashTokenContext | undefined {
	const cursor = clampCursor(cursorPosition, value);
	let start = cursor;
	while (start > 0 && !/\s/.test(value[start - 1])) {
		start--;
	}

	const text = value.slice(start, cursor);
	if (!text.startsWith("/")) return undefined;
	return { text, start, end: cursor };
}

function clampCursor(cursorPosition: number, value: string): number {
	return Math.max(0, Math.min(cursorPosition, value.length));
}

function joinAroundRemovedToken(beforeToken: string, afterToken: string): string {
	if (beforeToken && afterToken && /\s$/.test(beforeToken) && /^\s/.test(afterToken)) {
		return `${beforeToken}${afterToken.trimStart()}`;
	}
	return `${beforeToken}${afterToken}`;
}

function orderedTriggers(suggestions: SlashSuggestionItem[]): string[] {
	const triggers = suggestions.flatMap((suggestion) =>
		suggestion.emptyLabel ? [suggestion.trigger, suggestion.insertText] : [suggestion.trigger],
	);
	return [...new Set(triggers)].sort((a, b) => b.length - a.length);
}

function selectableSuggestions(suggestions: SlashSuggestionItem[]): SlashSuggestionItem[] {
	return suggestions
		.filter((suggestion) => suggestion.keepOpen !== true)
		.sort((a, b) => b.insertText.length - a.insertText.length);
}
