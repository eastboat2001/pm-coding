import { piClientHeaders } from "./client-id.js";

export function buildRunRequestHeaders(initHeaders?: HeadersInit, hasBody = false): Record<string, string> {
	const headers = Object.fromEntries(new Headers(initHeaders).entries());
	headers["X-PI-Client-ID"] = piClientHeaders()["X-PI-Client-ID"];
	if (hasBody && !hasHeader(headers, "content-type")) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalizedName = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}
