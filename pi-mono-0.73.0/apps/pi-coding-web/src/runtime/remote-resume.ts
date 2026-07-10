import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentV2RunStatus } from "@mariozechner/pi-web-workspace";

const ACTIVE_RUN_STATUSES: ReadonlySet<AgentV2RunStatus> = new Set(["queued", "running", "cancelling"]);

export interface InterruptedToolResultResumeOptions {
	activeRunId?: string;
	isStreaming: boolean;
	messages: readonly AgentMessage[];
	parentRunId?: string;
	resumedSessions: Set<string>;
	runStatus?: AgentV2RunStatus;
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
	if (options.activeRunId && options.runStatus && ACTIVE_RUN_STATUSES.has(options.runStatus)) return false;
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
