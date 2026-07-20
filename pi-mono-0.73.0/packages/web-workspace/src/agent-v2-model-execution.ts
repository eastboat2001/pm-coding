import type { AgentV2ContextPacket } from "./agent-v2-context-packet.js";
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2ModelUsageSummary, AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";

export type { AgentV2ModelUsageSummary } from "./agent-v2-types.js";

const MAX_JSON_CODE_UNITS_PER_SCALAR = 12;
const MAX_JSON_STRUCTURAL_CODE_UNITS = 65_536;
const MAX_SUMMARY_CHARS = 4_096;
const MAX_FILES = 64;
const MAX_PATH_CHARS = 1_024;
const MAX_FILE_CONTENT_CHARS = 1_048_576;
const MAX_AGGREGATE_CONTENT_CHARS = 8_388_608;
const MAX_ID_CHARS = 256;
const MAX_ADDRESSED_DIAGNOSTIC_IDS = 64;
const MAX_SOURCE_CODE_UNITS =
	MAX_JSON_CODE_UNITS_PER_SCALAR *
		(MAX_AGGREGATE_CONTENT_CHARS +
			MAX_SUMMARY_CHARS +
			MAX_ID_CHARS +
			MAX_FILES * MAX_PATH_CHARS +
			MAX_ADDRESSED_DIAGNOSTIC_IDS * MAX_ID_CHARS) +
	MAX_JSON_STRUCTURAL_CODE_UNITS;

export const AGENT_V2_MODEL_RESULT_LIMITS = Object.freeze({
	maxSourceCodeUnits: MAX_SOURCE_CODE_UNITS,
	maxJsonCodeUnitsPerScalar: MAX_JSON_CODE_UNITS_PER_SCALAR,
	maxJsonStructuralCodeUnits: MAX_JSON_STRUCTURAL_CODE_UNITS,
	maxSummaryChars: MAX_SUMMARY_CHARS,
	maxFiles: MAX_FILES,
	maxPathChars: MAX_PATH_CHARS,
	maxFileContentChars: MAX_FILE_CONTENT_CHARS,
	maxAggregateContentChars: MAX_AGGREGATE_CONTENT_CHARS,
	maxIdChars: MAX_ID_CHARS,
	maxAddressedDiagnosticIds: MAX_ADDRESSED_DIAGNOSTIC_IDS,
} as const);

export const AGENT_V2_REPAIR_WORKSPACE_LIMITS = Object.freeze({
	maxFiles: 32,
	// These are context budgets, not source-file size limits. Larger source files
	// are represented by bounded excerpts and repaired through checksum-bound
	// patches instead of being rejected before the model is called.
	maxContextBytesPerFile: 65_536,
	maxTotalContextBytes: 96_000,
	maxPatches: 64,
} as const);

export type AgentV2ModelContractErrorCode =
	| "invalid_protocol"
	| "invalid_schema"
	| "invalid_identifier"
	| "invalid_unicode"
	| "unsafe_path"
	| "duplicate_path"
	| "limit_exceeded"
	| "repair_workspace_limit_exceeded"
	| "prompt_invalid"
	| "prompt_limit_exceeded";

const ERROR_MESSAGES: Readonly<Record<AgentV2ModelContractErrorCode, string>> = Object.freeze({
	invalid_protocol: "Agent v2 model response does not follow the required JSON protocol.",
	invalid_schema: "Agent v2 model response does not match the required result schema.",
	invalid_identifier: "Agent v2 model result contains an invalid identifier.",
	invalid_unicode: "Agent v2 model result contains invalid Unicode text.",
	unsafe_path: "Agent v2 model result contains an unsafe output path.",
	duplicate_path: "Agent v2 model result contains colliding output paths.",
	limit_exceeded: "Agent v2 model result exceeds a configured safety limit.",
	repair_workspace_limit_exceeded: "Agent v2 repair workspace exceeds a configured safety limit.",
	prompt_invalid: "Agent v2 model prompt input is invalid.",
	prompt_limit_exceeded: "Agent v2 model prompt exceeds a configured safety limit.",
});

export class AgentV2ModelContractError extends Error {
	readonly code: AgentV2ModelContractErrorCode;

	constructor(code: AgentV2ModelContractErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "AgentV2ModelContractError";
		this.code = code;
	}
}

export interface AgentV2GeneratedFile {
	path: string;
	content: string;
}

export interface AgentV2AuthorizedInputReference {
	kind: "attachment" | "project_file";
	inputId: string;
	logicalPath: string;
	mediaType: string;
	byteLength: number;
	checksum: string;
}

