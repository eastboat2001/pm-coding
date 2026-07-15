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
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu;
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
        message: sanitizeDiagnosticString(input.message),
        data: sanitizeDiagnosticData(input.data ?? {}),
        createdAt: input.createdAt,
    };
}
export function canonicalizeAgentV2DiagnosticEvent(input) {
    return createAgentV2DiagnosticEvent(input);
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
        timestamp: event.createdAt,
        clientId: event.clientId,
        level: event.severity,
        category: "agent",
        eventType: event.code,
        traceId: event.traceId,
        data: data,
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
    const sanitized = sanitizeDiagnosticValue(value, 0, "", new WeakSet());
    return isRecord(sanitized) ? sanitized : {};
}
function sanitizeDiagnosticValue(value, depth, key, seen) {
    if (isSensitiveDiagnosticKey(key))
        return REDACTED;
    if (depth > MAX_DEPTH)
        return "[max-depth]";
    if (typeof value === "string")
        return sanitizeDiagnosticString(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return value;
    if (typeof value === "bigint")
        return value.toString();
    if (typeof value === "symbol" || typeof value === "function")
        return `[${typeof value}]`;
    if (value === undefined)
        return undefined;
    if (typeof value !== "object")
        return sanitizeDiagnosticString(String(value));
    if (seen.has(value))
        return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, depth + 1, "", seen));
    }
    if (isRecord(value)) {
        const result = {};
        const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, MAX_OBJECT_KEYS);
        for (const [childKey, descriptor] of descriptors) {
            if (!("value" in descriptor)) {
                result[childKey] = "[accessor]";
                continue;
            }
            result[childKey] = sanitizeDiagnosticValue(descriptor.value, depth + 1, childKey, seen);
        }
        return result;
    }
    return sanitizeDiagnosticString(String(value));
}
function sanitizeDiagnosticString(value) {
    let sanitized = value.replace(URL_PATTERN, sanitizeUrlMatch);
    sanitized = sanitized.replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]");
    sanitized = sanitized.replace(/\b(Basic\s+)[A-Za-z0-9+/]{16,}={0,2}\b/gu, "$1[redacted]");
    sanitized = sanitized.replace(/\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
    sanitized = sanitized.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED);
    sanitized = sanitized.replace(/\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}\b/gu, REDACTED);
    sanitized = sanitized.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, REDACTED);
    sanitized = sanitized.replace(/\bhf_[A-Za-z0-9]{12,}\b/gu, REDACTED);
    sanitized = sanitized.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, REDACTED);
    sanitized = sanitized.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu, REDACTED);
    return truncateString(sanitized);
}
function isSensitiveDiagnosticKey(key) {
    if (!key)
        return false;
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(Boolean);
    if (words.length === 0)
        return false;
    if (words.some((word) => [
        "auth",
        "authorization",
        "bearer",
        "cookie",
        "cookies",
        "credential",
        "credentials",
        "header",
        "headers",
        "password",
        "secret",
        "stderr",
        "stdout",
    ].includes(word))) {
        return true;
    }
    if (words.some((word, index) => word === "api" && words[index + 1] === "key"))
        return true;
    if (words.some((word, index) => word === "provider" && words[index + 1] === "payload"))
        return true;
    const tokenIndex = words.indexOf("token");
    if (tokenIndex < 0)
        return false;
    const suffix = words.slice(tokenIndex + 1);
    return (suffix.length === 0 || !suffix.every((word) => ["count", "counts", "length", "budget", "limit"].includes(word)));
}
function sanitizeUrlMatch(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password) {
            url.username = "redacted";
            url.password = "";
        }
        if (url.search)
            url.search = "?[redacted]";
        return url.toString();
    }
    catch {
        return REDACTED;
    }
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