import { createHash } from "node:crypto";
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2StoreResult } from "./agent-v2-runtime-store.js";
import type {
	AgentV2ArtifactRecord,
	AgentV2RunEventRecord,
	AgentV2RunUpdateResult,
	AgentV2ValidationRecord,
	AppendAgentV2RunEventInput,
	AppendAgentV2ValidationAttemptInput,
	CreateAgentV2RunInput,
	UpdateAgentV2RunInput,
	UpsertAgentV2ArtifactInput,
	UpsertAgentV2DocumentInput,
	UpsertAgentV2TaskInput,
} from "./agent-v2-store.js";
import { buildAgentV2Run } from "./agent-v2-store.js";
import type {
	AgentV2Phase,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
	AgentV2TaskNode,
	AgentV2TaskStatus,
} from "./agent-v2-types.js";

export interface AgentV2InputBlobRecord {
	clientId: string;
	runId: string;
	inputId: string;
	logicalPath: string;
	mediaType: string;
	encoding: "utf8" | "binary";
	bytes: Uint8Array;
	byteLength: number;
	checksum: string;
	createdAt: string;
}

export function agentV2StartReplayEvidence(input: AgentV2StartRunCommitInput): Record<string, unknown> {
	const run = buildAgentV2Run(input.run);
	return {
		protocolVersion: 1,
		run: {
			clientId: run.clientId,
			runId: run.runId,
			input: run.input,
			model: run.model,
			createdAt: run.createdAt,
		},
		bootstrapVersion: input.bootstrapVersion,
		bootstrapChecksum: input.bootstrapChecksum,
		inputBlobs: input.inputBlobs.map(({ bytes, ...blob }) => ({ ...blob, bytes: Array.from(bytes) })),
		inputReferences: input.inputReferences,
		readyPhase: input.readyPhase,
		documents: input.documents,
		tasks: input.tasks,
		artifacts: input.artifacts,
		diagnostics: input.diagnostics,
		queueName: input.queueName,
		createdAt: input.createdAt,
	};
}

export function agentV2CancelReplayEvidence(input: AgentV2CancelRunCommitInput): Record<string, unknown> {
	return {
		protocolVersion: 1,
		clientId: input.clientId,
		runId: input.runId,
		expectedStatuses: input.expectedStatuses,
		expectedRun: input.expectedRun,
		queueName: input.queueName,
		cancelToken: input.cancelToken,
		cancelledAt: input.cancelledAt,
		...(input.reason !== undefined ? { reason: input.reason } : {}),
	};
}

export function agentV2StartReplayFingerprint(input: AgentV2StartRunCommitInput): string {
	return protocolFingerprint(agentV2StartReplayEvidence(input));
}