export interface AgentV2ImplementationResult {
	version: 1;
	taskId: string;
	summary: string;
	files: AgentV2GeneratedFile[];
}

export interface AgentV2RepairResult {
	version: 1;
	taskId: string;
	summary: string;
	files: AgentV2GeneratedFile[];
	patches?: AgentV2RepairPatch[];
	addressedDiagnosticIds: string[];
}

export interface AgentV2RepairPatch {
	path: string;
	expectedChecksum: string;
	oldText: string;
	newText: string;
}

export interface AgentV2ModelExecutionEnvelope<T> {
	result: T;
	provider: string;
	model: string;
	usage?: AgentV2ModelUsageSummary;
}

export type AgentV2MaterializedInput =
	| { kind: "text"; reference: AgentV2AuthorizedInputReference; text: string; checksum: string }
	| {
			kind: "image";
			reference: AgentV2AuthorizedInputReference;
			data: Uint8Array;
			mediaType: "image/png" | "image/jpeg" | "image/webp";
			checksum: string;
	  };

export interface AgentV2SkillInstructionContext {
	skills: Array<{ name: string; location: string; content: string }>;
	resources: Array<{ skillName: string; path: string; content: string; checksum: string }>;
}

export interface AgentV2ModelExecutionInput {
	run: AgentV2RunSnapshot;
	contextPacket: AgentV2ContextPacket;
	task: AgentV2TaskNode;
	inputs: readonly AgentV2MaterializedInput[];
	skillContext?: AgentV2SkillInstructionContext;
	signal: AbortSignal;
}

export interface AgentV2RepairWorkspaceFile {
	artifactId: string;
	path: string;
	mediaType: string;
	checksum: string;
	byteLength: number;
	content: string;
	contentMode?: "full" | "excerpt";
	contentByteLength?: number;
}

export interface AgentV2RepairModelExecutionInput extends AgentV2ModelExecutionInput {
	diagnostics: readonly AgentV2DiagnosticEvent[];
	workspaceFiles: readonly AgentV2RepairWorkspaceFile[];
}

export interface AgentV2ModelExecution {
	generateImplementation(
		input: AgentV2ModelExecutionInput,
	): Promise<AgentV2ModelExecutionEnvelope<AgentV2ImplementationResult>>;
	generateRepair(input: AgentV2RepairModelExecutionInput): Promise<AgentV2ModelExecutionEnvelope<AgentV2RepairResult>>;
}

const IMPLEMENTATION_FIELDS = new Set(["version", "taskId", "summary", "files"]);
const REPAIR_FIELDS = new Set(["version", "taskId", "summary", "files", "addressedDiagnosticIds"]);
const REPAIR_PATCH_FIELDS = new Set(["version", "taskId", "summary", "files", "patches", "addressedDiagnosticIds"]);
const FILE_FIELDS = new Set(["path", "content"]);
const PATCH_FIELDS = new Set(["path", "expectedChecksum", "oldText", "newText"]);
const BLOCKED_PATH_SEGMENTS = new Set([".git", ".pi", ".codex", ".superpowers", "node_modules", "agent-v2"]);
const INTERNAL_PROJECT_FILES = new Set([".pi-project.json", ".pi-project-files.json"]);
const INVALID_PATH_COMPONENT_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/u;
const STABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/u;

export function parseAgentV2ImplementationResult(text: string, expectedTaskId: string): AgentV2ImplementationResult {
	const taskId = requireStableIdentifier(expectedTaskId);
	const value = parseResponseObject(text);
	assertExactFields(value, IMPLEMENTATION_FIELDS);
	return parseCommonResult(value, taskId);
}

export function parseAgentV2RepairResult(text: string, expectedTaskId: string): AgentV2RepairResult {
	const taskId = requireStableIdentifier(expectedTaskId);
	const value = parseResponseObject(text);
	const hasPatches = Object.hasOwn(value, "patches");
	assertExactFields(value, hasPatches ? REPAIR_PATCH_FIELDS : REPAIR_FIELDS);
	const addressedDiagnosticIds = requireArray(value.addressedDiagnosticIds);
	if (
		addressedDiagnosticIds.length === 0 ||
		addressedDiagnosticIds.length > AGENT_V2_MODEL_RESULT_LIMITS.maxAddressedDiagnosticIds
	) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	const common = parseCommonResult(value, taskId, true);
	const patches = hasPatches ? parseRepairPatches(value.patches) : [];
	if (common.files.length === 0 && patches.length === 0) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	const changedPathKeys = new Set(common.files.map((file) => file.path.toLocaleLowerCase("en-US")));
	for (const patch of patches) {
		const key = patch.path.toLocaleLowerCase("en-US");
		if (changedPathKeys.has(key)) throw new AgentV2ModelContractError("duplicate_path");
		changedPathKeys.add(key);
	}
	const seen = new Set<string>();
	const parsedIds = addressedDiagnosticIds.map((candidate) => {
		const diagnosticId = requireStableIdentifier(candidate);
		if (seen.has(diagnosticId)) throw new AgentV2ModelContractError("invalid_identifier");
		seen.add(diagnosticId);
		return diagnosticId;
	});
	return { ...common, ...(hasPatches ? { patches } : {}), addressedDiagnosticIds: parsedIds };
}

