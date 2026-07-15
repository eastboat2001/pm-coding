import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AgentV2DiagnosticEvent, canonicalizeAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type {
	AgentV2CancelRunCommitInput,
	AgentV2CancelRunCommitResult,
	AgentV2DiagnosticCommitInput,
	AgentV2DiagnosticCommitResult,
	AgentV2ExecutionMutationInput,
	AgentV2ExecutionMutationResult,
	AgentV2InputBlobRecord,
	AgentV2InputReferenceRecord,
	AgentV2RunTransitionCommitInput,
	AgentV2RunTransitionCommitResult,
	AgentV2StartRunCommitInput,
	AgentV2StartRunCommitResult,
} from "./agent-v2-durable-store.js";
import {
	agentV2CancelReplayFingerprint,
	agentV2StartReplayFingerprint,
	equalAgentV2ProtocolValues,
	isAgentV2DeterministicExecutionTaskId,
	isCanonicalAgentV2Revision,
	isStrictlyNewerAgentV2Revision,
	matchesAgentV2ExpectedRun,
} from "./agent-v2-durable-store.js";
import type {
	AgentV2OutboxDeliveryInput,
	AgentV2OutboxLeaseInput,
	AgentV2OutboxRecord,
	AgentV2OutboxReference,
	AgentV2OutboxRescheduleInput,
} from "./agent-v2-outbox.js";
import {
	agentV2OutboxIntentId,
	assertAgentV2Timestamp,
	validateAgentV2OutboxDeliveryInput,
	validateAgentV2OutboxLeaseInput,
	validateAgentV2OutboxRescheduleInput,
} from "./agent-v2-outbox.js";
import {
	AGENT_V2_ARTIFACT_COLUMNS,
	AGENT_V2_DIAGNOSTIC_COLUMNS,
	AGENT_V2_DOCUMENT_COLUMNS,
	AGENT_V2_RUN_COLUMNS,
	AGENT_V2_TASK_COLUMNS,
	AGENT_V2_VALIDATION_COLUMNS,
	type AgentV2ArtifactRecord,
	type AgentV2ArtifactRow,
	type AgentV2DiagnosticRow,
	type AgentV2DocumentRecord,
	type AgentV2DocumentRow,
	type AgentV2RunEventRecord,
	type AgentV2RunEventRow,
	type AgentV2RunRow,
	type AgentV2RunUpdateResult,
	type AgentV2TaskRow,
	type AgentV2ValidationRecord,
	type AgentV2ValidationRow,
	type AppendAgentV2RunEventInput,
	type AppendAgentV2ValidationAttemptInput,
	applyAgentV2RunUpdate,
	buildAgentV2Artifact,
	buildAgentV2Document,
	buildAgentV2Run,
	buildAgentV2Task,
	buildAgentV2Validation,
	type CreateAgentV2RunInput,
	equalAgentV2ValidationRecords,
	stringifyAgentV2Json,
	toAgentV2ArtifactRecord,
	toAgentV2DiagnosticRecord,
	toAgentV2DocumentRecord,
	toAgentV2RunRecord,
	toAgentV2TaskRecord,
	toAgentV2ValidationRecord,
	type UpdateAgentV2RunInput,
	type UpsertAgentV2ArtifactInput,
	type UpsertAgentV2DocumentInput,
	type UpsertAgentV2TaskInput,
} from "./agent-v2-store.js";
import {
	AGENT_V2_SCHEMA_INDEXES,
	AGENT_V2_SCHEMA_RESET_REQUIRED,
	AGENT_V2_SCHEMA_TABLES,
	AGENT_V2_SCHEMA_VERSION,
	type AgentV2RunSnapshot,
	type AgentV2TaskNode,
} from "./agent-v2-types.js";
import { isObject } from "./json.js";
import type {
	CreateRunWithMessageInput,
	ResetAgentV2RuntimeDataOptions,
	ResetAgentV2RuntimeDataResult,
	RuntimeStore,
} from "./runtime-store.js";
import type {
	AppendAppPreviewGoalEventInput,
	AppendMessageInput,
	AppendRunEventInput,
	AppPreviewGoalEventRecord,
	AppPreviewGoalEventType,
	AppPreviewGoalRecord,
	AppPreviewGoalSource,
	AppPreviewGoalStatus,
	CreateRunInput,
	CreateSessionInput,
	JsonObject,
	RunStatus,
	RunStatusPatch,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionRecord,
	StartRunResult,
	UpdateAppPreviewGoalInput,
	UpsertAppPreviewGoalInput,
} from "./types.js";

export type { CreateRunWithMessageInput } from "./runtime-store.js";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["cancelled", "completed", "failed", "interrupted"]);
const AGENT_V2_RESET_TABLES = [
	"agent_v2_outbox",
	"agent_v2_input_references",
	"agent_v2_input_blobs",
	"agent_v2_bootstraps",
	"agent_v2_diagnostics",
	"agent_v2_validation_attempts",
	"agent_v2_documents",
	"agent_v2_artifacts",
	"agent_v2_tasks",
	"agent_v2_run_events",
	"agent_v2_runs",
	"agent_v2_schema_metadata",
] as const;
const AGENT_V2_PRE_V2_TABLES = ["agent_v2_validations"] as const;

const SQLITE_AGENT_V2_SCHEMA = `
	CREATE TABLE agent_v2_schema_metadata (
		singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
		schema_version INTEGER NOT NULL CHECK(schema_version = 2),
		applied_at TEXT NOT NULL
	);
	CREATE TABLE agent_v2_runs (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
		phase TEXT NOT NULL CHECK(phase IN ('intake','capability_routing','spec_draft','spec_review','plan_draft','task_generation','implementation','validation','repair','preview','delivery','blocked','failed','cancelled')),
		attempt INTEGER NOT NULL CHECK(attempt >= 0), input_json TEXT NOT NULL, model_json TEXT NOT NULL,
		worker_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, error_json TEXT,
		PRIMARY KEY (client_id, run_id)
	);
	CREATE INDEX idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at);
	CREATE INDEX idx_agent_v2_runs_worker_active ON agent_v2_runs(worker_id, updated_at)
		WHERE worker_id IS NOT NULL AND status IN ('running','cancelling');
	CREATE TABLE agent_v2_run_events (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), event_type TEXT NOT NULL,
		payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, seq),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_tasks (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('pending','ready','running','blocked','succeeded','failed','cancelled')),
		parent_task_id TEXT, depends_on_json TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL,
		input_json TEXT NOT NULL, output_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		started_at TEXT, ended_at TEXT, error_json TEXT, PRIMARY KEY (client_id, run_id, task_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_tasks_run_updated ON agent_v2_tasks(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_artifacts (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
		media_type TEXT NOT NULL, checksum TEXT NOT NULL, version TEXT NOT NULL, validation_status TEXT NOT NULL,
		source_task_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, artifact_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_artifacts_run_updated ON agent_v2_artifacts(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_documents (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, document_id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
		content_markdown TEXT NOT NULL, content_json TEXT NOT NULL, source_task_id TEXT, created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, document_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_documents_run_updated ON agent_v2_documents(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_diagnostics (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, diagnostic_id TEXT NOT NULL, severity TEXT NOT NULL,
		category TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, phase TEXT, task_id TEXT, artifact_id TEXT,
		trace_id TEXT, data_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, diagnostic_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_diagnostics_run_created ON agent_v2_diagnostics(client_id, run_id, created_at, diagnostic_id);
	CREATE TABLE agent_v2_validation_attempts (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, validation_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
		task_id TEXT, artifact_id TEXT, status TEXT NOT NULL CHECK(status IN ('passed','failed','blocked','warning')),
		summary TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, validation_id, attempt),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_validation_attempts_run_created ON agent_v2_validation_attempts(client_id, run_id, created_at, validation_id, attempt);
	CREATE TABLE agent_v2_input_blobs (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, input_id TEXT NOT NULL, logical_path TEXT NOT NULL,
		media_type TEXT NOT NULL, encoding TEXT NOT NULL CHECK(encoding IN ('utf8','binary')), bytes BLOB NOT NULL,
		byte_length INTEGER NOT NULL CHECK(byte_length >= 0), checksum TEXT NOT NULL, created_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, input_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE UNIQUE INDEX uq_agent_v2_input_blobs_logical_path ON agent_v2_input_blobs(client_id, run_id, logical_path);
	CREATE TABLE agent_v2_input_references (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, input_id TEXT NOT NULL, logical_path TEXT NOT NULL,
		media_type TEXT NOT NULL, checksum TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('attachment','project_file')),
		ordinal INTEGER NOT NULL CHECK(ordinal >= 0), display_name TEXT, byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
		PRIMARY KEY (client_id, run_id, kind, ordinal),
		FOREIGN KEY (client_id, run_id, input_id) REFERENCES agent_v2_input_blobs(client_id, run_id, input_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE,
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_bootstraps (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, bootstrap_version TEXT NOT NULL, bootstrap_checksum TEXT NOT NULL,
		created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_outbox (
		intent_id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, client_id TEXT NOT NULL, run_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK(kind IN ('run_enqueue','run_cancel','live_event','workspace_diagnostic','langfuse_diagnostic')),
		status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered','dead_letter')), available_at TEXT NOT NULL,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reference_json TEXT NOT NULL,
		attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), lease_owner TEXT, lease_expires_at TEXT,
		last_error_code TEXT, last_error_message TEXT, delivered_at TEXT,
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE UNIQUE INDEX uq_agent_v2_outbox_dedupe ON agent_v2_outbox(dedupe_key);
	CREATE INDEX idx_agent_v2_outbox_dispatch ON agent_v2_outbox(status, available_at, created_at, intent_id);
	CREATE INDEX idx_agent_v2_outbox_lease ON agent_v2_outbox(status, lease_expires_at, intent_id);
	CREATE INDEX idx_agent_v2_outbox_run ON agent_v2_outbox(client_id, run_id, created_at, intent_id);
`;
const AGENT_V2_RUN_EVENT_COLUMNS = "client_id, run_id, seq, event_type, payload_json, created_at";

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

