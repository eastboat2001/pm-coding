export type RunTransientStatusSource = "connection" | "retry" | "providerStalled";

export type RunTransientStatusTexts = Partial<Record<RunTransientStatusSource, string>>;

type ProviderStallStatusLabel =
	"Model response has not updated. Monitoring provider recovery; automatic preview recovery will start if the stream times out.";

const PROVIDER_STALL_STATUS_MIN_DELAY_MS = 1_000;
const PROVIDER_STALL_STATUS_MAX_DELAY_MS = 5_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export function providerStallStatusText(
	translate: (label: ProviderStallStatusLabel) => string = (label) => label,
): string {
	return translate(
		"Model response has not updated. Monitoring provider recovery; automatic preview recovery will start if the stream times out.",
	);
}

export function selectRunTransientStatusText(statuses: RunTransientStatusTexts): string {
	return statuses.connection || statuses.retry || statuses.providerStalled || "";
}

export function providerStallStatusDelayMs(streamIdleTimeoutMs: number | undefined): number {
	const timeoutMs =
		typeof streamIdleTimeoutMs === "number" && Number.isFinite(streamIdleTimeoutMs) && streamIdleTimeoutMs > 0
			? streamIdleTimeoutMs
			: DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	return Math.min(
		PROVIDER_STALL_STATUS_MAX_DELAY_MS,
		Math.max(PROVIDER_STALL_STATUS_MIN_DELAY_MS, Math.floor(timeoutMs / 2)),
	);
}

export function shouldClearProviderStallStatusForRunEvent(payloadType: string | undefined): boolean {
	return payloadType === "tool_execution_start";
}

export function shouldScheduleProviderStallStatusAfterRunEvent(payloadType: string | undefined): boolean {
	if (!payloadType || payloadType === "agent_end") return false;
	return payloadType !== "tool_execution_start";
}
