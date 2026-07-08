import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2RunSnapshot, transitionAgentV2RunSnapshot } from "./agent-v2-state-machine.js";
import type {
	AgentV2DocumentContent,
	AgentV2DocumentKind,
	AgentV2Error,
	AgentV2Phase,
	AgentV2RunInput,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
	AgentV2TaskKind,
	AgentV2TaskNode,
	AgentV2TaskStatus,
} from "./agent-v2-types.js";
import { isObject } from "./json.js";
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
	expectedStatuses?: readonly AgentV2RunStatus[];
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
	acceptanceCriteria: string[];
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
	kind: string;
	path: string;
	mediaType: string;
	checksum: string;
	version: string;
	sourceTaskId?: string;
	validationStatus: string;
	metadataJson: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertAgentV2ArtifactInput extends JsonObject {
	clientId: string;
	runId: string;
	artifactId: string;
	kind: string;
	path: string;
	mediaType: string;
	checksum: string;
	version: string;
	sourceTaskId?: string;
	validationStatus: string;
	metadataJson?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentV2DocumentRecord extends JsonObject {
	clientId: string;
	runId: string;
	documentId: string;
	kind: AgentV2DocumentKind;
	version: string;
	contentMarkdown: string;
	contentJson: AgentV2DocumentContent;
	sourceTaskId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertAgentV2DocumentInput extends JsonObject {
	clientId: string;
	runId: string;
	documentId: string;
	kind: AgentV2DocumentKind;
	version: string;
	contentMarkdown: string;
	contentJson: AgentV2DocumentContent;
	sourceTaskId?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentV2RunEventRecord extends JsonObject {
	clientId: string;
	runId: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface AppendAgentV2RunEventInput extends JsonObject {
	clientId: string;
	runId: string;
	seq?: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt?: string;
}

export type AgentV2ValidationStatus = "passed" | "failed" | "blocked" | "warning";

export interface AgentV2ValidationRecord extends JsonObject {
	clientId: string;
	runId: string;
	validationId: string;
	taskId?: string;
	artifactId?: string;
	status: AgentV2ValidationStatus;
	summary: string;
	details: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertAgentV2ValidationInput extends JsonObject {
	clientId: string;
	runId: string;
	validationId: string;
	taskId?: string;
	artifactId?: string;
	status: AgentV2ValidationStatus;
	summary: string;
	details: Record<string, unknown>;
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
	acceptance_criteria_json: unknown;
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
	kind: string;
	path: string;
	media_type: string;
	checksum: string;
	version: string;
	source_task_id: string | null;
	validation_status: string;
	metadata_json: unknown;
	created_at: TimestampValue;
	updated_at: TimestampValue;
}

export interface AgentV2DocumentRow {
	client_id: string;
	run_id: string;
	document_id: string;
	kind: AgentV2DocumentKind;
	version: string;
	content_markdown: string;
	content_json: unknown;
	source_task_id: string | null;
	created_at: TimestampValue;
	updated_at: TimestampValue;
}

export interface AgentV2RunEventRow {
	client_id: string;
	run_id: string;
	seq: number | string;
	event_type: string;
	payload_json: unknown;
	created_at: TimestampValue;
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

export interface AgentV2ValidationRow {
	client_id: string;
	run_id: string;
	validation_id: string;
	task_id: string | null;
	artifact_id: string | null;
	status: AgentV2ValidationStatus;
	summary: string;
	details_json: unknown;
	created_at: TimestampValue;
	updated_at: TimestampValue;
}

export const AGENT_V2_RUN_COLUMNS =
	"client_id, run_id, status, phase, attempt, input_json, model_json, worker_id, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_TASK_COLUMNS =
	"client_id, run_id, task_id, parent_task_id, kind, title, status, depends_on_json, acceptance_criteria_json, input_json, output_json, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_ARTIFACT_COLUMNS =
	"client_id, run_id, artifact_id, kind, path, media_type, checksum, version, source_task_id, validation_status, metadata_json, created_at, updated_at";
export const AGENT_V2_DOCUMENT_COLUMNS =
	"client_id, run_id, document_id, kind, version, content_markdown, content_json, source_task_id, created_at, updated_at";
export const AGENT_V2_RUN_EVENT_COLUMNS = "client_id, run_id, seq, event_type, payload_json, created_at";
export const AGENT_V2_DIAGNOSTIC_COLUMNS =
	"client_id, run_id, diagnostic_id, severity, category, code, phase, task_id, artifact_id, trace_id, message, data_json, created_at";
export const AGENT_V2_VALIDATION_COLUMNS =
	"client_id, run_id, validation_id, task_id, artifact_id, status, summary, details_json, created_at, updated_at";

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
		acceptanceCriteria: input.acceptanceCriteria ?? [],
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
		kind: input.kind,
		path: input.path,
		mediaType: input.mediaType,
		checksum: input.checksum,
		version: input.version,
		...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
		validationStatus: input.validationStatus,
		metadataJson: input.metadataJson ?? {},
		createdAt,
		updatedAt,
	};
}

export function buildAgentV2Document(input: UpsertAgentV2DocumentInput): AgentV2DocumentRecord {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const updatedAt = input.updatedAt ?? createdAt;
	const contentJson = normalizeAgentV2DocumentContent(input.kind, input.contentJson);

	return {
		clientId: input.clientId,
		runId: input.runId,
		documentId: input.documentId,
		kind: input.kind,
		version: input.version,
		contentMarkdown: input.contentMarkdown,
		contentJson,
		...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
		createdAt,
		updatedAt,
	};
}

export function buildAgentV2Validation(input: UpsertAgentV2ValidationInput): AgentV2ValidationRecord {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const updatedAt = input.updatedAt ?? createdAt;

	return {
		clientId: input.clientId,
		runId: input.runId,
		validationId: input.validationId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.artifactId ? { artifactId: input.artifactId } : {}),
		status: input.status,
		summary: input.summary,
		details: input.details ?? {},
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
		acceptanceCriteria: parseStringArray(row.acceptance_criteria_json),
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
		kind: row.kind,
		path: row.path,
		mediaType: row.media_type,
		checksum: row.checksum,
		version: row.version,
		...(row.source_task_id ? { sourceTaskId: row.source_task_id } : {}),
		validationStatus: row.validation_status,
		metadataJson: parseJsonObject(row.metadata_json),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
	};
}

export function toAgentV2DocumentRecord(row: AgentV2DocumentRow): AgentV2DocumentRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		documentId: row.document_id,
		kind: row.kind,
		version: row.version,
		contentMarkdown: row.content_markdown,
		contentJson: parseAgentV2DocumentContent(row.content_json, row.kind),
		...(row.source_task_id ? { sourceTaskId: row.source_task_id } : {}),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
	};
}

export function toAgentV2RunEventRecord(row: AgentV2RunEventRow): AgentV2RunEventRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		seq: toNumber(row.seq),
		type: row.event_type,
		payload: parseJsonObject(row.payload_json),
		createdAt: toTimestamp(row.created_at),
	};
}