export function agentV2CancelReplayFingerprint(input: AgentV2CancelRunCommitInput): string {
	return protocolFingerprint(agentV2CancelReplayEvidence(input));
}
export interface AgentV2InputReferenceRecord {
	clientId: string;
	runId: string;
	kind: "attachment" | "project_file";
	ordinal: number;
	inputId: string;
	logicalPath: string;
	displayName?: string;
	mediaType: string;
	byteLength: number;
	checksum: string;
}
export interface AgentV2StartRunCommitInput {
	run: CreateAgentV2RunInput;
	bootstrapVersion: string;
	bootstrapChecksum: string;
	inputBlobs: readonly AgentV2InputBlobRecord[];
	inputReferences: readonly AgentV2InputReferenceRecord[];
	readyPhase: AgentV2Phase;
	documents: readonly UpsertAgentV2DocumentInput[];
	tasks: readonly UpsertAgentV2TaskInput[];
	artifacts: readonly UpsertAgentV2ArtifactInput[];
	diagnostics: readonly AgentV2DiagnosticEvent[];
	queueName: string;
	createdAt: string;
}
export interface AgentV2StartRunCommitResult {
	run: AgentV2RunSnapshot;
	runCreatedEvent: AgentV2RunEventRecord;
	planningReadyEvent: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[];
	replayed: boolean;
}
export interface AgentV2ExpectedRunState {
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	attempt: number;
	workerId: string | null;
	updatedAt: string;
}
export interface AgentV2RunTransitionCommitInput {
	update: UpdateAgentV2RunInput;
	expectedRun: AgentV2ExpectedRunState;
	event: Omit<AppendAgentV2RunEventInput, "clientId" | "runId" | "seq">;
	diagnostic?: AgentV2DiagnosticEvent;
}
export interface AgentV2RunTransitionCommitResult {
	update: AgentV2RunUpdateResult;
	event?: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[];
}
export interface AgentV2CancelRunCommitInput {
	clientId: string;
	runId: string;
	expectedStatuses: readonly ("queued" | "running")[];
	expectedRun: AgentV2ExpectedRunState;
	queueName: string;
	cancelToken: string;
	cancelledAt: string;
	reason?: string;
}
export interface AgentV2CancelRunCommitResult {
	run: AgentV2RunSnapshot;
	cancelEvent: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[];
	replayed: boolean;
}
export interface AgentV2ExecutionMutationInput {
	clientId: string;
	runId: string;
	expectedRun: AgentV2ExpectedRunState;
	expectedTasks: readonly { taskId: string; status: AgentV2TaskStatus; updatedAt: string }[];
	updatedAt: string;
	nextRunPhase?: AgentV2Phase;
	tasks: readonly UpsertAgentV2TaskInput[];
	artifacts?: readonly UpsertAgentV2ArtifactInput[];
	validation?: AppendAgentV2ValidationAttemptInput;
	diagnostics?: readonly AgentV2DiagnosticEvent[];
	events: readonly Omit<AppendAgentV2RunEventInput, "clientId" | "runId" | "seq">[];
}
export interface AgentV2ExecutionMutationResult {
	applied: boolean;
	run: AgentV2RunSnapshot;
	tasks: readonly AgentV2TaskNode[];
	artifacts: readonly AgentV2ArtifactRecord[];
	validation?: AgentV2ValidationRecord;
	events: readonly AgentV2RunEventRecord[];
	outboxIntentIds: readonly string[];
}
export interface AgentV2DiagnosticCommitInput {
	diagnostic: AgentV2DiagnosticEvent;
	emitRunEvent: boolean;
}
export interface AgentV2DiagnosticCommitResult {
	diagnostic: AgentV2DiagnosticEvent;
	event?: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[];
}
export interface AgentV2DurableCommitStore {
	commitAgentV2RunStart(input: AgentV2StartRunCommitInput): AgentV2StoreResult<AgentV2StartRunCommitResult>;
	commitAgentV2RunCancel(input: AgentV2CancelRunCommitInput): AgentV2StoreResult<AgentV2CancelRunCommitResult>;
	commitAgentV2RunTransition(
		input: AgentV2RunTransitionCommitInput,
	): AgentV2StoreResult<AgentV2RunTransitionCommitResult>;
	commitAgentV2ExecutionMutation(
		input: AgentV2ExecutionMutationInput,
	): AgentV2StoreResult<AgentV2ExecutionMutationResult>;
	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2StoreResult<AgentV2DiagnosticCommitResult>;
	listAgentV2InputReferences(clientId: string, runId: string): AgentV2StoreResult<AgentV2InputReferenceRecord[]>;
	readAgentV2InputBlob(
		clientId: string,
		runId: string,
		inputId: string,
	): AgentV2StoreResult<AgentV2InputBlobRecord | undefined>;
}

export function matchesAgentV2ExpectedRun(run: AgentV2RunSnapshot, expected: AgentV2ExpectedRunState): boolean {
	return (
		run.status === expected.status &&
		run.phase === expected.phase &&
		run.attempt === expected.attempt &&
		(run.workerId ?? null) === expected.workerId &&
		run.updatedAt === expected.updatedAt
	);
}

export function equalAgentV2ProtocolValues(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonicalProtocolValue(left)) === JSON.stringify(canonicalProtocolValue(right));
}

export function isCanonicalAgentV2Revision(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

export function isStrictlyNewerAgentV2Revision(next: unknown, current: unknown): next is string {
	return (
		isCanonicalAgentV2Revision(next) && isCanonicalAgentV2Revision(current) && Date.parse(next) > Date.parse(current)
	);
}

function canonicalProtocolValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalProtocolValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalProtocolValue(child)]),
	);
}

function protocolFingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalProtocolValue(value)))
		.digest("hex");
}
