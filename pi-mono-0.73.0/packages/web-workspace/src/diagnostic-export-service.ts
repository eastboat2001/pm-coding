import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import type { RuntimeDbStore } from "./runtime-db.js";
import type { JsonObject, RuntimeRunEventRecord, RuntimeRunRecord } from "./types.js";
import type { WorkspaceSessionService } from "./workspace-session-service.js";

export interface DiagnosticExportRequest {
	clientId: string;
	sessionId?: string;
	runId?: string;
	includeSettings?: boolean;
	maxDiagnosticEvents?: number;
}

export interface DiagnosticExportResult extends JsonObject {
	version: 1;
	exportedAt: string;
	query: JsonObject;
	runtime: JsonObject;
	diagnostics: JsonObject;
	settings?: JsonObject;
}

export class WorkspaceDiagnosticExportService {
	constructor(
		private readonly runtimeDb: RuntimeDbStore,
		private readonly diagnostics: WorkspaceDiagnosticLogService,
		private readonly sessions: WorkspaceSessionService,
	) {}

	export(request: DiagnosticExportRequest): DiagnosticExportResult {
		const clientId = stringField(request.clientId);
		if (!clientId) throw new Error("Client id is required.");
		if (!request.sessionId && !request.runId) throw new Error("Query parameter `sessionId` or `runId` is required.");

		const requestedRun = request.runId ? this.runtimeDb.getRun(clientId, request.runId) : undefined;
		if (request.runId && !requestedRun) throw new Error("Runtime run not found.");
		const sessionId = stringField(request.sessionId) ?? requestedRun?.sessionId;
		if (!sessionId) throw new Error("Runtime session id could not be resolved.");
		if (requestedRun && requestedRun.sessionId !== sessionId)
			throw new Error("Run does not belong to requested session.");

		const session = this.runtimeDb.getSession(clientId, sessionId);
		const runs = requestedRun ? [requestedRun] : this.runtimeDb.listRunsForSession(clientId, sessionId);
		const diagnosticEvents = this.diagnostics.exportEvents({
			clientId,
			sessionId,
			maxEvents: request.maxDiagnosticEvents,
		});
		const includeSettings = request.includeSettings !== false;
		const settings = includeSettings ? (this.sessions.readSettings(clientId) ?? {}) : undefined;

		return {
			version: 1,
			exportedAt: new Date().toISOString(),
			query: {
				clientId,
				sessionId,
				...(request.runId ? { runId: request.runId } : {}),
				includeSettings,
				maxDiagnosticEvents: diagnosticEvents.limit,
			},
				runtime: {
					session: session ?? null,
					messages: session ? this.runtimeDb.listMessages(clientId, sessionId) : [],
					runs,
					runEventsByRunId: collectRunEvents(this.runtimeDb, clientId, runs),
					sessionFile: null,
				},
			diagnostics: {
				status: this.diagnostics.status(),
				...diagnosticEvents,
			},
			...(includeSettings ? { settings } : {}),
		};
	}
}

function collectRunEvents(
	runtimeDb: RuntimeDbStore,
	clientId: string,
	runs: RuntimeRunRecord[],
): Record<string, RuntimeRunEventRecord[]> {
	const eventsByRunId: Record<string, RuntimeRunEventRecord[]> = {};
	for (const run of runs) {
		eventsByRunId[run.runId] = runtimeDb.listRunEvents(clientId, run.runId, 0);
	}
	return eventsByRunId;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
