export type RunConnectionStatus = "offline" | "online_syncing" | "run_reconnecting" | "run_reconnected";

type RunConnectionStatusLabel =
	| "Network connection lost. Waiting to reconnect..."
	| "Network restored. Syncing run status..."
	| "Run connection interrupted. Restoring updates..."
	| "Run updates reconnected. Syncing status...";

const LABELS: Record<RunConnectionStatus, RunConnectionStatusLabel> = {
	offline: "Network connection lost. Waiting to reconnect...",
	online_syncing: "Network restored. Syncing run status...",
	run_reconnecting: "Run connection interrupted. Restoring updates...",
	run_reconnected: "Run updates reconnected. Syncing status...",
};

export function runConnectionStatusText(
	status: RunConnectionStatus,
	translate: (label: RunConnectionStatusLabel) => string = (label) => label,
): string {
	return translate(LABELS[status]);
}
