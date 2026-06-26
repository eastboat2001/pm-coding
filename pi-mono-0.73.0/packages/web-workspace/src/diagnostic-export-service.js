const DIAGNOSTIC_CONTEXT_PADDING_MS = 10 * 60 * 1000;
export class WorkspaceDiagnosticExportService {
    runtimeDb;
    diagnostics;
    sessions;
    constructor(runtimeDb, diagnostics, sessions) {
        this.runtimeDb = runtimeDb;
        this.diagnostics = diagnostics;
        this.sessions = sessions;
    }
    export(request) {
        const clientId = stringField(request.clientId);
        if (!clientId)
            throw new Error("Client id is required.");
        if (!request.sessionId && !request.runId)
            throw new Error("Query parameter `sessionId` or `runId` is required.");
        const requestedRun = request.runId ? this.runtimeDb.getRun(clientId, request.runId) : undefined;
        if (request.runId && !requestedRun)
            throw new Error("Runtime run not found.");
        const sessionId = stringField(request.sessionId) ?? requestedRun?.sessionId;
        if (!sessionId)
            throw new Error("Runtime session id could not be resolved.");
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
    exportArchive(request) {
        const context = this.resolveContext(request);
        const exportedAt = new Date().toISOString();
        const includeSettings = request.includeSettings !== false;
        const entries = [];
        const add = (entry) => {
            entries.push(entry);
            return entry;
        };
        add(jsonEntry("runtime/session.json", "runtime-session", () => context.session ?? null));
        add(ndjsonEntry("runtime/messages.ndjson", "runtime-messages", () => context.session ? this.runtimeDb.iterateMessages(context.clientId, context.sessionId) : []));
        add(jsonEntry("runtime/runs.json", "runtime-runs", () => context.runs));
        for (const run of context.runs) {
            const runId = safeFilenamePart(run.runId);
            add(jsonEntry(`runtime/run-events/${runId}.summary.json`, "runtime-run-events-summary", () => summarizeRunEvents(run.runId, this.runtimeDb.iterateRunEvents(context.clientId, run.runId, 0))));
            add(ndjsonEntry(`runtime/run-events/${runId}.events.ndjson`, "runtime-run-events", () => this.runtimeDb.iterateRunEvents(context.clientId, run.runId, 0)));
        }
        add(jsonEntry("diagnostics/status.json", "diagnostic-status", () => this.diagnostics.status()));
        add(jsonEntry("diagnostics/overview.json", "diagnostic-overview", () => buildDiagnosticOverview({
            context,
            diagnostics: this.diagnostics,
            exportedAt,
            maxDiagnosticEvents: request.maxDiagnosticEvents,
            runtimeDb: this.runtimeDb,
        })));
        add(ndjsonEntry("diagnostics/events.ndjson", "diagnostic-events", () => this.diagnostics.iterateExportEvents({
            clientId: context.clientId,
            sessionId: context.sessionId,
            maxEvents: request.maxDiagnosticEvents,
        })));
        add(ndjsonEntry("diagnostics/session-events.ndjson", "diagnostic-session-events", () => this.diagnostics.iterateExportEvents({
            clientId: context.clientId,
            sessionId: context.sessionId,
            maxEvents: request.maxDiagnosticEvents,
        })));
        add(ndjsonEntry("diagnostics/global-events.ndjson", "diagnostic-global-events", () => this.diagnostics.iterateExportEvents({
            ...diagnosticContextQuery(context, request.maxDiagnosticEvents),
            globalOnly: true,
        })));
        add(ndjsonEntry("diagnostics/timeline.ndjson", "diagnostic-timeline", () => buildDiagnosticTimeline({
            context,
            diagnostics: this.diagnostics,
            maxDiagnosticEvents: request.maxDiagnosticEvents,
            runtimeDb: this.runtimeDb,
        })));
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
    resolveContext(request) {
        const clientId = stringField(request.clientId);
        if (!clientId)
            throw new Error("Client id is required.");
        if (!request.sessionId && !request.runId)
            throw new Error("Query parameter `sessionId` or `runId` is required.");
        const requestedRun = request.runId ? this.runtimeDb.getRun(clientId, request.runId) : undefined;
        if (request.runId && !requestedRun)
            throw new Error("Runtime run not found.");
        const sessionId = stringField(request.sessionId) ?? requestedRun?.sessionId;
        if (!sessionId)
            throw new Error("Runtime session id could not be resolved.");
        if (requestedRun && requestedRun.sessionId !== sessionId)
            throw new Error("Run does not belong to requested session.");
        return {
            clientId,
            sessionId,
            session: this.runtimeDb.getSession(clientId, sessionId),
            runs: requestedRun ? [requestedRun] : this.runtimeDb.listRunsForSession(clientId, sessionId),
        };
    }
}
function collectRunEvents(runtimeDb, clientId, runs) {
    const eventsByRunId = {};
    for (const run of runs) {
        eventsByRunId[run.runId] = runtimeDb.listRunEvents(clientId, run.runId, 0);
    }
    return eventsByRunId;
}
function buildDiagnosticOverview(input) {
    const messages = collectMessages(input.runtimeDb, input.context);
    const allDiagnostics = Array.from(input.diagnostics.iterateExportEvents(diagnosticContextQuery(input.context, input.maxDiagnosticEvents)));
    const runIds = new Set(input.context.runs.map((run) => run.runId));
    const relevantDiagnostics = allDiagnostics.filter((event) => isRelevantDiagnosticEvent(event, input.context, runIds));
    const sessionDiagnostics = allDiagnostics.filter((event) => event.sessionId === input.context.sessionId);
    const globalDiagnostics = allDiagnostics.filter((event) => !event.sessionId);
    const runs = buildRunOverviews(input.runtimeDb, input.context, relevantDiagnostics);
    const findings = buildDiagnosticFindings({
        context: input.context,
        globalDiagnostics,
        relevantDiagnostics,
        runs,
    });
    return {
        version: 1,
        exportedAt: input.exportedAt,
        session: input.context.session
            ? {
                sessionId: input.context.session.sessionId,
                clientId: input.context.session.clientId,
                title: input.context.session.title,
                model: input.context.session.model,
                thinkingLevel: input.context.session.thinkingLevel,
                createdAt: input.context.session.createdAt,
                updatedAt: input.context.session.updatedAt,
                lastRunStatus: input.context.session.lastRunStatus ?? null,
                lastRunId: input.context.session.lastRunId ?? null,
            }
            : null,
        counts: {
            messages: messages.length,
            runs: input.context.runs.length,
            runtimeRunEvents: runs.reduce((total, run) => total + run.eventCount, 0),
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
function collectMessages(runtimeDb, context) {
    if (!context.session)
        return [];
    return Array.from(runtimeDb.iterateMessages(context.clientId, context.sessionId));
}
function buildRunOverviews(runtimeDb, context, diagnosticEvents) {
    return context.runs.map((run) => {
        const events = Array.from(runtimeDb.iterateRunEvents(context.clientId, run.runId, 0));
        const diagnosticsForRun = diagnosticEvents.filter((event) => diagnosticEventRunId(event) === run.runId);
        const firstEventAt = events[0]?.createdAt ?? null;
        const lastEventAt = events.at(-1)?.createdAt ?? null;
        return {
            runId: run.runId,
            sessionId: run.sessionId,
            status: run.status,
            workerId: run.workerId ?? null,
            startedAt: run.startedAt ?? null,
            updatedAt: run.updatedAt,
            endedAt: run.endedAt ?? null,
            error: run.error ?? null,
            model: run.model,
            thinkingLevel: run.thinkingLevel,
            eventCount: events.length,
            eventTypes: countRunEventTypes(events),
            firstEventAt,
            lastEventAt,
            diagnosticEventTypes: countDiagnosticEventTypes(diagnosticsForRun),
        };
    });
}
function buildDiagnosticFindings(input) {
    const findings = [];
    const addFinding = (severity, code, message, evidence) => {
        findings.push({ severity, code, message, evidence });
    };
    if (!input.context.session) {
        addFinding("error", "session_missing", "Runtime session metadata was not found for the requested session.", {
            sessionId: input.context.sessionId,
        });
    }
    const queuedTimeout = input.relevantDiagnostics.find((event) => event.eventType === "agent.remote_run.queued_timeout");
    if (queuedTimeout) {
        addFinding("error", "run_queued_timeout", "Run stayed queued long enough to trigger the client-side queued timeout diagnostic.", diagnosticEvidence(queuedTimeout));
    }
    const workerQueueError = input.globalDiagnostics.find((event) => event.eventType === "worker.queue.claim.error");
    if (workerQueueError) {
        addFinding("error", "worker_queue_error", "A global worker queue claim error was recorded near this export and may explain queued runs.", diagnosticEvidence(workerQueueError));
    }
    const workerStartFailure = input.globalDiagnostics.find((event) => event.eventType === "system.worker.start_failed" || event.eventType === "system.worker.service_start_failed");
    if (workerStartFailure) {
        addFinding("error", "worker_start_failed", "A worker startup failure was recorded near this export and may explain queued runs.", diagnosticEvidence(workerStartFailure));
    }
    const workerFatalError = input.globalDiagnostics.find((event) => event.eventType === "system.worker.uncaught_exception" ||
        event.eventType === "system.worker.unhandled_rejection");
    if (workerFatalError) {
        addFinding("error", "worker_fatal_error", "A fatal worker process error was recorded near this export.", diagnosticEvidence(workerFatalError));
    }
    const workerStartingEvents = input.globalDiagnostics.filter((event) => event.eventType === "system.worker.starting");
    const workerStartedEvents = input.globalDiagnostics.filter((event) => event.eventType === "system.worker.started");
    const recoveredActiveRuns = input.globalDiagnostics.filter((event) => event.eventType === "system.worker.recovered_active_runs" &&
        diagnosticEventNumber(event, "recoveredCount") > 0);
    if (recoveredActiveRuns.length > 0) {
        addFinding("warn", "worker_recovered_active_claims", "Worker startup recovered active Redis claims near this session; repeated nonzero counts can indicate stuck runs blocking new work.", diagnosticEventSeriesEvidence(recoveredActiveRuns));
    }
    if (queuedTimeout && workerStartingEvents.length > 0 && workerStartedEvents.length === 0) {
        addFinding("warn", "worker_start_not_confirmed", "Worker startup was observed, but no worker-started confirmation was recorded before the run timed out in queue.", diagnosticEventSeriesEvidence(workerStartingEvents));
    }
    if (workerStartingEvents.length >= 3) {
        addFinding("warn", "worker_repeated_starting", "Multiple worker startup events were recorded near this session; the worker process or container may be restarting repeatedly.", diagnosticEventSeriesEvidence(workerStartingEvents));
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
            addFinding("error", "run_never_started", "Run was never claimed by a worker before reaching its current status.", {
                runId: run.runId,
                status: run.status,
                updatedAt: run.updatedAt,
                endedAt: run.endedAt,
            });
        }
        const enqueued = input.relevantDiagnostics.find((event) => event.eventType === "agent.run.enqueued" && diagnosticEventRunId(event) === run.runId);
        const claimed = input.relevantDiagnostics.find((event) => event.eventType === "worker.queue.claimed" && diagnosticEventRunId(event) === run.runId);
        if (enqueued && !claimed) {
            addFinding("error", "run_enqueued_but_not_claimed", "Run was written to the Redis queue, but no worker claim for this run was observed in the diagnostic window.", {
                runId: run.runId,
                enqueued: diagnosticEvidence(enqueued),
            });
        }
        if (run.status === "failed") {
            addFinding("error", "run_failed", "Run reached failed status.", {
                runId: run.runId,
                error: run.error,
                endedAt: run.endedAt,
            });
        }
    }
    const providerOrModelDiagnosticsObserved = input.relevantDiagnostics.some((event) => event.category === "provider" ||
        event.category === "model" ||
        event.eventType.startsWith("provider.") ||
        event.eventType.startsWith("model."));
    const hasRuntimeRunEvents = input.runs.some((run) => run.eventCount > 0);
    if (input.runs.length > 0 && !hasRuntimeRunEvents && !providerOrModelDiagnosticsObserved) {
        addFinding("warn", "model_request_not_observed", "No provider/model diagnostics or runtime run events were observed; the request likely did not reach the model layer.", {
            runIds: input.runs.map((run) => run.runId),
            diagnosticEventTypes: countDiagnosticEventTypes(input.relevantDiagnostics),
        });
    }
    const providerOrModelError = input.relevantDiagnostics.find((event) => (event.category === "provider" || event.category === "model") && event.level === "error");
    if (providerOrModelError) {
        addFinding("error", "provider_or_model_error", "Provider/model diagnostic error was recorded for this session.", diagnosticEvidence(providerOrModelError));
    }
    if (input.relevantDiagnostics.length === 0) {
        addFinding("warn", "no_relevant_diagnostic_events", "No relevant diagnostic events were found in this export.", {
            sessionId: input.context.sessionId,
            runIds: input.runs.map((run) => run.runId),
        });
    }
    return findings;
}
function buildDiagnosticTimeline(input) {
    const records = [];
    let order = 0;
    if (input.context.session) {
        records.push({
            timestamp: input.context.session.createdAt,
            source: "runtime",
            kind: "runtime.session",
            order: order++,
            sessionId: input.context.session.sessionId,
            title: input.context.session.title,
            model: input.context.session.model,
            thinkingLevel: input.context.session.thinkingLevel,
        });
    }
    for (const message of collectMessages(input.runtimeDb, input.context)) {
        records.push({
            timestamp: message.createdAt,
            source: "runtime",
            kind: "runtime.message",
            order: order++,
            sessionId: message.sessionId,
            messageId: message.messageId,
            role: message.role,
            payload: message.payload,
        });
    }
    for (const run of input.context.runs) {
        records.push({
            timestamp: run.startedAt ?? run.updatedAt,
            source: "runtime",
            kind: "runtime.run",
            order: order++,
            runId: run.runId,
            sessionId: run.sessionId,
            status: run.status,
            workerId: run.workerId ?? null,
            startedAt: run.startedAt ?? null,
            updatedAt: run.updatedAt,
            endedAt: run.endedAt ?? null,
            error: run.error ?? null,
        });
        for (const event of input.runtimeDb.iterateRunEvents(input.context.clientId, run.runId, 0)) {
            records.push({
                timestamp: event.createdAt,
                source: "runtime",
                kind: "runtime.run_event",
                order: order++,
                runId: event.runId,
                sessionId: event.sessionId,
                seq: event.seq,
                type: event.type,
                payload: event.payload,
            });
        }
    }
    const runIds = new Set(input.context.runs.map((run) => run.runId));
    for (const event of input.diagnostics.iterateExportEvents(diagnosticContextQuery(input.context, input.maxDiagnosticEvents))) {
        if (!isRelevantDiagnosticEvent(event, input.context, runIds))
            continue;
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
function isRelevantDiagnosticEvent(event, context, runIds) {
    if (event.sessionId === context.sessionId || event.traceId === context.sessionId)
        return true;
    const dataSessionId = stringField(event.data.sessionId) ?? stringField(event.data.session_id);
    if (dataSessionId === context.sessionId)
        return true;
    const dataRunId = diagnosticEventRunId(event);
    if (dataRunId && runIds.has(dataRunId))
        return true;
    return !event.sessionId;
}
function diagnosticContextQuery(context, maxDiagnosticEvents) {
    return {
        ...diagnosticContextWindow(context),
        maxEvents: maxDiagnosticEvents,
        order: "asc",
    };
}
function diagnosticContextWindow(context) {
    const timestamps = [];
    addTimestampMillis(timestamps, context.session?.createdAt);
    addTimestampMillis(timestamps, context.session?.updatedAt);
    for (const run of context.runs) {
        addTimestampMillis(timestamps, run.startedAt);
        addTimestampMillis(timestamps, run.updatedAt);
        addTimestampMillis(timestamps, run.endedAt);
    }
    if (timestamps.length === 0)
        return {};
    const since = new Date(Math.min(...timestamps) - DIAGNOSTIC_CONTEXT_PADDING_MS).toISOString();
    const until = new Date(Math.max(...timestamps) + DIAGNOSTIC_CONTEXT_PADDING_MS).toISOString();
    return { since, until };
}
function addTimestampMillis(timestamps, value) {
    if (!value)
        return;
    const millis = Date.parse(value);
    if (Number.isFinite(millis))
        timestamps.push(millis);
}
function diagnosticEventRunId(event) {
    return stringField(event.data.runId) ?? stringField(event.data.run_id);
}
function diagnosticEventNumber(event, key) {
    const value = event.data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function diagnosticEvidence(event) {
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
function diagnosticEventSeriesEvidence(events) {
    const first = events[0];
    const last = events.at(-1);
    return {
        count: events.length,
        first: first ? diagnosticEvidence(first) : null,
        last: last ? diagnosticEvidence(last) : null,
    };
}
function countRunEventTypes(events) {
    const counts = {};
    for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
    return counts;
}
function countDiagnosticEventTypes(events) {
    const counts = {};
    for (const event of events) {
        counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
    }
    return counts;
}
function countDiagnosticLevels(events) {
    const counts = {};
    for (const event of events) {
        counts[event.level] = (counts[event.level] ?? 0) + 1;
    }
    return counts;
}
function compareTimelineRecords(left, right) {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
    }
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    if (timestampOrder !== 0)
        return timestampOrder;
    return left.order - right.order;
}
function stringField(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function jsonEntry(path, kind, value) {
    return {
        path,
        kind,
        *chunks() {
            yield `${JSON.stringify(value(), null, 2)}\n`;
        },
    };
}
function ndjsonEntry(path, kind, values) {
    return {
        path,
        kind,
        *chunks() {
            for (const value of values()) {
                yield `${JSON.stringify(value)}\n`;
            }
        },
    };
}
function summarizeRunEvents(runId, events) {
    let totalEvents = 0;
    let payloadBytes = 0;
    let largestPayloadBytes = 0;
    let firstSeq;
    let lastSeq;
    const eventTypes = {};
    for (const event of events) {
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
function diagnosticExportFilename(sessionId, runId, extension) {
    const id = safeFilenamePart(runId ?? sessionId ?? "logs");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pi-diagnostics-${id}-${timestamp}.${extension}`;
}
function safeFilenamePart(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "logs";
}
const encoder = new TextEncoder();
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;
async function* zipArchive(entries) {
    const centralDirectory = [];
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
function zipLocalHeader(name) {
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
function zipDataDescriptor(crc, size) {
    assertZip32(size);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    return descriptor;
}
function zipCentralDirectoryHeader(name, entry) {
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
function zipEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
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
function assertZip16(value) {
    if (value > 0xffff)
        throw new Error("Diagnostic archive has too many files for ZIP32.");
}
function assertZip32(value) {
    if (value > 0xffffffff)
        throw new Error("Diagnostic archive file is too large for ZIP32.");
}
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    CRC32_TABLE[index] = value >>> 0;
}
function crc32Start() {
    return 0xffffffff;
}
function crc32Update(current, chunk) {
    let crc = current;
    for (const byte of chunk) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return crc >>> 0;
}
function crc32Finish(current) {
    return (current ^ 0xffffffff) >>> 0;
}
//# sourceMappingURL=diagnostic-export-service.js.map