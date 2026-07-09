import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2RunEventRecord } from "./agent-v2-store.js";
import type { AgentV2RunSnapshot } from "./agent-v2-types.js";
import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import type { MaybeAsyncIterable, RuntimeStore } from "./runtime-store.js";
import type {
	DiagnosticLogEventRecord,
	DiagnosticLogExportQuery,
	JsonObject,
} from "./types.js";
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

export type DiagnosticArchiveChunk = string | Uint8Array;

export interface DiagnosticArchiveEntry {
	path: string;
	kind: string;
	chunks(): Iterable<DiagnosticArchiveChunk> | AsyncIterable<DiagnosticArchiveChunk>;
}

export interface DiagnosticArchiveExport {
	filename: string;
	contentType: "application/zip";
	entries: DiagnosticArchiveEntry[];
	stream(): AsyncIterable<Uint8Array>;
}

interface DiagnosticExportContext {
	clientId: string;
	sessionId: string;
	session: null;
	runs: AgentV2RunSnapshot[];
}

interface AgentV2RunOverview extends JsonObject {
	runId: string;
	status: string;
	phase: string;
	attempt: number;
	workerId: string | null;
	startedAt: string | null;
	updatedAt: string;
	endedAt: string | null;
	error: JsonObject | null;
	input: JsonObject;
	model: unknown;
	eventCount: number;
	eventTypes: Record<string, number>;
	firstEventAt: string | null;
	lastEventAt: string | null;
	diagnosticEventTypes: Record<string, number>;
	agentV2DiagnosticCodes: Record<string, number>;
}

type DiagnosticFindingSeverity = "info" | "warn" | "error";

const DIAGNOSTIC_CONTEXT_PADDING_MS = 10 * 60 * 1000;

interface DiagnosticFinding extends JsonObject {
	severity: DiagnosticFindingSeverity;
	code: string;
	message: string;
	evidence: JsonObject;
}

interface TimelineRecord extends JsonObject {
	timestamp: string;
	source: string;
	kind: string;
	order: number;
}

export class WorkspaceDiagnosticExportService {
	constructor(
		private readonly runtimeDb: RuntimeStore,
		private readonly diagnostics: WorkspaceDiagnosticLogService,
		private readonly sessions: WorkspaceSessionService,
	) {}

	async export(request: DiagnosticExportRequest): Promise<DiagnosticExportResult> {
		const context = await this.resolveContext(request);
		const diagnosticEvents = this.diagnostics.exportEvents({
			clientId: context.clientId,
			sessionId: context.sessionId,
			maxEvents: request.maxDiagnosticEvents,
		});
		const includeSettings = request.includeSettings !== false;
		const settings = includeSettings ? (this.sessions.readSettings(context.clientId) ?? {}) : undefined;

		return {
			version: 1,
			exportedAt: new Date().toISOString(),
			query: {
				clientId: context.clientId,
				sessionId: context.sessionId,
				...(request.runId ? { runId: request.runId } : {}),
				includeSettings,
				maxDiagnosticEvents: diagnosticEvents.limit,
			},
			runtime: {
				session: context.session,
				messages: [],
				runs: context.runs,
				runEventsByRunId: await collectAgentV2RunEvents(this.runtimeDb, context.clientId, context.runs),
				agentV2DiagnosticsByRunId: await collectAgentV2Diagnostics(
					this.runtimeDb,
					context.clientId,
					context.runs,
				),
				sessionFile: null,
			},
			diagnostics: {
				status: this.diagnostics.status(),
				...diagnosticEvents,
			},
			...(includeSettings ? { settings } : {}),
		};
	}

