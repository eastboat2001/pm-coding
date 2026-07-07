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
];
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;
const MAX_DEPTH = 8;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;
export function createAgentV2DiagnosticEvent(input) {
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
export function toWorkspaceDiagnosticEvent(event) {
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
function assertAgentV2DiagnosticCategory(value) {
    if (!isAgentV2DiagnosticCategory(value)) {
        throw new Error(`Invalid Agent v2 diagnostic category: ${value}`);
    }
}
function isAgentV2DiagnosticCategory(value) {
    return AGENT_V2_DIAGNOSTIC_CATEGORIES.includes(value);
}
function sanitizeDiagnosticData(value) {
    const sanitized = sanitizeDiagnosticValue(value, 0);
    return isRecord(sanitized) ? sanitized : {};
}
function sanitizeDiagnosticValue(value, depth, key = "") {
    if (SENSITIVE_KEY_PATTERN.test(key))
        return REDACTED;
    if (depth > MAX_DEPTH)
        return "[max-depth]";
    if (typeof value === "string")
        return truncateString(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return value;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, depth + 1));
    }
    if (isRecord(value)) {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
            result[childKey] = sanitizeDiagnosticValue(childValue, depth + 1, childKey);
        }
        return result;
    }
    if (value === undefined)
        return undefined;
    return String(value);
}
function truncateString(value) {
    if (value.length <= MAX_STRING_LENGTH)
        return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agent-v2-diagnostics.js.map