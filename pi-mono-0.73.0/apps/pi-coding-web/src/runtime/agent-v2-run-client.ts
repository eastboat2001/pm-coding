import type { AgentV2RunEventRecord, AgentV2RunSnapshot } from "@mariozechner/pi-web-workspace";
import { piClientHeaders } from "./client-id.js";

export const AGENT_V2_RUNS_API_PREFIX = "/api/agent-v2/runs";

const FAST_POLL_INTERVAL_MS = 150;
const MAX_POLL_INTERVAL_MS = 1000;
const IDLE_POLL_BACKOFF_MS = 150;
const RUN_EVENT_STREAM_RECONNECT_MS = 1000;

export interface AgentV2BrowserProjectFile {
	filename: string;
	content: string;
	encoding?: "base64";
}

export interface AgentV2BrowserStartRunRequest {
	sessionId: string;
	title: string;
	objective: string;
	conversationSnapshot?: AgentV2BrowserConversationSnapshot;
	selectedSkillNames?: string[];
	attachments?: unknown[];
	projectFiles?: AgentV2BrowserProjectFile[];
	model: unknown;
}

export interface AgentV2BrowserConversationSnapshot {
	compactedSummary: string;
	recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
	currentObjective: string;
}

type AgentV2BrowserAttachmentDescriptor = {
	type: string;
	fileName: string;
	mimeType: string;
	projectFilePath: string;
};

type AgentV2BrowserModelReference = { provider: string; id: string };

export interface AgentV2RunEventConnection {
	readonly CLOSED: 2;
	readonly CONNECTING: 0;
	readonly OPEN: 1;
	closed: boolean;
	lastError?: Error;
	lastSeq: number;
	pollIntervalMs: number;
	readyState: 0 | 1 | 2;
	close(): void;
}

export interface AgentV2RunEventConnectionOptions {
	onStatusChange?: (connection: AgentV2RunEventConnection) => void;
}

export async function startAgentV2Run(request: AgentV2BrowserStartRunRequest): Promise<AgentV2RunSnapshot> {
	const model = requireStableModelReference(request.model);
	const projectFiles = validateProjectFiles(request.projectFiles ?? []);
	const attachments = validateAttachmentDescriptors(request.attachments ?? [], projectFiles);
	const objective = requireNonEmptyString(request.objective, "objective");
	const conversationSnapshot = validateConversationSnapshot(request.conversationSnapshot, objective);
	const selectedSkillNames = validateSelectedSkillNames(request.selectedSkillNames ?? []);
	const input = {
		sessionId: requireNonEmptyString(request.sessionId, "sessionId"),
		title: requireNonEmptyString(request.title, "title"),
		objective,
		...(conversationSnapshot ? { conversationSnapshot } : {}),
		...(selectedSkillNames.length > 0 ? { selectedSkillNames } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
		...(projectFiles.length > 0 ? { projectFiles } : {}),
	};
	return requestAgentV2RunApi<AgentV2RunSnapshot>(`${AGENT_V2_RUNS_API_PREFIX}/start`, {
		method: "POST",
		body: JSON.stringify({ input, model }),
	});
}

function validateSelectedSkillNames(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 16) throw new Error("Agent v2 selected skill names are invalid.");
	const names: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(candidate)) {
			throw new Error("Agent v2 selected skill name is invalid.");
		}
		if (seen.has(candidate)) throw new Error("Agent v2 selected skill names must be unique.");
		seen.add(candidate);
		names.push(candidate);
	}
	return names;
}

function validateConversationSnapshot(
	value: unknown,
	objective: string,
): AgentV2BrowserConversationSnapshot | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("Agent v2 conversation snapshot must be an object.");
	const keys = Object.keys(value).sort();
	if (
		keys.length !== 3 ||
		keys[0] !== "compactedSummary" ||
		keys[1] !== "currentObjective" ||
		keys[2] !== "recentMessages"
	) {
		throw new Error("Agent v2 conversation snapshot contains unsupported fields.");
	}
	if (typeof value.compactedSummary !== "string" || value.compactedSummary.length > 32_768) {
		throw new Error("Agent v2 conversation snapshot compactedSummary is invalid.");
	}
	if (value.currentObjective !== objective) {
		throw new Error("Agent v2 conversation snapshot currentObjective must match objective.");
	}
	if (!Array.isArray(value.recentMessages) || value.recentMessages.length > 64) {
		throw new Error("Agent v2 conversation snapshot recentMessages is invalid.");
	}
	const recentMessages = value.recentMessages.map((candidate) => {
		if (!isRecord(candidate)) throw new Error("Agent v2 conversation snapshot message must be an object.");
		const messageKeys = Object.keys(candidate).sort();
		if (messageKeys.length !== 2 || messageKeys[0] !== "content" || messageKeys[1] !== "role") {
			throw new Error("Agent v2 conversation snapshot message contains unsupported fields.");
		}
		if (candidate.role !== "user" && candidate.role !== "assistant") {
			throw new Error("Agent v2 conversation snapshot message role is invalid.");
		}
		const role: "user" | "assistant" = candidate.role;
		if (typeof candidate.content !== "string" || !candidate.content.trim() || candidate.content.length > 8_192) {
			throw new Error("Agent v2 conversation snapshot message content is invalid.");
		}
		return { role, content: candidate.content };
	});
	const snapshot = {
		compactedSummary: value.compactedSummary,
		recentMessages,
		currentObjective: objective,
	};
	if (JSON.stringify(snapshot).length > 60_000) {
		throw new Error("Agent v2 conversation snapshot exceeds the maximum size.");
	}
	return snapshot;
}

