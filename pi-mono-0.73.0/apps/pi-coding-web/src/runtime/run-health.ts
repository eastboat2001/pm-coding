import type { RuntimeRunRecord } from "@mariozechner/pi-web-workspace";

import type { DiagnosticEvent } from "../diagnostics/diagnostic-client.js";

export const QUEUED_RUN_TIMEOUT_MS = 10_000;

export function createQueuedRunTimeoutDiagnostic(
	run: RuntimeRunRecord,
	options: { nowMs?: number; timeoutMs?: number } = {},
): DiagnosticEvent | undefined {
	if (run.status !== "queued") {
		return undefined;
	}

	const updatedAtMs = Date.parse(run.updatedAt);
	if (!Number.isFinite(updatedAtMs)) {
		return undefined;
	}

	const nowMs = options.nowMs ?? Date.now();
	const timeoutMs = options.timeoutMs ?? QUEUED_RUN_TIMEOUT_MS;
	const queuedMs = Math.max(0, nowMs - updatedAtMs);
	if (queuedMs < timeoutMs) {
		return undefined;
	}

	return {
		level: "error",
		category: "agent",
		eventType: "agent.remote_run.queued_timeout",
		data: {
			runId: run.runId,
			sessionId: run.sessionId,
			status: run.status,
			queuedMs,
			message: "Run stayed queued without worker progress; PI worker or Redis may not be running.",
		},
	};
}