	async exportArchive(request: DiagnosticExportRequest): Promise<DiagnosticArchiveExport> {
		const context = await this.resolveContext(request);
		const exportedAt = new Date().toISOString();
		const includeSettings = request.includeSettings !== false;
		const entries: DiagnosticArchiveEntry[] = [];
		const add = (entry: DiagnosticArchiveEntry): DiagnosticArchiveEntry => {
			entries.push(entry);
			return entry;
		};

		add(jsonEntry("runtime/session.json", "runtime-session", () => context.session));
		add(ndjsonEntry("runtime/messages.ndjson", "runtime-messages", () => []));
		add(jsonEntry("runtime/runs.json", "agent-v2-runs", () => context.runs));
		for (const run of context.runs) {
			const runId = safeFilenamePart(run.runId);
			add(
				jsonEntry(`runtime/run-events/${runId}.summary.json`, "agent-v2-run-events-summary", async () =>
					summarizeRunEvents(run.runId, await this.runtimeDb.listAgentV2RunEvents(context.clientId, run.runId, 0)),
				),
			);
			add(
				ndjsonEntry(`runtime/run-events/${runId}.events.ndjson`, "agent-v2-run-events", () =>
					this.runtimeDb.listAgentV2RunEvents(context.clientId, run.runId, 0),
				),
			);
			add(
				jsonEntry(`agent-v2/diagnostics/${runId}.summary.json`, "agent-v2-diagnostics-summary", async () =>
					summarizeAgentV2Diagnostics(run.runId, await this.runtimeDb.listAgentV2Diagnostics(context.clientId, run.runId)),
				),
			);
			add(
				ndjsonEntry(`agent-v2/diagnostics/${runId}.diagnostics.ndjson`, "agent-v2-diagnostics", () =>
					this.runtimeDb.listAgentV2Diagnostics(context.clientId, run.runId),
				),
			);
		}
		add(jsonEntry("diagnostics/status.json", "diagnostic-status", () => this.diagnostics.status()));
		add(
			jsonEntry("diagnostics/overview.json", "diagnostic-overview", () =>
				buildDiagnosticOverview({
					context,
					diagnostics: this.diagnostics,
					exportedAt,
					maxDiagnosticEvents: request.maxDiagnosticEvents,
					runtimeDb: this.runtimeDb,
				}),
			),
		);
		add(
			ndjsonEntry("diagnostics/events.ndjson", "diagnostic-events", () =>
				this.diagnostics.iterateExportEvents({
					clientId: context.clientId,
					sessionId: context.sessionId,
					maxEvents: request.maxDiagnosticEvents,
				}),
			),
		);
		add(
			ndjsonEntry("diagnostics/session-events.ndjson", "diagnostic-session-events", () =>
				this.diagnostics.iterateExportEvents({
					clientId: context.clientId,
					sessionId: context.sessionId,
					maxEvents: request.maxDiagnosticEvents,
				}),
			),
		);
		add(
			ndjsonEntry("diagnostics/global-events.ndjson", "diagnostic-global-events", () =>
				this.diagnostics.iterateExportEvents({
					...diagnosticContextQuery(context, request.maxDiagnosticEvents),
					globalOnly: true,
				}),
			),
		);
		add(
			ndjsonEntry("diagnostics/timeline.ndjson", "diagnostic-timeline", () =>
				buildDiagnosticTimeline({
					context,
					diagnostics: this.diagnostics,
					maxDiagnosticEvents: request.maxDiagnosticEvents,
					runtimeDb: this.runtimeDb,
				}),
			),
		);
		if (includeSettings) {
			add(jsonEntry("settings/settings.json", "settings", () => this.sessions.readSettings(context.clientId) ?? {}));
		}

		const manifest = jsonEntry("manifest.json", "manifest", () => ({
			format: "pi-diagnostic-archive",
			version: 1,
			exportedAt,
			query: {
				clientId: context.clientId,
				sessionId: context.sessionId,
				...(request.runId ? { runId: request.runId } : {}),
				includeSettings,
				maxDiagnosticEvents: request.maxDiagnosticEvents,
			},
			files: entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
		}));
		const archiveEntries = [manifest, ...entries];
		return {
			filename: diagnosticExportFilename(context.sessionId, request.runId, "zip"),
			contentType: "application/zip",
			entries: archiveEntries,
			stream() {
				return zipArchive(archiveEntries);
			},
		};
	}

	private async resolveContext(request: DiagnosticExportRequest): Promise<DiagnosticExportContext> {
		const clientId = stringField(request.clientId);
		if (!clientId) throw new Error("Client id is required.");
		if (!request.sessionId && !request.runId) throw new Error("Query parameter `sessionId` or `runId` is required.");
		const requestedRun = request.runId ? await this.runtimeDb.getAgentV2Run(clientId, request.runId) : undefined;
		if (request.runId && !requestedRun) throw new Error("Agent v2 run not found.");
		const sessionId = stringField(request.sessionId) ?? agentV2RunSessionId(requestedRun);
		if (!sessionId) throw new Error("Runtime session id could not be resolved.");
		if (requestedRun && agentV2RunSessionId(requestedRun) !== sessionId)
			throw new Error("Run does not belong to requested session.");
		const runs = requestedRun
			? [requestedRun]
			: (await this.runtimeDb.listAgentV2Runs(clientId)).filter((run) => agentV2RunSessionId(run) === sessionId);
		return {
			clientId,
			sessionId,
			session: null,
			runs,
		};
	}
}

