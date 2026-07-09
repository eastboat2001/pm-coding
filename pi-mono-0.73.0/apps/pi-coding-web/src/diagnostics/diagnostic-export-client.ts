import type { RuntimeSessionRecord } from "@mariozechner/pi-web-workspace";
import { getOrCreatePiClientId, piClientHeaders } from "../runtime/client-id.js";

const LOGS_API_PREFIX = "/api/pi-logs";
const DEFAULT_MAX_DIAGNOSTIC_EVENTS = 200000;

export interface DiagnosticExportEndpointOptions {
	sessionId?: string;
	runId?: string;
	clientId?: string;
	maxDiagnosticEvents?: number;
	includeSettings?: boolean;
}

export function buildDiagnosticExportEndpoint(options: DiagnosticExportEndpointOptions): string {
	const params = new URLSearchParams();
	if (options.sessionId) params.set("sessionId", options.sessionId);
	if (options.runId) params.set("runId", options.runId);
	if (options.clientId) params.set("clientId", options.clientId);
	params.set("format", "archive");
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
	return `pi-diagnostics-${title}-${sessionId}-${timestamp}.zip`;
}

export async function downloadDiagnosticSessionExport(session: RuntimeSessionRecord): Promise<void> {
	const clientId = getOrCreatePiClientId();
	const endpoint = buildDiagnosticExportEndpoint({
		...(session.lastRunId ? { runId: session.lastRunId } : { sessionId: session.sessionId }),
		clientId,
	});
	const url = new URL(endpoint, window.location.origin).toString();
	const response = await fetch(url, {
		method: "HEAD",
		headers: piClientHeaders(),
	});
	if (!response.ok) {
		throw new Error(`Diagnostic export failed with HTTP ${response.status}`);
	}
	downloadUrl(url, diagnosticExportDownloadName(session));
}

function downloadUrl(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}

function sanitizeFilenamePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "session";
}