export function toAgentV2ValidationRecord(row: AgentV2ValidationRow): AgentV2ValidationRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		validationId: row.validation_id,
		...(row.task_id ? { taskId: row.task_id } : {}),
		...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
		status: row.status,
		summary: row.summary,
		details: parseJsonObject(row.details_json),
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

function normalizeAgentV2DocumentContent(
	kind: AgentV2DocumentKind,
	contentJson: AgentV2DocumentContent,
): AgentV2DocumentContent {
	const contentKind = contentJson.kind;
	if (contentKind !== undefined && typeof contentKind !== "string") {
		throw new Error(
			`Agent v2 document kind must be a string when present: input.kind="${kind}" contentJson.kind=${String(contentKind)}`,
		);
	}
	if (typeof contentKind === "string" && contentKind !== kind) {
		throw new Error(`Agent v2 document kind mismatch: input.kind="${kind}" contentJson.kind="${contentKind}"`);
	}
	return { ...contentJson, kind } as AgentV2DocumentContent;
}

function parseAgentV2DocumentContent(value: unknown, fallbackKind: AgentV2DocumentKind): AgentV2DocumentContent {
	const parsed = parseJsonObject(value);
	const parsedKind = parsed.kind;
	if (isAgentV2DocumentKind(parsedKind)) return parsed as unknown as AgentV2DocumentContent;
	return { ...parsed, kind: fallbackKind } as AgentV2DocumentContent;
}

function isAgentV2DocumentKind(value: unknown): value is AgentV2DocumentKind {
	return value === "capability_decision" || value === "spec" || value === "plan" || value === "tasks";
}

function toNumber(value: number | string): number {
	return typeof value === "number" ? value : Number(value);
}

function toTimestamp(value: TimestampValue): string {
	return value instanceof Date ? value.toISOString() : value;
}