type MessageStatsRow = {
	message_count: number;
	total_payload_bytes: number | null;
	largest_payload_bytes: number | null;
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

type AppPreviewGoalRow = {
	goal_id: string;
	client_id: string;
	session_id: string;
	source: AppPreviewGoalSource;
	status: AppPreviewGoalStatus;
	max_continuation_runs: number;
	continuation_runs_used: number;
	retry_attempts_used: number;
	last_run_id: string | null;
	last_preview_url: string | null;
	last_failure_reason: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

type AppPreviewGoalEventRow = {
	id: number;
	goal_id: string;
	client_id: string;
	session_id: string;
	run_id: string | null;
	event_type: AppPreviewGoalEventType;
	reason_code: string | null;
	payload_json: string;
	created_at: string;
};

type SeqRow = {
	seq: number;
};

type SessionRunContext = {
	model: JsonObject;
	thinkingLevel: string;
};

export class RuntimeDbStore implements RuntimeStore {
	private database: DatabaseSync | undefined;

	constructor(private readonly dbFile: string) {}

	ensureSchema(): void {
		mkdirSync(dirname(this.dbFile), { recursive: true });
		const db = this.open();
		this.ensureClientIdentitySchema(db);
		db.exec(`
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

	ensureAgentV2Schema(): void {
		mkdirSync(dirname(this.dbFile), { recursive: true });
		const db = this.open();
		const existingTables = sqliteAgentV2ObjectNames(db, "table");
		if (existingTables.length > 0) {
			assertExactSqliteAgentV2Schema(db);
			return;
		}
		this.writeTransaction(db, () => createSqliteAgentV2Schema(db, now()));
	}

	ping(signal: AbortSignal): void {
		if (signal.aborted) throw new Error("agent_v2.readiness_aborted");
		this.open().prepare("SELECT 1").get();
		if (signal.aborted) throw new Error("agent_v2.readiness_aborted");
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

	updateSessionTitle(clientId: string, sessionId: string, title: string): RuntimeSessionRecord | undefined {
		const updatedAt = now();
		this.open()
			.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE client_id = ? AND session_id = ?")
			.run(title, updatedAt, clientId, sessionId);
		return this.getSession(clientId, sessionId);
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

	getSessionMessageStats(
		clientId: string,
		sessionId: string,
	): { messageCount: number; totalPayloadBytes: number; largestPayloadBytes: number } {
		const row = this.open()
			.prepare(
				`SELECT
					COUNT(*) AS message_count,
					SUM(length(payload_json)) AS total_payload_bytes,
					MAX(length(payload_json)) AS largest_payload_bytes
				FROM messages
				WHERE client_id = ? AND session_id = ?`,
			)
			.get(clientId, sessionId) as MessageStatsRow | undefined;
		return {
			messageCount: row?.message_count ?? 0,
			totalPayloadBytes: row?.total_payload_bytes ?? 0,
			largestPayloadBytes: row?.largest_payload_bytes ?? 0,
		};
	}

	*iterateMessages(clientId: string, sessionId: string): Iterable<RuntimeMessageRecord> {
		const rows = this.open()
			.prepare(
				`SELECT id, session_id, client_id, role, payload_json, created_at
				FROM messages
				WHERE client_id = ? AND session_id = ?
				ORDER BY id ASC`,
			)
			.iterate(clientId, sessionId) as Iterable<MessageRow>;
		for (const row of rows) {
			yield toMessageRecord(row);
		}
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
			this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
		});
		return requiredRecord(this.getRun(input.clientId, input.runId), "run");
	}

	createContinuationRun(input: CreateRunInput): RuntimeRunRecord | undefined {
		const updatedAt = input.createdAt ?? now();
		const db = this.open();
		const created = this.writeTransaction(db, () => {
			if (!this.getSession(input.clientId, input.sessionId)) return false;
			if (this.hasActiveRun(db, input.clientId, input.sessionId)) return false;
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
			this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			return true;
		});
		return created ? requiredRecord(this.getRun(input.clientId, input.runId), "run") : undefined;
	}

	createRunWithMessage(input: CreateRunWithMessageInput): StartRunResult | undefined {
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
				db.prepare(
					`INSERT INTO sessions (
						session_id,
						client_id,
						title,
						model_json,
						thinking_level,
						created_at,
						updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).run(
					input.sessionId,
					input.clientId,
					input.title,
					JSON.stringify(input.model),
					input.thinkingLevel,
					createdAt,
					createdAt,
				);
			}
			db.prepare(
				`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?)`,
			).run(input.sessionId, input.clientId, input.messageRole, JSON.stringify(input.payload), createdAt);
			messageId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
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
				createdAt,
			);
			this.updateSessionRun(input.clientId, input.sessionId, input.runId, "queued", createdAt, {
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			return true;
		});
		if (!created) return undefined;
		return {
			session: requiredRecord(this.getSession(input.clientId, input.sessionId), "session"),
			message: requiredRecord(this.getMessage(input.clientId, messageId), "message"),
			run: requiredRecord(this.getRun(input.clientId, input.runId), "run"),
		};
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
			const seq =
				input.seq ??
				(
					db
						.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE client_id = ? AND run_id = ?")
						.get(input.clientId, input.runId) as SeqRow
				).seq;
			db.prepare(
				`INSERT INTO run_events (run_id, session_id, client_id, seq, event_type, payload_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(input.runId, run.sessionId, input.clientId, seq, input.type, JSON.stringify(input.payload), createdAt);
			db.prepare("UPDATE runs SET updated_at = ? WHERE client_id = ? AND run_id = ?").run(
				createdAt,
				input.clientId,
				input.runId,
			);
			this.updateSessionRun(input.clientId, run.sessionId, run.runId, run.status, createdAt);
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

	getLatestRunCheckpoint(clientId: string, runId: string): RuntimeRunEventRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND event_type = 'message_update'
				ORDER BY seq DESC
				LIMIT 1`,
			)
			.get(clientId, runId) as RunEventRow | undefined;
		return row ? toRunEventRecord(row) : undefined;
	}

	*iterateRunEvents(clientId: string, runId: string, afterSeq: number): Iterable<RuntimeRunEventRecord> {
		const rows = this.open()
			.prepare(
				`SELECT id, run_id, session_id, client_id, seq, event_type, payload_json, created_at
				FROM run_events
				WHERE client_id = ? AND run_id = ? AND seq > ?
				ORDER BY seq ASC`,
			)
			.iterate(clientId, runId, afterSeq) as Iterable<RunEventRow>;
		for (const row of rows) {
			yield toRunEventRecord(row);
		}
	}

	upsertAppPreviewGoal(input: UpsertAppPreviewGoalInput): AppPreviewGoalRecord {
		const createdAt = input.createdAt ?? now();
		const updatedAt = input.updatedAt ?? createdAt;
		this.open()
			.prepare(
				`INSERT INTO app_preview_goals (
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
					completed_at = excluded.completed_at`,
			)
			.run(
				input.goalId,
				input.clientId,
				input.sessionId,
				input.source,
				input.status,
				input.maxContinuationRuns,
				input.continuationRunsUsed,
				input.retryAttemptsUsed,
				input.lastRunId ?? null,
				input.lastPreviewUrl ?? null,
				input.lastFailureReason ?? null,
				createdAt,
				updatedAt,
				input.completedAt ?? null,
			);
		return requiredRecord(this.getAppPreviewGoal(input.clientId, input.sessionId), "app preview goal");
	}

	getAppPreviewGoal(clientId: string, sessionId: string): AppPreviewGoalRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT goal_id, client_id, session_id, source, status, max_continuation_runs, continuation_runs_used,
					retry_attempts_used, last_run_id, last_preview_url, last_failure_reason, created_at, updated_at, completed_at
				FROM app_preview_goals
				WHERE client_id = ? AND session_id = ?`,
			)
			.get(clientId, sessionId) as AppPreviewGoalRow | undefined;
		return row ? toAppPreviewGoalRecord(row) : undefined;
	}

	updateAppPreviewGoal(input: UpdateAppPreviewGoalInput): AppPreviewGoalRecord | undefined {
		const current = this.getAppPreviewGoal(input.clientId, input.sessionId);
		if (!current) return undefined;
		const updatedAt = input.updatedAt ?? now();
		const lastRunId = "lastRunId" in input ? input.lastRunId : current.lastRunId;
		const lastPreviewUrl = "lastPreviewUrl" in input ? input.lastPreviewUrl : current.lastPreviewUrl;
		const lastFailureReason = "lastFailureReason" in input ? input.lastFailureReason : current.lastFailureReason;
		const completedAt = "completedAt" in input ? input.completedAt : current.completedAt;
		this.open()
			.prepare(
				`UPDATE app_preview_goals
				SET status = ?,
					max_continuation_runs = ?,
					continuation_runs_used = ?,
					retry_attempts_used = ?,
					last_run_id = ?,
					last_preview_url = ?,
					last_failure_reason = ?,
					updated_at = ?,
					completed_at = ?
				WHERE client_id = ? AND session_id = ?`,
			)
			.run(
				input.status ?? current.status,
				input.maxContinuationRuns ?? current.maxContinuationRuns,
				input.continuationRunsUsed ?? current.continuationRunsUsed,
				input.retryAttemptsUsed ?? current.retryAttemptsUsed,
				lastRunId ?? null,
				lastPreviewUrl ?? null,
				lastFailureReason ?? null,
				updatedAt,
				completedAt ?? null,
				input.clientId,
				input.sessionId,
			);
		return this.getAppPreviewGoal(input.clientId, input.sessionId);
	}

	appendAppPreviewGoalEvent(input: AppendAppPreviewGoalEventInput): AppPreviewGoalEventRecord {
		const createdAt = input.createdAt ?? now();
		const payload = input.payload ?? {};
		const db = this.open();
		const row = this.writeTransaction(db, () => {
			const goal = requiredRecord(this.getAppPreviewGoal(input.clientId, input.sessionId), "app preview goal");
			if (goal.goalId !== input.goalId)
				throw new Error("App preview goal event goal id does not match session goal");
			db.prepare(
				`INSERT INTO app_preview_goal_events (
					goal_id,
					client_id,
					session_id,
					run_id,
					event_type,
					reason_code,
					payload_json,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.goalId,
				input.clientId,
				input.sessionId,
				input.runId ?? null,
				input.eventType,
				input.reasonCode ?? null,
				JSON.stringify(payload),
				createdAt,
			);
			return db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
		});
		return requiredRecord(this.getAppPreviewGoalEvent(input.clientId, row.id), "app preview goal event");
	}

	listAppPreviewGoalEvents(clientId: string, sessionId: string, afterEventId: number): AppPreviewGoalEventRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT id, goal_id, client_id, session_id, run_id, event_type, reason_code, payload_json, created_at
				FROM app_preview_goal_events
				WHERE client_id = ? AND session_id = ? AND id > ?
				ORDER BY id ASC`,
			)
			.all(clientId, sessionId, afterEventId) as AppPreviewGoalEventRow[];
		return rows.map(toAppPreviewGoalEventRecord);
	}

	createAgentV2Run(input: CreateAgentV2RunInput): AgentV2RunSnapshot {
		const run = buildAgentV2Run(input);
		this.open()
			.prepare(
				`INSERT INTO agent_v2_runs (
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
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				run.clientId,
				run.runId,
				run.status,
				run.phase,
				run.attempt,
				stringifyAgentV2Json(run.input),
				stringifyAgentV2Json(run.model),
				run.workerId ?? null,
				run.createdAt,
				run.updatedAt,
				run.startedAt ?? null,
				run.endedAt ?? null,
				run.error ? stringifyAgentV2Json(run.error) : null,
			);
		return requiredRecord(this.getAgentV2Run(run.clientId, run.runId), "agent v2 run");
	}

	getAgentV2Run(clientId: string, runId: string): AgentV2RunSnapshot | undefined {
		const row = this.open()
			.prepare(`SELECT ${AGENT_V2_RUN_COLUMNS} FROM agent_v2_runs WHERE client_id = ? AND run_id = ?`)
			.get(clientId, runId) as unknown as AgentV2RunRow | undefined;
		return row ? toAgentV2RunRecord(row) : undefined;
	}

	listAgentV2Runs(clientId: string): AgentV2RunSnapshot[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_RUN_COLUMNS}
				FROM agent_v2_runs
				WHERE client_id = ?
				ORDER BY updated_at DESC, run_id ASC`,
			)
			.all(clientId) as unknown as AgentV2RunRow[];
		return rows.map(toAgentV2RunRecord);
	}

	listAgentV2RunsByWorker(workerId: string): AgentV2RunSnapshot[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_RUN_COLUMNS}
				FROM agent_v2_runs
				WHERE worker_id = ? AND status IN ('running', 'cancelling')
				ORDER BY updated_at ASC, run_id ASC`,
			)
			.all(workerId) as unknown as AgentV2RunRow[];
		return rows.map(toAgentV2RunRecord);
	}

	updateAgentV2Run(input: UpdateAgentV2RunInput): AgentV2RunSnapshot {
		return this.updateAgentV2RunWithResult(input).run;
	}

	updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): AgentV2RunUpdateResult {
		const db = this.open();
		return this.writeTransaction(db, () => {
			const currentRow = db
				.prepare(`SELECT ${AGENT_V2_RUN_COLUMNS} FROM agent_v2_runs WHERE client_id = ? AND run_id = ?`)
				.get(input.clientId, input.runId) as unknown as AgentV2RunRow | undefined;
			const current = requiredRecord(currentRow ? toAgentV2RunRecord(currentRow) : undefined, "agent v2 run");
			if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
				return { run: current, applied: false };
			}
			const next = applyAgentV2RunUpdate(current, input);
			db.prepare(
				`UPDATE agent_v2_runs
					SET status = ?,
						phase = ?,
						attempt = ?,
						worker_id = ?,
						updated_at = ?,
						started_at = ?,
						ended_at = ?,
						error_json = ?
					WHERE client_id = ? AND run_id = ?`,
			).run(
				next.status,
				next.phase,
				next.attempt,
				next.workerId ?? null,
				next.updatedAt,
				next.startedAt ?? null,
				next.endedAt ?? null,
				next.error ? stringifyAgentV2Json(next.error) : null,
				input.clientId,
				input.runId,
			);
			const updatedRow = db
				.prepare(`SELECT ${AGENT_V2_RUN_COLUMNS} FROM agent_v2_runs WHERE client_id = ? AND run_id = ?`)
				.get(input.clientId, input.runId) as unknown as AgentV2RunRow | undefined;
			return {
				run: requiredRecord(updatedRow ? toAgentV2RunRecord(updatedRow) : undefined, "agent v2 run"),
				applied: true,
			};
		});
	}

	appendAgentV2RunEvent(input: AppendAgentV2RunEventInput): AgentV2RunEventRecord {
		const createdAt = input.createdAt ?? now();
		const db = this.open();
		const event = this.writeTransaction(db, () => {
			requiredRecord(this.getAgentV2Run(input.clientId, input.runId), "agent v2 run");
			const seq =
				input.seq ??
				(
					db
						.prepare(
							"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_v2_run_events WHERE client_id = ? AND run_id = ?",
						)
						.get(input.clientId, input.runId) as SeqRow
				).seq;
			db.prepare(
				`INSERT INTO agent_v2_run_events (
					client_id,
					run_id,
					seq,
					event_type,
					payload_json,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			).run(input.clientId, input.runId, seq, input.type, stringifyAgentV2Json(input.payload), createdAt);
			return requiredRecord(
				this.listAgentV2RunEvents(input.clientId, input.runId, seq - 1).find((record) => record.seq === seq),
				"agent v2 run event",
			);
		});
		return event;
	}

	listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): AgentV2RunEventRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_RUN_EVENT_COLUMNS}
				FROM agent_v2_run_events
				WHERE client_id = ? AND run_id = ? AND seq > ?
				ORDER BY seq ASC`,
			)
			.all(clientId, runId, afterSeq) as unknown as AgentV2RunEventRow[];
		return rows.map(toAgentV2RunEventRecord);
	}

	upsertAgentV2Task(input: UpsertAgentV2TaskInput): AgentV2TaskNode {
		const task = buildAgentV2Task(input);
		this.open()
			.prepare(
				`INSERT INTO agent_v2_tasks (
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
					error_json = excluded.error_json`,
			)
			.run(
				input.clientId,
				input.runId,
				task.taskId,
				task.parentTaskId ?? null,
				task.kind,
				task.title,
				task.status,
				stringifyAgentV2Json(task.dependsOn),
				stringifyAgentV2Json(task.acceptanceCriteria),
				stringifyAgentV2Json(task.input),
				stringifyAgentV2Json(task.output),
				task.createdAt,
				task.updatedAt,
				task.startedAt ?? null,
				task.endedAt ?? null,
				task.error ? stringifyAgentV2Json(task.error) : null,
			);
		return requiredRecord(
			this.listAgentV2Tasks(input.clientId, input.runId).find((taskRecord) => taskRecord.taskId === input.taskId),
			"agent v2 task",
		);
	}

	listAgentV2Tasks(clientId: string, runId: string): AgentV2TaskNode[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_TASK_COLUMNS}
				FROM agent_v2_tasks
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, task_id ASC`,
			)
			.all(clientId, runId) as unknown as AgentV2TaskRow[];
		return rows.map(toAgentV2TaskRecord);
	}

	upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInput): AgentV2ArtifactRecord {
		const artifact = buildAgentV2Artifact(input);
		this.open()
			.prepare(
				`INSERT INTO agent_v2_artifacts (
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
					updated_at = excluded.updated_at`,
			)
			.run(
				artifact.clientId,
				artifact.runId,
				artifact.artifactId,
				artifact.kind,
				artifact.path,
				artifact.mediaType,
				artifact.checksum,
				artifact.version,
				artifact.sourceTaskId ?? null,
				artifact.validationStatus,
				stringifyAgentV2Json(artifact.metadataJson),
				artifact.createdAt,
				artifact.updatedAt,
			);
		return requiredRecord(
			this.listAgentV2Artifacts(input.clientId, input.runId).find(
				(artifactRecord) => artifactRecord.artifactId === input.artifactId,
			),
			"agent v2 artifact",
		);
	}

	listAgentV2Artifacts(clientId: string, runId: string): AgentV2ArtifactRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_ARTIFACT_COLUMNS}
				FROM agent_v2_artifacts
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, artifact_id ASC`,
			)
			.all(clientId, runId) as unknown as AgentV2ArtifactRow[];
		return rows.map(toAgentV2ArtifactRecord);
	}

	upsertAgentV2Document(input: UpsertAgentV2DocumentInput): AgentV2DocumentRecord {
		const document = buildAgentV2Document(input);
		this.open()
			.prepare(
				`INSERT INTO agent_v2_documents (
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
					updated_at = excluded.updated_at`,
			)
			.run(
				document.clientId,
				document.runId,
				document.documentId,
				document.kind,
				document.version,
				document.contentMarkdown,
				stringifyAgentV2Json(document.contentJson),
				document.sourceTaskId ?? null,
				document.createdAt,
				document.updatedAt,
			);
		return requiredRecord(
			this.getAgentV2Document(input.clientId, input.runId, input.documentId),
			"agent v2 document",
		);
	}

	listAgentV2Documents(clientId: string, runId: string): AgentV2DocumentRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
				FROM agent_v2_documents
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, document_id ASC`,
			)
			.all(clientId, runId) as unknown as AgentV2DocumentRow[];
		return rows.map(toAgentV2DocumentRecord);
	}

	getAgentV2Document(clientId: string, runId: string, documentId: string): AgentV2DocumentRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
				FROM agent_v2_documents
				WHERE client_id = ? AND run_id = ? AND document_id = ?`,
			)
			.get(clientId, runId, documentId) as unknown as AgentV2DocumentRow | undefined;
		return row ? toAgentV2DocumentRecord(row) : undefined;
	}

	appendAgentV2ValidationAttempt(input: AppendAgentV2ValidationAttemptInput): AgentV2ValidationRecord {
		const validation = buildAgentV2Validation(input);
		const existing = this.listAgentV2Validations(validation.clientId, validation.runId).find(
			(record) => record.validationId === validation.validationId && record.attempt === validation.attempt,
		);
		if (existing) {
			if (equalAgentV2ValidationRecords(existing, validation)) return existing;
			throw new Error("Agent v2 validation attempt conflict");
		}
		this.open()
			.prepare(
				`INSERT INTO agent_v2_validation_attempts (
					client_id,
					run_id,
					validation_id,
					attempt,
					task_id,
					artifact_id,
					status,
					summary,
					details_json,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				validation.clientId,
				validation.runId,
				validation.validationId,
				validation.attempt,
				validation.taskId ?? null,
				validation.artifactId ?? null,
				validation.status,
				validation.summary,
				stringifyAgentV2Json(validation.details),
				validation.createdAt,
				validation.updatedAt,
			);
		return requiredRecord(
			this.listAgentV2Validations(validation.clientId, validation.runId).find(
				(record) => record.validationId === validation.validationId && record.attempt === validation.attempt,
			),
			"agent v2 validation",
		);
	}

	listAgentV2Validations(clientId: string, runId: string): AgentV2ValidationRecord[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_VALIDATION_COLUMNS}
				FROM agent_v2_validation_attempts
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, validation_id ASC, attempt ASC`,
			)
			.all(clientId, runId) as unknown as AgentV2ValidationRow[];
		return rows.map(toAgentV2ValidationRecord);
	}

	appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): AgentV2DiagnosticEvent {
		input = canonicalizeAgentV2DiagnosticEvent(input);
		this.open()
			.prepare(
				`INSERT INTO agent_v2_diagnostics (
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
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.clientId,
				input.runId,
				input.diagnosticId,
				input.severity,
				input.category,
				input.code,
				input.phase ?? null,
				input.taskId ?? null,
				input.artifactId ?? null,
				input.traceId ?? null,
				input.message,
				stringifyAgentV2Json(input.data),
				input.createdAt,
			);
		return requiredRecord(
			this.listAgentV2Diagnostics(input.clientId, input.runId).find(
				(diagnostic) => diagnostic.diagnosticId === input.diagnosticId,
			),
			"agent v2 diagnostic",
		);
	}

	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2DiagnosticEvent[] {
		const rows = this.open()
			.prepare(
				`SELECT ${AGENT_V2_DIAGNOSTIC_COLUMNS}
				FROM agent_v2_diagnostics
				WHERE client_id = ? AND run_id = ?
				ORDER BY created_at ASC, diagnostic_id ASC`,
			)
			.all(clientId, runId) as unknown as AgentV2DiagnosticRow[];
		return rows.map(toAgentV2DiagnosticRecord);
	}

	commitAgentV2RunStart(input: AgentV2StartRunCommitInput): AgentV2StartRunCommitResult {
		assertAgentV2Timestamp(input.createdAt, "createdAt");
		const initialRun = buildAgentV2Run(input.run);
		const initialTasks = input.tasks.map(buildAgentV2Task);
		if (
			!isCanonicalAgentV2Revision(input.createdAt) ||
			!isCanonicalAgentV2Revision(initialRun.createdAt) ||
			!isCanonicalAgentV2Revision(initialRun.updatedAt) ||
			Date.parse(initialRun.updatedAt) < Date.parse(initialRun.createdAt) ||
			initialTasks.some(
				(task) =>
					!isCanonicalAgentV2Revision(task.createdAt) ||
					!isCanonicalAgentV2Revision(task.updatedAt) ||
					Date.parse(task.updatedAt) < Date.parse(task.createdAt),
			)
		)
			throw new Error("Agent v2 run start revision must be a canonical UTC millisecond timestamp");
		const db = this.open();
		return this.writeTransaction(db, () => {
			if (
				[...input.documents, ...input.tasks, ...input.artifacts, ...input.diagnostics].some(
					(child) => child.clientId !== input.run.clientId || child.runId !== input.run.runId,
				)
			)
				throw new Error("Agent v2 run start child identity mismatch");
			const startFingerprint = agentV2StartReplayFingerprint(input);
			const existing = this.getAgentV2RunWithDatabase(db, input.run.clientId, input.run.runId);
			if (existing) {
				const expected = buildAgentV2Run(input.run);
				const bootstrap = db
					.prepare(
						"SELECT bootstrap_version, bootstrap_checksum FROM agent_v2_bootstraps WHERE client_id=? AND run_id=?",
					)
					.get(input.run.clientId, input.run.runId) as
					| { bootstrap_version: string; bootstrap_checksum: string }
					| undefined;
				if (
					existing.createdAt !== expected.createdAt ||
					!equalAgentV2ProtocolValues(existing.input, expected.input) ||
					!equalAgentV2ProtocolValues(existing.model, expected.model) ||
					bootstrap?.bootstrap_version !== input.bootstrapVersion ||
					bootstrap.bootstrap_checksum !== startFingerprint
				)
					throw new Error("Agent v2 run start replay conflict");
				const events = this.listAgentV2RunEventsWithDatabase(db, input.run.clientId, input.run.runId, 0);
				const runCreatedEvent = events[0];
				const planningReadyEvent = events[1];
				if (
					!runCreatedEvent ||
					!planningReadyEvent ||
					runCreatedEvent.seq !== 1 ||
					runCreatedEvent.type !== "agent_v2.run_created" ||
					runCreatedEvent.createdAt !== input.createdAt ||
					!equalAgentV2ProtocolValues(runCreatedEvent.payload, {
						type: "agent_v2.run_created",
						status: "queued",
						phase: "intake",
						attempt: 1,
						at: input.createdAt,
					}) ||
					planningReadyEvent.seq !== 2 ||
					planningReadyEvent.type !== "agent_v2.planning_ready" ||
					planningReadyEvent.createdAt !== input.createdAt ||
					!equalAgentV2ProtocolValues(planningReadyEvent.payload, {
						type: "agent_v2.planning_ready",
						phase: input.readyPhase,
						at: input.createdAt,
					})
				)
					throw new Error("Agent v2 run start replay conflict");
				const outboxIntentIds = startOutboxReferences(input).map((reference) => {
					const intentId = agentV2OutboxIntentId(outboxDedupeKey(input.run.clientId, input.run.runId, reference));
					const intent = this.getAgentV2OutboxWithDatabase(db, intentId);
					if (
						!intent ||
						intent.clientId !== input.run.clientId ||
						intent.runId !== input.run.runId ||
						!equalAgentV2ProtocolValues(intent.reference, reference)
					)
						throw new Error("Agent v2 run start replay conflict");
					return intentId;
				});
				return {
					run: existing,
					runCreatedEvent,
					planningReadyEvent,
					outboxIntentIds,
					replayed: true,
				};
			}

			const run = buildAgentV2Run(input.run);
			db.prepare(`INSERT INTO agent_v2_runs (
				client_id, run_id, status, phase, attempt, input_json, model_json, worker_id,
				created_at, updated_at, started_at, ended_at, error_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				run.clientId,
				run.runId,
				run.status,
				input.readyPhase,
				run.attempt,
				stringifyAgentV2Json(run.input),
				stringifyAgentV2Json(run.model),
				run.workerId ?? null,
				run.createdAt,
				run.updatedAt,
				run.startedAt ?? null,
				run.endedAt ?? null,
				run.error ? stringifyAgentV2Json(run.error) : null,
			);
			for (const blob of input.inputBlobs)
				this.insertAgentV2InputBlobWithDatabase(db, blob, run.clientId, run.runId);
			for (const reference of input.inputReferences)
				this.insertAgentV2InputReferenceWithDatabase(db, reference, run.clientId, run.runId);
			db.prepare(
				"INSERT INTO agent_v2_bootstraps (client_id, run_id, bootstrap_version, bootstrap_checksum, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(run.clientId, run.runId, input.bootstrapVersion, startFingerprint, input.createdAt);
			for (const document of input.documents) this.upsertAgentV2DocumentWithDatabase(db, document);
			for (const task of input.tasks) this.upsertAgentV2TaskWithDatabase(db, task);
			for (const artifact of input.artifacts) this.upsertAgentV2ArtifactWithDatabase(db, artifact);
			for (const diagnostic of input.diagnostics) this.appendAgentV2DiagnosticWithDatabase(db, diagnostic);

			const runCreatedEvent = this.appendAgentV2RunEventWithDatabase(db, {
				clientId: run.clientId,
				runId: run.runId,
				seq: 1,
				type: "agent_v2.run_created",
				payload: {
					type: "agent_v2.run_created",
					status: run.status,
					phase: run.phase,
					attempt: run.attempt,
					at: input.createdAt,
				},
				createdAt: input.createdAt,
			});
			const planningReadyEvent = this.appendAgentV2RunEventWithDatabase(db, {
				clientId: run.clientId,
				runId: run.runId,
				seq: 2,
				type: "agent_v2.planning_ready",
				payload: { type: "agent_v2.planning_ready", phase: input.readyPhase, at: input.createdAt },
				createdAt: input.createdAt,
			});
			const outboxIntentIds = [
				this.insertAgentV2OutboxWithDatabase(
					db,
					run.clientId,
					run.runId,
					{ kind: "live_event", eventSeq: 1 },
					input.createdAt,
				),
				this.insertAgentV2OutboxWithDatabase(
					db,
					run.clientId,
					run.runId,
					{ kind: "live_event", eventSeq: 2 },
					input.createdAt,
				),
			];
			for (const diagnostic of input.diagnostics)
				outboxIntentIds.push(...this.insertDiagnosticOutboxWithDatabase(db, diagnostic));
			outboxIntentIds.push(
				this.insertAgentV2OutboxWithDatabase(
					db,
					run.clientId,
					run.runId,
					{ kind: "run_enqueue", queueName: input.queueName },
					input.createdAt,
				),
			);
			return {
				run: requiredRecord(this.getAgentV2RunWithDatabase(db, run.clientId, run.runId), "agent v2 run"),
				runCreatedEvent,
				planningReadyEvent,
				outboxIntentIds,
				replayed: false,
			};
		});
	}

	commitAgentV2RunTransition(input: AgentV2RunTransitionCommitInput): AgentV2RunTransitionCommitResult {
		if (
			input.diagnostic &&
			(input.diagnostic.clientId !== input.update.clientId || input.diagnostic.runId !== input.update.runId)
		) {
			throw new Error("Agent v2 run transition child identity mismatch");
		}
		const db = this.open();
		return this.writeTransaction(db, () => {
			const current = requiredRecord(
				this.getAgentV2RunWithDatabase(db, input.update.clientId, input.update.runId),
				"agent v2 run",
			);
			if (
				!input.update.expectedStatuses?.includes(current.status) ||
				!matchesAgentV2ExpectedRun(current, input.expectedRun) ||
				!isCanonicalAgentV2Revision(input.expectedRun.updatedAt) ||
				!isStrictlyNewerAgentV2Revision(input.update.updatedAt, current.updatedAt)
			) {
				return { update: { run: current, applied: false }, outboxIntentIds: [] };
			}
			const next = applyAgentV2RunUpdate(current, input.update);
			this.updateAgentV2RunWithDatabase(db, next);
			const event = this.appendAgentV2RunEventWithDatabase(db, {
				clientId: current.clientId,
				runId: current.runId,
				type: String(input.event.type),
				payload: input.event.payload as Record<string, unknown>,
				...(typeof input.event.createdAt === "string" ? { createdAt: input.event.createdAt } : {}),
			});
			const outboxIntentIds = [
				this.insertAgentV2OutboxWithDatabase(
					db,
					current.clientId,
					current.runId,
					{ kind: "live_event", eventSeq: event.seq },
					event.createdAt,
				),
			];
			if (input.diagnostic) {
				this.appendAgentV2DiagnosticWithDatabase(db, input.diagnostic);
				outboxIntentIds.push(...this.insertDiagnosticOutboxWithDatabase(db, input.diagnostic));
			}
			return { update: { run: next, applied: true }, event, outboxIntentIds };
		});
	}

	commitAgentV2RunCancel(input: AgentV2CancelRunCommitInput): AgentV2CancelRunCommitResult {
		const db = this.open();
		return this.writeTransaction(db, () => {
			const current = requiredRecord(
				this.getAgentV2RunWithDatabase(db, input.clientId, input.runId),
				"agent v2 run",
			);
			const dedupeKey = `run_cancel:${input.clientId}:${input.runId}:${input.queueName}:${input.cancelToken}`;
			const existingIntent = db
				.prepare("SELECT intent_id FROM agent_v2_outbox WHERE dedupe_key = ?")
				.get(dedupeKey) as { intent_id: string } | undefined;
			if (existingIntent) {
				const cancelFingerprint = agentV2CancelReplayFingerprint(input);
				const event = this.listAgentV2RunEventsWithDatabase(db, input.clientId, input.runId, 0).find(
					(item) =>
						item.type === "agent_v2.phase_changed" &&
						item.createdAt === input.cancelledAt &&
						equalAgentV2ProtocolValues(item.payload, {
							type: "agent_v2.phase_changed",
							phase: "cancelled",
							status: "cancelled",
							attempt: input.expectedRun.attempt,
							at: input.cancelledAt,
							...(input.reason !== undefined ? { reason: input.reason } : {}),
							cancelFingerprint,
						}),
				);
				const liveReference: AgentV2OutboxReference | undefined = event
					? { kind: "live_event", eventSeq: event.seq }
					: undefined;
				const liveIntent = liveReference
					? this.getAgentV2OutboxWithDatabase(
							db,
							agentV2OutboxIntentId(outboxDedupeKey(input.clientId, input.runId, liveReference)),
						)
					: undefined;
				const cancelIntent = this.getAgentV2OutboxWithDatabase(db, existingIntent.intent_id);
				if (
					!event ||
					current.status !== "cancelled" ||
					current.phase !== "cancelled" ||
					current.attempt !== input.expectedRun.attempt ||
					(current.workerId ?? null) !== input.expectedRun.workerId ||
					current.updatedAt !== input.cancelledAt ||
					current.endedAt !== input.cancelledAt ||
					!liveReference ||
					!liveIntent ||
					!equalAgentV2ProtocolValues(liveIntent.reference, liveReference) ||
					!cancelIntent ||
					!equalAgentV2ProtocolValues(cancelIntent.reference, {
						kind: "run_cancel",
						queueName: input.queueName,
						cancelToken: input.cancelToken,
					})
				)
					throw new Error("Agent v2 cancel replay conflict");
				return {
					run: current,
					cancelEvent: event,
					outboxIntentIds: [liveIntent.intentId, existingIntent.intent_id],
					replayed: true,
				};
			}
			if (
				!(current.status === "queued" || current.status === "running") ||
				!input.expectedStatuses.includes(current.status) ||
				!matchesAgentV2ExpectedRun(current, input.expectedRun) ||
				!isCanonicalAgentV2Revision(input.expectedRun.updatedAt) ||
				!isStrictlyNewerAgentV2Revision(input.cancelledAt, current.updatedAt)
			) {
				throw new Error("Agent v2 cancel compare-and-set conflict");
			}
			const next = applyAgentV2RunUpdate(current, {
				clientId: input.clientId,
				runId: input.runId,
				expectedStatuses: input.expectedStatuses,
				status: "cancelled",
				phase: "cancelled",
				updatedAt: input.cancelledAt,
				endedAt: input.cancelledAt,
			});
			this.updateAgentV2RunWithDatabase(db, next);
			const cancelEvent = this.appendAgentV2RunEventWithDatabase(db, {
				clientId: input.clientId,
				runId: input.runId,
				type: "agent_v2.phase_changed",
				payload: {
					type: "agent_v2.phase_changed",
					phase: "cancelled",
					status: "cancelled",
					attempt: current.attempt,
					at: input.cancelledAt,
					...(input.reason !== undefined ? { reason: input.reason } : {}),
					cancelFingerprint: agentV2CancelReplayFingerprint(input),
				},
				createdAt: input.cancelledAt,
			});
			const outboxIntentIds = [
				this.insertAgentV2OutboxWithDatabase(
					db,
					input.clientId,
					input.runId,
					{ kind: "live_event", eventSeq: cancelEvent.seq },
					input.cancelledAt,
				),
				this.insertAgentV2OutboxWithDatabase(
					db,
					input.clientId,
					input.runId,
					{ kind: "run_cancel", queueName: input.queueName, cancelToken: input.cancelToken },
					input.cancelledAt,
				),
			];
			return { run: next, cancelEvent, outboxIntentIds, replayed: false };
		});
	}

	commitAgentV2ExecutionMutation(input: AgentV2ExecutionMutationInput): AgentV2ExecutionMutationResult {
		const db = this.open();
		return this.writeTransaction(db, () => {
			const run = requiredRecord(this.getAgentV2RunWithDatabase(db, input.clientId, input.runId), "agent v2 run");
			const currentTasks = this.listAgentV2TasksWithDatabase(db, input.clientId, input.runId);
			const expectations = new Map(input.expectedTasks.map((task) => [task.taskId, task]));
			const taskIds = new Set(input.tasks.map((task) => task.taskId));
			const childIdentityMismatch = [
				...input.tasks,
				...(input.artifacts ?? []),
				...(input.diagnostics ?? []),
				...(input.validation ? [input.validation] : []),
			].some((child) => child.clientId !== input.clientId || child.runId !== input.runId);
			if (
				expectations.size !== input.expectedTasks.length ||
				taskIds.size !== input.tasks.length ||
				expectations.size !== taskIds.size ||
				input.tasks.some((task) => !expectations.has(task.taskId)) ||
				input.expectedTasks.some(
					(expected) => "absent" in expected && !isAgentV2DeterministicExecutionTaskId(expected.taskId),
				) ||
				!isCanonicalAgentV2Revision(input.expectedRun.updatedAt) ||
				!isCanonicalAgentV2Revision(run.updatedAt) ||
				!isStrictlyNewerAgentV2Revision(input.updatedAt, run.updatedAt) ||
				childIdentityMismatch ||
				!matchesAgentV2ExpectedRun(run, input.expectedRun) ||
				input.expectedTasks.some((expected) => {
					const current = currentTasks.find((task) => task.taskId === expected.taskId);
					if ("absent" in expected) return current !== undefined;
					return (
						!isCanonicalAgentV2Revision(expected.updatedAt) ||
						!current ||
						!isCanonicalAgentV2Revision(current.updatedAt) ||
						current.status !== expected.status ||
						current.updatedAt !== expected.updatedAt
					);
				}) ||
				input.tasks.some((task) => {
					const expected = expectations.get(task.taskId);
					const current = currentTasks.find((candidate) => candidate.taskId === task.taskId);
					if (!expected) return true;
					if ("absent" in expected) {
						return (
							current !== undefined ||
							!isCanonicalAgentV2Revision(task.updatedAt) ||
							task.updatedAt !== input.updatedAt
						);
					}
					return !current || !isStrictlyNewerAgentV2Revision(task.updatedAt, current.updatedAt);
				})
			) {
				return {
					applied: false,
					run,
					tasks: currentTasks,
					artifacts: [],
					events: [],
					outboxIntentIds: [],
				};
			}
			const nextRun = applyAgentV2RunUpdate(run, {
				clientId: input.clientId,
				runId: input.runId,
				...(input.nextRunPhase ? { phase: input.nextRunPhase } : {}),
				updatedAt: input.updatedAt,
			});
			this.updateAgentV2RunWithDatabase(db, nextRun);
			for (const task of input.tasks) this.upsertAgentV2TaskWithDatabase(db, task);
			for (const artifact of input.artifacts ?? []) this.upsertAgentV2ArtifactWithDatabase(db, artifact);
			const validation = input.validation
				? this.appendAgentV2ValidationWithDatabase(db, input.validation)
				: undefined;
			for (const diagnostic of input.diagnostics ?? []) this.appendAgentV2DiagnosticWithDatabase(db, diagnostic);
			const events = input.events.map((event) =>
				this.appendAgentV2RunEventWithDatabase(db, {
					clientId: input.clientId,
					runId: input.runId,
					type: String(event.type),
					payload: event.payload as Record<string, unknown>,
					...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
				}),
			);
			const outboxIntentIds = events.map((event) =>
				this.insertAgentV2OutboxWithDatabase(
					db,
					input.clientId,
					input.runId,
					{ kind: "live_event", eventSeq: event.seq },
					event.createdAt,
				),
			);
			for (const diagnostic of input.diagnostics ?? [])
				outboxIntentIds.push(...this.insertDiagnosticOutboxWithDatabase(db, diagnostic));
			return {
				applied: true,
				run: nextRun,
				tasks: this.listAgentV2TasksWithDatabase(db, input.clientId, input.runId),
				artifacts: this.listAgentV2ArtifactsWithDatabase(db, input.clientId, input.runId),
				validation,
				events,
				outboxIntentIds,
			};
		});
	}

	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2DiagnosticCommitResult {
		const db = this.open();
		return this.writeTransaction(db, () => {
			const diagnostic = this.appendAgentV2DiagnosticWithDatabase(db, input.diagnostic);
			const outboxIntentIds = this.insertDiagnosticOutboxWithDatabase(db, diagnostic);
			const existingEvent = this.listAgentV2RunEventsWithDatabase(db, diagnostic.clientId, diagnostic.runId, 0).find(
				(event) => event.type === "diagnostic" && event.payload.diagnosticId === diagnostic.diagnosticId,
			);
			const event = input.emitRunEvent
				? (existingEvent ??
					this.appendAgentV2RunEventWithDatabase(db, {
						clientId: diagnostic.clientId,
						runId: diagnostic.runId,
						type: "diagnostic",
						payload: { diagnosticId: diagnostic.diagnosticId },
						createdAt: diagnostic.createdAt,
					}))
				: undefined;
			if (event)
				outboxIntentIds.push(
					this.insertAgentV2OutboxWithDatabase(
						db,
						diagnostic.clientId,
						diagnostic.runId,
						{ kind: "live_event", eventSeq: event.seq },
						event.createdAt,
					),
				);
			return { diagnostic, event, outboxIntentIds };
		});
	}

	listAgentV2InputReferences(clientId: string, runId: string): AgentV2InputReferenceRecord[] {
		return this.listAgentV2InputReferencesWithDatabase(this.open(), clientId, runId);
	}

	readAgentV2InputBlob(clientId: string, runId: string, inputId: string): AgentV2InputBlobRecord | undefined {
		return this.readAgentV2InputBlobWithDatabase(this.open(), clientId, runId, inputId);
	}

	leaseAgentV2Outbox(input: AgentV2OutboxLeaseInput): AgentV2OutboxRecord[] {
		validateAgentV2OutboxLeaseInput(input);
		const db = this.open();
		return this.writeTransaction(db, () => {
			const kindSql = input.kinds?.length ? ` AND kind IN (${input.kinds.map(() => "?").join(",")})` : "";
			const rows = db
				.prepare(
					`SELECT intent_id FROM agent_v2_outbox WHERE ((status = 'pending' AND available_at <= ?) OR (status = 'leased' AND lease_expires_at <= ?))${kindSql} ORDER BY available_at, created_at, intent_id LIMIT ?`,
				)
				.all(input.now, input.now, ...(input.kinds ?? []), input.limit) as { intent_id: string }[];
			const expiresAt = new Date(Date.parse(input.now) + input.leaseTtlMs).toISOString();
			for (const row of rows)
				db.prepare(
					"UPDATE agent_v2_outbox SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE intent_id = ?",
				).run(input.ownerId, expiresAt, input.now, row.intent_id);
			return rows.map((row) =>
				requiredRecord(this.getAgentV2OutboxWithDatabase(db, row.intent_id), "agent v2 outbox intent"),
			);
		});
	}

	markAgentV2OutboxDelivered(input: AgentV2OutboxDeliveryInput): "delivered" | "lease_lost" {
		validateAgentV2OutboxDeliveryInput(input);
		const result = this.open()
			.prepare(
				"UPDATE agent_v2_outbox SET status = 'delivered', delivered_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE intent_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ? AND lease_expires_at > ?",
			)
			.run(
				input.deliveredAt,
				input.deliveredAt,
				input.intentId,
				input.ownerId,
				input.leaseAttempt,
				input.deliveredAt,
			);
		return Number(result.changes) === 1 ? "delivered" : "lease_lost";
	}

	rescheduleAgentV2Outbox(input: AgentV2OutboxRescheduleInput): "pending" | "dead_letter" | "lease_lost" {
		validateAgentV2OutboxRescheduleInput(input);
		const db = this.open();
		return this.writeTransaction(db, () => {
			const row = db
				.prepare(
					"SELECT attempt_count FROM agent_v2_outbox WHERE intent_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ? AND lease_expires_at > ?",
				)
				.get(input.intentId, input.ownerId, input.leaseAttempt, input.updatedAt) as
				| { attempt_count: number }
				| undefined;
			if (!row) return "lease_lost";
			const status = row.attempt_count >= input.maxAttempts ? "dead_letter" : "pending";
			db.prepare(
				"UPDATE agent_v2_outbox SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE intent_id = ?",
			).run(status, input.availableAt, input.errorCode, input.errorMessage, input.updatedAt, input.intentId);
			return status;
		});
	}

	resetAgentV2RuntimeData(options: ResetAgentV2RuntimeDataOptions = {}): ResetAgentV2RuntimeDataResult {
		const db = this.open();
		const appliedAt = options.now?.() ?? now();
		return this.writeTransaction(db, () => {
			const tables = [...AGENT_V2_PRE_V2_TABLES, ...AGENT_V2_RESET_TABLES] as const;
			const agentV2RowsDeleted = countSqliteRows(db, tables);
			for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
			createSqliteAgentV2Schema(db, appliedAt);
			return {
				agentV2RowsDeleted,
				schemaVersion: AGENT_V2_SCHEMA_VERSION,
			};
		});
	}

	private getAgentV2RunWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
	): AgentV2RunSnapshot | undefined {
		const row = db
			.prepare(`SELECT ${AGENT_V2_RUN_COLUMNS} FROM agent_v2_runs WHERE client_id = ? AND run_id = ?`)
			.get(clientId, runId) as unknown as AgentV2RunRow | undefined;
		return row ? toAgentV2RunRecord(row) : undefined;
	}

	private updateAgentV2RunWithDatabase(db: DatabaseSync, run: AgentV2RunSnapshot): void {
		db.prepare(
			"UPDATE agent_v2_runs SET status = ?, phase = ?, attempt = ?, worker_id = ?, updated_at = ?, started_at = ?, ended_at = ?, error_json = ? WHERE client_id = ? AND run_id = ?",
		).run(
			run.status,
			run.phase,
			run.attempt,
			run.workerId ?? null,
			run.updatedAt,
			run.startedAt ?? null,
			run.endedAt ?? null,
			run.error ? stringifyAgentV2Json(run.error) : null,
			run.clientId,
			run.runId,
		);
	}

	private appendAgentV2RunEventWithDatabase(
		db: DatabaseSync,
		input: AppendAgentV2RunEventInput,
	): AgentV2RunEventRecord {
		const seq =
			input.seq ??
			(
				db
					.prepare(
						"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_v2_run_events WHERE client_id = ? AND run_id = ?",
					)
					.get(input.clientId, input.runId) as SeqRow
			).seq;
		const createdAt = input.createdAt ?? now();
		db.prepare(
			"INSERT INTO agent_v2_run_events (client_id, run_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(input.clientId, input.runId, seq, input.type, stringifyAgentV2Json(input.payload), createdAt);
		return { clientId: input.clientId, runId: input.runId, seq, type: input.type, payload: input.payload, createdAt };
	}

	private listAgentV2RunEventsWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
		afterSeq: number,
	): AgentV2RunEventRecord[] {
		return (
			db
				.prepare(
					`SELECT ${AGENT_V2_RUN_EVENT_COLUMNS} FROM agent_v2_run_events WHERE client_id = ? AND run_id = ? AND seq > ? ORDER BY seq`,
				)
				.all(clientId, runId, afterSeq) as unknown as AgentV2RunEventRow[]
		).map(toAgentV2RunEventRecord);
	}

	private insertAgentV2InputBlobWithDatabase(
		db: DatabaseSync,
		input: AgentV2InputBlobRecord,
		clientId: string,
		runId: string,
	): void {
		if (input.clientId !== clientId || input.runId !== runId || input.byteLength !== input.bytes.byteLength)
			throw new Error("Agent v2 input blob identity or length mismatch");
		db.prepare(
			"INSERT INTO agent_v2_input_blobs (client_id, run_id, input_id, logical_path, media_type, encoding, bytes, byte_length, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.clientId,
			input.runId,
			input.inputId,
			input.logicalPath,
			input.mediaType,
			input.encoding,
			Buffer.from(input.bytes),
			input.byteLength,
			input.checksum,
			input.createdAt,
		);
	}

	private listAgentV2InputReferencesWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
	): AgentV2InputReferenceRecord[] {
		return (
			db
				.prepare(
					"SELECT client_id, run_id, kind, ordinal, input_id, logical_path, display_name, media_type, byte_length, checksum FROM agent_v2_input_references WHERE client_id = ? AND run_id = ? ORDER BY kind, ordinal",
				)
				.all(clientId, runId) as InputReferenceRow[]
		).map(toInputReference);
	}

	private readAgentV2InputBlobWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
		inputId: string,
	): AgentV2InputBlobRecord | undefined {
		const row = db
			.prepare(
				"SELECT client_id, run_id, input_id, logical_path, media_type, encoding, bytes, byte_length, checksum, created_at FROM agent_v2_input_blobs WHERE client_id = ? AND run_id = ? AND input_id = ?",
			)
			.get(clientId, runId, inputId) as InputBlobRow | undefined;
		return row ? toInputBlob(row) : undefined;
	}

	private insertAgentV2InputReferenceWithDatabase(
		db: DatabaseSync,
		input: AgentV2InputReferenceRecord,
		clientId: string,
		runId: string,
	): void {
		if (input.clientId !== clientId || input.runId !== runId)
			throw new Error("Agent v2 input reference identity mismatch");
		db.prepare(
			"INSERT INTO agent_v2_input_references (client_id, run_id, input_id, logical_path, media_type, checksum, kind, ordinal, display_name, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.clientId,
			input.runId,
			input.inputId,
			input.logicalPath,
			input.mediaType,
			input.checksum,
			input.kind,
			input.ordinal,
			input.displayName ?? null,
			input.byteLength,
		);
	}

	private upsertAgentV2TaskWithDatabase(db: DatabaseSync, input: UpsertAgentV2TaskInput): AgentV2TaskNode {
		const task = buildAgentV2Task(input);
		db.prepare(`INSERT INTO agent_v2_tasks (client_id, run_id, task_id, parent_task_id, kind, title, status, depends_on_json, acceptance_criteria_json, input_json, output_json, created_at, updated_at, started_at, ended_at, error_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(client_id, run_id, task_id) DO UPDATE SET parent_task_id=excluded.parent_task_id, kind=excluded.kind, title=excluded.title, status=excluded.status, depends_on_json=excluded.depends_on_json, acceptance_criteria_json=excluded.acceptance_criteria_json, input_json=excluded.input_json, output_json=excluded.output_json, updated_at=excluded.updated_at, started_at=excluded.started_at, ended_at=excluded.ended_at, error_json=excluded.error_json`).run(
			input.clientId,
			input.runId,
			task.taskId,
			task.parentTaskId ?? null,
			task.kind,
			task.title,
			task.status,
			stringifyAgentV2Json(task.dependsOn),
			stringifyAgentV2Json(task.acceptanceCriteria),
			stringifyAgentV2Json(task.input),
			stringifyAgentV2Json(task.output),
			task.createdAt,
			task.updatedAt,
			task.startedAt ?? null,
			task.endedAt ?? null,
			task.error ? stringifyAgentV2Json(task.error) : null,
		);
		return task;
	}

	private listAgentV2TasksWithDatabase(db: DatabaseSync, clientId: string, runId: string): AgentV2TaskNode[] {
		return (
			db
				.prepare(
					`SELECT ${AGENT_V2_TASK_COLUMNS} FROM agent_v2_tasks WHERE client_id = ? AND run_id = ? ORDER BY created_at, task_id`,
				)
				.all(clientId, runId) as unknown as AgentV2TaskRow[]
		).map(toAgentV2TaskRecord);
	}

	private upsertAgentV2ArtifactWithDatabase(
		db: DatabaseSync,
		input: UpsertAgentV2ArtifactInput,
	): AgentV2ArtifactRecord {
		const artifact = buildAgentV2Artifact(input);
		db.prepare(`INSERT INTO agent_v2_artifacts (client_id, run_id, artifact_id, kind, path, media_type, checksum, version, source_task_id, validation_status, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(client_id, run_id, artifact_id) DO UPDATE SET kind=excluded.kind, path=excluded.path, media_type=excluded.media_type, checksum=excluded.checksum, version=excluded.version, source_task_id=excluded.source_task_id, validation_status=excluded.validation_status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`).run(
			artifact.clientId,
			artifact.runId,
			artifact.artifactId,
			artifact.kind,
			artifact.path,
			artifact.mediaType,
			artifact.checksum,
			artifact.version,
			artifact.sourceTaskId ?? null,
			artifact.validationStatus,
			stringifyAgentV2Json(artifact.metadataJson),
			artifact.createdAt,
			artifact.updatedAt,
		);
		return artifact;
	}

	private listAgentV2ArtifactsWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
	): AgentV2ArtifactRecord[] {
		return (
			db
				.prepare(
					`SELECT ${AGENT_V2_ARTIFACT_COLUMNS} FROM agent_v2_artifacts WHERE client_id = ? AND run_id = ? ORDER BY created_at, artifact_id`,
				)
				.all(clientId, runId) as unknown as AgentV2ArtifactRow[]
		).map(toAgentV2ArtifactRecord);
	}

	private upsertAgentV2DocumentWithDatabase(
		db: DatabaseSync,
		input: UpsertAgentV2DocumentInput,
	): AgentV2DocumentRecord {
		const document = buildAgentV2Document(input);
		db.prepare(`INSERT INTO agent_v2_documents (client_id, run_id, document_id, kind, version, content_markdown, content_json, source_task_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(client_id, run_id, document_id) DO UPDATE SET kind=excluded.kind, version=excluded.version, content_markdown=excluded.content_markdown, content_json=excluded.content_json, source_task_id=excluded.source_task_id, updated_at=excluded.updated_at`).run(
			document.clientId,
			document.runId,
			document.documentId,
			document.kind,
			document.version,
			document.contentMarkdown,
			stringifyAgentV2Json(document.contentJson),
			document.sourceTaskId ?? null,
			document.createdAt,
			document.updatedAt,
		);
		return document;
	}

	private appendAgentV2DiagnosticWithDatabase(
		db: DatabaseSync,
		input: AgentV2DiagnosticEvent,
	): AgentV2DiagnosticEvent {
		input = canonicalizeAgentV2DiagnosticEvent(input);
		const existingRow = db
			.prepare(
				`SELECT ${AGENT_V2_DIAGNOSTIC_COLUMNS} FROM agent_v2_diagnostics WHERE client_id=? AND run_id=? AND diagnostic_id=?`,
			)
			.get(input.clientId, input.runId, input.diagnosticId) as unknown as AgentV2DiagnosticRow | undefined;
		if (existingRow) {
			const existing = toAgentV2DiagnosticRecord(existingRow);
			if (equalAgentV2ProtocolValues(existing, input)) return existing;
			throw new Error("Agent v2 diagnostic conflict");
		}
		db.prepare(
			"INSERT INTO agent_v2_diagnostics (client_id, run_id, diagnostic_id, severity, category, code, phase, task_id, artifact_id, trace_id, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.clientId,
			input.runId,
			input.diagnosticId,
			input.severity,
			input.category,
			input.code,
			input.phase ?? null,
			input.taskId ?? null,
			input.artifactId ?? null,
			input.traceId ?? null,
			input.message,
			stringifyAgentV2Json(input.data),
			input.createdAt,
		);
		return input;
	}

	private appendAgentV2ValidationWithDatabase(
		db: DatabaseSync,
		input: AppendAgentV2ValidationAttemptInput,
	): AgentV2ValidationRecord {
		const validation = buildAgentV2Validation(input);
		const existingRow = db
			.prepare(
				`SELECT ${AGENT_V2_VALIDATION_COLUMNS} FROM agent_v2_validation_attempts WHERE client_id=? AND run_id=? AND validation_id=? AND attempt=?`,
			)
			.get(validation.clientId, validation.runId, validation.validationId, validation.attempt) as unknown as
			| AgentV2ValidationRow
			| undefined;
		if (existingRow) {
			const existing = toAgentV2ValidationRecord(existingRow);
			if (equalAgentV2ValidationRecords(existing, validation)) return existing;
			throw new Error("Agent v2 validation attempt conflict");
		}
		db.prepare(
			"INSERT INTO agent_v2_validation_attempts (client_id, run_id, validation_id, attempt, task_id, artifact_id, status, summary, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			validation.clientId,
			validation.runId,
			validation.validationId,
			validation.attempt,
			validation.taskId ?? null,
			validation.artifactId ?? null,
			validation.status,
			validation.summary,
			stringifyAgentV2Json(validation.details),
			validation.createdAt,
			validation.updatedAt,
		);
		return validation;
	}

	private insertDiagnosticOutboxWithDatabase(db: DatabaseSync, diagnostic: AgentV2DiagnosticEvent): string[] {
		return [
			this.insertAgentV2OutboxWithDatabase(
				db,
				diagnostic.clientId,
				diagnostic.runId,
				{ kind: "workspace_diagnostic", diagnosticId: diagnostic.diagnosticId },
				diagnostic.createdAt,
			),
			this.insertAgentV2OutboxWithDatabase(
				db,
				diagnostic.clientId,
				diagnostic.runId,
				{ kind: "langfuse_diagnostic", diagnosticId: diagnostic.diagnosticId },
				diagnostic.createdAt,
			),
		];
	}

	private insertAgentV2OutboxWithDatabase(
		db: DatabaseSync,
		clientId: string,
		runId: string,
		reference: AgentV2OutboxReference,
		createdAt: string,
	): string {
		const dedupeKey = outboxDedupeKey(clientId, runId, reference);
		const intentId = agentV2OutboxIntentId(dedupeKey);
		const referenceJson = stringifyAgentV2Json(reference);
		const existing = db
			.prepare("SELECT intent_id, reference_json FROM agent_v2_outbox WHERE dedupe_key = ?")
			.get(dedupeKey) as { intent_id: string; reference_json: string } | undefined;
		if (existing) {
			if (
				existing.intent_id !== intentId ||
				!equalAgentV2ProtocolValues(JSON.parse(existing.reference_json), reference)
			)
				throw new Error("Agent v2 outbox dedupe conflict");
			return existing.intent_id;
		}
		db.prepare(
			"INSERT INTO agent_v2_outbox (intent_id, dedupe_key, client_id, run_id, kind, status, available_at, created_at, updated_at, reference_json, attempt_count) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0)",
		).run(intentId, dedupeKey, clientId, runId, reference.kind, createdAt, createdAt, createdAt, referenceJson);
		return intentId;
	}

	private getAgentV2OutboxWithDatabase(db: DatabaseSync, intentId: string): AgentV2OutboxRecord | undefined {
		const row = db.prepare("SELECT * FROM agent_v2_outbox WHERE intent_id = ?").get(intentId) as
			| OutboxRow
			| undefined;
		return row ? toOutboxRecord(row) : undefined;
	}

	deleteSession(clientId: string, sessionId: string): boolean {
		const db = this.open();
		return this.writeTransaction(db, () => {
			db.prepare("DELETE FROM app_preview_goal_events WHERE client_id = ? AND session_id = ?").run(
				clientId,
				sessionId,
			);
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

	private ensureClientIdentitySchema(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE IF NOT EXISTS clients (
				client_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
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

	private getAppPreviewGoalEvent(clientId: string, eventId: number): AppPreviewGoalEventRecord | undefined {
		const row = this.open()
			.prepare(
				`SELECT id, goal_id, client_id, session_id, run_id, event_type, reason_code, payload_json, created_at
				FROM app_preview_goal_events
				WHERE client_id = ? AND id = ?`,
			)
			.get(clientId, eventId) as AppPreviewGoalEventRow | undefined;
		return row ? toAppPreviewGoalEventRecord(row) : undefined;
	}

	private updateSessionRun(
		clientId: string,
		sessionId: string,
		runId: string,
		status: RunStatus,
		updatedAt: string,
		context?: SessionRunContext,
	): void {
		if (context) {
			this.open()
				.prepare(
					`UPDATE sessions
					SET updated_at = ?, last_run_status = ?, last_run_id = ?, model_json = ?, thinking_level = ?
					WHERE client_id = ? AND session_id = ?`,
				)
				.run(updatedAt, status, runId, JSON.stringify(context.model), context.thinkingLevel, clientId, sessionId);
			return;
		}

		this.open()
			.prepare(
				`UPDATE sessions
				SET updated_at = ?, last_run_status = ?, last_run_id = ?
				WHERE client_id = ? AND session_id = ?`,
			)
			.run(updatedAt, status, runId, clientId, sessionId);
	}

	private hasActiveRun(db: DatabaseSync, clientId: string, sessionId: string): boolean {
		const row = db
			.prepare(
				`SELECT 1 AS active
				FROM runs
				WHERE client_id = ? AND session_id = ? AND status IN ('queued', 'running', 'cancelling')
				LIMIT 1`,
			)
			.get(clientId, sessionId) as { active: number } | undefined;
		return row !== undefined;
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

function toAgentV2RunEventRecord(row: AgentV2RunEventRow): AgentV2RunEventRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		seq: Number(row.seq),
		type: row.event_type,
		payload: parseJsonObject(String(row.payload_json)),
		createdAt: String(row.created_at),
	};
}

function toAppPreviewGoalRecord(row: AppPreviewGoalRow): AppPreviewGoalRecord {
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

function toAppPreviewGoalEventRecord(row: AppPreviewGoalEventRow): AppPreviewGoalEventRecord {
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

function parseJsonObject(value: string): JsonObject {
	const parsed = JSON.parse(value) as unknown;
	return isObject(parsed) ? parsed : {};
}

function parseAppPreviewGoalEventPayload(value: string): JsonObject {
	try {
		return parseJsonObject(value);
	} catch {
		return {};
	}
}

function requiredRecord<T>(record: T | undefined, label: string): T {
	if (!record) throw new Error(`Runtime ${label} not found`);
	return record;
}

type InputBlobRow = {
	client_id: string;
	run_id: string;
	input_id: string;
	logical_path: string;
	media_type: string;
	encoding: "utf8" | "binary";
	bytes: Uint8Array;
	byte_length: number;
	checksum: string;
	created_at: string;
};
type InputReferenceRow = {
	client_id: string;
	run_id: string;
	kind: "attachment" | "project_file";
	ordinal: number;
	input_id: string;
	logical_path: string;
	display_name: string | null;
	media_type: string;
	byte_length: number;
	checksum: string;
};
type OutboxRow = {
	intent_id: string;
	dedupe_key: string;
	client_id: string;
	run_id: string;
	reference_json: string;
	status: AgentV2OutboxRecord["status"];
	attempt_count: number;
	available_at: string;
	lease_owner: string | null;
	lease_expires_at: string | null;
	last_error_code: string | null;
	last_error_message: string | null;
	created_at: string;
	updated_at: string;
	delivered_at: string | null;
};

function toInputBlob(row: InputBlobRow): AgentV2InputBlobRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		inputId: row.input_id,
		logicalPath: row.logical_path,
		mediaType: row.media_type,
		encoding: row.encoding,
		bytes: new Uint8Array(row.bytes),
		byteLength: row.byte_length,
		checksum: row.checksum,
		createdAt: row.created_at,
	};
}

function toInputReference(row: InputReferenceRow): AgentV2InputReferenceRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		kind: row.kind,
		ordinal: row.ordinal,
		inputId: row.input_id,
		logicalPath: row.logical_path,
		...(row.display_name ? { displayName: row.display_name } : {}),
		mediaType: row.media_type,
		byteLength: row.byte_length,
		checksum: row.checksum,
	};
}

function toOutboxRecord(row: OutboxRow): AgentV2OutboxRecord {
	return {
		intentId: row.intent_id,
		dedupeKey: row.dedupe_key,
		clientId: row.client_id,
		runId: row.run_id,
		reference: JSON.parse(row.reference_json) as AgentV2OutboxReference,
		status: row.status,
		attemptCount: row.attempt_count,
		availableAt: row.available_at,
		...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
		...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
		...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
		...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
	};
}

function outboxDedupeKey(clientId: string, runId: string, reference: AgentV2OutboxReference): string {
	switch (reference.kind) {
		case "run_enqueue":
			return `run_enqueue:${clientId}:${runId}:${reference.queueName}`;
		case "run_cancel":
			return `run_cancel:${clientId}:${runId}:${reference.queueName}:${reference.cancelToken}`;
		case "live_event":
			return `live_event:${clientId}:${runId}:${reference.eventSeq}`;
		case "workspace_diagnostic":
			return `workspace_diagnostic:${clientId}:${runId}:${reference.diagnosticId}`;
		case "langfuse_diagnostic":
			return `langfuse_diagnostic:${clientId}:${runId}:${reference.diagnosticId}`;
	}
}

function startOutboxReferences(input: AgentV2StartRunCommitInput): AgentV2OutboxReference[] {
	return [
		{ kind: "live_event", eventSeq: 1 },
		{ kind: "live_event", eventSeq: 2 },
		...input.diagnostics.flatMap((diagnostic): AgentV2OutboxReference[] => [
			{ kind: "workspace_diagnostic", diagnosticId: diagnostic.diagnosticId },
			{ kind: "langfuse_diagnostic", diagnosticId: diagnostic.diagnosticId },
		]),
		{ kind: "run_enqueue", queueName: input.queueName },
	];
}

function countSqliteRows<TableName extends string>(
	db: DatabaseSync,
	tables: readonly TableName[],
): Record<TableName, number> {
	const counts = {} as Record<TableName, number>;
	for (const table of tables) {
		if (!sqliteTableExists(db, table)) {
			counts[table] = 0;
			continue;
		}
		const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
		counts[table] = Number(row.count);
	}
	return counts;
}

function sqliteTableExists(db: DatabaseSync, table: string): boolean {
	const row = db
		.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table) as { present?: number } | undefined;
	return row?.present === 1;
}

function createSqliteAgentV2Schema(db: DatabaseSync, appliedAt: string): void {
	db.exec(SQLITE_AGENT_V2_SCHEMA);
	db.prepare("INSERT INTO agent_v2_schema_metadata (singleton_id, schema_version, applied_at) VALUES (1, ?, ?)").run(
		AGENT_V2_SCHEMA_VERSION,
		appliedAt,
	);
}

function sqliteAgentV2ObjectNames(db: DatabaseSync, type: "index" | "table"): string[] {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'agent_v2_%' ORDER BY name")
			.all(type) as Array<{ name: string }>
	).map((row) => row.name);
}