async function collectAgentV2RunEvents(
	runtimeDb: RuntimeStore,
	clientId: string,
	runs: AgentV2RunSnapshot[],
): Promise<Record<string, AgentV2RunEventRecord[]>> {
	const eventsByRunId: Record<string, AgentV2RunEventRecord[]> = {};
	for (const run of runs) {
		eventsByRunId[run.runId] = await runtimeDb.listAgentV2RunEvents(clientId, run.runId, 0);
	}
	return eventsByRunId;
}

async function collectAgentV2Diagnostics(
	runtimeDb: RuntimeStore,
	clientId: string,
	runs: AgentV2RunSnapshot[],
): Promise<Record<string, AgentV2DiagnosticEvent[]>> {
	const diagnosticsByRunId: Record<string, AgentV2DiagnosticEvent[]> = {};
	for (const run of runs) {
		diagnosticsByRunId[run.runId] = await runtimeDb.listAgentV2Diagnostics(clientId, run.runId);
	}
	return diagnosticsByRunId;
}

async function buildDiagnosticOverview(input: {
	context: DiagnosticExportContext;
	diagnostics: WorkspaceDiagnosticLogService;
	exportedAt: string;
	maxDiagnosticEvents?: number;
	runtimeDb: RuntimeStore;
}): Promise<JsonObject> {
	const allDiagnostics = Array.from(
		input.diagnostics.iterateExportEvents(diagnosticContextQuery(input.context, input.maxDiagnosticEvents)),
	);
	const runIds = new Set(input.context.runs.map((run) => run.runId));
	const relevantDiagnostics = allDiagnostics.filter((event) =>
		isRelevantDiagnosticEvent(event, input.context, runIds),
	);
	const sessionDiagnostics = allDiagnostics.filter((event) => event.sessionId === input.context.sessionId);
	const globalDiagnostics = allDiagnostics.filter((event) => !event.sessionId);
	const agentV2DiagnosticsByRunId = await collectAgentV2Diagnostics(
		input.runtimeDb,
		input.context.clientId,
		input.context.runs,
	);
	const agentV2Diagnostics = Object.values(agentV2DiagnosticsByRunId).flat();
	const runs = await buildRunOverviews(
		input.runtimeDb,
		input.context,
		relevantDiagnostics,
		agentV2DiagnosticsByRunId,
	);
	const findings = buildDiagnosticFindings({
		context: input.context,
		globalDiagnostics,
		agentV2Diagnostics,
		relevantDiagnostics,
		runs,
	});
	return {
		version: 1,
		exportedAt: input.exportedAt,
		session: null,
		counts: {
			messages: 0,
			runs: input.context.runs.length,
			runtimeRunEvents: runs.reduce((total, run) => total + run.eventCount, 0),
			agentV2Diagnostics: agentV2Diagnostics.length,
			diagnosticEvents: relevantDiagnostics.length,
			sessionDiagnosticEvents: sessionDiagnostics.length,
			globalDiagnosticEvents: globalDiagnostics.length,
		},
		diagnosticEventTypes: countDiagnosticEventTypes(relevantDiagnostics),
		diagnosticLevels: countDiagnosticLevels(relevantDiagnostics),
		runs,
		findings,
	};
}

async function buildRunOverviews(
	runtimeDb: RuntimeStore,
	context: DiagnosticExportContext,
	diagnosticEvents: DiagnosticLogEventRecord[],
	agentV2DiagnosticsByRunId: Record<string, AgentV2DiagnosticEvent[]>,
): Promise<AgentV2RunOverview[]> {
	const overviews: AgentV2RunOverview[] = [];
	for (const run of context.runs) {
		const events = await arrayFromMaybeAsync(await runtimeDb.listAgentV2RunEvents(context.clientId, run.runId, 0));
		const diagnosticsForRun = diagnosticEvents.filter((event) => diagnosticEventRunId(event) === run.runId);
		const agentV2DiagnosticsForRun = agentV2DiagnosticsByRunId[run.runId] ?? [];
		const firstEventAt = events[0]?.createdAt ?? null;
		const lastEventAt = events.at(-1)?.createdAt ?? null;
		overviews.push({
			runId: run.runId,
			status: run.status,
			phase: run.phase,
			attempt: run.attempt,
			workerId: run.workerId ?? null,
			startedAt: run.startedAt ?? null,
			updatedAt: run.updatedAt,
			endedAt: run.endedAt ?? null,
			error: run.error ? { ...run.error } : null,
			input: run.input,
			model: run.model,
			eventCount: events.length,
			eventTypes: countRunEventTypes(events),
			firstEventAt,
			lastEventAt,
			diagnosticEventTypes: countDiagnosticEventTypes(diagnosticsForRun),
			agentV2DiagnosticCodes: countAgentV2DiagnosticCodes(agentV2DiagnosticsForRun),
		});
	}
	return overviews;
}

