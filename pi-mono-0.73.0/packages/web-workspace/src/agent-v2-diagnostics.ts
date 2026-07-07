import type { AgentV2Phase } from "./agent-v2-types.js";

export const AGENT_V2_DIAGNOSTIC_CATEGORIES = [
	"schema",
	"queue",
	"worker",
	"planning",
	"task_graph",
	"tool_execution",
	"artifact",
	"validation",
	"repair",
	"preview",
	"model",
	"cancellation",
] as const;

export type AgentV2DiagnosticCategory = (typeof AGENT_V2_DIAGNOSTIC_CATEGORIES)[number];

export type AgentV2DiagnosticSeverity = "debug" | "info" | "warn" | "error";

export interface AgentV2DiagnosticEvent {
	diagnosticId: string;
	clientId: string;
	runId: string;
	severity: AgentV2DiagnosticSeverity;
	category: AgentV2DiagnosticCategory;
	code: string;
	phase?: AgentV2Phase;
	taskId?: string;
	artifactId?: string;
	traceId?: string;
	message: string;
	data: Record<string, unknown>;
	createdAt: string;
}

export interface CreateAgentV2DiagnosticEventInput {
	diagnosticId: string;
	clientId: string;
	runId: string;
	severity: AgentV2DiagnosticSeverity;
	category: string;
	code: string;
	phase?: AgentV2Phase;
	taskId?: string;
	artifactId?: string;
	traceId?: string;
	message: string;
	data?: Record<string, unknown>;
	createdAt: string;
}

export interface WorkspaceDiagnosticEvent {
	level: AgentV2DiagnosticSeverity;
	category: "agent";
	eventType: string;
	sessionId?: string;
	traceId?: string;
	data: Record<string, unknown>;
}

const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;
const MAX_DEPTH = 8;
const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
	/(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;

export function createAgentV2DiagnosticEvent(input: CreateAgentV2DiagnosticEventInput): AgentV2DiagnosticEvent {
	assertAgentV2DiagnosticCategory(input.category);

	return {
		diagnosticId: input.diagnosticId,
		clientId: input.clientId,
		runId: input.runId,
		severity: input.severity,
		category: input.category,
		code: input.code,
		phase: input.phase,
		taskId: input.taskId,
		artifactId: input.artifactId,
		traceId: input.traceId,
		message: input.message,
		data: input.data ?? {},
		createdAt: input.createdAt,
	};
}

export function toWorkspaceDiagnosticEvent(event: AgentV2DiagnosticEvent): WorkspaceDiagnosticEvent {
	const data = sanitizeDiagnosticData({
		...event.data,
		agentV2Category: `agent_v2.${event.category}`,
		artifactId: event.artifactId,
		code: event.code,
		clientId: event.clientId,
		createdAt: event.createdAt,
		diagnosticId: event.diagnosticId,
		message: event.message,
		phase: event.phase,
		runId: event.runId,
		severity: event.severity,
		taskId: event.taskId,
		traceId: event.traceId,
	});

	return {
		level: event.severity,
		category: "agent",
		eventType: event.code,
		traceId: event.traceId,
		data,
	};
}

function assertAgentV2DiagnosticCategory(value: string): asserts value is AgentV2DiagnosticCategory {
	if (!isAgentV2DiagnosticCategory(value)) {
		throw new Error(`Invalid Agent v2 diagnostic category: ${value}`);
	}
}

function isAgentV2DiagnosticCategory(value: string): value is AgentV2DiagnosticCategory {
	return AGENT_V2_DIAGNOSTIC_CATEGORIES.includes(value as AgentV2DiagnosticCategory);
}

function sanitizeDiagnosticData(value: Record<string, unknown>): Record<string, unknown> {
	const sanitized = sanitizeDiagnosticValue(value, 0);
	return isRecord(sanitized) ? sanitized : {};
}

function sanitizeDiagnosticValue(value: unknown, depth: number, key = ""): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
	if (depth > MAX_DEPTH) return "[max-depth]";
	if (typeof value === "string") return truncateString(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, depth + 1));
	}
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
			result[childKey] = sanitizeDiagnosticValue(childValue, depth + 1, childKey);
		}
		return result;
	}
	if (value === undefined) return undefined;
	return String(value);
}

function truncateString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
