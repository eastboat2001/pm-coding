import type { AgentMessage } from "@mariozechner/pi-agent-core";

const DATE_PART_FORMATTER = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

const TIME_PART_FORMATTER = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

export function sessionLastMessageModifiedAt(
	messages: AgentMessage[],
	createdAt: string,
	fallbackLastModified: string,
): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const timestamp = messages[index]?.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
			return new Date(timestamp).toISOString();
		}
	}
	return validIsoString(createdAt) || validIsoString(fallbackLastModified) || new Date().toISOString();
}

export function formatSessionUpdatedAt(isoString: string, now = new Date()): string {
	const date = new Date(isoString);
	if (!Number.isFinite(date.getTime())) return "";
	const time = TIME_PART_FORMATTER.format(date);
	if (isSameLocalDay(date, now)) return `今天 ${time}`;
	if (isSameLocalDay(date, addLocalDays(now, -1))) return `昨天 ${time}`;
	return `${formatDatePart(date)} ${time}`;
}

function validIsoString(value: string): string {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function isSameLocalDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function addLocalDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

function formatDatePart(date: Date): string {
	const parts = DATE_PART_FORMATTER.formatToParts(date);
	const year = parts.find((part) => part.type === "year")?.value ?? String(date.getFullYear());
	const month = parts.find((part) => part.type === "month")?.value ?? String(date.getMonth() + 1).padStart(2, "0");
	const day = parts.find((part) => part.type === "day")?.value ?? String(date.getDate()).padStart(2, "0");
	return `${year}/${month}/${day}`;
}
