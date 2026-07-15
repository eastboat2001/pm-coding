import type { AgentV2RunEventRecord, AgentV2RunSnapshot, JsonObject } from "@mariozechner/pi-web-workspace";
import { piClientHeaders } from "./client-id.js";

export const AGENT_V2_RUNS_API_PREFIX = "/api/agent-v2/runs";

const FAST_POLL_INTERVAL_MS = 150;
const MAX_POLL_INTERVAL_MS = 1000;
const IDLE_POLL_BACKOFF_MS = 150;
const RUN_EVENT_STREAM_RECONNECT_MS = 1000;

export interface AgentV2BrowserProjectFile {
	filename: string;
	content: string;
}

export interface AgentV2BrowserStartRunRequest {
	sessionId: string;
	title: string;
	prompt: string;
	objective?: string;
	message?: JsonObject;
	attachments?: unknown[];
	projectFiles?: AgentV2BrowserProjectFile[];
	model?: unknown;
}

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
	const input: Record<string, unknown> = {
		sessionId: request.sessionId,
		title: request.title,
		prompt: request.prompt,
		...(request.objective ? { objective: request.objective } : {}),
		...(request.message ? { message: request.message } : {}),
		...(request.attachments ? { attachments: request.attachments } : {}),
		...(request.projectFiles ? { projectFiles: request.projectFiles } : {}),
	};
	return requestAgentV2RunApi<AgentV2RunSnapshot>(`${AGENT_V2_RUNS_API_PREFIX}/start`, {
		method: "POST",
		body: JSON.stringify({
			input,
			...(request.model !== undefined ? { model: request.model } : {}),
		}),
	});
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