function requireStableModelReference(value: unknown): AgentV2BrowserModelReference {
	if (!isRecord(value)) throw new Error("Agent v2 model must contain only provider and id.");
	const keys = Object.keys(value).sort();
	if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "provider") {
		throw new Error("Agent v2 model must contain only provider and id.");
	}
	return {
		provider: requireNonEmptyString(value.provider, "model.provider"),
		id: requireNonEmptyString(value.id, "model.id"),
	};
}

function validateProjectFiles(files: readonly AgentV2BrowserProjectFile[]): AgentV2BrowserProjectFile[] {
	const validated: AgentV2BrowserProjectFile[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		if (!isRecord(file)) throw new Error("Agent v2 project file must be an object.");
		const keys = Object.keys(file);
		if (keys.some((key) => key !== "filename" && key !== "content" && key !== "encoding")) {
			throw new Error("Agent v2 project file contains unsupported fields.");
		}
		const filename = requireNonEmptyString(file.filename, "project file filename");
		if (seen.has(filename.toLowerCase())) throw new Error("Agent v2 project file paths must be unique.");
		seen.add(filename.toLowerCase());
		if (typeof file.content !== "string") throw new Error("Agent v2 project file content must be a string.");
		if (file.encoding !== undefined && file.encoding !== "base64") {
			throw new Error("Agent v2 project file encoding is invalid.");
		}
		validated.push({
			filename,
			content: file.content,
			...(file.encoding === "base64" ? { encoding: "base64" } : {}),
		});
	}
	return validated;
}

function validateAttachmentDescriptors(
	attachments: readonly unknown[],
	projectFiles: readonly AgentV2BrowserProjectFile[],
): AgentV2BrowserAttachmentDescriptor[] {
	const filesByPath = new Map(projectFiles.map((file) => [file.filename, file]));
	const caseFoldedPaths = new Map(projectFiles.map((file) => [file.filename.toLowerCase(), file.filename]));
	return attachments.map((attachment) => {
		if (!isRecord(attachment)) throw new Error("Agent v2 attachment must be an object.");
		const rawType = requireNonEmptyString(attachment.type, "attachment type");
		const type = rawType === "document" || rawType === "file" ? "file" : rawType === "image" ? "image" : undefined;
		if (!type) throw new Error("Agent v2 attachment type must be file or image.");
		const descriptor = {
			type,
			fileName: requireNonEmptyString(attachment.fileName, "attachment fileName"),
			mimeType: requireNonEmptyString(attachment.mimeType, "attachment mimeType"),
			projectFilePath: requireNonEmptyString(attachment.projectFilePath, "attachment projectFilePath"),
		};
		const projectFile = filesByPath.get(descriptor.projectFilePath);
		if (!projectFile) {
			const caseMismatch = caseFoldedPaths.has(descriptor.projectFilePath.toLowerCase());
			throw new Error(
				caseMismatch
					? "Agent v2 attachment path casing must exactly match its project file."
					: "Agent v2 attachment must reference a canonical project file.",
			);
		}
		if (typeof attachment.extractedText === "string" && attachment.extractedText !== projectFile.content) {
			throw new Error("Agent v2 attachment content conflicts with its project file.");
		}
		if (
			type === "image" &&
			typeof attachment.content === "string" &&
			(attachment.content !== projectFile.content || projectFile.encoding !== "base64")
		) {
			throw new Error("Agent v2 attachment content conflicts with its project file.");
		}
		return descriptor;
	});
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Agent v2 ${field} must be a non-empty string.`);
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getAgentV2Run(runId: string): Promise<AgentV2RunSnapshot | undefined> {
	try {
		return await requestAgentV2RunApi<AgentV2RunSnapshot>(
			`${AGENT_V2_RUNS_API_PREFIX}/${encodeURIComponent(runId)}`,
			{
				method: "GET",
			},
		);
	} catch (error) {
		if (error instanceof Error && error.message === "Agent v2 run not found.") {
			return undefined;
		}
		throw error;
	}
}

export async function cancelAgentV2Run(runId: string): Promise<AgentV2RunSnapshot> {
	return requestAgentV2RunApi<AgentV2RunSnapshot>(`${AGENT_V2_RUNS_API_PREFIX}/${encodeURIComponent(runId)}/cancel`, {
		method: "POST",
	});
}

export async function listAgentV2RunEvents(runId: string, afterSeq = 0): Promise<AgentV2RunEventRecord[]> {
	const result = await requestAgentV2RunApi<{ events: AgentV2RunEventRecord[] }>(
		`${AGENT_V2_RUNS_API_PREFIX}/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
		{ method: "GET" },
	);
	return result.events;
}