function assertExactSqliteAgentV2Schema(db: DatabaseSync): void {
	const tables = sqliteAgentV2ObjectNames(db, "table");
	const indexes = (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_agent_v2_%' OR name LIKE 'uq_agent_v2_%') ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name);
	const metadataColumns = sqliteTableExists(db, "agent_v2_schema_metadata")
		? (db.prepare("PRAGMA table_info(agent_v2_schema_metadata)").all() as Array<{ name: string }>).map(
				(row) => row.name,
			)
		: [];
	const metadata =
		JSON.stringify(metadataColumns) === JSON.stringify(["singleton_id", "schema_version", "applied_at"])
			? (db.prepare("SELECT singleton_id, schema_version FROM agent_v2_schema_metadata").all() as Array<{
					singleton_id: number;
					schema_version: number;
				}>)
			: [];
	if (
		JSON.stringify(tables) !== JSON.stringify(AGENT_V2_SCHEMA_TABLES) ||
		JSON.stringify(indexes) !== JSON.stringify([...AGENT_V2_SCHEMA_INDEXES].sort()) ||
		metadata.length !== 1 ||
		metadata[0]?.singleton_id !== 1 ||
		metadata[0]?.schema_version !== AGENT_V2_SCHEMA_VERSION
	) {
		throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
	}
	const reference = new DatabaseSync(":memory:");
	try {
		reference.exec("PRAGMA foreign_keys = ON");
		reference.exec(SQLITE_AGENT_V2_SCHEMA);
		if (JSON.stringify(sqliteAgentV2Shape(db)) !== JSON.stringify(sqliteAgentV2Shape(reference))) {
			throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
		}
	} finally {
		reference.close();
	}
}

function sqliteAgentV2Shape(db: DatabaseSync): unknown {
	return {
		tables: AGENT_V2_SCHEMA_TABLES.map((table) => ({
			table,
			columns: db.prepare(`PRAGMA table_info(${table})`).all(),
			foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
			sql: normalizeSchemaSql(
				(
					db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
						sql: string;
					}
				).sql,
			),
		})),
		indexes: [...AGENT_V2_SCHEMA_INDEXES].sort().map((name) => ({
			name,
			columns: db.prepare(`PRAGMA index_xinfo(${name})`).all(),
			sql: normalizeSchemaSql(
				(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string })
					.sql,
			),
		})),
	};
}

function normalizeSchemaSql(sql: string): string {
	return sql
		.replaceAll(/\s+/g, " ")
		.replaceAll(/\s*([(),>=])\s*/g, "$1")
		.trim()
		.toLowerCase();
}

function now(): string {
	return new Date().toISOString();
}
