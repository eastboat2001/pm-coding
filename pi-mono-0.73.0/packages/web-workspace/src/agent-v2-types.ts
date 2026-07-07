export const AGENT_V2_SCHEMA_VERSION = 1 as const;

export const AGENT_V2_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type AgentV2RunStatus = (typeof AGENT_V2_RUN_STATUSES)[number];

export const AGENT_V2_PHASES = ["intake", "planning", "execution", "validation", "repair", "finalizing"] as const;
export type AgentV2Phase = (typeof AGENT_V2_PHASES)[number];

export const AGENT_V2_TASK_STATUSES = ["pending", "ready", "running", "blocked", "succeeded", "failed", "cancelled"] as const;
export type AgentV2TaskStatus = (typeof AGENT_V2_TASK_STATUSES)[number];

export type AgentV2TaskKind = "requirements" | "design" | "implementation" | "validation" | "repair" | "artifact";

export type AgentV2RunInput = Record<string, unknown>;

export interface AgentV2Error {
	code: string;
	message: string;
	retryable: boolean;
	data?: Record<string, unknown>;
}

export interface AgentV2TaskNode {
	taskId: string;
	parentTaskId?: string;
	kind: AgentV2TaskKind;
	title: string;
	status: AgentV2TaskStatus;
	dependsOn: string[];
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface AgentV2RunSnapshot {
	clientId: string;
	runId: string;
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	attempt: number;
	input: AgentV2RunInput;
	model: unknown;
	workerId?: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface AgentV2RunSnapshotInput {
	clientId: string;
	runId: string;
	input: AgentV2RunInput;
	model: unknown;
	createdAt?: string;
	updatedAt?: string;
	workerId?: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

