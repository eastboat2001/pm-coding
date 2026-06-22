import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isObject } from "./json.js";
import { LangfuseDiagnosticExporter } from "./langfuse-exporter.js";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 50000;
const MAX_EXPORT_LIMIT = 200000;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 200;
const MAX_DEPTH = 8;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;
export class WorkspaceDiagnosticLogService {
    config;
    database;
    langfuse;
    constructor(config, options = {}) {
        this.config = config;
        this.langfuse = new LangfuseDiagnosticExporter(config, options);
    }
    ensureDirs() {
        mkdirSync(dirname(this.config.logsDbFile), { recursive: true });
    }
    status() {
        if (!this.config.loggingEnabled) {
            return {
                enabled: false,
                databaseFile: this.config.logsDbFile,
                eventCount: 0,
                rawProviderLoggingEnabled: this.config.rawProviderLoggingEnabled,
                rawProviderLogMaxChars: this.config.rawProviderLogMaxChars,
                promptSnapshotLoggingEnabled: this.config.promptSnapshotLoggingEnabled,
                promptSnapshotMaxChars: this.config.promptSnapshotMaxChars,
                modelOutputSnapshotLoggingEnabled: this.config.modelOutputSnapshotLoggingEnabled,
                modelOutputSnapshotMaxChars: this.config.modelOutputSnapshotMaxChars,
                modelStreamIdleTimeoutMs: this.config.modelStreamIdleTimeoutMs,
                logRetentionDays: this.config.logRetentionDays,
                logMaxEvents: this.config.logMaxEvents,
                ...this.langfuse.status(),
            };
        }
        if (!existsSync(this.config.logsDbFile)) {
            return {
                enabled: true,
                databaseFile: this.config.logsDbFile,
                eventCount: 0,
                rawProviderLoggingEnabled: this.config.rawProviderLoggingEnabled,
                rawProviderLogMaxChars: this.config.rawProviderLogMaxChars,
                promptSnapshotLoggingEnabled: this.config.promptSnapshotLoggingEnabled,
                promptSnapshotMaxChars: this.config.promptSnapshotMaxChars,
                modelOutputSnapshotLoggingEnabled: this.config.modelOutputSnapshotLoggingEnabled,
                modelOutputSnapshotMaxChars: this.config.modelOutputSnapshotMaxChars,
                modelStreamIdleTimeoutMs: this.config.modelStreamIdleTimeoutMs,
                logRetentionDays: this.config.logRetentionDays,
                logMaxEvents: this.config.logMaxEvents,
                ...this.langfuse.status(),
            };
        }
        const row = this.open().prepare("SELECT COUNT(*) AS count FROM diagnostic_events").get();
        return {
            enabled: true,
            databaseFile: this.config.logsDbFile,
            eventCount: row?.count ?? 0,
            rawProviderLoggingEnabled: this.config.rawProviderLoggingEnabled,
            rawProviderLogMaxChars: this.config.rawProviderLogMaxChars,
            promptSnapshotLoggingEnabled: this.config.promptSnapshotLoggingEnabled,
            promptSnapshotMaxChars: this.config.promptSnapshotMaxChars,
            modelOutputSnapshotLoggingEnabled: this.config.modelOutputSnapshotLoggingEnabled,
            modelOutputSnapshotMaxChars: this.config.modelOutputSnapshotMaxChars,
            modelStreamIdleTimeoutMs: this.config.modelStreamIdleTimeoutMs,
            logRetentionDays: this.config.logRetentionDays,
            logMaxEvents: this.config.logMaxEvents,
            ...(this.getMetadata("last_cleanup_at") ? { lastCleanupAt: this.getMetadata("last_cleanup_at") } : {}),
            ...(this.getMetadata("last_vacuum_at") ? { lastVacuumAt: this.getMetadata("last_vacuum_at") } : {}),
            ...this.langfuse.status(),
        };
    }
    writeEvents(request) {
        if (!this.config.loggingEnabled)
            return { accepted: 0, dropped: request.events?.length ?? 0 };
        const events = Array.isArray(request.events) ? request.events : [];
        if (events.length === 0)
            return { accepted: 0, dropped: 0 };
        const insert = this.open().prepare(`
			INSERT INTO diagnostic_events (
				timestamp,
				client_id,
				level,
				category,
				event_type,
				session_id,
				trace_id,
				span_id,
				parent_span_id,
				request_id,
				provider,
				model,
				duration_ms,
				data_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
        let accepted = 0;
        const normalizedEvents = [];
        for (const event of events) {
            const normalized = normalizeEvent(event);
            normalizedEvents.push(normalized);
            insert.run(normalized.timestamp, normalized.clientId ?? null, normalized.level, normalized.category, normalized.eventType, normalized.sessionId ?? null, normalized.traceId ?? null, normalized.spanId ?? null, normalized.parentSpanId ?? null, normalized.requestId ?? null, normalized.provider ?? null, normalized.model ?? null, normalized.durationMs ?? null, JSON.stringify(normalized.data));
            accepted += 1;
            this.writeStdoutSummary(normalized);
        }
        this.langfuse.enqueue(normalizedEvents);
        this.cleanupAfterWrite();
        return { accepted, dropped: events.length - accepted };
    }
    async flushLangfuse() {
        await this.langfuse.flush();
    }
    close() {
        this.database?.close();
        this.database = undefined;
    }
    queryEvents(query = {}) {
        if (!this.config.loggingEnabled || !existsSync(this.config.logsDbFile))
            return { events: [] };
        const clauses = [];
        const values = [];
        addClause(clauses, values, "client_id", stringField(query.clientId));
        addClause(clauses, values, "session_id", stringField(query.sessionId));
        addClause(clauses, values, "trace_id", stringField(query.traceId));
        addClause(clauses, values, "level", diagnosticLevel(query.level));
        addClause(clauses, values, "category", diagnosticCategory(query.category));
        addClause(clauses, values, "event_type", stringField(query.eventType));
        const limit = clampLimit(query.limit);
        values.push(limit);
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.open()
            .prepare(`SELECT id, timestamp, client_id, level, category, event_type, session_id, trace_id, span_id, parent_span_id, request_id, provider, model, duration_ms, data_json
				FROM diagnostic_events
				${where}
				ORDER BY id DESC
				LIMIT ?`)
            .all(...values);
        return { events: rows.map(toRecord) };
    }
    exportEvents(query = {}) {
        const limit = clampExportLimit(query.maxEvents ?? query.limit);
        if (!this.config.loggingEnabled || !existsSync(this.config.logsDbFile)) {
            return { events: [], total: 0, exported: 0, truncated: false, limit };
        }
        const clauses = [];
        const values = [];
        addClause(clauses, values, "client_id", stringField(query.clientId));
        addClause(clauses, values, "session_id", stringField(query.sessionId));
        addClause(clauses, values, "trace_id", stringField(query.traceId));
        addClause(clauses, values, "level", diagnosticLevel(query.level));
        addClause(clauses, values, "category", diagnosticCategory(query.category));
        addClause(clauses, values, "event_type", stringField(query.eventType));
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const countRow = this.open()
            .prepare(`SELECT COUNT(*) AS count FROM diagnostic_events ${where}`)
            .get(...values);
        const rows = this.open()
            .prepare(`SELECT id, timestamp, client_id, level, category, event_type, session_id, trace_id, span_id, parent_span_id, request_id, provider, model, duration_ms, data_json
				FROM diagnostic_events
				${where}
				ORDER BY id ASC
				LIMIT ?`)
            .all(...values, limit);
        const total = countRow?.count ?? rows.length;
        return {
            events: rows.map(toRecord),
            total,
            exported: rows.length,
            truncated: rows.length < total,
            limit,
        };
    }
    open() {
        if (!this.database) {
            this.ensureDirs();
            this.database = new DatabaseSync(this.config.logsDbFile);
            this.database.exec(`
				CREATE TABLE IF NOT EXISTS diagnostic_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					timestamp TEXT NOT NULL,
					client_id TEXT,
					level TEXT NOT NULL,
					category TEXT NOT NULL,
					event_type TEXT NOT NULL,
					session_id TEXT,
					trace_id TEXT,
					span_id TEXT,
					parent_span_id TEXT,
					request_id TEXT,
					provider TEXT,
					model TEXT,
					duration_ms INTEGER,
					data_json TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_timestamp ON diagnostic_events(timestamp);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_session_id ON diagnostic_events(session_id);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_trace_id ON diagnostic_events(trace_id);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_level ON diagnostic_events(level);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_category ON diagnostic_events(category);
				CREATE INDEX IF NOT EXISTS idx_diagnostic_events_event_type ON diagnostic_events(event_type);
				CREATE TABLE IF NOT EXISTS diagnostic_metadata (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
			`);
            this.ensureClientIdColumn();
            this.database.exec("CREATE INDEX IF NOT EXISTS idx_diagnostic_events_client_id ON diagnostic_events(client_id);");
        }
        return this.database;
    }
    ensureClientIdColumn() {
        const db = this.open();
        const columns = db.prepare("PRAGMA table_info(diagnostic_events)").all();
        if (columns.some((column) => column.name === "client_id"))
            return;
        db.exec("ALTER TABLE diagnostic_events ADD COLUMN client_id TEXT;");
    }
    cleanupAfterWrite() {
        try {
            this.cleanupIfNeeded(Date.now());
        }
        catch (error) {
            if (this.config.logStdoutEnabled) {
                console.warn(`[pi-diagnostics] warn system.log_cleanup.error session=- trace=- ${errorMessage(error)}`);
            }
        }
    }
    cleanupIfNeeded(nowMs) {
        if (this.config.logRetentionDays <= 0 && this.config.logMaxEvents <= 0)
            return;
        const lastCleanupAt = metadataMillis(this.getMetadata("last_cleanup_at"));
        if (lastCleanupAt !== undefined &&
            this.config.logCleanupIntervalMs > 0 &&
            nowMs - lastCleanupAt < this.config.logCleanupIntervalMs) {
            return;
        }
        let deleted = 0;
        if (this.config.logRetentionDays > 0) {
            const cutoff = new Date(nowMs - this.config.logRetentionDays * 24 * 60 * 60 * 1000).toISOString();
            deleted += runChanges(this.open().prepare("DELETE FROM diagnostic_events WHERE timestamp < ?").run(cutoff));
        }
        if (this.config.logMaxEvents > 0) {
            deleted += runChanges(this.open()
                .prepare(`DELETE FROM diagnostic_events
						WHERE id NOT IN (
							SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT ?
						)`)
                .run(this.config.logMaxEvents));
        }
        this.setMetadata("last_cleanup_at", new Date(nowMs).toISOString());
        if (deleted > 0)
            this.vacuumIfNeeded(nowMs);
    }
    vacuumIfNeeded(nowMs) {
        if (this.config.logVacuumIntervalMs <= 0)
            return;
        const lastVacuumAt = metadataMillis(this.getMetadata("last_vacuum_at"));
        if (lastVacuumAt !== undefined &&
            this.config.logVacuumIntervalMs > 0 &&
            nowMs - lastVacuumAt < this.config.logVacuumIntervalMs) {
            return;
        }
        this.open().exec("PRAGMA optimize; VACUUM;");
        this.setMetadata("last_vacuum_at", new Date(nowMs).toISOString());
    }
    getMetadata(key) {
        const row = this.open().prepare("SELECT value FROM diagnostic_metadata WHERE key = ?").get(key);
        return row?.value;
    }
    setMetadata(key, value) {
        this.open()
            .prepare(`INSERT INTO diagnostic_metadata (key, value)
				VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(key, value);
    }
    writeStdoutSummary(event) {
        if (!this.config.logStdoutEnabled || (event.level !== "warn" && event.level !== "error"))
            return;
        const message = `[pi-diagnostics] ${event.level} ${event.category}.${event.eventType} session=${event.sessionId ?? "-"} trace=${event.traceId ?? "-"}`;
        if (event.level === "error") {
            console.error(message);
            return;
        }
        console.warn(message);
    }
}
function metadataMillis(value) {
    if (!value)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function runChanges(result) {
    const record = result;
    return typeof record.changes === "number" ? record.changes : 0;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function normalizeEvent(event) {
    const data = isObject(event.data) ? event.data : {};
    return {
        timestamp: isoTimestamp(event.timestamp) ?? new Date().toISOString(),
        clientId: stringField(event.clientId) ?? stringField(data.clientId),
        level: diagnosticLevel(event.level) ?? "info",
        category: diagnosticCategory(event.category) ?? "system",
        eventType: stringField(event.eventType) ?? "event",
        sessionId: stringField(event.sessionId),
        traceId: stringField(event.traceId),
        spanId: stringField(event.spanId),
        parentSpanId: stringField(event.parentSpanId),
        requestId: stringField(event.requestId),
        provider: stringField(event.provider),
        model: stringField(event.model),
        durationMs: integerField(event.durationMs),
        data: sanitizeJsonObject(data),
    };
}
function toRecord(row) {
    const parsed = JSON.parse(row.data_json);
    const data = isObject(parsed) ? parsed : {};
    return {
        id: row.id,
        timestamp: row.timestamp,
        ...(row.client_id ? { clientId: row.client_id } : {}),
        level: row.level,
        category: row.category,
        eventType: row.event_type,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.trace_id ? { traceId: row.trace_id } : {}),
        ...(row.span_id ? { spanId: row.span_id } : {}),
        ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
        ...(row.request_id ? { requestId: row.request_id } : {}),
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
        data,
    };
}
function sanitizeJsonObject(value) {
    const sanitized = sanitizeJsonValue(value, 0);
    return isObject(sanitized) ? sanitized : {};
}
function sanitizeJsonValue(value, depth, key = "") {
    if (SENSITIVE_KEY_PATTERN.test(key))
        return REDACTED;
    if (depth > MAX_DEPTH)
        return "[max-depth]";
    if (typeof value === "string")
        return truncateString(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return value;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeJsonValue(item, depth + 1));
    }
    if (isObject(value)) {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
            result[childKey] = sanitizeJsonValue(childValue, depth + 1, childKey);
        }
        return result;
    }
    if (value === undefined)
        return undefined;
    return String(value);
}
function truncateString(value) {
    if (value.length <= MAX_STRING_LENGTH)
        return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}
function isoTimestamp(value) {
    const timestamp = stringField(value);
    if (!timestamp)
        return undefined;
    const millis = Date.parse(timestamp);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}
function stringField(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function integerField(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}
function diagnosticLevel(value) {
    return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : undefined;
}
function diagnosticCategory(value) {
    if (value === "agent" ||
        value === "handoff" ||
        value === "model" ||
        value === "project" ||
        value === "provider" ||
        value === "skill" ||
        value === "storage" ||
        value === "system" ||
        value === "tool") {
        return value;
    }
    return undefined;
}
function clampLimit(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.round(value)));
}
function clampExportLimit(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return DEFAULT_EXPORT_LIMIT;
    return Math.min(MAX_EXPORT_LIMIT, Math.max(1, Math.round(value)));
}
function addClause(clauses, values, column, value) {
    if (!value)
        return;
    clauses.push(`${column} = ?`);
    values.push(value);
}
//# sourceMappingURL=diagnostic-log-service.js.map