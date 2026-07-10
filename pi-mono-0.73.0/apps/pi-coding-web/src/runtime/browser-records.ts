import type { AgentV2RunStatus } from "@mariozechner/pi-web-workspace";

export interface BrowserSessionRecord {
	sessionId: string;
	clientId: string;
	title: string;
	model: Record<string, unknown>;
	thinkingLevel: string;
	createdAt: string;
	updatedAt: string;
	lastRunStatus?: AgentV2RunStatus;
	lastRunId?: string;
}

export interface BrowserMessageRecord {
	messageId: number;
	sessionId: string;
	clientId: string;
	role: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface BrowserDeleteSessionResult {
	deleted: boolean;
	sessionId: string;
	cancelledRuns?: number;
}