function parseRepairPatches(value: unknown): AgentV2RepairPatch[] {
	const rawPatches = requireArray(value);
	if (rawPatches.length > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxPatches) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	return rawPatches.map((candidate) => {
		const patch = requireRecord(candidate);
		assertExactFields(patch, PATCH_FIELDS);
		const path = normalizeGeneratedPath(patch.path);
		const expectedChecksum = inspectBoundedScalarText(patch.expectedChecksum, 80, "invalid_identifier").text;
		if (!/^sha256:[a-f0-9]{64}$/u.test(expectedChecksum)) {
			throw new AgentV2ModelContractError("invalid_identifier");
		}
		const oldText = inspectBoundedScalarText(
			patch.oldText,
			AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxContextBytesPerFile,
			"limit_exceeded",
		).text;
		if (oldText.length === 0) throw new AgentV2ModelContractError("invalid_schema");
		const newText = inspectBoundedScalarText(
			patch.newText,
			AGENT_V2_MODEL_RESULT_LIMITS.maxFileContentChars,
			"limit_exceeded",
		).text;
		return { path, expectedChecksum, oldText, newText };
	});
}

function parseResponseObject(text: string): Record<string, unknown> {
	if (typeof text !== "string" || text.length > AGENT_V2_MODEL_RESULT_LIMITS.maxSourceCodeUnits) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	const trimmed = text.trim();
	if (!trimmed) throw new AgentV2ModelContractError("invalid_protocol");
	for (const jsonSource of responseJsonCandidates(trimmed)) {
		try {
			const parsed: unknown = JSON.parse(jsonSource);
			if (isRecord(parsed) && Object.getPrototypeOf(parsed) === Object.prototype) return parsed;
		} catch {
			// Continue to the next safely bounded object candidate.
		}
	}
	throw new AgentV2ModelContractError("invalid_protocol");
}

function responseJsonCandidates(source: string): string[] {
	const candidates = [source];
	const fenced = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(source);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const object = singleBalancedJsonObjectCandidate(source);
	if (object && !candidates.includes(object)) candidates.push(object);
	return candidates;
}

function singleBalancedJsonObjectCandidate(source: string): string | undefined {
	let start = -1;
	let candidateStart = -1;
	let candidateEnd = -1;
	let candidateCount = 0;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (character !== "}" || depth === 0) continue;
		depth -= 1;
		if (depth === 0 && start >= 0) {
			candidateCount += 1;
			if (candidateCount > 1) return undefined;
			candidateStart = start;
			candidateEnd = index + 1;
			start = -1;
		}
	}
	return candidateCount === 1 ? source.slice(candidateStart, candidateEnd) : undefined;
}

function parseCommonResult(
	value: Record<string, unknown>,
	expectedTaskId: string,
	allowEmptyFiles = false,
): AgentV2ImplementationResult {
	if (value.version !== 1 || value.taskId !== expectedTaskId) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	const summary = inspectBoundedScalarText(
		value.summary,
		AGENT_V2_MODEL_RESULT_LIMITS.maxSummaryChars,
		"limit_exceeded",
	);
	if (!summary.hasNonWhitespace) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	const rawFiles = requireArray(value.files);
	if ((!allowEmptyFiles && rawFiles.length === 0) || rawFiles.length > AGENT_V2_MODEL_RESULT_LIMITS.maxFiles) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	let aggregateChars = 0;
	const collisionKeys = new Set<string>();
	const files = rawFiles.map((candidate): AgentV2GeneratedFile => {
		const file = requireRecord(candidate);
		assertExactFields(file, FILE_FIELDS);
		const path = normalizeGeneratedPath(file.path);
		const collisionKey = path.toLocaleLowerCase("en-US");
		if (collisionKeys.has(collisionKey)) throw new AgentV2ModelContractError("duplicate_path");
		collisionKeys.add(collisionKey);
		const remainingAggregate = AGENT_V2_MODEL_RESULT_LIMITS.maxAggregateContentChars - aggregateChars;
		const content = inspectBoundedScalarText(
			file.content,
			Math.min(AGENT_V2_MODEL_RESULT_LIMITS.maxFileContentChars, remainingAggregate),
			"limit_exceeded",
		);
		aggregateChars += content.length;
		return { path, content: content.text };
	});
	return { version: 1, taskId: expectedTaskId, summary: summary.text, files };
}

