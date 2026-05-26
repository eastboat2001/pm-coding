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

export function buildSlashSuggestionState(value: string, suggestions: SlashSuggestionItem[]): SlashSuggestionState {
	const emptyState = { open: false, items: [], query: "", trigger: "" };
	const selections = getSlashSelections(value, suggestions);
	const activeValue = selections.items.length > 0 ? selections.text : value;
	const selectedIds = new Set(selections.items.map((item) => item.id));
	if (activeValue.includes("\n")) return emptyState;
	if (selections.items.length > 0 && !activeValue.startsWith("/")) return emptyState;

	for (const trigger of orderedTriggers(suggestions)) {
		if (activeValue === trigger) {
			const items = suggestions.filter((item) => item.trigger === trigger && !selectedIds.has(item.id));
			if (items.length > 0) return { open: true, items, query: "", trigger };
			return emptyTriggerState(trigger, "", suggestions);
		}

		const queryPrefix = `${trigger}:`;
		if (activeValue.startsWith(queryPrefix)) {
			const query = activeValue.slice(queryPrefix.length).toLowerCase();
			const items = suggestions.filter(
				(item) =>
					item.trigger === trigger && !selectedIds.has(item.id) && item.label.toLowerCase().startsWith(query),
			);
			if (items.length > 0) return { open: true, items, query, trigger };
			return emptyTriggerState(trigger, query, suggestions);
		}
	}

	return emptyState;
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

function emptyTriggerState(trigger: string, query: string, suggestions: SlashSuggestionItem[]): SlashSuggestionState {
	const emptySource = suggestions.find((item) => item.insertText === trigger && item.emptyLabel);
	if (!emptySource) return { open: false, items: [], query: "", trigger: "" };
	return {
		open: true,
		items: [],
		query,
		trigger,
		emptyLabel: emptySource.emptyLabel,
		emptyDetail: emptySource.emptyDetail,
	};
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
