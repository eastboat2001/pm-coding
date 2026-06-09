import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isObject } from "./json.js";
import type {
	AppendMessageInput,
	AppendRunEventInput,
	CreateRunInput,
	CreateSessionInput,
	JsonObject,
	RunStatus,
	RunStatusPatch,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionRecord,
} from "./types.js";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["cancelled", "completed", "failed", "interrupted"]);

type SessionRow = {
	session_id: string;
	client_id: string;
	title: string;
	model_json: string;
	thinking_level: string;
	created_at: string;
	updated_at: string;
	last_run_status: RunStatus | null;
	last_run_id: string | null;
};

type MessageRow = {
	id: number;
	session_id: string;
	client_id: string;
	role: string;
	payload_json: string;
	created_at: string;
};

type RunRow = {
	run_id: string;
	session_id: string;
	client_id: string;
	status: RunStatus;
	worker_id: string | null;
	model_json: string;
	thinking_level: string;
	started_at: string | null;
	updated_at: string;
	ended_at: string | null;
	error: string | null;
};

type RunEventRow = {
	id: number;
	run_id: string;
	session_id: string;
	client_id: string;
	seq: number;
	event_type: string;
	payload_json: string;
	created_at: string;
};

type SeqRow = {
	seq: number;
};

export class RuntimeDbStore {
	private database: DatabaseSync | undefined;

	constructor(private readonly dbFile: string) {}