function buildDiagnosticFindings(input: {
	context: DiagnosticExportContext;
	globalDiagnostics: DiagnosticLogEventRecord[];
	agentV2Diagnostics: AgentV2DiagnosticEvent[];
	relevantDiagnostics: DiagnosticLogEventRecord[];
	runs: AgentV2RunOverview[];
}): DiagnosticFinding[] {
	const findings: DiagnosticFinding[] = [];
	const addFinding = (
		severity: DiagnosticFindingSeverity,
		code: string,
		message: string,
		evidence: JsonObject,
	): void => {
		findings.push({ severity, code, message, evidence });
	};

	const queuedTimeout = input.relevantDiagnostics.find(
		(event) => event.eventType === "agent.remote_run.queued_timeout",
	);
	if (queuedTimeout) {
		addFinding(
			"error",
			"run_queued_timeout",
			"Run stayed queued long enough to trigger the client-side queued timeout diagnostic.",
			diagnosticEvidence(queuedTimeout),
		);
	}

	const workerQueueError = input.globalDiagnostics.find((event) => event.eventType === "worker.queue.claim.error");
	if (workerQueueError) {
		addFinding(
			"error",
			"worker_queue_error",
			"A global worker queue claim error was recorded near this export and may explain queued runs.",
			diagnosticEvidence(workerQueueError),
		);
	}

	const workerStartFailure = input.globalDiagnostics.find(
		(event) =>
			event.eventType === "system.worker.start_failed" || event.eventType === "system.worker.service_start_failed",
	);
	if (workerStartFailure) {
		addFinding(
			"error",
			"worker_start_failed",
			"A worker startup failure was recorded near this export and may explain queued runs.",
			diagnosticEvidence(workerStartFailure),
		);
	}

	const workerFatalError = input.globalDiagnostics.find(
		(event) =>
			event.eventType === "system.worker.uncaught_exception" ||
			event.eventType === "system.worker.unhandled_rejection",
	);
	if (workerFatalError) {
		addFinding(
			"error",
			"worker_fatal_error",
			"A fatal worker process error was recorded near this export.",
			diagnosticEvidence(workerFatalError),
		);
	}

	const workerStartingEvents = input.globalDiagnostics.filter((event) => event.eventType === "system.worker.starting");
	const workerStartedEvents = input.globalDiagnostics.filter((event) => event.eventType === "system.worker.started");
	const recoveredActiveRuns = input.globalDiagnostics.filter(
		(event) =>
			event.eventType === "system.worker.recovered_active_runs" &&
			diagnosticEventNumber(event, "recoveredCount") > 0,
	);
	if (recoveredActiveRuns.length > 0) {
		addFinding(
			"warn",
			"worker_recovered_active_claims",
			"Worker startup recovered active Redis claims near this session; repeated nonzero counts can indicate stuck runs blocking new work.",
			diagnosticEventSeriesEvidence(recoveredActiveRuns),
		);
	}
	if (queuedTimeout && workerStartingEvents.length > 0 && workerStartedEvents.length === 0) {
		addFinding(
			"warn",
			"worker_start_not_confirmed",
			"Worker startup was observed, but no worker-started confirmation was recorded before the run timed out in queue.",
			diagnosticEventSeriesEvidence(workerStartingEvents),
		);
	}
	if (workerStartingEvents.length >= 3) {
		addFinding(
			"warn",
			"worker_repeated_starting",
			"Multiple worker startup events were recorded near this session; the worker process or container may be restarting repeatedly.",
			diagnosticEventSeriesEvidence(workerStartingEvents),
		);
	}

	for (const run of input.runs) {
		if (run.eventCount === 0) {
			addFinding("warn", "run_has_no_events", "Run has no runtime event stream entries.", {
				runId: run.runId,
				status: run.status,
				workerId: run.workerId,
			});
		}
		if (!run.workerId && !run.startedAt && ["queued", "cancelled", "failed", "interrupted"].includes(run.status)) {
			addFinding(
				"error",
				"run_never_started",
				"Run was never claimed by a worker before reaching its current status.",
				{
					runId: run.runId,
					status: run.status,
					updatedAt: run.updatedAt,
					endedAt: run.endedAt,
				},
			);
		}
		const enqueued = input.relevantDiagnostics.find(
			(event) => event.eventType === "agent.run.enqueued" && diagnosticEventRunId(event) === run.runId,
		);
		const claimed = input.relevantDiagnostics.find(
			(event) => event.eventType === "worker.queue.claimed" && diagnosticEventRunId(event) === run.runId,
		);
		if (enqueued && !claimed) {
			addFinding(
				"error",
				"run_enqueued_but_not_claimed",
				"Run was written to the Redis queue, but no worker claim for this run was observed in the diagnostic window.",
				{
					runId: run.runId,
					enqueued: diagnosticEvidence(enqueued),
				},
			);
		}
		if (run.status === "failed") {
			addFinding("error", "run_failed", "Run reached failed status.", {
				runId: run.runId,
				error: run.error,
				endedAt: run.endedAt,
			});
		}
	}

	const providerOrModelDiagnosticsObserved = input.relevantDiagnostics.some(
		(event) =>
			event.category === "provider" ||
			event.category === "model" ||
			event.eventType.startsWith("provider.") ||
			event.eventType.startsWith("model."),
	);
	const agentV2DiagnosticsObserved = input.agentV2Diagnostics.length > 0;
	const hasRuntimeRunEvents = input.runs.some((run) => run.eventCount > 0);
	if (input.runs.length > 0 && !hasRuntimeRunEvents && !providerOrModelDiagnosticsObserved && !agentV2DiagnosticsObserved) {
		addFinding(
			"warn",
			"model_request_not_observed",
			"No provider/model diagnostics or runtime run events were observed; the request likely did not reach the model layer.",
			{
				runIds: input.runs.map((run) => run.runId),
				diagnosticEventTypes: countDiagnosticEventTypes(input.relevantDiagnostics),
			},
		);
	}

	const providerOrModelError = input.relevantDiagnostics.find(
		(event) => (event.category === "provider" || event.category === "model") && event.level === "error",
	);
	if (providerOrModelError) {
		addFinding(
			"error",
			"provider_or_model_error",
			"Provider/model diagnostic error was recorded for this session.",
			diagnosticEvidence(providerOrModelError),
		);
	}

	const agentV2Error = input.agentV2Diagnostics.find((event) => event.severity === "error");
	if (agentV2Error) {
		addFinding("error", "agent_v2_diagnostic_error", "Agent v2 diagnostic error was recorded for this run.", {
			diagnosticId: agentV2Error.diagnosticId,
			runId: agentV2Error.runId,
			category: agentV2Error.category,
			code: agentV2Error.code,
			message: agentV2Error.message,
			data: agentV2Error.data,
		});
	}

	if (input.relevantDiagnostics.length === 0 && input.agentV2Diagnostics.length === 0) {
		addFinding("warn", "no_relevant_diagnostic_events", "No relevant diagnostic events were found in this export.", {
			sessionId: input.context.sessionId,
			runIds: input.runs.map((run) => run.runId),
		});
	}

	return findings;
}