function normalizeGeneratedPath(value: unknown): string {
	if (typeof value !== "string") throw new AgentV2ModelContractError("invalid_schema");
	if (value.length > AGENT_V2_MODEL_RESULT_LIMITS.maxPathChars * 2) {
		throw new AgentV2ModelContractError("unsafe_path");
	}
	const raw = inspectBoundedScalarText(value, AGENT_V2_MODEL_RESULT_LIMITS.maxPathChars, "unsafe_path");
	const canonical = inspectBoundedScalarText(
		raw.text.normalize("NFC"),
		AGENT_V2_MODEL_RESULT_LIMITS.maxPathChars,
		"unsafe_path",
	).text;
	if (/^(?:[A-Za-z]:|[\\/]{2}|[\\/])/u.test(canonical) || canonical.includes("%")) {
		throw new AgentV2ModelContractError("unsafe_path");
	}
	const components = canonical.replaceAll("\\", "/").split("/");
	for (const component of components) {
		const lower = component.toLocaleLowerCase("en-US");
		const windowsStem =
			component
				.replace(/[ .]+$/gu, "")
				.split(".", 1)[0]
				?.replace(/[ .]+$/gu, "")
				.toLocaleUpperCase("en-US") ?? "";
		if (
			component === "" ||
			component === "." ||
			component === ".." ||
			component.trim() !== component ||
			component.endsWith(".") ||
			INVALID_PATH_COMPONENT_CHARACTERS.test(component) ||
			BLOCKED_PATH_SEGMENTS.has(lower) ||
			INTERNAL_PROJECT_FILES.has(lower) ||
			(lower.startsWith(".pi-project") && lower.endsWith(".json")) ||
			lower === ".env" ||
			lower.startsWith(".env.") ||
			windowsStem === "CON" ||
			windowsStem === "PRN" ||
			windowsStem === "AUX" ||
			windowsStem === "NUL" ||
			/^COM[1-9]$/u.test(windowsStem) ||
			/^LPT[1-9]$/u.test(windowsStem)
		) {
			throw new AgentV2ModelContractError("unsafe_path");
		}
	}
	return components.join("/");
}

function requireStableIdentifier(value: unknown): string {
	const identifier = inspectBoundedScalarText(value, AGENT_V2_MODEL_RESULT_LIMITS.maxIdChars, "invalid_identifier");
	if (identifier.length === 0 || !STABLE_IDENTIFIER.test(identifier.text)) {
		throw new AgentV2ModelContractError("invalid_identifier");
	}
	return identifier.text;
}

function assertExactFields(value: Record<string, unknown>, expected: ReadonlySet<string>): void {
	const keys = Object.keys(value);
	if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new AgentV2ModelContractError("invalid_schema");
	return value;
}

function inspectBoundedScalarText(
	value: unknown,
	maxChars: number,
	limitCode: AgentV2ModelContractErrorCode,
): { text: string; length: number; hasNonWhitespace: boolean } {
	if (typeof value !== "string") throw new AgentV2ModelContractError("invalid_schema");
	let length = 0;
	let hasNonWhitespace = false;
	for (const scalar of value) {
		const first = scalar.charCodeAt(0);
		if (scalar.length === 1 && first >= 0xd800 && first <= 0xdfff) {
			throw new AgentV2ModelContractError("invalid_unicode");
		}
		length += 1;
		if (length > maxChars) throw new AgentV2ModelContractError(limitCode);
		if (!isEcmaWhitespace(scalar.codePointAt(0) ?? 0)) hasNonWhitespace = true;
	}
	return { text: value, length, hasNonWhitespace };
}

function isEcmaWhitespace(codePoint: number): boolean {
	return (
		(codePoint >= 0x0009 && codePoint <= 0x000d) ||
		codePoint === 0x0020 ||
		codePoint === 0x00a0 ||
		codePoint === 0x1680 ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000 ||
		codePoint === 0xfeff
	);
}