export function connectAgentV2RunEvents(
	runId: string,
	afterSeq: number,
	onEvent: (event: AgentV2RunEventRecord) => void | Promise<void>,
	options: AgentV2RunEventConnectionOptions = {},
): AgentV2RunEventConnection {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	const connection: AgentV2RunEventConnection = {
		CLOSED: 2,
		CONNECTING: 0,
		OPEN: 1,
		closed: false,
		lastSeq: afterSeq,
		pollIntervalMs: FAST_POLL_INTERVAL_MS,
		readyState: 0,
		close() {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			abortController?.abort();
			connection.closed = true;
			connection.readyState = connection.CLOSED;
			notifyStatusChange();
		},
	};

	const notifyStatusChange = (): void => {
		options.onStatusChange?.(connection);
	};

	const connectStream = async (): Promise<void> => {
		if (connection.closed) return;
		abortController = new AbortController();
		connection.readyState = connection.CONNECTING;
		notifyStatusChange();
		let fallbackToPolling = false;
		try {
			const endpoint = new URL(
				`${AGENT_V2_RUNS_API_PREFIX}/${encodeURIComponent(runId)}/events?afterSeq=${connection.lastSeq}&stream=1`,
				window.location.origin,
			).toString();
			const response = await fetch(endpoint, {
				method: "GET",
				headers: buildAgentV2RunRequestHeaders({
					Accept: "text/event-stream",
					"Last-Event-ID": String(connection.lastSeq),
				}),
				signal: abortController.signal,
			});
			if (!response.ok) {
				throw new Error(`Agent v2 event stream failed with HTTP ${response.status}`);
			}
			if (!isEventStreamResponse(response)) {
				const result = (await response.json()) as { events: AgentV2RunEventRecord[] };
				if (connection.closed) return;
				connection.readyState = connection.OPEN;
				connection.lastError = undefined;
				notifyStatusChange();
				await deliverRunEvents(result.events);
				fallbackToPolling = true;
				return;
			}
			if (!response.body) {
				throw new Error("Agent v2 event stream response did not include a body.");
			}
			if (connection.closed) return;
			connection.readyState = connection.OPEN;
			connection.lastError = undefined;
			notifyStatusChange();
			await readEventStream(response.body, deliverRunEvent);
		} catch (error) {
			if (connection.closed) return;
			connection.lastError = toError(error);
			connection.readyState = connection.CONNECTING;
			notifyStatusChange();
		} finally {
			abortController = undefined;
			if (!connection.closed) {
				timeoutId = setTimeout(
					() => {
						if (fallbackToPolling) {
							void poll();
						} else {
							void connectStream();
						}
					},
					fallbackToPolling ? connection.pollIntervalMs : RUN_EVENT_STREAM_RECONNECT_MS,
				);
			}
		}
	};

	const deliverRunEvent = async (event: AgentV2RunEventRecord): Promise<void> => {
		if (connection.closed) return;
		if (event.seq <= connection.lastSeq) return;
		if (event.seq !== connection.lastSeq + 1) {
			throw new Error(`Agent v2 event sequence gap: expected ${connection.lastSeq + 1}, received ${event.seq}.`);
		}
		await onEvent(event);
		connection.lastSeq = event.seq;
	};

	const deliverRunEvents = async (events: AgentV2RunEventRecord[]): Promise<void> => {
		for (const event of events) {
			await deliverRunEvent(event);
			if (connection.closed) return;
		}
	};

	const poll = async (): Promise<void> => {
		if (connection.closed) return;
		try {
			const events = await listAgentV2RunEvents(runId, connection.lastSeq);
			if (connection.closed) return;
			connection.readyState = connection.OPEN;
			connection.lastError = undefined;
			notifyStatusChange();
			connection.pollIntervalMs =
				events.length > 0
					? FAST_POLL_INTERVAL_MS
					: Math.min(connection.pollIntervalMs + IDLE_POLL_BACKOFF_MS, MAX_POLL_INTERVAL_MS);
			await deliverRunEvents(events);
		} catch (error) {
			connection.lastError = toError(error);
			connection.pollIntervalMs = MAX_POLL_INTERVAL_MS;
			if (!connection.closed) {
				connection.readyState = connection.CONNECTING;
				notifyStatusChange();
			}
		} finally {
			if (!connection.closed) {
				timeoutId = setTimeout(() => {
					void poll();
				}, connection.pollIntervalMs);
			}
		}
	};

	if (typeof globalThis.ReadableStream !== "undefined") {
		void connectStream();
	} else {
		void poll();
	}
	return connection;
}

