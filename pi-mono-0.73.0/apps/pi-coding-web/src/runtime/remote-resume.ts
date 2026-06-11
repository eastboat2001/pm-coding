import type { AgentMessage } from "@mariozechner/pi-ai";
import type { RunStatus } from "@mariozechner/pi-web-workspace";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running", "cancelling"]);

export interface InterruptedToolResultResumeOptions {
	activeRunId?: string;
	isStreaming: boolean;
	messages: readonly AgentMessage[];
	resumedSessions: Set<string>;
	runStatus?: RunStatus;
	sessionId?: string;
	startRemoteContinuation(): Promise<void>;
	reportError(error: unknown, sessionId: string): void;
}

export function resumeInterruptedToolResultSession(options: InterruptedToolResultResumeOptions): boolean {
	const sessionId = options.sessionId;
	if (!sessionId || options.resumedSessions.has(sessionId)) return false;
	if (options.isStreaming) return false;
	if (options.activeRunId && ACTIVE_RUN_STATUSES.has(options.runStatus as RunStatus)) return false;

	const lastMessage = options.messages.at(-1);
	if (!lastMessage || lastMessage.role !== "toolResult") return false;

	options.resumedSessions.add(sessionId);
	void options.startRemoteContinuation().catch((error) => {
		options.reportError(error, sessionId);
		options.resumedSessions.delete(sessionId);
	});
	return true;
}