async function buildDiagnosticTimeline(input: {
	context: DiagnosticExportContext;
	diagnostics: WorkspaceDiagnosticLogService;
	maxDiagnosticEvents?: number;
	runtimeDb: RuntimeStore;
}): Promise<TimelineRecord[]> {
	const records: TimelineRecord[] = [];
	let order = 0;
	for (const run of input.context.runs) {
		records.push({
			timestamp: run.startedAt ?? run.createdAt,
			source: "agent_v2",
			kind: "agent_v2.run",
			order: order++,
			runId: run.runId,
			sessionId: agentV2RunSessionId(run) ?? null,
			status: run.status,
			phase: run.phase,
			attempt: run.attempt,
			workerId: run.workerId ?? null,
			createdAt: run.createdAt,
			startedAt: run.startedAt ?? null,
			updatedAt: run.updatedAt,
			endedAt: run.endedAt ?? null,
			error: run.error ? { ...run.error } : null,
		});
		for (const event of await input.runtimeDb.listAgentV2RunEvents(input.context.clientId, run.runId, 0)) {
			records.push({
				timestamp: event.createdAt,
				source: "agent_v2",
				kind: "agent_v2.run_event",
				order: order++,
				runId: event.runId,
				sessionId: agentV2RunSessionId(run) ?? null,
				seq: event.seq,
				type: event.type,
				payload: event.payload,
			});
		}
		for (const diagnostic of await input.runtimeDb.listAgentV2Diagnostics(input.context.clientId, run.runId)) {
			records.push({
				timestamp: diagnostic.createdAt,
				source: "agent_v2",
				kind: "agent_v2.diagnostic",
				order: order++,
				runId: diagnostic.runId,
				sessionId: agentV2RunSessionId(run) ?? null,
				diagnosticId: diagnostic.diagnosticId,
				severity: diagnostic.severity,
				category: diagnostic.category,
				code: diagnostic.code,
				phase: diagnostic.phase ?? null,
				message: diagnostic.message,
				data: diagnostic.data,
			});
		}
	}
	const runIds = new Set(input.context.runs.map((run) => run.runId));
	for (const event of input.diagnostics.iterateExportEvents(
		diagnosticContextQuery(input.context, input.maxDiagnosticEvents),
	)) {
		if (!isRelevantDiagnosticEvent(event, input.context, runIds)) continue;
		records.push({
			timestamp: event.timestamp,
			source: "diagnostics",
			kind: event.eventType,
			order: order++,
			id: event.id,
			level: event.level,
			category: event.category,
			clientId: event.clientId ?? null,
			sessionId: event.sessionId ?? null,
			traceId: event.traceId ?? null,
			requestId: event.requestId ?? null,
			provider: event.provider ?? null,
			model: event.model ?? null,
			durationMs: event.durationMs ?? null,
			data: event.data,
		});
	}
	return records.sort(compareTimelineRecords);
}

