import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_V2_ARTIFACT_COLUMNS, AGENT_V2_DIAGNOSTIC_COLUMNS, AGENT_V2_DOCUMENT_COLUMNS, AGENT_V2_RUN_COLUMNS, AGENT_V2_TASK_COLUMNS, AGENT_V2_VALIDATION_COLUMNS, applyAgentV2RunUpdate, buildAgentV2Artifact, buildAgentV2Document, buildAgentV2Run, buildAgentV2Task, buildAgentV2Validation, stringifyAgentV2Json, toAgentV2ArtifactRecord, toAgentV2DiagnosticRecord, toAgentV2DocumentRecord, toAgentV2RunRecord, toAgentV2TaskRecord, toAgentV2ValidationRecord, } from "./agent-v2-store.js";
import { AGENT_V2_SCHEMA_VERSION } from "./agent-v2-types.js";
import { isObject } from "./json.js";
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed", "interrupted"]);
const LEGACY_RESET_TABLES = [
    "app_preview_goal_events",
    "app_preview_goals",
    "run_events",
    "messages",
    "runs",
    "sessions",
];
const AGENT_V2_RESET_TABLES = [
    "agent_v2_diagnostics",
    "agent_v2_validations",
    "agent_v2_documents",
    "agent_v2_artifacts",
    "agent_v2_tasks",
    "agent_v2_runs",
    "agent_v2_schema_metadata",
];
export class RuntimeDbStore {
    dbFile;
    database;
    constructor(dbFile) {
        this.dbFile = dbFile;
    }
    ensureSchema() {
        mkdirSync(dirname(this.dbFile), { recursive: true });
        this.open().exec(`
			PRAGMA foreign_keys = ON;

			CREATE TABLE IF NOT EXISTS clients (
				client_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				title TEXT NOT NULL,
				model_json TEXT NOT NULL,
				thinking_level TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_run_status TEXT,
				last_run_id TEXT,
				PRIMARY KEY (client_id, session_id),
				FOREIGN KEY (client_id) REFERENCES clients(client_id)
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_client_updated ON sessions(client_id, updated_at DESC);

			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				role TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			);
			CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(client_id, session_id, id);

			CREATE TABLE IF NOT EXISTS runs (
				run_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				status TEXT NOT NULL,
				worker_id TEXT,
				model_json TEXT NOT NULL,
				thinking_level TEXT NOT NULL,
				started_at TEXT,
				updated_at TEXT NOT NULL,
				ended_at TEXT,
				error TEXT,
				PRIMARY KEY (client_id, run_id),
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			);
			CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(client_id, session_id, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);

			CREATE TABLE IF NOT EXISTS run_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE (client_id, run_id, seq),
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id),
				FOREIGN KEY (client_id, run_id) REFERENCES runs(client_id, run_id)
			);
			CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(client_id, run_id, seq);

			CREATE TABLE IF NOT EXISTS app_preview_goals (
				goal_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				source TEXT NOT NULL,
				status TEXT NOT NULL,
				max_continuation_runs INTEGER NOT NULL,
				continuation_runs_used INTEGER NOT NULL,
				retry_attempts_used INTEGER NOT NULL,
				last_run_id TEXT,
				last_preview_url TEXT,
				last_failure_reason TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				PRIMARY KEY (client_id, session_id),
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			);
			CREATE INDEX IF NOT EXISTS idx_app_preview_goals_status ON app_preview_goals(status, updated_at);

			CREATE TABLE IF NOT EXISTS app_preview_goal_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				goal_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				run_id TEXT,
				event_type TEXT NOT NULL,
				reason_code TEXT,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			);
			CREATE INDEX IF NOT EXISTS idx_app_preview_goal_events_goal ON app_preview_goal_events(client_id, session_id, id);
		`);
    }
    ensureAgentV2Schema() {
        mkdirSync(dirname(this.dbFile), { recursive: true });
        const db = this.open();
        db.exec(`
			CREATE TABLE IF NOT EXISTS agent_v2_schema_metadata (
				schema_version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS agent_v2_runs (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				status TEXT NOT NULL,
				phase TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				input_json TEXT NOT NULL,
				model_json TEXT NOT NULL,
				worker_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				started_at TEXT,
				ended_at TEXT,
				error_json TEXT,
				PRIMARY KEY (client_id, run_id),
				FOREIGN KEY (client_id) REFERENCES clients(client_id)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at);

			CREATE TABLE IF NOT EXISTS agent_v2_tasks (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				parent_task_id TEXT,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				depends_on_json TEXT NOT NULL,
				acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
				input_json TEXT NOT NULL,
				output_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				started_at TEXT,
				ended_at TEXT,
				error_json TEXT,
				PRIMARY KEY (client_id, run_id, task_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_v2_tasks_run_updated ON agent_v2_tasks(client_id, run_id, updated_at DESC);

				CREATE TABLE IF NOT EXISTS agent_v2_artifacts (
					client_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
				artifact_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				path TEXT NOT NULL,
				media_type TEXT NOT NULL,
				checksum TEXT NOT NULL,
				version TEXT NOT NULL,
				source_task_id TEXT,
				validation_status TEXT NOT NULL,
				metadata_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, artifact_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
				);
				CREATE INDEX IF NOT EXISTS idx_agent_v2_artifacts_run_updated ON agent_v2_artifacts(client_id, run_id, updated_at DESC);

				CREATE TABLE IF NOT EXISTS agent_v2_documents (
					client_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					document_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					version TEXT NOT NULL,
					content_markdown TEXT NOT NULL,
					content_json TEXT NOT NULL,
					source_task_id TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (client_id, run_id, document_id),
					FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
				);
				CREATE INDEX IF NOT EXISTS idx_agent_v2_documents_run_updated ON agent_v2_documents(client_id, run_id, updated_at DESC);

				CREATE TABLE IF NOT EXISTS agent_v2_validations (
					client_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
				validation_id TEXT NOT NULL,
				task_id TEXT,
				artifact_id TEXT,
				status TEXT NOT NULL,
				summary TEXT NOT NULL,
				details_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, validation_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_v2_validations_run_updated ON agent_v2_validations(client_id, run_id, updated_at DESC);

			CREATE TABLE IF NOT EXISTS agent_v2_diagnostics (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				diagnostic_id TEXT NOT NULL,
				severity TEXT NOT NULL,
				category TEXT NOT NULL,
				code TEXT NOT NULL,
				phase TEXT,
				task_id TEXT,
				artifact_id TEXT,
				trace_id TEXT,
				message TEXT NOT NULL,
				data_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, diagnostic_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			);
			CREATE INDEX IF NOT EXISTS idx_agent_v2_diagnostics_run_created ON agent_v2_diagnostics(client_id, run_id, created_at ASC);
			`);
        ensureSqliteColumn(db, "agent_v2_tasks", "acceptance_criteria_json", "TEXT NOT NULL DEFAULT '[]'");
        db.prepare(`INSERT INTO agent_v2_schema_metadata (schema_version, applied_at)
			VALUES (?, ?)
			ON CONFLICT(schema_version) DO NOTHING`).run(AGENT_V2_SCHEMA_VERSION, now());
    }
    close() {
        this.database?.close();
        this.database = undefined;
    }
    upsertClient(clientId) {
        const timestamp = now();
        this.open()
            .prepare(`INSERT INTO clients (client_id, created_at, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(client_id) DO UPDATE SET updated_at = excluded.updated_at`)
            .run(clientId, timestamp, timestamp);
    }
    createSession(input) {
        const createdAt = input.createdAt ?? now();
        const updatedAt = input.updatedAt ?? createdAt;
        this.upsertClient(input.clientId);
        this.open()
            .prepare(`INSERT INTO sessions (
					session_id,
					client_id,
					title,
					model_json,
					thinking_level,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(input.sessionId, input.clientId, input.title, JSON.stringify(input.model), input.thinkingLevel, createdAt, updatedAt);
        return requiredRecord(this.getSession(input.clientId, input.sessionId), "session");
    }
    listSessions(clientId) {
        const rows = this.open()
            .prepare(`SELECT session_id, client_id, title, model_json, thinking_level, created_at, updated_at, last_run_status, last_run_id
				FROM sessions
				WHERE client_id = ?
				ORDER BY updated_at DESC, session_id ASC`)
            .all(clientId);
        return rows.map(toSessionRecord);
    }
    getSession(clientId, sessionId) {
        const row = this.open()
            .prepare(`SELECT session_id, client_id, title, model_json, thinking_level, created_at, updated_at, last_run_status, last_run_id
				FROM sessions
				WHERE client_id = ? AND session_id = ?`)
            .get(clientId, sessionId);
        return row ? toSessionRecord(row) : undefined;
    }
    updateSessionTitle(clientId, sessionId, title) {
        const updatedAt = now();
        this.open()
            .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE client_id = ? AND session_id = ?")
            .run(title, updatedAt, clientId, sessionId);
        return this.getSession(clientId, sessionId);
    }
    appendMessage(input) {
        const createdAt = input.createdAt ?? now();
        const db = this.open();
        const row = this.writeTransaction(db, () => {
            db.prepare(`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?)`).run(input.sessionId, input.clientId, input.role, JSON.stringify(input.payload), createdAt);
            db.prepare("UPDATE sessions SET updated_at = ? WHERE client_id = ? AND session_id = ?").run(createdAt, input.clientId, input.sessionId);
            return db.prepare("SELECT last_insert_rowid() AS id").get();
        });
        return requiredRecord(this.getMessage(input.clientId, row.id), "message");
    }
    listMessages(clientId, sessionId) {
        const rows = this.open()
            .prepare(`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND session_id = ?
				ORDER BY id ASC`)
            .all(clientId, sessionId);
        return rows.map(toMessageRecord);
    }
    getSessionMessageStats(clientId, sessionId) {
        const row = this.open()
            .prepare(`SELECT
					COUNT(*) AS message_count,
					SUM(length(payload_json)) AS total_payload_bytes,
					MAX(length(payload_json)) AS largest_payload_bytes
				FROM messages
				WHERE client_id = ? AND session_id = ?`)
            .get(clientId, sessionId);
        return {
            messageCount: row?.message_count ?? 0,
            totalPayloadBytes: row?.total_payload_bytes ?? 0,
            largestPayloadBytes: row?.largest_payload_bytes ?? 0,
        };
    }
    *iterateMessages(clientId, sessionId) {
        const rows = this.open()
            .prepare(`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND session_id = ?
				ORDER BY id ASC`)
            .iterate(clientId, sessionId);
        for (const row of rows) {
            yield toMessageRecord(row);
        }
    }
    getRun(clientId, runId) {
        const row = this.open()
            .prepare(`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ? AND run_id = ?`)
            .get(clientId, runId);
        return row ? toRunRecord(row) : undefined;
    }
    getRunById(runId) {
        const row = this.open()
            .prepare(`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE run_id = ?
				ORDER BY updated_at DESC, client_id ASC
				LIMIT 1`)
            .get(runId);
        return row ? toRunRecord(row) : undefined;
    }
    listRuns(clientId) {
        const rows = this.open()
            .prepare(`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ?
				ORDER BY updated_at DESC, run_id ASC`)
            .all(clientId);
        return rows.map(toRunRecord);
    }
    listRunsForSession(clientId, sessionId) {
        const rows = this.open()
            .prepare(`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ? AND session_id = ?
				ORDER BY updated_at DESC, run_id ASC`)
            .all(clientId, sessionId);
        return rows.map(toRunRecord);
    }
    listRunsByStatus(status, workerId) {
        const sql = workerId === undefined
            ? `SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
					FROM runs
					WHERE status = ?
					ORDER BY updated_at ASC, run_id ASC`
            : `SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
					FROM runs
					WHERE status = ? AND worker_id = ?
					ORDER BY updated_at ASC, run_id ASC`;
        const rows = workerId === undefined
            ? this.open().prepare(sql).all(status)
            : this.open().prepare(sql).all(status, workerId);
        return rows.map(toRunRecord);
    }
    listRunningRunsByWorker(workerId) {
        const rows = this.open()
            .prepare(`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE worker_id = ? AND status IN ('running', 'cancelling')
				ORDER BY updated_at ASC, run_id ASC`)
            .all(workerId);
        return rows.map(toRunRecord);
    }
    createRun(input) {
        const updatedAt = input.createdAt ?? now();
        const db = this.open();
        this.writeTransaction(db, () => {
            db.prepare(`INSERT INTO runs (
					run_id,
					session_id,
					client_id,
					status,
					model_json,
					thinking_level,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.sessionId, input.clientId, "queued", JSON.stringify(input.model), input.thinkingLevel, updatedAt);
            this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
                model: input.model,
                thinkingLevel: input.thinkingLevel,
            });
        });
        return requiredRecord(this.getRun(input.clientId, input.runId), "run");
    }
    createContinuationRun(input) {
        const updatedAt = input.createdAt ?? now();
        const db = this.open();
        const created = this.writeTransaction(db, () => {
            if (!this.getSession(input.clientId, input.sessionId))
                return false;
            if (this.hasActiveRun(db, input.clientId, input.sessionId))
                return false;
            db.prepare(`INSERT INTO runs (
					run_id,
					session_id,
					client_id,
					status,
					model_json,
					thinking_level,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.sessionId, input.clientId, "queued", JSON.stringify(input.model), input.thinkingLevel, updatedAt);
            this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
                model: input.model,
                thinkingLevel: input.thinkingLevel,
            });
            return true;
        });
        return created ? requiredRecord(this.getRun(input.clientId, input.runId), "run") : undefined;
    }
    createRunWithMessage(input) {
        const createdAt = input.createdAt ?? now();
        const db = this.open();
        let messageId = 0;
        const created = this.writeTransaction(db, () => {
            const existingSession = this.getSession(input.clientId, input.sessionId);
            if (existingSession && this.hasActiveRun(db, input.clientId, input.sessionId)) {
                return false;
            }
            if (!existingSession) {
                this.upsertClient(input.clientId);
                db.prepare(`INSERT INTO sessions (
						session_id,
						client_id,
						title,
						model_json,
						thinking_level,
						created_at,
						updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.sessionId, input.clientId, input.title, JSON.stringify(input.model), input.thinkingLevel, createdAt, createdAt);
            }
            db.prepare(`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?)`).run(input.sessionId, input.clientId, input.messageRole, JSON.stringify(input.payload), createdAt);
            messageId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
            db.prepare(`INSERT INTO runs (
					run_id,
					session_id,
					client_id,
					status,
					model_json,
					thinking_level,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.sessionId, input.clientId, "queued", JSON.stringify(input.model), input.thinkingLevel, createdAt);
            this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", createdAt, {
                model: input.model,
                thinkingLevel: input.thinkingLevel,
            });
            return true;
        });
        if (!created)
            return undefined;
        return {
            session: requiredRecord(this.getSession(input.clientId, input.sessionId), "session"),
            message: requiredRecord(this.getMessage(input.clientId, messageId), "message"),
            run: requiredRecord(this.getRun(input.clientId, input.runId), "run"),
        };
    }
    updateRunStatus(runId, clientId, status, patch = {}) {
        const current = requiredRecord(this.getRun(clientId, runId), "run");
        const updatedAt = patch.updatedAt ?? now();
        const workerId = status === "running" ? (patch.workerId ?? current.workerId) : current.workerId;
        const startedAt = status === "running" ? (patch.startedAt ?? current.startedAt ?? updatedAt) : current.startedAt;
        const endedAt = TERMINAL_RUN_STATUSES.has(status) ? (patch.endedAt ?? updatedAt) : current.endedAt;
        const error = TERMINAL_RUN_STATUSES.has(status) ? (patch.error ?? current.error) : current.error;
        const db = this.open();
        this.writeTransaction(db, () => {
            db.prepare(`UPDATE runs
					SET status = ?, worker_id = ?, started_at = ?, updated_at = ?, ended_at = ?, error = ?
					WHERE client_id = ? AND run_id = ?`).run(status, workerId ?? null, startedAt ?? null, updatedAt, endedAt ?? null, error ?? null, clientId, runId);
            this.updateSessionRun(clientId, current.sessionId, runId, status, updatedAt);
        });
        return requiredRecord(this.getRun(clientId, runId), "run");
    }
    appendRunEvent(input) {
        const createdAt = input.createdAt ?? now();
        const db = this.open();
        const row = this.writeTransaction(db, () => {
            const run = requiredRecord(this.getRun(input.clientId, input.runId), "run");
            if (run.sessionId !== input.sessionId)
                throw new Error("Run event session does not match run session");
            const seq = input.seq ??
                db
                    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE client_id = ? AND run_id = ?")
                    .get(input.clientId, input.runId).seq;
            db.prepare(`INSERT INTO run_events (run_id, session_id, client_id, seq, event_type, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.runId, run.sessionId, input.clientId, seq, input.type, JSON.stringify(input.payload), createdAt);
            db.prepare("UPDATE runs SET updated_at = ? WHERE client_id = ? AND run_id = ?").run(createdAt, input.clientId, input.runId);
            this.updateSessionRun(input.clientId, run.sessionId, run.runId, run.status, createdAt);
            return db.prepare("SELECT last_insert_rowid() AS id").get();
        });
        return requiredRecord(this.getRunEvent(input.clientId, row.id), "run event");
    }
    listRunEvents(clientId, runId, afterSeq) {
        const rows = this.open()
            .prepare(`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND seq > ?
				ORDER BY seq ASC`)
            .all(clientId, runId, afterSeq);
        return rows.map(toRunEventRecord);
    }
    getLatestRunCheckpoint(clientId, runId) {
        const row = this.open()
            .prepare(`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND event_type = 'message_update'
				ORDER BY seq DESC
				LIMIT 1`)
            .get(clientId, runId);
        return row ? toRunEventRecord(row) : undefined;
    }
    *iterateRunEvents(clientId, runId, afterSeq) {
        const rows = this.open()
            .prepare(`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND seq > ?
				ORDER BY seq ASC`)
            .iterate(clientId, runId, afterSeq);
        for (const row of rows) {
            yield toRunEventRecord(row);
        }
    }
    upsertAppPreviewGoal(input) {
        const createdAt = input.createdAt ?? now();
        const updatedAt = input.updatedAt ?? createdAt;
        this.open()
            .prepare(`INSERT INTO app_preview_goals (
					goal_id,
					client_id,
					session_id,
					source,
					status,
					max_continuation_runs,
					continuation_runs_used,
					retry_attempts_used,
					last_run_id,
					last_preview_url,
					last_failure_reason,
					created_at,
					updated_at,
					completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id, session_id) DO UPDATE SET
					goal_id = excluded.goal_id,
					source = excluded.source,
					status = excluded.status,
					max_continuation_runs = excluded.max_continuation_runs,
					continuation_runs_used = excluded.continuation_runs_used,
					retry_attempts_used = excluded.retry_attempts_used,
					last_run_id = excluded.last_run_id,
					last_preview_url = excluded.last_preview_url,
					last_failure_reason = excluded.last_failure_reason,
					updated_at = excluded.updated_at,
					completed_at = excluded.completed_at`)
            .run(input.goalId, input.clientId, input.sessionId, input.source, input.status, input.maxContinuationRuns, input.continuationRunsUsed, input.retryAttemptsUsed, input.lastRunId ?? null, input.lastPreviewUrl ?? null, input.lastFailureReason ?? null, createdAt, updatedAt, input.completedAt ?? null);
        return requiredRecord(this.getAppPreviewGoal(input.clientId, input.sessionId), "app preview goal");
    }
    getAppPreviewGoal(clientId, sessionId) {
        const row = this.open()
            .prepare(`SELECT goal_id, client_id, session_id, source, status, max_continuation_runs, continuation_runs_used,
					retry_attempts_used, last_run_id, last_preview_url, last_failure_reason, created_at, updated_at, completed_at
				FROM app_preview_goals
				WHERE client_id = ? AND session_id = ?`)
            .get(clientId, sessionId);
        return row ? toAppPreviewGoalRecord(row) : undefined;
    }
    updateAppPreviewGoal(input) {
        const current = this.getAppPreviewGoal(input.clientId, input.sessionId);
        if (!current)
            return undefined;
        const updatedAt = input.updatedAt ?? now();
        const lastRunId = "lastRunId" in input ? input.lastRunId : current.lastRunId;
        const lastPreviewUrl = "lastPreviewUrl" in input ? input.lastPreviewUrl : current.lastPreviewUrl;
        const lastFailureReason = "lastFailureReason" in input ? input.lastFailureReason : current.lastFailureReason;
        const completedAt = "completedAt" in input ? input.completedAt : current.completedAt;
        this.open()
            .prepare(`UPDATE app_preview_goals
				SET status = ?,
					max_continuation_runs = ?,
					continuation_runs_used = ?,
					retry_attempts_used = ?,
					last_run_id = ?,
					last_preview_url = ?,
					last_failure_reason = ?,
					updated_at = ?,
					completed_at = ?
				WHERE client_id = ? AND session_id = ?`)
            .run(input.status ?? current.status, input.maxContinuationRuns ?? current.maxContinuationRuns, input.continuationRunsUsed ?? current.continuationRunsUsed, input.retryAttemptsUsed ?? current.retryAttemptsUsed, lastRunId ?? null, lastPreviewUrl ?? null, lastFailureReason ?? null, updatedAt, completedAt ?? null, input.clientId, input.sessionId);
        return this.getAppPreviewGoal(input.clientId, input.sessionId);
    }
    appendAppPreviewGoalEvent(input) {
        const createdAt = input.createdAt ?? now();
        const payload = input.payload ?? {};
        const db = this.open();
        const row = this.writeTransaction(db, () => {
            const goal = requiredRecord(this.getAppPreviewGoal(input.clientId, input.sessionId), "app preview goal");
            if (goal.goalId !== input.goalId)
                throw new Error("App preview goal event goal id does not match session goal");
            db.prepare(`INSERT INTO app_preview_goal_events (
					goal_id,
					client_id,
					session_id,
					run_id,
					event_type,
					reason_code,
					payload_json,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.goalId, input.clientId, input.sessionId, input.runId ?? null, input.eventType, input.reasonCode ?? null, JSON.stringify(payload), createdAt);
            return db.prepare("SELECT last_insert_rowid() AS id").get();
        });
        return requiredRecord(this.getAppPreviewGoalEvent(input.clientId, row.id), "app preview goal event");
    }
    listAppPreviewGoalEvents(clientId, sessionId, afterEventId) {
        const rows = this.open()
            .prepare(`SELECT id, goal_id, client_id, session_id, run_id, event_type, reason_code, payload_json, created_at
				FROM app_preview_goal_events
				WHERE client_id = ? AND session_id = ? AND id > ?
				ORDER BY id ASC`)
            .all(clientId, sessionId, afterEventId);
        return rows.map(toAppPreviewGoalEventRecord);
    }
    createAgentV2Run(input) {
        const run = buildAgentV2Run(input);
        this.upsertClient(run.clientId);
        this.open()
            .prepare(`INSERT INTO agent_v2_runs (
					client_id,
					run_id,
					status,
					phase,
					attempt,
					input_json,
					model_json,
					worker_id,
					created_at,
					updated_at,
					started_at,
					ended_at,
					error_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(run.clientId, run.runId, run.status, run.phase, run.attempt, stringifyAgentV2Json(run.input), stringifyAgentV2Json(run.model), run.workerId ?? null, run.createdAt, run.updatedAt, run.startedAt ?? null, run.endedAt ?? null, run.error ? stringifyAgentV2Json(run.error) : null);
        return requiredRecord(this.getAgentV2Run(run.clientId, run.runId), "agent v2 run");
    }
    getAgentV2Run(clientId, runId) {
        const row = this.open()
            .prepare(`SELECT ${AGENT_V2_RUN_COLUMNS} FROM agent_v2_runs WHERE client_id = ? AND run_id = ?`)
            .get(clientId, runId);
        return row ? toAgentV2RunRecord(row) : undefined;
    }
    updateAgentV2Run(input) {
        const current = requiredRecord(this.getAgentV2Run(input.clientId, input.runId), "agent v2 run");
        const next = applyAgentV2RunUpdate(current, input);
        this.open()
            .prepare(`UPDATE agent_v2_runs
				SET status = ?,
					phase = ?,
					attempt = ?,
					worker_id = ?,
					updated_at = ?,
					started_at = ?,
					ended_at = ?,
					error_json = ?
				WHERE client_id = ? AND run_id = ?`)
            .run(next.status, next.phase, next.attempt, next.workerId ?? null, next.updatedAt, next.startedAt ?? null, next.endedAt ?? null, next.error ? stringifyAgentV2Json(next.error) : null, input.clientId, input.runId);
        return requiredRecord(this.getAgentV2Run(input.clientId, input.runId), "agent v2 run");
    }
    upsertAgentV2Task(input) {
        const task = buildAgentV2Task(input);
        this.open()
            .prepare(`INSERT INTO agent_v2_tasks (
					client_id,
					run_id,
					task_id,
					parent_task_id,
					kind,
					title,
					status,
					depends_on_json,
					acceptance_criteria_json,
					input_json,
					output_json,
					created_at,
					updated_at,
					started_at,
					ended_at,
					error_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id, run_id, task_id) DO UPDATE SET
					parent_task_id = excluded.parent_task_id,
					kind = excluded.kind,
					title = excluded.title,
					status = excluded.status,
					depends_on_json = excluded.depends_on_json,
					acceptance_criteria_json = excluded.acceptance_criteria_json,
					input_json = excluded.input_json,
					output_json = excluded.output_json,
					updated_at = excluded.updated_at,
					started_at = excluded.started_at,
					ended_at = excluded.ended_at,
					error_json = excluded.error_json`)
            .run(input.clientId, input.runId, task.taskId, task.parentTaskId ?? null, task.kind, task.title, task.status, stringifyAgentV2Json(task.dependsOn), stringifyAgentV2Json(task.acceptanceCriteria), stringifyAgentV2Json(task.input), stringifyAgentV2Json(task.output), task.createdAt, task.updatedAt, task.startedAt ?? null, task.endedAt ?? null, task.error ? stringifyAgentV2Json(task.error) : null);
        return requiredRecord(this.listAgentV2Tasks(input.clientId, input.runId).find((taskRecord) => taskRecord.taskId === input.taskId), "agent v2 task");
    }
    listAgentV2Tasks(clientId, runId) {
        const rows = this.open()
            .prepare(`SELECT ${AGENT_V2_TASK_COLUMNS}
				FROM agent_v2_tasks
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, task_id ASC`)
            .all(clientId, runId);
        return rows.map(toAgentV2TaskRecord);
    }
    upsertAgentV2Artifact(input) {
        const artifact = buildAgentV2Artifact(input);
        this.open()
            .prepare(`INSERT INTO agent_v2_artifacts (
					client_id,
					run_id,
					artifact_id,
					kind,
					path,
					media_type,
					checksum,
					version,
					source_task_id,
					validation_status,
					metadata_json,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id, run_id, artifact_id) DO UPDATE SET
					kind = excluded.kind,
					path = excluded.path,
					media_type = excluded.media_type,
					checksum = excluded.checksum,
					version = excluded.version,
					source_task_id = excluded.source_task_id,
					validation_status = excluded.validation_status,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at`)
            .run(artifact.clientId, artifact.runId, artifact.artifactId, artifact.kind, artifact.path, artifact.mediaType, artifact.checksum, artifact.version, artifact.sourceTaskId ?? null, artifact.validationStatus, stringifyAgentV2Json(artifact.metadataJson), artifact.createdAt, artifact.updatedAt);
        return requiredRecord(this.listAgentV2Artifacts(input.clientId, input.runId).find((artifactRecord) => artifactRecord.artifactId === input.artifactId), "agent v2 artifact");
    }
    listAgentV2Artifacts(clientId, runId) {
        const rows = this.open()
            .prepare(`SELECT ${AGENT_V2_ARTIFACT_COLUMNS}
				FROM agent_v2_artifacts
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, artifact_id ASC`)
            .all(clientId, runId);
        return rows.map(toAgentV2ArtifactRecord);
    }
    upsertAgentV2Document(input) {
        const document = buildAgentV2Document(input);
        this.open()
            .prepare(`INSERT INTO agent_v2_documents (
					client_id,
					run_id,
					document_id,
					kind,
					version,
					content_markdown,
					content_json,
					source_task_id,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id, run_id, document_id) DO UPDATE SET
					kind = excluded.kind,
					version = excluded.version,
					content_markdown = excluded.content_markdown,
					content_json = excluded.content_json,
					source_task_id = excluded.source_task_id,
					updated_at = excluded.updated_at`)
            .run(document.clientId, document.runId, document.documentId, document.kind, document.version, document.contentMarkdown, stringifyAgentV2Json(document.contentJson), document.sourceTaskId ?? null, document.createdAt, document.updatedAt);
        return requiredRecord(this.getAgentV2Document(input.clientId, input.runId, input.documentId), "agent v2 document");
    }
    listAgentV2Documents(clientId, runId) {
        const rows = this.open()
            .prepare(`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
				FROM agent_v2_documents
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, document_id ASC`)
            .all(clientId, runId);
        return rows.map(toAgentV2DocumentRecord);
    }
    getAgentV2Document(clientId, runId, documentId) {
        const row = this.open()
            .prepare(`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
				FROM agent_v2_documents
				WHERE client_id = ? AND run_id = ? AND document_id = ?`)
            .get(clientId, runId, documentId);
        return row ? toAgentV2DocumentRecord(row) : undefined;
    }
    upsertAgentV2Validation(input) {
        const validation = buildAgentV2Validation(input);
        this.open()
            .prepare(`INSERT INTO agent_v2_validations (
					client_id,
					run_id,
					validation_id,
					task_id,
					artifact_id,
					status,
					summary,
					details_json,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id, run_id, validation_id) DO UPDATE SET
					task_id = excluded.task_id,
					artifact_id = excluded.artifact_id,
					status = excluded.status,
					summary = excluded.summary,
					details_json = excluded.details_json,
					updated_at = excluded.updated_at`)
            .run(validation.clientId, validation.runId, validation.validationId, validation.taskId ?? null, validation.artifactId ?? null, validation.status, validation.summary, stringifyAgentV2Json(validation.details), validation.createdAt, validation.updatedAt);
        return requiredRecord(this.listAgentV2Validations(validation.clientId, validation.runId).find((record) => record.validationId === validation.validationId), "agent v2 validation");
    }
    listAgentV2Validations(clientId, runId) {
        const rows = this.open()
            .prepare(`SELECT ${AGENT_V2_VALIDATION_COLUMNS}
				FROM agent_v2_validations
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, validation_id ASC`)
            .all(clientId, runId);
        return rows.map(toAgentV2ValidationRecord);
    }
    appendAgentV2Diagnostic(input) {
        this.open()
            .prepare(`INSERT INTO agent_v2_diagnostics (
					client_id,
					run_id,
					diagnostic_id,
					severity,
					category,
					code,
					phase,
					task_id,
					artifact_id,
					trace_id,
					message,
					data_json,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.clientId, input.runId, input.diagnosticId, input.severity, input.category, input.code, input.phase ?? null, input.taskId ?? null, input.artifactId ?? null, input.traceId ?? null, input.message, stringifyAgentV2Json(input.data), input.createdAt);
        return requiredRecord(this.listAgentV2Diagnostics(input.clientId, input.runId).find((diagnostic) => diagnostic.diagnosticId === input.diagnosticId), "agent v2 diagnostic");
    }
    listAgentV2Diagnostics(clientId, runId) {
        const rows = this.open()
            .prepare(`SELECT ${AGENT_V2_DIAGNOSTIC_COLUMNS}
				FROM agent_v2_diagnostics
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, diagnostic_id ASC`)
            .all(clientId, runId);
        return rows.map(toAgentV2DiagnosticRecord);
    }
    resetAgentV2RuntimeData(options = {}) {
        this.ensureSchema();
        this.ensureAgentV2Schema();
        const db = this.open();
        const appliedAt = options.now?.() ?? now();
        return this.writeTransaction(db, () => {
            const legacyRowsDeletedBase = deleteAllRows(db, LEGACY_RESET_TABLES);
            const agentV2RowsDeleted = deleteAllRows(db, AGENT_V2_RESET_TABLES);
            const legacyRowsDeleted = {
                ...legacyRowsDeletedBase,
                clients: options.includeClients === true ? deleteAllRows(db, ["clients"]).clients : 0,
            };
            db.prepare("INSERT INTO agent_v2_schema_metadata (schema_version, applied_at) VALUES (?, ?)").run(AGENT_V2_SCHEMA_VERSION, appliedAt);
            return {
                legacyRowsDeleted,
                agentV2RowsDeleted,
                schemaVersion: AGENT_V2_SCHEMA_VERSION,
            };
        });
    }
    deleteSession(clientId, sessionId) {
        const db = this.open();
        return this.writeTransaction(db, () => {
            db.prepare("DELETE FROM app_preview_goal_events WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
            db.prepare("DELETE FROM app_preview_goals WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
            db.prepare("DELETE FROM run_events WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
            db.prepare("DELETE FROM runs WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
            db.prepare("DELETE FROM messages WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
            const result = db
                .prepare("DELETE FROM sessions WHERE client_id = ? AND session_id = ?")
                .run(clientId, sessionId);
            return Number(result.changes) > 0;
        });
    }
    open() {
        if (!this.database) {
            mkdirSync(dirname(this.dbFile), { recursive: true });
            this.database = new DatabaseSync(this.dbFile);
            this.database.exec(`
				PRAGMA journal_mode = WAL;
				PRAGMA busy_timeout = 5000;
				PRAGMA foreign_keys = ON;
			`);
        }
        return this.database;
    }
    getMessage(clientId, messageId) {
        const row = this.open()
            .prepare(`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND id = ?`)
            .get(clientId, messageId);
        return row ? toMessageRecord(row) : undefined;
    }
    getRunEvent(clientId, eventId) {
        const row = this.open()
            .prepare(`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND id = ?`)
            .get(clientId, eventId);
        return row ? toRunEventRecord(row) : undefined;
    }
    getAppPreviewGoalEvent(clientId, eventId) {
        const row = this.open()
            .prepare(`SELECT id, goal_id, client_id, session_id, run_id, event_type, reason_code, payload_json, created_at
				FROM app_preview_goal_events
				WHERE client_id = ? AND id = ?`)
            .get(clientId, eventId);
        return row ? toAppPreviewGoalEventRecord(row) : undefined;
    }
    updateSessionRun(clientId, sessionId, runId, status, updatedAt, context) {
        if (context) {
            this.open()
                .prepare(`UPDATE sessions
					SET updated_at = ?, last_run_status = ?, last_run_id = ?, model_json = ?, thinking_level = ?
					WHERE client_id = ? AND session_id = ?`)
                .run(updatedAt, status, runId, JSON.stringify(context.model), context.thinkingLevel, clientId, sessionId);
            return;
        }
        this.open()
            .prepare(`UPDATE sessions
				SET updated_at = ?, last_run_status = ?, last_run_id = ?
				WHERE client_id = ? AND session_id = ?`)
            .run(updatedAt, status, runId, clientId, sessionId);
    }
    hasActiveRun(db, clientId, sessionId) {
        const row = db
            .prepare(`SELECT 1 AS active
				FROM runs
				WHERE client_id = ? AND session_id = ? AND status IN ('queued', 'running', 'cancelling')
				LIMIT 1`)
            .get(clientId, sessionId);
        return row !== undefined;
    }
    writeTransaction(db, callback) {
        db.exec("BEGIN IMMEDIATE");
        try {
            const result = callback();
            db.exec("COMMIT");
            return result;
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
}
function toSessionRecord(row) {
    return {
        sessionId: row.session_id,
        clientId: row.client_id,
        title: row.title,
        model: parseJsonObject(row.model_json),
        thinkingLevel: row.thinking_level,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.last_run_status ? { lastRunStatus: row.last_run_status } : {}),
        ...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
    };
}
function toMessageRecord(row) {
    return {
        messageId: row.id,
        sessionId: row.session_id,
        clientId: row.client_id,
        role: row.role,
        payload: parseJsonObject(row.payload_json),
        createdAt: row.created_at,
    };
}
function toRunRecord(row) {
    return {
        runId: row.run_id,
        sessionId: row.session_id,
        clientId: row.client_id,
        status: row.status,
        ...(row.worker_id ? { workerId: row.worker_id } : {}),
        model: parseJsonObject(row.model_json),
        thinkingLevel: row.thinking_level,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        updatedAt: row.updated_at,
        ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}
function toRunEventRecord(row) {
    return {
        eventId: row.id,
        runId: row.run_id,
        sessionId: row.session_id,
        clientId: row.client_id,
        seq: row.seq,
        type: row.event_type,
        payload: parseJsonObject(row.payload_json),
        createdAt: row.created_at,
    };
}
function toAppPreviewGoalRecord(row) {
    return {
        goalId: row.goal_id,
        clientId: row.client_id,
        sessionId: row.session_id,
        source: row.source,
        status: row.status,
        maxContinuationRuns: row.max_continuation_runs,
        continuationRunsUsed: row.continuation_runs_used,
        retryAttemptsUsed: row.retry_attempts_used,
        ...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
        ...(row.last_preview_url ? { lastPreviewUrl: row.last_preview_url } : {}),
        ...(row.last_failure_reason ? { lastFailureReason: row.last_failure_reason } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
}
function toAppPreviewGoalEventRecord(row) {
    return {
        eventId: row.id,
        goalId: row.goal_id,
        clientId: row.client_id,
        sessionId: row.session_id,
        ...(row.run_id ? { runId: row.run_id } : {}),
        eventType: row.event_type,
        ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
        payload: parseAppPreviewGoalEventPayload(row.payload_json),
        createdAt: row.created_at,
    };
}
function parseJsonObject(value) {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
}
function parseAppPreviewGoalEventPayload(value) {
    try {
        return parseJsonObject(value);
    }
    catch {
        return {};
    }
}
function requiredRecord(record, label) {
    if (!record)
        throw new Error(`Runtime ${label} not found`);
    return record;
}
function deleteAllRows(db, tables) {
    const counts = {};
    for (const table of tables) {
        const result = db.prepare(`DELETE FROM ${table}`).run();
        counts[table] = Number(result.changes);
    }
    return counts;
}
function ensureSqliteColumn(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column))
        return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function now() {
    return new Date().toISOString();
}
//# sourceMappingURL=runtime-db.js.map