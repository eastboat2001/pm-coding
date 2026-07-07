import { isObject } from "./json.js";
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type {
	AgentV2Error,
	AgentV2Phase,
	AgentV2RunInput,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
	AgentV2TaskKind,
	AgentV2TaskNode,
	AgentV2TaskStatus,
} from "./agent-v2-types.js";
import { createAgentV2RunSnapshot, transitionAgentV2RunSnapshot } from "./agent-v2-state-machine.js";
import type { JsonObject } from "./types.js";

type TimestampValue = string | Date;

export interface CreateAgentV2RunInput extends JsonObject {
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

export interface UpdateAgentV2RunInput extends JsonObject {
	clientId: string;
	runId: string;
	status?: AgentV2RunStatus;
	phase?: AgentV2Phase;
	attempt?: number;
	workerId?: string;
	updatedAt?: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface UpsertAgentV2TaskInput extends JsonObject {
	clientId: string;
	runId: string;
	taskId: string;
	parentTaskId?: string;
	kind: AgentV2TaskKind;
	title: string;
	status: AgentV2TaskStatus;
	dependsOn: string[];
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface AgentV2ArtifactRecord extends JsonObject {
	clientId: string;
	runId: string;
	artifactId: string;
	taskId?: string;
	kind: string;
	uri: string;
	title: string;
	description?: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertAgentV2ArtifactInput extends JsonObject {
	clientId: string;
	runId: string;
	artifactId: string;
	taskId?: string;
	kind: string;
	uri: string;
	title: string;
	description?: string;
	metadata?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentV2RunRow {
	client_id: string;
	run_id: string;
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	attempt: number | string;
	input_json: unknown;
	model_json: unknown;
	worker_id: string | null;
	created_at: TimestampValue;
	updated_at: TimestampValue;
	started_at: TimestampValue | null;
	ended_at: TimestampValue | null;
	error_json: unknown;
}

export interface AgentV2TaskRow {
	client_id: string;
	run_id: string;
	task_id: string;
	parent_task_id: string | null;
	kind: AgentV2TaskKind;
	title: string;
	status: AgentV2TaskStatus;
	depends_on_json: unknown;
	input_json: unknown;
	output_json: unknown;
	created_at: TimestampValue;
	updated_at: TimestampValue;
	started_at: TimestampValue | null;
	ended_at: TimestampValue | null;
	error_json: unknown;
}

export interface AgentV2ArtifactRow {
	client_id: string;
	run_id: string;
	artifact_id: string;
	task_id: string | null;
	kind: string;
	uri: string;
	title: string;
	description: string | null;
	metadata_json: unknown;
	created_at: TimestampValue;
	updated_at: TimestampValue;
}

export interface AgentV2DiagnosticRow {
	client_id: string;
	run_id: string;
	diagnostic_id: string;
	severity: AgentV2DiagnosticEvent["severity"];
	category: AgentV2DiagnosticEvent["category"];
	code: string;
	phase: AgentV2Phase | null;
	task_id: string | null;
	artifact_id: string | null;
	trace_id: string | null;
	message: string;
	data_json: unknown;
	created_at: TimestampValue;
}

export const AGENT_V2_RUN_COLUMNS =
	"client_id, run_id, status, phase, attempt, input_json, model_json, worker_id, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_TASK_COLUMNS =
	"client_id, run_id, task_id, parent_task_id, kind, title, status, depends_on_json, input_json, output_json, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_ARTIFACT_COLUMNS =
	"client_id, run_id, artifact_id, task_id, kind, uri, title, description, metadata_json, created_at, updated_at";
export const AGENT_V2_DIAGNOSTIC_COLUMNS =
	"client_id, run_id, diagnostic_id, severity, category, code, phase, task_id, artifact_id, trace_id, message, data_json, created_at";

export function buildAgentV2Run(input: CreateAgentV2RunInput): AgentV2RunSnapshot {
	return createAgentV2RunSnapshot(input);
}

export function applyAgentV2RunUpdate(snapshot: AgentV2RunSnapshot, input: UpdateAgentV2RunInput): AgentV2RunSnapshot {
	if (input.status) {
		return transitionAgentV2RunSnapshot(snapshot, input.status, {
			phase: input.phase,
			attempt: input.attempt,
			...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
			...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
			...(input.error !== undefined ? { error: input.error } : {}),
		});
	}

	const next: AgentV2RunSnapshot = {
		...snapshot,
		phase: input.phase ?? snapshot.phase,
		attempt: input.attempt ?? snapshot.attempt,
		updatedAt: input.updatedAt ?? new Date().toISOString(),
	};

	if (input.workerId !== undefined || snapshot.workerId !== undefined) {
		next.workerId = input.workerId ?? snapshot.workerId;
	}
	if (input.startedAt !== undefined || snapshot.startedAt !== undefined) {
		next.startedAt = input.startedAt ?? snapshot.startedAt;
	}
	if (input.endedAt !== undefined || snapshot.endedAt !== undefined) {
		next.endedAt = input.endedAt ?? snapshot.endedAt;
	}
	if (input.error !== undefined || snapshot.error !== undefined) {
		next.error = input.error ?? snapshot.error;
	}

	return next;
}

export function buildAgentV2Task(input: UpsertAgentV2TaskInput): AgentV2TaskNode {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const updatedAt = input.updatedAt ?? createdAt;

	return {
		taskId: input.taskId,
		...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
		kind: input.kind,
		title: input.title,
		status: input.status,
		dependsOn: input.dependsOn,
		input: input.input,
		output: input.output,
		createdAt,
		updatedAt,
		...(input.startedAt ? { startedAt: input.startedAt } : {}),
		...(input.endedAt ? { endedAt: input.endedAt } : {}),
		...(input.error ? { error: input.error } : {}),
	};
}

export function buildAgentV2Artifact(input: UpsertAgentV2ArtifactInput): AgentV2ArtifactRecord {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const updatedAt = input.updatedAt ?? createdAt;

	return {
		clientId: input.clientId,
		runId: input.runId,
		artifactId: input.artifactId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		kind: input.kind,
		uri: input.uri,
		title: input.title,
		...(input.description ? { description: input.description } : {}),
		metadata: input.metadata ?? {},
		createdAt,
		updatedAt,
	};
}

export function toAgentV2RunRecord(row: AgentV2RunRow): AgentV2RunSnapshot {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		status: row.status,
		phase: row.phase,
		attempt: toNumber(row.attempt),
		input: parseJsonObject(row.input_json),
		model: parseJsonValue(row.model_json),
		...(row.worker_id ? { workerId: row.worker_id } : {}),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
		...(row.started_at ? { startedAt: toTimestamp(row.started_at) } : {}),
		...(row.ended_at ? { endedAt: toTimestamp(row.ended_at) } : {}),
		...(parseAgentV2Error(row.error_json) ? { error: parseAgentV2Error(row.error_json)! } : {}),
	};
}

export function toAgentV2TaskRecord(row: AgentV2TaskRow): AgentV2TaskNode {
	return {
		taskId: row.task_id,
		...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
		kind: row.kind,
		title: row.title,
		status: row.status,
		dependsOn: parseStringArray(row.depends_on_json),
		input: parseJsonObject(row.input_json),
		output: parseJsonObject(row.output_json),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
		...(row.started_at ? { startedAt: toTimestamp(row.started_at) } : {}),
		...(row.ended_at ? { endedAt: toTimestamp(row.ended_at) } : {}),
		...(parseAgentV2Error(row.error_json) ? { error: parseAgentV2Error(row.error_json)! } : {}),
	};
}

export function toAgentV2ArtifactRecord(row: AgentV2ArtifactRow): AgentV2ArtifactRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		artifactId: row.artifact_id,
		...(row.task_id ? { taskId: row.task_id } : {}),
		kind: row.kind,
		uri: row.uri,
		title: row.title,
		...(row.description ? { description: row.description } : {}),
		metadata: parseJsonObject(row.metadata_json),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
	};
}

export function toAgentV2DiagnosticRecord(row: AgentV2DiagnosticRow): AgentV2DiagnosticEvent {
	return {
		diagnosticId: row.diagnostic_id,
		clientId: row.client_id,
		runId: row.run_id,
		severity: row.severity,
		category: row.category,
		code: row.code,
		...(row.phase ? { phase: row.phase } : {}),
		...(row.task_id ? { taskId: row.task_id } : {}),
		...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
		...(row.trace_id ? { traceId: row.trace_id } : {}),
		message: row.message,
		data: parseJsonObject(row.data_json),
		createdAt: toTimestamp(row.created_at),
	};
}

export function stringifyAgentV2Json(value: unknown): string {
	return JSON.stringify(value ?? {});
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value === "string") {
		return JSON.parse(value) as unknown;
	}
	return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	const parsed = parseJsonValue(value);
	return isObject(parsed) ? parsed : {};
}

function parseStringArray(value: unknown): string[] {
	const parsed = parseJsonValue(value);
	return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseAgentV2Error(value: unknown): AgentV2Error | undefined {
	const parsed = parseJsonValue(value);
	if (!isObject(parsed)) return undefined;
	if (typeof parsed.code !== "string" || typeof parsed.message !== "string" || typeof parsed.retryable !== "boolean") {
		return undefined;
	}

	const error: AgentV2Error = {
		code: parsed.code,
		message: parsed.message,
		retryable: parsed.retryable,
	};
	if (isObject(parsed.data)) error.data = parsed.data;
	return error;
}

function toNumber(value: number | string): number {
	return typeof value === "number" ? value : Number(value);
}

function toTimestamp(value: TimestampValue): string {
	return value instanceof Date ? value.toISOString() : value;
}
