export type TransientStatusKind = "retry" | "recovery" | "waiting";

export interface ParsedTransientStatus {
	kind: TransientStatusKind;
	label: string;
	progress?: string;
}

const STATUS_PROGRESS_PATTERN = /^(.*?)\s*\((\d+\s*\/\s*\d+|\d+s)\)\s*$/;

export function parseTransientStatusText(statusText: string): ParsedTransientStatus | undefined {
	const text = statusText.trim();
	if (!text) return undefined;

	const progress = STATUS_PROGRESS_PATTERN.exec(text);
	if (progress) {
		const label = progress[1].trim();
		return {
			kind: classifyTransientStatus(label),
			label,
			progress: progress[2].replace(/\s+/g, ""),
		};
	}

	return {
		kind: classifyTransientStatus(text),
		label: text,
	};
}

function classifyTransientStatus(text: string): TransientStatusKind {
	const lower = text.toLowerCase();
	if (lower.includes("retry") || text.includes("重试")) return "retry";
	if (lower.includes("waiting") || text.includes("等待") || text.includes("暂无更新")) return "waiting";
	if (
		lower.includes("recover") ||
		lower.includes("restor") ||
		lower.includes("reconnect") ||
		text.includes("恢复") ||
		text.includes("继续")
	) {
		return "recovery";
	}
	return "waiting";
}
