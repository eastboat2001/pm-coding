import type { RuntimeRunEventRecord } from "@mariozechner/pi-web-workspace";

type RunRetryStatusLabel = "Retrying request..." | "next attempt in";

export interface RunRetryStatus {
	label: "Retrying request...";
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
}

export function retryStatusFromRunEvent(event: RuntimeRunEventRecord): RunRetryStatus | undefined {
	const payload = event.payload;
	if (!isRecord(payload) || payload.type !== "agent_retry_scheduled") return undefined;
	return {
		label: "Retrying request...",
		attempt: positiveNumber(payload.attempt),
		maxAttempts: positiveNumber(payload.maxAttempts),
		delayMs: positiveNumber(payload.delayMs),
	};
}

export function retryStatusText(
	status: RunRetryStatus,
	translate: (label: RunRetryStatusLabel) => string = (label) => label,
): string {
	const label = translate(status.label);
	const parts: string[] = [];
	if (status.attempt !== undefined && status.maxAttempts !== undefined) {
		parts.push(`${status.attempt}/${status.maxAttempts}`);
	}
	if (status.delayMs !== undefined) {
		parts.push(`${translate("next attempt in")} ${formatDelay(status.delayMs)}`);
	}
	return parts.length > 0 ? `${label} (${parts.join(", ")})` : label;
}

export function shouldClearRetryStatusForRunEvent(event: RuntimeRunEventRecord): boolean {
	const payload = event.payload;
	return isRecord(payload) && payload.type !== "agent_retry_scheduled";
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatDelay(delayMs: number): string {
	if (delayMs < 1000) return `${Math.round(delayMs)}ms`;
	const seconds = delayMs / 1000;
	return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
