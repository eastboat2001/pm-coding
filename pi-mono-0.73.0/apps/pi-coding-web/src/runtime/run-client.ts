import type {
	DeleteSessionResult,
	RuntimeSessionDetail,
	RuntimeSessionListResult,
	RuntimeSessionRecord,
} from "@mariozechner/pi-web-workspace";
import { piClientHeaders } from "./client-id.js";

const SESSIONS_API_PREFIX = "/api/pi-sessions";

export function buildRunRequestHeaders(initHeaders?: HeadersInit, hasBody = false): Record<string, string> {
	const headers = Object.fromEntries(new Headers(initHeaders).entries());
	headers["X-PI-Client-ID"] = piClientHeaders()["X-PI-Client-ID"];
	if (hasBody && !hasHeader(headers, "content-type")) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalizedName = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}