async function arrayFromMaybeAsync<T>(values: MaybeAsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) {
		result.push(value);
	}
	return result;
}

function isRelevantDiagnosticEvent(
	event: DiagnosticLogEventRecord,
	context: DiagnosticExportContext,
	runIds: ReadonlySet<string>,
): boolean {
	if (event.sessionId === context.sessionId || event.traceId === context.sessionId) return true;
	const dataSessionId = stringField(event.data.sessionId) ?? stringField(event.data.session_id);
	if (dataSessionId === context.sessionId) return true;
	const dataRunId = diagnosticEventRunId(event);
	if (dataRunId && runIds.has(dataRunId)) return true;
	return !event.sessionId;
}

function diagnosticContextQuery(
	context: DiagnosticExportContext,
	maxDiagnosticEvents: number | undefined,
): DiagnosticLogExportQuery {
	return {
		...diagnosticContextWindow(context),
		maxEvents: maxDiagnosticEvents,
		order: "asc",
	};
}

function diagnosticContextWindow(context: DiagnosticExportContext): Pick<DiagnosticLogExportQuery, "since" | "until"> {
	const timestamps: number[] = [];
	for (const run of context.runs) {
		addTimestampMillis(timestamps, run.createdAt);
		addTimestampMillis(timestamps, run.startedAt);
		addTimestampMillis(timestamps, run.updatedAt);
		addTimestampMillis(timestamps, run.endedAt);
	}
	if (timestamps.length === 0) return {};
	const since = new Date(Math.min(...timestamps) - DIAGNOSTIC_CONTEXT_PADDING_MS).toISOString();
	const until = new Date(Math.max(...timestamps) + DIAGNOSTIC_CONTEXT_PADDING_MS).toISOString();
	return { since, until };
}

function addTimestampMillis(timestamps: number[], value: string | undefined): void {
	if (!value) return;
	const millis = Date.parse(value);
	if (Number.isFinite(millis)) timestamps.push(millis);
}

function diagnosticEventRunId(event: DiagnosticLogEventRecord): string | undefined {
	return stringField(event.data.runId) ?? stringField(event.data.run_id);
}

