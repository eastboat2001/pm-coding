import { createHash } from "node:crypto";
export const AGENT_V2_INPUT_LIMITS = {
    maxEntries: 64,
    maxTextBytes: 1_048_576,
    maxImageBytes: 2_097_152,
    maxTotalBytes: 8_388_608,
};
export const AGENT_V2_RUN_ID_MAX_LENGTH = 128;
export const AGENT_V2_MODEL_PROVIDER_MAX_LENGTH = 128;
export const AGENT_V2_MODEL_ID_MAX_LENGTH = 256;
export const AGENT_V2_CONVERSATION_SNAPSHOT_MAX_CHARS = 60_000;
export const AGENT_V2_CONVERSATION_SUMMARY_MAX_CHARS = 32_768;
export const AGENT_V2_CONVERSATION_MESSAGE_MAX_CHARS = 8_192;
export const AGENT_V2_CONVERSATION_MESSAGE_MAX_ENTRIES = 64;
export class AgentV2StartInputError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentV2StartInputError";
    }
}
const REQUEST_FIELDS = new Set(["input", "model", "runId"]);
const INPUT_FIELDS = new Set([
    "sessionId",
    "title",
    "objective",
    "conversationSnapshot",
    "selectedSkillNames",
    "projectFiles",
    "attachments",
]);
const PROJECT_FILE_FIELDS = new Set(["filename", "content", "encoding"]);
const ATTACHMENT_FIELDS = new Set(["type", "fileName", "mimeType", "projectFilePath"]);
const MODEL_FIELDS = new Set(["provider", "id"]);
const CONVERSATION_SNAPSHOT_FIELDS = new Set(["compactedSummary", "recentMessages", "currentObjective"]);
const CONVERSATION_MESSAGE_FIELDS = new Set(["role", "content"]);
const BLOCKED_PATH_SEGMENTS = new Set([".git", ".pi", ".codex", ".superpowers", "node_modules", "agent-v2"]);
const INTERNAL_PROJECT_FILES = new Set([".pi-project.json", ".pi-project-files.json"]);
const INVALID_PATH_COMPONENT_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/u;
const ROUTE_SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
export function normalizeAgentV2StartInput(value, identity) {
    return bindAgentV2StartPayload(normalizeAgentV2StartPayload(value, identity.runId), identity);
}
export function normalizeAgentV2StartPayload(value, runId) {
    const request = requireRecord(value, "Agent v2 start request");
    assertExactFields(request, REQUEST_FIELDS, "Agent v2 start request");
    const canonicalRunId = normalizeAgentV2RunId(runId);
    if (request.runId !== undefined && request.runId !== canonicalRunId) {
        throw new AgentV2StartInputError("Agent v2 start request runId does not match the canonical identity");
    }
    const input = requireRecord(request.input, "Agent v2 start input");
    assertExactFields(input, INPUT_FIELDS, "Agent v2 start input");
    const sessionId = requireNonEmptyString(input.sessionId, "Agent v2 start input sessionId");
    const title = requireNonEmptyString(input.title, "Agent v2 start input title");
    const objective = requireNonEmptyString(input.objective, "Agent v2 start input objective");
    const conversationSnapshot = normalizeConversationSnapshot(input.conversationSnapshot, objective);
    const selectedSkillNames = normalizeSelectedSkillNames(input.selectedSkillNames);
    const model = normalizeAgentV2ModelReference(request.model);
    const projectFiles = optionalArray(input.projectFiles, "Agent v2 projectFiles");
    const attachments = optionalArray(input.attachments, "Agent v2 attachments");
    if (projectFiles.length + attachments.length > AGENT_V2_INPUT_LIMITS.maxEntries) {
        throw new AgentV2StartInputError(`Agent v2 start input entries exceed ${AGENT_V2_INPUT_LIMITS.maxEntries}`);
    }
    const filesByCollisionKey = new Map();
    const orderedFiles = [];
    let totalBytes = 0;
    for (const candidate of projectFiles) {
        const entry = requireRecord(candidate, "Agent v2 project file");
        assertExactFields(entry, PROJECT_FILE_FIELDS, "Agent v2 project file");
        const logicalPath = normalizeLogicalPath(requireRawNonEmptyString(entry.filename, "Agent v2 project file filename"));
        const content = requireString(entry.content, "Agent v2 project file content");
        if (entry.encoding !== undefined && entry.encoding !== "base64") {
            throw new AgentV2StartInputError("Agent v2 project file encoding must be base64 when provided");
        }
        const bytes = entry.encoding === "base64" ? decodeStrictBase64(content) : encodeStrictUtf8(content);
        const media = sniffMedia(bytes);
        const byteLimit = media.encoding === "binary" ? AGENT_V2_INPUT_LIMITS.maxImageBytes : AGENT_V2_INPUT_LIMITS.maxTextBytes;
        if (bytes.byteLength > byteLimit) {
            throw new AgentV2StartInputError(`Agent v2 ${media.encoding === "binary" ? "image" : "text"} bytes exceed ${byteLimit}`);
        }
        const checksum = checksumBytes(bytes);
        const collisionKey = logicalPath.toLocaleLowerCase("en-US");
        const existing = filesByCollisionKey.get(collisionKey);
        if (existing) {
            if (existing.logicalPath !== logicalPath || existing.checksum !== checksum) {
                throw new AgentV2StartInputError(`Agent v2 project file path conflict: ${logicalPath}`);
            }
            continue;
        }
        const file = {
            logicalPath,
            bytes,
            mediaType: media.mediaType,
            encoding: media.encoding,
            checksum,
            inputId: deterministicInputId(logicalPath, checksum),
        };
        filesByCollisionKey.set(collisionKey, file);
        orderedFiles.push(file);
        totalBytes += bytes.byteLength;
        if (totalBytes > AGENT_V2_INPUT_LIMITS.maxTotalBytes) {
            throw new AgentV2StartInputError(`Agent v2 start input total bytes exceed ${AGENT_V2_INPUT_LIMITS.maxTotalBytes}`);
        }
    }
    const inputBlobs = orderedFiles.map((file) => ({
        inputId: file.inputId,
        logicalPath: file.logicalPath,
        mediaType: file.mediaType,
        encoding: file.encoding,
        bytes: new Uint8Array(file.bytes),
        byteLength: file.bytes.byteLength,
        checksum: file.checksum,
    }));
    const inputReferences = orderedFiles.map((file, ordinal) => ({
        kind: "project_file",
        ordinal,
        inputId: file.inputId,
        logicalPath: file.logicalPath,
        mediaType: file.mediaType,
        byteLength: file.bytes.byteLength,
        checksum: file.checksum,
    }));
    attachments.forEach((candidate, ordinal) => {
        const descriptor = requireRecord(candidate, "Agent v2 attachment");
        assertExactFields(descriptor, ATTACHMENT_FIELDS, "Agent v2 attachment");
        const type = requireNonEmptyString(descriptor.type, "Agent v2 attachment type");
        if (type !== "file" && type !== "image") {
            throw new AgentV2StartInputError("Agent v2 attachment type must be file or image");
        }
        const displayName = requireNonEmptyString(descriptor.fileName, "Agent v2 attachment fileName");
        if (/[\\/\0]/u.test(displayName) || displayName === "." || displayName === "..") {
            throw new AgentV2StartInputError("Agent v2 attachment fileName is invalid");
        }
        requireNonEmptyString(descriptor.mimeType, "Agent v2 attachment mimeType");
        const logicalPath = normalizeLogicalPath(requireRawNonEmptyString(descriptor.projectFilePath, "Agent v2 attachment projectFilePath"));
        const file = filesByCollisionKey.get(logicalPath.toLocaleLowerCase("en-US"));
        if (!file || file.logicalPath !== logicalPath) {
            throw new AgentV2StartInputError(`Agent v2 attachment must match a normalized project file: ${logicalPath}`);
        }
        if (type === "image" && file.encoding !== "binary") {
            throw new AgentV2StartInputError("Agent v2 image attachment must reference a sniffed PNG, JPEG, or WebP image");
        }
        inputReferences.push({
            kind: "attachment",
            ordinal,
            inputId: file.inputId,
            logicalPath: file.logicalPath,
            displayName,
            mediaType: file.mediaType,
            byteLength: file.bytes.byteLength,
            checksum: file.checksum,
        });
    });
    return {
        runId: canonicalRunId,
        sessionId,
        title,
        objective,
        ...(conversationSnapshot ? { conversationSnapshot } : {}),
        selectedSkillNames,
        model,
        inputBlobs,
        inputReferences,
    };
}
export function bindAgentV2StartPayload(payload, identity) {
    assertIdentity(identity);
    if (payload.runId !== identity.runId) {
        throw new AgentV2StartInputError("Agent v2 normalized start payload runId does not match the canonical identity");
    }
    const inputBlobs = payload.inputBlobs.map((blob) => ({
        ...blob,
        clientId: identity.clientId,
        runId: identity.runId,
        bytes: new Uint8Array(blob.bytes),
        createdAt: identity.createdAt,
    }));
    const inputReferences = payload.inputReferences.map((reference) => ({
        ...reference,
        clientId: identity.clientId,
        runId: identity.runId,
    }));
    return {
        runInput: {
            sessionId: payload.sessionId,
            title: payload.title,
            objective: payload.objective,
            ...(payload.conversationSnapshot
                ? {
                    conversationSnapshot: {
                        ...payload.conversationSnapshot,
                        recentMessages: payload.conversationSnapshot.recentMessages.map((message) => ({ ...message })),
                    },
                }
                : {}),
            selectedSkillNames: [...payload.selectedSkillNames],
            inputReferences: inputReferences.map((reference) => ({ ...reference })),
        },
        model: { ...payload.model },
        inputBlobs,
        inputReferences,
    };
}
function normalizeSelectedSkillNames(value) {
    const candidates = optionalArray(value, "Agent v2 selected skill names");
    if (candidates.length > 16)
        throw new AgentV2StartInputError("Agent v2 selected skill names exceed 16 entries");
    const names = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(candidate)) {
            throw new AgentV2StartInputError("Agent v2 selected skill name is invalid");
        }
        if (seen.has(candidate))
            throw new AgentV2StartInputError("Agent v2 selected skill names must be unique");
        seen.add(candidate);
        names.push(candidate);
    }
    return names;
}
function normalizeConversationSnapshot(value, objective) {
    if (value === undefined)
        return undefined;
    const snapshot = requireRecord(value, "Agent v2 conversation snapshot");
    assertExactFields(snapshot, CONVERSATION_SNAPSHOT_FIELDS, "Agent v2 conversation snapshot");
    const compactedSummary = sanitizeConversationText(requireBoundedString(snapshot.compactedSummary, "Agent v2 conversation snapshot compactedSummary", AGENT_V2_CONVERSATION_SUMMARY_MAX_CHARS));
    const currentObjective = requireNonEmptyString(snapshot.currentObjective, "Agent v2 conversation snapshot currentObjective");
    if (currentObjective !== objective) {
        throw new AgentV2StartInputError("Agent v2 conversation snapshot currentObjective must match objective");
    }
    const candidates = optionalArray(snapshot.recentMessages, "Agent v2 conversation snapshot recentMessages");
    if (candidates.length > AGENT_V2_CONVERSATION_MESSAGE_MAX_ENTRIES) {
        throw new AgentV2StartInputError("Agent v2 conversation snapshot contains too many recent messages");
    }
    const recentMessages = candidates.map((candidate) => {
        const message = requireRecord(candidate, "Agent v2 conversation snapshot message");
        assertExactFields(message, CONVERSATION_MESSAGE_FIELDS, "Agent v2 conversation snapshot message");
        if (message.role !== "user" && message.role !== "assistant") {
            throw new AgentV2StartInputError("Agent v2 conversation snapshot message role must be user or assistant");
        }
        const role = message.role;
        const content = sanitizeConversationText(requireBoundedString(message.content, "Agent v2 conversation snapshot message content", AGENT_V2_CONVERSATION_MESSAGE_MAX_CHARS));
        if (!content) {
            throw new AgentV2StartInputError("Agent v2 conversation snapshot message content must be non-empty");
        }
        return { role, content };
    });
    const normalized = {
        compactedSummary,
        recentMessages,
        currentObjective: sanitizeConversationText(currentObjective),
    };
    if (JSON.stringify(normalized).length > AGENT_V2_CONVERSATION_SNAPSHOT_MAX_CHARS) {
        throw new AgentV2StartInputError("Agent v2 conversation snapshot exceeds the maximum size");
    }
    return normalized;
}
function sanitizeConversationText(value) {
    return value
        .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
        .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[REDACTED_PATH]")
        .replace(/\/(?:home|Users|var|tmp|opt|srv)\/[^\s,;]*/gu, "[REDACTED_PATH]")
        .trim();
}
export function normalizeAgentV2ModelReference(value) {
    const model = requireRecord(value, "Agent v2 model reference");
    assertExactFields(model, MODEL_FIELDS, "Agent v2 model reference");
    return {
        provider: requireStableModelIdentifier(model.provider, "Agent v2 model provider", AGENT_V2_MODEL_PROVIDER_MAX_LENGTH),
        id: requireStableModelIdentifier(model.id, "Agent v2 model id", AGENT_V2_MODEL_ID_MAX_LENGTH),
    };
}
function normalizeLogicalPath(value) {
    const canonicalValue = value.normalize("NFC");
    if (/^(?:[a-zA-Z]:|[\\/]{2}|[\\/])/u.test(canonicalValue) ||
        /[\u0000-\u001f\u007f]/u.test(canonicalValue) ||
        canonicalValue.includes("%")) {
        throw new AgentV2StartInputError(`Agent v2 logical path must be relative: ${value}`);
    }
    const segments = canonicalValue.replaceAll("\\", "/").split("/");
    if (segments.length === 0)
        throw new AgentV2StartInputError("Agent v2 logical path is empty");
    for (const segment of segments) {
        const lower = segment.toLocaleLowerCase("en-US");
        const windowsStem = segment
            .replace(/[ .]+$/gu, "")
            .split(".", 1)[0]
            ?.replace(/[ .]+$/gu, "")
            .toLocaleUpperCase("en-US") ?? "";
        if (segment === "" ||
            segment === "." ||
            segment === ".." ||
            segment.trim() !== segment ||
            segment.endsWith(".") ||
            INVALID_PATH_COMPONENT_CHARACTERS.test(segment) ||
            BLOCKED_PATH_SEGMENTS.has(lower) ||
            INTERNAL_PROJECT_FILES.has(lower) ||
            windowsStem === "CON" ||
            windowsStem === "PRN" ||
            windowsStem === "AUX" ||
            windowsStem === "NUL" ||
            /^COM[1-9]$/u.test(windowsStem ?? "") ||
            /^LPT[1-9]$/u.test(windowsStem ?? "") ||
            lower === ".env" ||
            lower.startsWith(".env.")) {
            throw new AgentV2StartInputError(`Agent v2 logical path contains a blocked path segment: ${value}`);
        }
    }
    return segments.join("/");
}
export function normalizeAgentV2RunId(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > AGENT_V2_RUN_ID_MAX_LENGTH ||
        value === "." ||
        value === ".." ||
        !ROUTE_SAFE_RUN_ID.test(value)) {
        throw new AgentV2StartInputError(`Agent v2 runId must be a canonical route-safe identifier of at most ${AGENT_V2_RUN_ID_MAX_LENGTH} characters`);
    }
    return value;
}
function requireStableModelIdentifier(value, label, maxLength) {
    const normalized = requireNonEmptyString(value, label);
    if (normalized.length > maxLength ||
        /[\u0000-\u001f\u007f\s]/u.test(normalized) ||
        /^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
        throw new AgentV2StartInputError(`${label} must be a stable server-side identifier`);
    }
    return normalized;
}
function sniffMedia(bytes) {
    if (hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10]))
        return { mediaType: "image/png", encoding: "binary" };
    if (hasPrefix(bytes, [0xff, 0xd8, 0xff]))
        return { mediaType: "image/jpeg", encoding: "binary" };
    if (bytes.byteLength >= 12 &&
        new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
        new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") {
        return { mediaType: "image/webp", encoding: "binary" };
    }
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        throw new AgentV2StartInputError("Agent v2 text project file must contain strict UTF-8 bytes");
    }
    return { mediaType: "text/plain", encoding: "utf8" };
}
function decodeStrictBase64(value) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw new AgentV2StartInputError("Agent v2 project file content is not strict base64");
    }
    return new Uint8Array(Buffer.from(value, "base64"));
}
function encodeStrictUtf8(value) {
    const bytes = new TextEncoder().encode(value);
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
        throw new AgentV2StartInputError("Agent v2 text project file must contain Unicode scalar values");
    }
    return bytes;
}
function checksumBytes(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function deterministicInputId(logicalPath, checksum) {
    return `input:${createHash("sha256").update(`${logicalPath}\0${checksum}`).digest("hex")}`;
}
function hasPrefix(bytes, prefix) {
    return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}
function assertIdentity(identity) {
    requireNonEmptyString(identity.clientId, "Agent v2 start identity clientId");
    normalizeAgentV2RunId(identity.runId);
    const epoch = Date.parse(identity.createdAt);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== identity.createdAt) {
        throw new AgentV2StartInputError("Agent v2 start identity createdAt must be a canonical UTC millisecond timestamp");
    }
}
function assertExactFields(value, allowed, label) {
    const extra = Object.keys(value).find((key) => !allowed.has(key));
    if (extra)
        throw new AgentV2StartInputError(`${label} contains unsupported field: ${extra}`);
}
function requireRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AgentV2StartInputError(`${label} must be an object`);
    }
    return value;
}
function optionalArray(value, label) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new AgentV2StartInputError(`${label} must be an array`);
    return value;
}
function requireString(value, label) {
    if (typeof value !== "string")
        throw new AgentV2StartInputError(`${label} must be a string`);
    return value;
}
function requireBoundedString(value, label, maxLength) {
    const text = requireString(value, label);
    if (text.length > maxLength)
        throw new AgentV2StartInputError(`${label} exceeds ${maxLength} characters`);
    return text;
}
function requireNonEmptyString(value, label) {
    const normalized = requireString(value, label).trim();
    if (!normalized)
        throw new AgentV2StartInputError(`${label} must be non-empty`);
    return normalized;
}
function requireRawNonEmptyString(value, label) {
    const raw = requireString(value, label);
    if (!raw.trim())
        throw new AgentV2StartInputError(`${label} must be non-empty`);
    return raw;
}
//# sourceMappingURL=agent-v2-start-input.js.map