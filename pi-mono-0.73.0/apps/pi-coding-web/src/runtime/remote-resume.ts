import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	RunStatus,
	RuntimeActiveRunRestore,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
} from "@mariozechner/pi-web-workspace";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running", "cancelling"]);

export interface ResolvedActiveRunRestore {
	run: RuntimeRunRecord;
	checkpointEvent?: RuntimeRunEventRecord;
	afterSeq: number;
	legacy: boolean;
}

export interface InterruptedToolResultResumeOptions {
	activeRunId?: string;
	isStreaming: boolean;
	messages: readonly AgentMessage[];
	parentRunId?: string;
	resumedSessions: Set<string>;
	runStatus?: RunStatus;
	sessionId?: string;
	startRemoteContinuation(parentRunId: string): Promise<void>;
	reportError(error: unknown, sessionId: string): void;
}

export function resumeInterruptedToolResultSession(options: InterruptedToolResultResumeOptions): boolean {
	const sessionId = options.sessionId;
	const parentRunId = options.parentRunId;
	if (!sessionId || !parentRunId) return false;
	const resumeKey = `${sessionId}:${parentRunId}`;
	if (options.resumedSessions.has(resumeKey)) return false;
	if (options.isStreaming) return false;
	if (options.activeRunId && ACTIVE_RUN_STATUSES.has(options.runStatus as RunStatus)) return false;
	if (options.runStatus !== "interrupted") return false;

	const lastMessage = options.messages.at(-1);
	if (!lastMessage || lastMessage.role !== "toolResult") return false;

	options.resumedSessions.add(resumeKey);
	void options.startRemoteContinuation(parentRunId).catch((error) => {
		options.reportError(error, sessionId);
		options.resumedSessions.delete(resumeKey);
	});
	return true;
}

export function resolveActiveRunRestore(
	detail: RuntimeSessionDetail,
	preferredRunId?: string,
): ResolvedActiveRunRestore | undefined {
	const restored = normalizeActiveRunRestore(detail.activeRun);
	if (restored && (!preferredRunId || restored.run.runId === preferredRunId)) return restored;
	return undefined;
}

function normalizeActiveRunRestore(
	activeRun: RuntimeActiveRunRestore | undefined,
): ResolvedActiveRunRestore | undefined {
	if (!activeRun || !ACTIVE_RUN_STATUSES.has(activeRun.run.status)) return undefined;
	return {
		run: activeRun.run,
		...(activeRun.checkpointEvent ? { checkpointEvent: activeRun.checkpointEvent } : {}),
		afterSeq: activeRun.afterSeq,
		legacy: false,
	};
}