function diagnosticEventNumber(event: DiagnosticLogEventRecord, key: string): number {
	const value = event.data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function diagnosticEvidence(event: DiagnosticLogEventRecord): JsonObject {
	return {
		id: event.id,
		timestamp: event.timestamp,
		level: event.level,
		category: event.category,
		eventType: event.eventType,
		clientId: event.clientId ?? null,
		sessionId: event.sessionId ?? null,
		traceId: event.traceId ?? null,
		requestId: event.requestId ?? null,
		provider: event.provider ?? null,
		model: event.model ?? null,
		durationMs: event.durationMs ?? null,
		data: event.data,
	};
}

function diagnosticEventSeriesEvidence(events: DiagnosticLogEventRecord[]): JsonObject {
	const first = events[0];
	const last = events.at(-1);
	return {
		count: events.length,
		first: first ? diagnosticEvidence(first) : null,
		last: last ? diagnosticEvidence(last) : null,
	};
}

function countRunEventTypes(events: Iterable<AgentV2RunEventRecord>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		counts[event.type] = (counts[event.type] ?? 0) + 1;
	}
	return counts;
}

function countDiagnosticEventTypes(events: Iterable<DiagnosticLogEventRecord>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
	}
	return counts;
}

function countAgentV2DiagnosticCodes(events: Iterable<AgentV2DiagnosticEvent>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		counts[event.code] = (counts[event.code] ?? 0) + 1;
	}
	return counts;
}

function countDiagnosticLevels(events: Iterable<DiagnosticLogEventRecord>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		counts[event.level] = (counts[event.level] ?? 0) + 1;
	}
	return counts;
}

function compareTimelineRecords(left: TimelineRecord, right: TimelineRecord): number {
	const leftTime = Date.parse(left.timestamp);
	const rightTime = Date.parse(right.timestamp);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	const timestampOrder = left.timestamp.localeCompare(right.timestamp);
	if (timestampOrder !== 0) return timestampOrder;
	return left.order - right.order;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function agentV2RunSessionId(run: AgentV2RunSnapshot | undefined): string | undefined {
	return stringField(run?.input.sessionId);
}

function jsonEntry(path: string, kind: string, value: () => unknown | Promise<unknown>): DiagnosticArchiveEntry {
	return {
		path,
		kind,
		async *chunks() {
			yield `${JSON.stringify(await value(), null, 2)}\n`;
		},
	};
}

function ndjsonEntry<T>(
	path: string,
	kind: string,
	values: () => MaybeAsyncIterable<T> | Promise<MaybeAsyncIterable<T>>,
): DiagnosticArchiveEntry {
	return {
		path,
		kind,
		async *chunks() {
			for await (const value of await values()) {
				yield `${JSON.stringify(value)}\n`;
			}
		},
	};
}

async function summarizeRunEvents(
	runId: string,
	events: MaybeAsyncIterable<AgentV2RunEventRecord>,
): Promise<JsonObject> {
	let totalEvents = 0;
	let payloadBytes = 0;
	let largestPayloadBytes = 0;
	let firstSeq: number | undefined;
	let lastSeq: number | undefined;
	const eventTypes: Record<string, number> = {};
	for await (const event of events) {
		totalEvents += 1;
		firstSeq ??= event.seq;
		lastSeq = event.seq;
		eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
		const size = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
		payloadBytes += size;
		largestPayloadBytes = Math.max(largestPayloadBytes, size);
	}
	return {
		runId,
		totalEvents,
		eventTypes,
		firstSeq,
		lastSeq,
		payloadBytes,
		largestPayloadBytes,
	};
}

async function summarizeAgentV2Diagnostics(
	runId: string,
	diagnostics: MaybeAsyncIterable<AgentV2DiagnosticEvent>,
): Promise<JsonObject> {
	let totalDiagnostics = 0;
	const severities: Record<string, number> = {};
	const categories: Record<string, number> = {};
	const codes: Record<string, number> = {};
	for await (const diagnostic of diagnostics) {
		totalDiagnostics += 1;
		severities[diagnostic.severity] = (severities[diagnostic.severity] ?? 0) + 1;
		categories[diagnostic.category] = (categories[diagnostic.category] ?? 0) + 1;
		codes[diagnostic.code] = (codes[diagnostic.code] ?? 0) + 1;
	}
	return {
		runId,
		totalDiagnostics,
		severities,
		categories,
		codes,
	};
}

function diagnosticExportFilename(
	sessionId: string | undefined,
	runId: string | undefined,
	extension: "json" | "zip",
): string {
	const id = safeFilenamePart(runId ?? sessionId ?? "logs");
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `pi-diagnostics-${id}-${timestamp}.${extension}`;
}

function safeFilenamePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "logs";
}

const encoder = new TextEncoder();
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;