function buildAgentV2RunRequestHeaders(initHeaders?: HeadersInit, hasBody = false): Record<string, string> {
	const headers = Object.fromEntries(new Headers(initHeaders).entries());
	headers["X-PI-Client-ID"] = piClientHeaders()["X-PI-Client-ID"];
	if (hasBody && !hasHeader(headers, "content-type")) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

function isEventStreamResponse(response: Response): boolean {
	return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

async function readEventStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: AgentV2RunEventRecord) => void | Promise<void>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = findServerSentEventBoundary(buffer);
			while (boundary) {
				const rawEvent = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				await deliverServerSentEvent(rawEvent, onEvent);
				boundary = findServerSentEventBoundary(buffer);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) await deliverServerSentEvent(buffer, onEvent);
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function findServerSentEventBoundary(buffer: string): { index: number; length: number } | undefined {
	const lfIndex = buffer.indexOf("\n\n");
	const crlfIndex = buffer.indexOf("\r\n\r\n");
	if (lfIndex < 0) {
		return crlfIndex < 0 ? undefined : { index: crlfIndex, length: 4 };
	}
	if (crlfIndex < 0 || lfIndex < crlfIndex) {
		return { index: lfIndex, length: 2 };
	}
	return { index: crlfIndex, length: 4 };
}

async function deliverServerSentEvent(
	rawEvent: string,
	onEvent: (event: AgentV2RunEventRecord) => void | Promise<void>,
): Promise<void> {
	let eventType = "message";
	let eventId: string | undefined;
	const dataLines: string[] = [];
	for (const line of rawEvent.split(/\r?\n/)) {
		if (!line || line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			eventType = line.slice("event:".length).trimStart() || "message";
			continue;
		}
		if (line.startsWith("id:")) {
			eventId = line.slice("id:".length).trimStart();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}
	const data = dataLines.join("\n");
	if (!data) return;
	if (eventType === "error") {
		throw new Error(serverSentErrorMessage(data));
	}
	const event = JSON.parse(data) as AgentV2RunEventRecord;
	const parsedEventId = parseServerSentEventId(eventId);
	if (parsedEventId !== event.seq) {
		throw new Error(`Agent v2 SSE id ${parsedEventId} does not match payload seq ${event.seq}.`);
	}
	await onEvent(event);
}

function parseServerSentEventId(value: string | undefined): number {
	if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
		throw new Error("Agent v2 SSE id must be a canonical non-negative integer.");
	}
	const id = Number(value);
	if (!Number.isSafeInteger(id)) {
		throw new Error("Agent v2 SSE id must be a safe integer.");
	}
	return id;
}

function serverSentErrorMessage(data: string): string {
	try {
		const payload: unknown = JSON.parse(data);
		if (typeof payload === "object" && payload !== null && "message" in payload) {
			const message = String((payload as { message: unknown }).message || "").trim();
			if (message) return message;
		}
	} catch {
		const message = data.trim();
		if (message) return message;
	}
	return "Agent v2 runtime event stream unavailable.";
}

async function requestAgentV2RunApi<T>(path: string, init: RequestInit = {}): Promise<T> {
	const endpoint = new URL(path, window.location.origin).toString();
	const headers = buildAgentV2RunRequestHeaders(init.headers, init.body !== undefined);

	let response: Response;
	try {
		response = await fetch(endpoint, { ...init, headers });
	} catch (error) {
		throw new Error(`Unable to reach PI runtime API: ${endpoint}. ${errorMessage(error)}`);
	}
	const result: unknown = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message =
			typeof result === "object" && result !== null && "error" in result
				? String((result as { error: unknown }).error)
				: "";
		throw new Error(message || `Runtime API failed with HTTP ${response.status}`);
	}
	return result as T;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalizedName = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}
