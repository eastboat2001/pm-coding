import { createHash } from "node:crypto";
import type { AgentV2InputBlobRecord, AgentV2InputReferenceRecord } from "./agent-v2-durable-store.js";
import type { AgentV2RunInput } from "./agent-v2-types.js";

export interface AgentV2ModelReference {
	provider: string;
	id: string;
}

export interface AgentV2InputLimits {
	maxEntries: 64;
	maxTextBytes: 1_048_576;
	maxImageBytes: 2_097_152;
	maxTotalBytes: 8_388_608;
}

export const AGENT_V2_INPUT_LIMITS: AgentV2InputLimits = {
	maxEntries: 64,
	maxTextBytes: 1_048_576,
	maxImageBytes: 2_097_152,
	maxTotalBytes: 8_388_608,
};

export const AGENT_V2_RUN_ID_MAX_LENGTH = 128;

export interface AgentV2NormalizedStartInput {
	runInput: AgentV2RunInput;
	model: AgentV2ModelReference;
	inputBlobs: readonly AgentV2InputBlobRecord[];
	inputReferences: readonly AgentV2InputReferenceRecord[];
}

type AgentV2UnboundInputBlobRecord = Omit<AgentV2InputBlobRecord, "clientId" | "runId" | "createdAt">;
type AgentV2UnboundInputReferenceRecord = Omit<AgentV2InputReferenceRecord, "clientId" | "runId">;

export interface AgentV2NormalizedStartPayload {
	runId: string;
	sessionId: string;
	title: string;
	objective: string;
	model: AgentV2ModelReference;
	inputBlobs: readonly AgentV2UnboundInputBlobRecord[];
	inputReferences: readonly AgentV2UnboundInputReferenceRecord[];
}

export class AgentV2StartInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentV2StartInputError";
	}
}

type NormalizedProjectFile = {
	logicalPath: string;
	bytes: Uint8Array;
	mediaType: string;
	encoding: "utf8" | "binary";
	checksum: string;
	inputId: string;
};

const REQUEST_FIELDS = new Set(["input", "model", "runId"]);
const INPUT_FIELDS = new Set(["sessionId", "title", "objective", "projectFiles", "attachments"]);
const PROJECT_FILE_FIELDS = new Set(["filename", "content", "encoding"]);
const ATTACHMENT_FIELDS = new Set(["type", "fileName", "mimeType", "projectFilePath"]);
const MODEL_FIELDS = new Set(["provider", "id"]);
const BLOCKED_PATH_SEGMENTS = new Set([".git", ".pi", ".codex", ".superpowers", "node_modules", "agent-v2"]);
const INTERNAL_PROJECT_FILES = new Set([".pi-project.json", ".pi-project-files.json"]);
const INVALID_PATH_COMPONENT_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/u;
const ROUTE_SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

export function normalizeAgentV2StartInput(
	value: unknown,
	identity: { clientId: string; runId: string; createdAt: string },
): AgentV2NormalizedStartInput {
	return bindAgentV2StartPayload(normalizeAgentV2StartPayload(value, identity.runId), identity);
}