async function* zipArchive(entries: DiagnosticArchiveEntry[]): AsyncIterable<Uint8Array> {
	const centralDirectory: Array<{ path: string; crc: number; size: number; offset: number }> = [];
	let offset = 0;

	for (const entry of entries) {
		const name = encoder.encode(entry.path);
		const localHeader = zipLocalHeader(name);
		yield localHeader;
		const localHeaderOffset = offset;
		offset += localHeader.byteLength;

		let crc = crc32Start();
		let size = 0;
		for await (const rawChunk of entry.chunks()) {
			const chunk = typeof rawChunk === "string" ? encoder.encode(rawChunk) : rawChunk;
			crc = crc32Update(crc, chunk);
			size += chunk.byteLength;
			offset += chunk.byteLength;
			yield chunk;
		}
		const finalCrc = crc32Finish(crc);
		const descriptor = zipDataDescriptor(finalCrc, size);
		yield descriptor;
		offset += descriptor.byteLength;
		centralDirectory.push({ path: entry.path, crc: finalCrc, size, offset: localHeaderOffset });
	}

	const centralStart = offset;
	for (const entry of centralDirectory) {
		const header = zipCentralDirectoryHeader(encoder.encode(entry.path), entry);
		yield header;
		offset += header.byteLength;
	}
	const centralSize = offset - centralStart;
	yield zipEndOfCentralDirectory(centralDirectory.length, centralSize, centralStart);
}

function zipLocalHeader(name: Uint8Array): Uint8Array {
	const header = Buffer.alloc(30 + name.byteLength);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(ZIP_FLAGS, 6);
	header.writeUInt16LE(0, 8);
	header.writeUInt16LE(0, 10);
	header.writeUInt16LE(0, 12);
	header.writeUInt32LE(0, 14);
	header.writeUInt32LE(0, 18);
	header.writeUInt32LE(0, 22);
	header.writeUInt16LE(name.byteLength, 26);
	header.writeUInt16LE(0, 28);
	header.set(name, 30);
	return header;
}

function zipDataDescriptor(crc: number, size: number): Uint8Array {
	assertZip32(size);
	const descriptor = Buffer.alloc(16);
	descriptor.writeUInt32LE(0x08074b50, 0);
	descriptor.writeUInt32LE(crc, 4);
	descriptor.writeUInt32LE(size, 8);
	descriptor.writeUInt32LE(size, 12);
	return descriptor;
}

function zipCentralDirectoryHeader(
	name: Uint8Array,
	entry: { path: string; crc: number; size: number; offset: number },
): Uint8Array {
	assertZip32(entry.size);
	assertZip32(entry.offset);
	const header = Buffer.alloc(46 + name.byteLength);
	header.writeUInt32LE(0x02014b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(20, 6);
	header.writeUInt16LE(ZIP_FLAGS, 8);
	header.writeUInt16LE(0, 10);
	header.writeUInt16LE(0, 12);
	header.writeUInt16LE(0, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.size, 20);
	header.writeUInt32LE(entry.size, 24);
	header.writeUInt16LE(name.byteLength, 28);
	header.writeUInt16LE(0, 30);
	header.writeUInt16LE(0, 32);
	header.writeUInt16LE(0, 34);
	header.writeUInt16LE(0, 36);
	header.writeUInt32LE(0, 38);
	header.writeUInt32LE(entry.offset, 42);
	header.set(name, 46);
	return header;
}

function zipEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
	assertZip16(entryCount);
	assertZip32(centralSize);
	assertZip32(centralOffset);
	const footer = Buffer.alloc(22);
	footer.writeUInt32LE(0x06054b50, 0);
	footer.writeUInt16LE(0, 4);
	footer.writeUInt16LE(0, 6);
	footer.writeUInt16LE(entryCount, 8);
	footer.writeUInt16LE(entryCount, 10);
	footer.writeUInt32LE(centralSize, 12);
	footer.writeUInt32LE(centralOffset, 16);
	footer.writeUInt16LE(0, 20);
	return footer;
}

function assertZip16(value: number): void {
	if (value > 0xffff) throw new Error("Diagnostic archive has too many files for ZIP32.");
}

function assertZip32(value: number): void {
	if (value > 0xffffffff) throw new Error("Diagnostic archive file is too large for ZIP32.");
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	CRC32_TABLE[index] = value >>> 0;
}

function crc32Start(): number {
	return 0xffffffff;
}

function crc32Update(current: number, chunk: Uint8Array): number {
	let crc = current;
	for (const byte of chunk) {
		crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return crc >>> 0;
}

function crc32Finish(current: number): number {
	return (current ^ 0xffffffff) >>> 0;
}
