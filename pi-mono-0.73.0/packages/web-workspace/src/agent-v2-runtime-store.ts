import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type {
	AgentV2DiagnosticCommitInput,
	AgentV2DiagnosticCommitResult,
	AgentV2ExecutionMutationInput,
	AgentV2ExecutionMutationResult,
	AgentV2RunRetryCommitInput,
	AgentV2RunRetryCommitResult,
	AgentV2RunTransitionCommitInput,
	AgentV2RunTransitionCommitResult,
} from "./agent-v2-durable-store.js";
import type {
	AgentV2ArtifactRecord,
	AgentV2DocumentRecord,
	AgentV2RunEventRecord,
	AgentV2RunUpdateResult,
	AgentV2ValidationRecord,
	AppendAgentV2ValidationAttemptInput,
	CreateAgentV2RunInput,
	UpdateAgentV2RunInput,
	UpsertAgentV2ArtifactInput,
	UpsertAgentV2DocumentInput,
	UpsertAgentV2TaskInput,
} from "./agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";

export type AgentV2StoreResult<T> = T | Promise<T>;
export type MaybeAsyncIterable<T> = AsyncIterable<T> | Iterable<T>;

export interface AgentV2SchemaStore {
	ensureAgentV2Schema(): AgentV2StoreResult<void>;
	ping(signal: AbortSignal): AgentV2StoreResult<void>;
}

export interface AgentV2RunApiStore {
	createAgentV2Run(input: CreateAgentV2RunInput): AgentV2StoreResult<AgentV2RunSnapshot>;
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Runs(clientId: string): AgentV2StoreResult<AgentV2RunSnapshot[]>;
	updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): AgentV2StoreResult<AgentV2RunUpdateResult>;
}

export interface AgentV2RuntimeSnapshotStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Tasks(clientId: string, runId: string): AgentV2StoreResult<AgentV2TaskNode[]>;
	listAgentV2Artifacts(clientId: string, runId: string): AgentV2StoreResult<AgentV2ArtifactRecord[]>;
	listAgentV2Documents(clientId: string, runId: string): AgentV2StoreResult<AgentV2DocumentRecord[]>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
	upsertAgentV2Task(input: UpsertAgentV2TaskInput): AgentV2StoreResult<AgentV2TaskNode>;
	appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
}

export interface AgentV2ExecutionStore extends AgentV2RuntimeSnapshotStore {
	commitAgentV2ExecutionMutation(
		input: AgentV2ExecutionMutationInput,
	): AgentV2StoreResult<AgentV2ExecutionMutationResult>;
	upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	appendAgentV2ValidationAttempt(
		input: AppendAgentV2ValidationAttemptInput,
	): AgentV2StoreResult<AgentV2ValidationRecord>;
	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2StoreResult<AgentV2DiagnosticCommitResult>;
}

export interface AgentV2PlanningStore {
	upsertAgentV2Document(input: UpsertAgentV2DocumentInput): AgentV2StoreResult<AgentV2DocumentRecord>;
	upsertAgentV2Task(input: UpsertAgentV2TaskInput): AgentV2StoreResult<AgentV2TaskNode>;
	upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2StoreResult<AgentV2DiagnosticCommitResult>;
}

export interface AgentV2RunEventLogStore {
	appendAgentV2RunEvent(input: {
		clientId: string;
		runId: string;
		seq?: number;
		type: string;
		payload: Record<string, unknown>;
		createdAt?: string;
	}): AgentV2StoreResult<AgentV2RunEventRecord>;
	listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): AgentV2StoreResult<AgentV2RunEventRecord[]>;
}

export interface AgentV2WorkerStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	updateAgentV2Run(input: UpdateAgentV2RunInput): AgentV2StoreResult<AgentV2RunSnapshot>;
	updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): AgentV2StoreResult<AgentV2RunUpdateResult>;
	appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
	commitAgentV2RunTransition(
		input: AgentV2RunTransitionCommitInput,
	): AgentV2StoreResult<AgentV2RunTransitionCommitResult>;
	commitAgentV2RunRetry?(input: AgentV2RunRetryCommitInput): AgentV2StoreResult<AgentV2RunRetryCommitResult>;
	listAgentV2Tasks?(clientId: string, runId: string): AgentV2StoreResult<AgentV2TaskNode[]>;
	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2StoreResult<AgentV2DiagnosticCommitResult>;
	/** Lists this worker's runs whose status is running or cancelling. */
	listAgentV2RunsByWorker(workerId: string): AgentV2StoreResult<AgentV2RunSnapshot[]>;
}

export interface AgentV2ResetStoreOptions {
	now?: () => string;
}

export interface AgentV2ResetStoreResult {
	agentV2RowsDeleted: Record<string, number>;
	schemaVersion: 2;
}

export interface AgentV2ResetStore {
	resetAgentV2RuntimeData(options?: AgentV2ResetStoreOptions): AgentV2StoreResult<AgentV2ResetStoreResult>;
}

export interface AgentV2DiagnosticExportStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Runs(clientId: string): AgentV2StoreResult<AgentV2RunSnapshot[]>;
	listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): AgentV2StoreResult<AgentV2RunEventRecord[]>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
}

export type { AgentV2DurableCommitStore } from "./agent-v2-durable-store.js";
export type { AgentV2OutboxStore } from "./agent-v2-outbox.js";