export function normalizeAgentV2StartPayload(value: unknown, runId: string): AgentV2NormalizedStartPayload {
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
	const model = normalizeModel(request.model);
	const projectFiles = optionalArray(input.projectFiles, "Agent v2 projectFiles");
	const attachments = optionalArray(input.attachments, "Agent v2 attachments");
	if (projectFiles.length + attachments.length > AGENT_V2_INPUT_LIMITS.maxEntries) {
		throw new AgentV2StartInputError(`Agent v2 start input entries exceed ${AGENT_V2_INPUT_LIMITS.maxEntries}`);
	}

	const filesByCollisionKey = new Map<string, NormalizedProjectFile>();
	const orderedFiles: NormalizedProjectFile[] = [];
	let totalBytes = 0;
	for (const candidate of projectFiles) {
		const entry = requireRecord(candidate, "Agent v2 project file");
		assertExactFields(entry, PROJECT_FILE_FIELDS, "Agent v2 project file");
		const logicalPath = normalizeLogicalPath(
			requireRawNonEmptyString(entry.filename, "Agent v2 project file filename"),
		);
		const content = requireString(entry.content, "Agent v2 project file content");
		if (entry.encoding !== undefined && entry.encoding !== "base64") {
			throw new AgentV2StartInputError("Agent v2 project file encoding must be base64 when provided");
		}
		const bytes = entry.encoding === "base64" ? decodeStrictBase64(content) : encodeStrictUtf8(content);
		const media = sniffMedia(bytes);
		const byteLimit =
			media.encoding === "binary" ? AGENT_V2_INPUT_LIMITS.maxImageBytes : AGENT_V2_INPUT_LIMITS.maxTextBytes;
		if (bytes.byteLength > byteLimit) {
			throw new AgentV2StartInputError(
				`Agent v2 ${media.encoding === "binary" ? "image" : "text"} bytes exceed ${byteLimit}`,
			);
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
		const file: NormalizedProjectFile = {
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
			throw new AgentV2StartInputError(
				`Agent v2 start input total bytes exceed ${AGENT_V2_INPUT_LIMITS.maxTotalBytes}`,
			);
		}
	}

	const inputBlobs: AgentV2UnboundInputBlobRecord[] = orderedFiles.map((file) => ({
		inputId: file.inputId,
		logicalPath: file.logicalPath,
		mediaType: file.mediaType,
		encoding: file.encoding,
		bytes: new Uint8Array(file.bytes),
		byteLength: file.bytes.byteLength,
		checksum: file.checksum,
	}));
	const inputReferences: AgentV2UnboundInputReferenceRecord[] = orderedFiles.map((file, ordinal) => ({
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
		const logicalPath = normalizeLogicalPath(
			requireRawNonEmptyString(descriptor.projectFilePath, "Agent v2 attachment projectFilePath"),
		);
		const file = filesByCollisionKey.get(logicalPath.toLocaleLowerCase("en-US"));
		if (!file || file.logicalPath !== logicalPath) {
			throw new AgentV2StartInputError(`Agent v2 attachment must match a normalized project file: ${logicalPath}`);
		}
		if (type === "image" && file.encoding !== "binary") {
			throw new AgentV2StartInputError(
				"Agent v2 image attachment must reference a sniffed PNG, JPEG, or WebP image",
			);
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
		model,
		inputBlobs,
		inputReferences,
	};
}

export function bindAgentV2StartPayload(
	payload: AgentV2NormalizedStartPayload,
	identity: { clientId: string; runId: string; createdAt: string },
): AgentV2NormalizedStartInput {
	assertIdentity(identity);
	if (payload.runId !== identity.runId) {
		throw new AgentV2StartInputError("Agent v2 normalized start payload runId does not match the canonical identity");
	}
	const inputBlobs: AgentV2InputBlobRecord[] = payload.inputBlobs.map((blob) => ({
		...blob,
		clientId: identity.clientId,
		runId: identity.runId,
		bytes: new Uint8Array(blob.bytes),
		createdAt: identity.createdAt,
	}));
	const inputReferences: AgentV2InputReferenceRecord[] = payload.inputReferences.map((reference) => ({
		...reference,
		clientId: identity.clientId,
		runId: identity.runId,
	}));
	return {
		runInput: {
			sessionId: payload.sessionId,
			title: payload.title,
			objective: payload.objective,
			inputReferences: inputReferences.map((reference) => ({ ...reference })),
		},
		model: { ...payload.model },
		inputBlobs,
		inputReferences,
	};
}

function normalizeModel(value: unknown): AgentV2ModelReference {
	const model = requireRecord(value, "Agent v2 model reference");
	assertExactFields(model, MODEL_FIELDS, "Agent v2 model reference");
	return {
		provider: requireStableModelIdentifier(model.provider, "Agent v2 model provider", 128),
		id: requireStableModelIdentifier(model.id, "Agent v2 model id", 256),
	};
}

function normalizeLogicalPath(value: string): string {
	const canonicalValue = value.normalize("NFC");
	if (
		/^(?:[a-zA-Z]:|[\\/]{2}|[\\/])/u.test(canonicalValue) ||
		/[\u0000-\u001f\u007f]/u.test(canonicalValue) ||
		canonicalValue.includes("%")
	) {
		throw new AgentV2StartInputError(`Agent v2 logical path must be relative: ${value}`);
	}
	const segments = canonicalValue.replaceAll("\\", "/").split("/");
	if (segments.length === 0) throw new AgentV2StartInputError("Agent v2 logical path is empty");
	for (const segment of segments) {
		const lower = segment.toLocaleLowerCase("en-US");
		const windowsStem =
			segment
				.replace(/[ .]+$/gu, "")
				.split(".", 1)[0]
				?.replace(/[ .]+$/gu, "")
				.toLocaleUpperCase("en-US") ?? "";
		if (
			segment === "" ||
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
			lower.startsWith(".env.")
		) {
			throw new AgentV2StartInputError(`Agent v2 logical path contains a blocked path segment: ${value}`);
		}
	}
	return segments.join("/");
}

export function normalizeAgentV2RunId(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > AGENT_V2_RUN_ID_MAX_LENGTH ||
		value === "." ||
		value === ".." ||
		!ROUTE_SAFE_RUN_ID.test(value)
	) {
		throw new AgentV2StartInputError(
			`Agent v2 runId must be a canonical route-safe identifier of at most ${AGENT_V2_RUN_ID_MAX_LENGTH} characters`,
		);
	}
	return value;
}

function requireStableModelIdentifier(value: unknown, label: string, maxLength: number): string {
	const normalized = requireNonEmptyString(value, label);
	if (
		normalized.length > maxLength ||
		/[\u0000-\u001f\u007f\s]/u.test(normalized) ||
		/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
	) {
		throw new AgentV2StartInputError(`${label} must be a stable server-side identifier`);
	}
	return normalized;
}

function sniffMedia(bytes: Uint8Array): { mediaType: string; encoding: "utf8" | "binary" } {
	if (hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return { mediaType: "image/png", encoding: "binary" };
	if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg", encoding: "binary" };
	if (
		bytes.byteLength >= 12 &&
		new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
	) {
		return { mediaType: "image/webp", encoding: "binary" };
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new AgentV2StartInputError("Agent v2 text project file must contain strict UTF-8 bytes");
	}
	return { mediaType: "text/plain", encoding: "utf8" };
}

function decodeStrictBase64(value: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
		throw new AgentV2StartInputError("Agent v2 project file content is not strict base64");
	}
	return new Uint8Array(Buffer.from(value, "base64"));
}

function encodeStrictUtf8(value: string): Uint8Array {
	const bytes = new TextEncoder().encode(value);
	if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
		throw new AgentV2StartInputError("Agent v2 text project file must contain Unicode scalar values");
	}
	return bytes;
}

function checksumBytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deterministicInputId(logicalPath: string, checksum: string): string {
	return `input:${createHash("sha256").update(`${logicalPath}\0${checksum}`).digest("hex")}`;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function assertIdentity(identity: { clientId: string; runId: string; createdAt: string }): void {
	requireNonEmptyString(identity.clientId, "Agent v2 start identity clientId");
	normalizeAgentV2RunId(identity.runId);
	const epoch = Date.parse(identity.createdAt);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== identity.createdAt) {
		throw new AgentV2StartInputError(
			"Agent v2 start identity createdAt must be a canonical UTC millisecond timestamp",
		);
	}
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	const extra = Object.keys(value).find((key) => !allowed.has(key));
	if (extra) throw new AgentV2StartInputError(`${label} contains unsupported field: ${extra}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentV2StartInputError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function optionalArray(value: unknown, label: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new AgentV2StartInputError(`${label} must be an array`);
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new AgentV2StartInputError(`${label} must be a string`);
	return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
	const normalized = requireString(value, label).trim();
	if (!normalized) throw new AgentV2StartInputError(`${label} must be non-empty`);
	return normalized;
}

function requireRawNonEmptyString(value: unknown, label: string): string {
	const raw = requireString(value, label);
	if (!raw.trim()) throw new AgentV2StartInputError(`${label} must be non-empty`);
	return raw;
}
