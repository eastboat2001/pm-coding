import type { RuntimeSessionRecord } from "@mariozechner/pi-web-workspace";
import { piClientHeaders } from "../runtime/client-id.js";

const LOGS_API_PREFIX = "/api/pi-logs";
const DEFAULT_MAX_DIAGNOSTIC_EVENTS = 200000;

export interface DiagnosticExportEndpointOptions {
	sessionId?: string;
	runId?: string;
	maxDiagnosticEvents?: number;
	includeSettings?: boolean;
}

export function buildDiagnosticExportEndpoint(options: DiagnosticExportEndpointOptions): string {
	const params = new URLSearchParams();
	if (options.sessionId) params.set("sessionId", options.sessionId);
	if (options.runId) params.set("runId", options.runId);
	params.set("maxDiagnosticEvents", String(options.maxDiagnosticEvents ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS));
	if (options.includeSettings === false) params.set("includeSettings", "false");
	return `${LOGS_API_PREFIX}/export?${params.toString()}`;
}

export function diagnosticSessionTitle(session: RuntimeSessionRecord): string {
	return session.title?.trim() || session.sessionId;
}

export function diagnosticExportDownloadName(session: RuntimeSessionRecord): string {
	const title = sanitizeFilenamePart(diagnosticSessionTitle(session));
	const sessionId = sanitizeFilenamePart(session.sessionId);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `pi-diagnostics-${title}-${sessionId}-${timestamp}.json`;
}

export async function downloadDiagnosticSessionExport(session: RuntimeSessionRecord): Promise<void> {
	const endpoint = buildDiagnosticExportEndpoint({ sessionId: session.sessionId });
	const response = await fetch(new URL(endpoint, window.location.origin).toString(), {
		method: "GET",
		headers: piClientHeaders(),
	});
	if (!response.ok) {
		const message = await response
			.json()
			.then((body) => (typeof body?.error === "string" ? body.error : ""))
			.catch(() => "");
		throw new Error(message || `Diagnostic export failed with HTTP ${response.status}`);
	}
	const blob = await response.blob();
	downloadBlob(blob, diagnosticExportDownloadName(session));
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

function sanitizeFilenamePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "session";
}
