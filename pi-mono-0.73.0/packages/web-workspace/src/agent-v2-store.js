import { isObject } from "./json.js";
import { createAgentV2RunSnapshot, transitionAgentV2RunSnapshot } from "./agent-v2-state-machine.js";
export const AGENT_V2_RUN_COLUMNS = "client_id, run_id, status, phase, attempt, input_json, model_json, worker_id, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_TASK_COLUMNS = "client_id, run_id, task_id, parent_task_id, kind, title, status, depends_on_json, acceptance_criteria_json, input_json, output_json, created_at, updated_at, started_at, ended_at, error_json";
export const AGENT_V2_ARTIFACT_COLUMNS = "client_id, run_id, artifact_id, kind, path, media_type, checksum, version, source_task_id, validation_status, metadata_json, created_at, updated_at";
export const AGENT_V2_DOCUMENT_COLUMNS = "client_id, run_id, document_id, kind, version, content_markdown, content_json, source_task_id, created_at, updated_at";
export const AGENT_V2_DIAGNOSTIC_COLUMNS = "client_id, run_id, diagnostic_id, severity, category, code, phase, task_id, artifact_id, trace_id, message, data_json, created_at";
export function buildAgentV2Run(input) {
    return createAgentV2RunSnapshot(input);
}
export function applyAgentV2RunUpdate(snapshot, input) {
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
    const next = {
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
export function buildAgentV2Task(input) {
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
export function buildAgentV2Artifact(input) {
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
export function buildAgentV2Document(input) {
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
export function toAgentV2RunRecord(row) {
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
        ...(parseAgentV2Error(row.error_json) ? { error: parseAgentV2Error(row.error_json) } : {}),
    };
}
export function toAgentV2TaskRecord(row) {
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
        ...(parseAgentV2Error(row.error_json) ? { error: parseAgentV2Error(row.error_json) } : {}),
    };
}
export function toAgentV2ArtifactRecord(row) {
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
export function toAgentV2DocumentRecord(row) {
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
export function toAgentV2DiagnosticRecord(row) {
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
export function stringifyAgentV2Json(value) {
    return JSON.stringify(value ?? {});
}
function parseJsonValue(value) {
    if (typeof value === "string") {
        return JSON.parse(value);
    }
    return value;
}
function parseJsonObject(value) {
    const parsed = parseJsonValue(value);
    return isObject(parsed) ? parsed : {};
}
function parseStringArray(value) {
    const parsed = parseJsonValue(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
}
function parseAgentV2Error(value) {
    const parsed = parseJsonValue(value);
    if (!isObject(parsed))
        return undefined;
    if (typeof parsed.code !== "string" || typeof parsed.message !== "string" || typeof parsed.retryable !== "boolean") {
        return undefined;
    }
    const error = {
        code: parsed.code,
        message: parsed.message,
        retryable: parsed.retryable,
    };
    if (isObject(parsed.data))
        error.data = parsed.data;
    return error;
}
function normalizeAgentV2DocumentContent(kind, contentJson) {
    const contentKind = contentJson.kind;
    if (contentKind !== undefined && typeof contentKind !== "string") {
        throw new Error(`Agent v2 document kind must be a string when present: input.kind="${kind}" contentJson.kind=${String(contentKind)}`);
    }
    if (typeof contentKind === "string" && contentKind !== kind) {
        throw new Error(`Agent v2 document kind mismatch: input.kind="${kind}" contentJson.kind="${contentKind}"`);
    }
    return { ...contentJson, kind };
}
function parseAgentV2DocumentContent(value, fallbackKind) {
    const parsed = parseJsonObject(value);
    const parsedKind = parsed.kind;
    if (isAgentV2DocumentKind(parsedKind))
        return parsed;
    return { ...parsed, kind: fallbackKind };
}
function isAgentV2DocumentKind(value) {
    return value === "capability_decision" || value === "spec" || value === "plan" || value === "tasks";
}
function toNumber(value) {
    return typeof value === "number" ? value : Number(value);
}
function toTimestamp(value) {
    return value instanceof Date ? value.toISOString() : value;
}
//# sourceMappingURL=agent-v2-store.js.map
