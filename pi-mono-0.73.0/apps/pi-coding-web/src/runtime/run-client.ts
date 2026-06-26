import type {
	AppPreviewGoalEventRecord,
	AppPreviewGoalRecord,
	AppPreviewGoalSource,
	DeleteSessionResult,
	RuntimeRunEventListResult,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
	RuntimeSessionListResult,
	RuntimeSessionRecord,
	StartRunRequest,
	StartRunResult,
} from "@mariozechner/pi-web-workspace";
import { piClientHeaders } from "./client-id.js";

const RUNS_API_PREFIX = "/api/pi-runs";
const SESSIONS_API_PREFIX = "/api/pi-sessions";
const FAST_POLL_INTERVAL_MS = 150;
const MAX_POLL_INTERVAL_MS = 1000;
const IDLE_POLL_BACKOFF_MS = 150;
const RUN_EVENT_STREAM_RECONNECT_MS = 1000;

export interface RunEventConnection {
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

export interface RunEventConnectionOptions {
	onStatusChange?: (connection: RunEventConnection) => void;
}

export function buildRunRequestHeaders(initHeaders?: HeadersInit, hasBody = false): Record<string, string> {
	const headers = Object.fromEntries(new Headers(initHeaders).entries());
	headers["X-PI-Client-ID"] = piClientHeaders()["X-PI-Client-ID"];
	if (hasBody && !hasHeader(headers, "content-type")) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

export function buildAppPreviewGoalStartRequest(
	source: AppPreviewGoalSource | undefined,
): StartRunRequest["appPreviewGoal"] {
	return source ? { enabled: true, source } : undefined;
}

export async function startRun(request: StartRunRequest): Promise<StartRunResult> {
	return requestRunApi<StartRunResult>(RUNS_API_PREFIX, {
		method: "POST",
		body: JSON.stringify(request),
	});
}

export async function listSessions(): Promise<RuntimeSessionRecord[]> {
	const result = await requestRunApi<RuntimeSessionListResult>(SESSIONS_API_PREFIX, { method: "GET" });
	return result.sessions;
}

export async function getSession(sessionId: string): Promise<RuntimeSessionDetail> {
	return requestRunApi<RuntimeSessionDetail>(`${SESSIONS_API_PREFIX}/${encodeURIComponent(sessionId)}`, {
		method: "GET",
	});
}

export async function deleteSession(
	sessionId: string,
	options: { force?: boolean } = {},
): Promise<DeleteSessionResult> {
	const forceQuery = options.force ? "?force=true" : "";
	return requestRunApi<DeleteSessionResult>(`${SESSIONS_API_PREFIX}/${encodeURIComponent(sessionId)}${forceQuery}`, {
		method: "DELETE",
	});
}

export async function renameSession(sessionId: string, title: string): Promise<RuntimeSessionRecord> {
	return requestRunApi<RuntimeSessionRecord>(`${SESSIONS_API_PREFIX}/${encodeURIComponent(sessionId)}`, {
		method: "PUT",
		body: JSON.stringify({ title }),
	});
}

export async function listRunEvents(runId: string, afterSeq = 0): Promise<RuntimeRunEventRecord[]> {
	const result = await requestRunApi<RuntimeRunEventListResult>(
		`${RUNS_API_PREFIX}/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
		{ method: "GET" },
	);
	return result.events;
}

export async function cancelRun(runId: string): Promise<RuntimeRunRecord> {
	return requestRunApi<RuntimeRunRecord>(`${RUNS_API_PREFIX}/${encodeURIComponent(runId)}/cancel`, {
		method: "POST",
	});
}

export async function getAppPreviewGoal(
	sessionId: string,
): Promise<{ goal: AppPreviewGoalRecord | null; events: AppPreviewGoalEventRecord[] }> {
	return requestRunApi<{ goal: AppPreviewGoalRecord | null; events: AppPreviewGoalEventRecord[] }>(
		`${RUNS_API_PREFIX}/goals/app-preview?sessionId=${encodeURIComponent(sessionId)}`,
		{ method: "GET" },
	);
}

export async function enableAppPreviewGoal(
	sessionId: string,
	source: AppPreviewGoalSource,
): Promise<{ goal: AppPreviewGoalRecord | null }> {
	return requestRunApi<{ goal: AppPreviewGoalRecord | null }>(`${RUNS_API_PREFIX}/goals/app-preview`, {
		method: "POST",
		body: JSON.stringify({ sessionId, source, enabled: true }),
	});
}

export async function disableAppPreviewGoal(sessionId: string): Promise<{ goal: AppPreviewGoalRecord | null }> {
	return requestRunApi<{ goal: AppPreviewGoalRecord | null }>(`${RUNS_API_PREFIX}/goals/app-preview/disable`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
}

export function connectRunEvents(
	runId: string,
	afterSeq: number,
	onEvent: (event: RuntimeRunEventRecord) => void | Promise<void>,
	options: RunEventConnectionOptions = {},
): RunEventConnection {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	const connection: RunEventConnection = {
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
				`${RUNS_API_PREFIX}/${encodeURIComponent(runId)}/events?afterSeq=${connection.lastSeq}&stream=1`,
				window.location.origin,
			).toString();
			const response = await fetch(endpoint, {
				method: "GET",
				headers: buildRunRequestHeaders({ Accept: "text/event-stream" }),
				signal: abortController.signal,
			});
			if (!response.ok) {
				throw new Error(`Runtime event stream failed with HTTP ${response.status}`);
			}
			if (!isEventStreamResponse(response)) {
				const result = (await response.json()) as RuntimeRunEventListResult;
				if (connection.closed) return;
				connection.readyState = connection.OPEN;
				connection.lastError = undefined;
				notifyStatusChange();
				await deliverRunEvents(result.events);
				fallbackToPolling = true;
				return;
			}
			if (!response.body) {
				throw new Error("Runtime event stream response did not include a body.");
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

	const deliverRunEvent = async (event: RuntimeRunEventRecord): Promise<void> => {
		if (connection.closed) return;
		await onEvent(event);
		connection.lastSeq = Math.max(connection.lastSeq, event.seq);
	};

	const deliverRunEvents = async (events: RuntimeRunEventRecord[]): Promise<void> => {
		for (const event of events) {
			await deliverRunEvent(event);
			if (connection.closed) return;
		}
	};

	const poll = async (): Promise<void> => {
		if (connection.closed) return;
		try {
			const events = await listRunEvents(runId, connection.lastSeq);
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

function isEventStreamResponse(response: Response): boolean {
	return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

async function readEventStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: RuntimeRunEventRecord) => void | Promise<void>,
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
	onEvent: (event: RuntimeRunEventRecord) => void | Promise<void>,
): Promise<void> {
	const data = rawEvent
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trimStart())
		.join("\n");
	if (!data) return;
	await onEvent(JSON.parse(data) as RuntimeRunEventRecord);
}

async function requestRunApi<T>(path: string, init: RequestInit = {}): Promise<T> {
	const endpoint = new URL(path, window.location.origin).toString();
	const headers = buildRunRequestHeaders(init.headers, init.body !== undefined);

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