	ensureSchema(): void {
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
		`);
	}

	close(): void {
		this.database?.close();
		this.database = undefined;
	}

	upsertClient(clientId: string): void {
		const timestamp = now();
		this.open()
			.prepare(
				`INSERT INTO clients (client_id, created_at, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(client_id) DO UPDATE SET updated_at = excluded.updated_at`,
			)
			.run(clientId, timestamp, timestamp);
	}

	createSession(input: CreateSessionInput): RuntimeSessionRecord {
		const createdAt = input.createdAt ?? now();
		const updatedAt = input.updatedAt ?? createdAt;
		this.upsertClient(input.clientId);
		this.open()
			.prepare(
				`INSERT INTO sessions (
					session_id,
					client_id,
					title,
					model_json,
					thinking_level,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.sessionId,
				input.clientId,
				input.title,
				JSON.stringify(input.model),
				input.thinkingLevel,
				createdAt,
				updatedAt,
			);
		return requiredRecord(this.getSession(input.clientId, input.sessionId), "session");
	}

	listSessions(clientId: string): RuntimeSessionRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT session_id, client_id, title, model_json, thinking_level, created_at, updated_at, last_run_status, last_run_id
				FROM sessions
				WHERE client_id = ?
				ORDER BY updated_at DESC, session_id ASC`,
			)
			.all(clientId) as SessionRow[];
		return rows.map(toSessionRecord);
	}

	getSession(clientId: string, sessionId: string): RuntimeSessionRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT session_id, client_id, title, model_json, thinking_level, created_at, updated_at, last_run_status, last_run_id
				FROM sessions
				WHERE client_id = ? AND session_id = ?`,
			)
			.get(clientId, sessionId) as SessionRow | undefined;
		return row ? toSessionRecord(row) : undefined;
	}

	appendMessage(input: AppendMessageInput): RuntimeMessageRecord {
		const createdAt = input.createdAt ?? now();
		const db = this.open();
		const row = this.writeTransaction(db, () => {
			db.prepare(
				`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?)`,
			).run(input.sessionId, input.clientId, input.role, JSON.stringify(input.payload), createdAt);
			db.prepare("UPDATE sessions SET updated_at = ? WHERE client_id = ? AND session_id = ?").run(
				createdAt,
				input.clientId,
				input.sessionId,
			);
			return db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
		});
		return requiredRecord(this.getMessage(input.clientId, row.id), "message");
	}

	listMessages(clientId: string, sessionId: string): RuntimeMessageRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND session_id = ?
				ORDER BY id ASC`,
			)
			.all(clientId, sessionId) as MessageRow[];
		return rows.map(toMessageRecord);
	}

	getRun(clientId: string, runId: string): RuntimeRunRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ? AND run_id = ?`,
			)
			.get(clientId, runId) as RunRow | undefined;
		return row ? toRunRecord(row) : undefined;
	}

	getRunById(runId: string): RuntimeRunRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE run_id = ?
				ORDER BY updated_at DESC, client_id ASC
				LIMIT 1`,
			)
			.get(runId) as RunRow | undefined;
		return row ? toRunRecord(row) : undefined;
	}

	listRuns(clientId: string): RuntimeRunRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ?
				ORDER BY updated_at DESC, run_id ASC`,
			)
			.all(clientId) as RunRow[];
		return rows.map(toRunRecord);
	}

	listRunsForSession(clientId: string, sessionId: string): RuntimeRunRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE client_id = ? AND session_id = ?
				ORDER BY updated_at DESC, run_id ASC`,
			)
			.all(clientId, sessionId) as RunRow[];
		return rows.map(toRunRecord);
	}

	listRunsByStatus(status: RunStatus, workerId?: string): RuntimeRunRecord[] {
		const sql =
			workerId === undefined
				? `SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
					FROM runs
					WHERE status = ?
					ORDER BY updated_at ASC, run_id ASC`
				: `SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
					FROM runs
					WHERE status = ? AND worker_id = ?
					ORDER BY updated_at ASC, run_id ASC`;
		const rows =
			workerId === undefined
				? (this.open().prepare(sql).all(status) as RunRow[])
				: (this.open().prepare(sql).all(status, workerId) as RunRow[]);
		return rows.map(toRunRecord);
	}

	listRunningRunsByWorker(workerId: string): RuntimeRunRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error
				FROM runs
				WHERE worker_id = ? AND status IN ('running', 'cancelling')
				ORDER BY updated_at ASC, run_id ASC`,
			)
			.all(workerId) as RunRow[];
		return rows.map(toRunRecord);
	}

	createRun(input: CreateRunInput): RuntimeRunRecord {
		const updatedAt = input.createdAt ?? now();
		const db = this.open();
		this.writeTransaction(db, () => {
			db.prepare(
				`INSERT INTO runs (
					run_id,
					session_id,
					client_id,
					status,
					model_json,
					thinking_level,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.runId,
				input.sessionId,
				input.clientId,
				"queued",
				JSON.stringify(input.model),
				input.thinkingLevel,
				updatedAt,
			);
			this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", updatedAt);
		});
		return requiredRecord(this.getRun(input.clientId, input.runId), "run");
	}

	updateRunStatus(runId: string, clientId: string, status: RunStatus, patch: RunStatusPatch = {}): RuntimeRunRecord {
		const current = requiredRecord(this.getRun(clientId, runId), "run");
		const updatedAt = patch.updatedAt ?? now();
		const workerId = status === "running" ? (patch.workerId ?? current.workerId) : current.workerId;
		const startedAt = status === "running" ? (patch.startedAt ?? current.startedAt ?? updatedAt) : current.startedAt;
		const endedAt = TERMINAL_RUN_STATUSES.has(status) ? (patch.endedAt ?? updatedAt) : current.endedAt;
		const error = TERMINAL_RUN_STATUSES.has(status) ? (patch.error ?? current.error) : current.error;
		const db = this.open();
		this.writeTransaction(db, () => {
			db.prepare(
				`UPDATE runs
					SET status = ?, worker_id = ?, started_at = ?, updated_at = ?, ended_at = ?, error = ?
					WHERE client_id = ? AND run_id = ?`,
			).run(status, workerId ?? null, startedAt ?? null, updatedAt, endedAt ?? null, error ?? null, clientId, runId);
			this.updateSessionRun(clientId, current.sessionId, runId, status, updatedAt);
		});
		return requiredRecord(this.getRun(clientId, runId), "run");
	}

	appendRunEvent(input: AppendRunEventInput): RuntimeRunEventRecord {
		const createdAt = input.createdAt ?? now();
		const db = this.open();
		const row = this.writeTransaction(db, () => {
			const run = requiredRecord(this.getRun(input.clientId, input.runId), "run");
			if (run.sessionId !== input.sessionId) throw new Error("Run event session does not match run session");
			const seqRow = db
				.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE client_id = ? AND run_id = ?")
				.get(input.clientId, input.runId) as SeqRow;
			db.prepare(
				`INSERT INTO run_events (run_id, session_id, client_id, seq, event_type, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.runId,
				run.sessionId,
				input.clientId,
				seqRow.seq,
				input.type,
				JSON.stringify(input.payload),
				createdAt,
			);
			return db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
		});
		return requiredRecord(this.getRunEvent(input.clientId, row.id), "run event");
	}

	listRunEvents(clientId: string, runId: string, afterSeq: number): RuntimeRunEventRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND seq > ?
				ORDER BY seq ASC`,
			)
			.all(clientId, runId, afterSeq) as RunEventRow[];
		return rows.map(toRunEventRecord);
	}

	deleteSession(clientId: string, sessionId: string): boolean {
		const db = this.open();
		return this.writeTransaction(db, () => {
			db.prepare("DELETE FROM run_events WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
			db.prepare("DELETE FROM runs WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
			db.prepare("DELETE FROM messages WHERE client_id = ? AND session_id = ?").run(clientId, sessionId);
			const result = db
				.prepare("DELETE FROM sessions WHERE client_id = ? AND session_id = ?")
				.run(clientId, sessionId);
			return Number(result.changes) > 0;
		});
	}

	private open(): DatabaseSync {
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

	private getMessage(clientId: string, messageId: number): RuntimeMessageRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND id = ?`,
			)
			.get(clientId, messageId) as MessageRow | undefined;
		return row ? toMessageRecord(row) : undefined;
	}

	private getRunEvent(clientId: string, eventId: number): RuntimeRunEventRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND id = ?`,
			)
			.get(clientId, eventId) as RunEventRow | undefined;
		return row ? toRunEventRecord(row) : undefined;
	}

	private updateSessionRun(
		clientId: string,
		sessionId: string,
		runId: string,
		status: RunStatus,
		updatedAt: string,
	): void {
		this.open()
			.prepare(
				`UPDATE sessions
				SET updated_at = ?, last_run_status = ?, last_run_id = ?
				WHERE client_id = ? AND session_id = ?`,
			)
			.run(updatedAt, status, runId, clientId, sessionId);
	}

	private writeTransaction<T>(db: DatabaseSync, callback: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}

function toSessionRecord(row: SessionRow): RuntimeSessionRecord {
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

function toMessageRecord(row: MessageRow): RuntimeMessageRecord {
	return {
		messageId: row.id,
		sessionId: row.session_id,
		clientId: row.client_id,
		role: row.role,
		payload: parseJsonObject(row.payload_json),
		createdAt: row.created_at,
	};
}

function toRunRecord(row: RunRow): RuntimeRunRecord {
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

function toRunEventRecord(row: RunEventRow): RuntimeRunEventRecord {
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

function parseJsonObject(value: string): JsonObject {
	const parsed = JSON.parse(value) as unknown;
	return isObject(parsed) ? parsed : {};
}

function requiredRecord<T>(record: T | undefined, label: string): T {
	if (!record) throw new Error(`Runtime ${label} not found`);
	return record;
}

function now(): string {
	return new Date().toISOString();
}
