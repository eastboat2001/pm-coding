import pg from "pg";
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import {
	AGENT_V2_ARTIFACT_COLUMNS,
	AGENT_V2_DIAGNOSTIC_COLUMNS,
	AGENT_V2_DOCUMENT_COLUMNS,
	AGENT_V2_RUN_COLUMNS,
	AGENT_V2_RUN_EVENT_COLUMNS,
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
	applyAgentV2RunUpdate,
	buildAgentV2Artifact,
	buildAgentV2Document,
	buildAgentV2Run,
	buildAgentV2Task,
	buildAgentV2Validation,
	type CreateAgentV2RunInput,
	toAgentV2ArtifactRecord,
	toAgentV2DiagnosticRecord,
	toAgentV2DocumentRecord,
	toAgentV2RunEventRecord,
	toAgentV2RunRecord,
	toAgentV2TaskRecord,
	toAgentV2ValidationRecord,
	type UpdateAgentV2RunInput,
	type UpsertAgentV2ArtifactInput,
	type UpsertAgentV2DocumentInput,
	type UpsertAgentV2TaskInput,
	type UpsertAgentV2ValidationInput,
} from "./agent-v2-store.js";
import { AGENT_V2_SCHEMA_VERSION, type AgentV2RunSnapshot, type AgentV2TaskNode } from "./agent-v2-types.js";
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

export interface QueryResultLike {
	rows: Record<string, unknown>[];
	rowCount?: number | null;
}

export interface Queryable {
	query(sql: string, values?: readonly unknown[]): Promise<QueryResultLike>;
}

type ReleasableQueryable = Queryable & { release(): void };
type ConnectableQueryable = Queryable & { connect(): Promise<ReleasableQueryable> };
type TimestampRowValue = string | Date;

interface SessionRow {
	session_id: string;
	client_id: string;
	title: string;
	model_json: unknown;
	thinking_level: string;
	created_at: TimestampRowValue;
	updated_at: TimestampRowValue;
	last_run_status: RunStatus | null;
	last_run_id: string | null;
}

interface MessageRow {
	id: number | string;
	session_id: string;
	client_id: string;
	role: string;
	payload_json: unknown;
	created_at: TimestampRowValue;
}

interface RunRow {
	run_id: string;
	session_id: string;
	client_id: string;
	status: RunStatus;
	worker_id: string | null;
	model_json: unknown;
	thinking_level: string;
	started_at: TimestampRowValue | null;
	updated_at: TimestampRowValue;
	ended_at: TimestampRowValue | null;
	error: string | null;
}

interface RunEventRow {
	id: number | string;
	run_id: string;
	session_id: string;
	client_id: string;
	seq: number | string;
	event_type: string;
	payload_json: unknown;
	created_at: TimestampRowValue;
}

interface AppPreviewGoalRow {
	goal_id: string;
	client_id: string;
	session_id: string;
	source: AppPreviewGoalSource;
	status: AppPreviewGoalStatus;
	max_continuation_runs: number | string;
	continuation_runs_used: number | string;
	retry_attempts_used: number | string;
	last_run_id: string | null;
	last_preview_url: string | null;
	last_failure_reason: string | null;
	created_at: TimestampRowValue;
	updated_at: TimestampRowValue;
	completed_at: TimestampRowValue | null;
}

interface AppPreviewGoalEventRow {
	id: number | string;
	goal_id: string;
	client_id: string;
	session_id: string;
	run_id: string | null;
	event_type: AppPreviewGoalEventType;
	reason_code: string | null;
	payload_json: unknown;
	created_at: TimestampRowValue;
}

interface MessageStatsRow {
	message_count: number | string | null;
	total_payload_bytes: number | string | null;
	largest_payload_bytes: number | string | null;
}

interface SeqRow {
	seq: number | string;
}

interface SessionRunContext {
	model: JsonObject;
	thinkingLevel: string;
}

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "cancelling"];
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["cancelled", "completed", "failed", "interrupted"]);
const LEGACY_RESET_TABLES = [
	"app_preview_goal_events",
	"app_preview_goals",
	"run_events",
	"messages",
	"runs",
	"sessions",
] as const;
const AGENT_V2_RESET_TABLES = [
	"agent_v2_diagnostics",
	"agent_v2_validations",
	"agent_v2_documents",
	"agent_v2_artifacts",
	"agent_v2_tasks",
	"agent_v2_run_events",
	"agent_v2_runs",
	"agent_v2_schema_metadata",
] as const;

const SESSION_COLUMNS =
	"session_id, client_id, title, model_json, thinking_level, created_at, updated_at, last_run_status, last_run_id";
const MESSAGE_COLUMNS = "id, session_id, client_id, role, payload_json, created_at";
const RUN_COLUMNS =
	"run_id, session_id, client_id, status, worker_id, model_json, thinking_level, started_at, updated_at, ended_at, error";
const RUN_EVENT_COLUMNS = "id, run_id, session_id, client_id, seq, event_type, payload_json, created_at";
const APP_PREVIEW_GOAL_COLUMNS =
	"goal_id, client_id, session_id, source, status, max_continuation_runs, continuation_runs_used, retry_attempts_used, last_run_id, last_preview_url, last_failure_reason, created_at, updated_at, completed_at";
const APP_PREVIEW_GOAL_EVENT_COLUMNS =
	"id, goal_id, client_id, session_id, run_id, event_type, reason_code, payload_json, created_at";

export class PostgresRuntimeStore implements RuntimeStore {
	private readonly queryable: ConnectableQueryable;
	private readonly pool?: pg.Pool;

	constructor(options: { url?: string; queryable?: Queryable } = {}) {
		if (options.queryable) {
			this.queryable = options.queryable as ConnectableQueryable;
			return;
		}

		const pool = new pg.Pool({ connectionString: options.url });
		this.pool = pool;
		this.queryable = {
			query: (sql, values) => pool.query(sql, values ? [...values] : undefined) as Promise<QueryResultLike>,
			connect: async () => {
				const client = await pool.connect();
				return {
					query: (sql, values) => client.query(sql, values ? [...values] : undefined) as Promise<QueryResultLike>,
					release: () => client.release(),
				};
			},
		};
	}

	async ensureSchema(): Promise<void> {
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS clients (
				client_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`,
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				title TEXT NOT NULL,
				model_json JSONB NOT NULL,
				thinking_level TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_run_status TEXT,
				last_run_id TEXT,
				PRIMARY KEY (client_id, session_id),
				FOREIGN KEY (client_id) REFERENCES clients(client_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_sessions_client_updated ON sessions(client_id, updated_at DESC)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS messages (
				id BIGSERIAL PRIMARY KEY,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				role TEXT NOT NULL,
				payload_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(client_id, session_id, id)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS runs (
				run_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				status TEXT NOT NULL,
				worker_id TEXT,
				model_json JSONB NOT NULL,
				thinking_level TEXT NOT NULL,
				started_at TEXT,
				updated_at TEXT NOT NULL,
				ended_at TEXT,
				error TEXT,
				PRIMARY KEY (client_id, run_id),
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(client_id, session_id, updated_at DESC)",
		);
		await this.query(this.queryable, "CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at)");
		await this.query(
			this.queryable,
			`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_session
			ON runs(client_id, session_id)
			WHERE status IN ('queued', 'running', 'cancelling')
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_runs_worker_running ON runs(worker_id, updated_at) WHERE status = 'running'",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS run_events (
				id BIGSERIAL PRIMARY KEY,
				run_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				payload_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE (client_id, run_id, seq),
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id),
				FOREIGN KEY (client_id, run_id) REFERENCES runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(client_id, run_id, seq)",
		);
		await this.query(
			this.queryable,
			`
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
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_app_preview_goals_status ON app_preview_goals(status, updated_at)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS app_preview_goal_events (
				id BIGSERIAL PRIMARY KEY,
				goal_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				run_id TEXT,
				event_type TEXT NOT NULL,
				reason_code TEXT,
				payload_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (client_id, session_id) REFERENCES sessions(client_id, session_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_app_preview_goal_events_goal ON app_preview_goal_events(client_id, session_id, id)",
		);
	}

	async ensureAgentV2Schema(): Promise<void> {
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_schema_metadata (
				schema_version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL
			)
		`,
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_runs (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				status TEXT NOT NULL,
				phase TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				input_json JSONB NOT NULL,
				model_json JSONB NOT NULL,
				worker_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				started_at TEXT,
				ended_at TEXT,
				error_json JSONB,
				PRIMARY KEY (client_id, run_id),
				FOREIGN KEY (client_id) REFERENCES clients(client_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_run_events (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				payload_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, seq),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_tasks (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				parent_task_id TEXT,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				depends_on_json JSONB NOT NULL,
				acceptance_criteria_json JSONB NOT NULL DEFAULT '[]'::jsonb,
				input_json JSONB NOT NULL,
				output_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				started_at TEXT,
				ended_at TEXT,
				error_json JSONB,
				PRIMARY KEY (client_id, run_id, task_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"ALTER TABLE agent_v2_tasks ADD COLUMN IF NOT EXISTS acceptance_criteria_json JSONB NOT NULL DEFAULT '[]'::jsonb",
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_tasks_run_updated ON agent_v2_tasks(client_id, run_id, updated_at DESC)",
		);
		await this.query(
			this.queryable,
			`
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
				metadata_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, artifact_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_artifacts_run_updated ON agent_v2_artifacts(client_id, run_id, updated_at DESC)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_documents (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				document_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				version TEXT NOT NULL,
				content_markdown TEXT NOT NULL,
				content_json JSONB NOT NULL,
				source_task_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, document_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_documents_run_updated ON agent_v2_documents(client_id, run_id, updated_at DESC)",
		);
		await this.query(
			this.queryable,
			`
			CREATE TABLE IF NOT EXISTS agent_v2_validations (
				client_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				validation_id TEXT NOT NULL,
				task_id TEXT,
				artifact_id TEXT,
				status TEXT NOT NULL,
				summary TEXT NOT NULL,
				details_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, validation_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_validations_run_updated ON agent_v2_validations(client_id, run_id, updated_at DESC)",
		);
		await this.query(
			this.queryable,
			`
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
				data_json JSONB NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (client_id, run_id, diagnostic_id),
				FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
			)
		`,
		);
		await this.query(
			this.queryable,
			"CREATE INDEX IF NOT EXISTS idx_agent_v2_diagnostics_run_created ON agent_v2_diagnostics(client_id, run_id, created_at ASC)",
		);
		await this.query(
			this.queryable,
			`INSERT INTO agent_v2_schema_metadata (schema_version, applied_at)
			VALUES ($1, $2)
			ON CONFLICT(schema_version) DO NOTHING`,
			[AGENT_V2_SCHEMA_VERSION, now()],
		);
	}

	async close(): Promise<void> {
		await this.pool?.end();
	}

	async upsertClient(clientId: string): Promise<void> {
		await this.upsertClientWithQueryable(this.queryable, clientId, now());
	}

	async createSession(input: CreateSessionInput): Promise<RuntimeSessionRecord> {
		const createdAt = input.createdAt ?? now();
		const updatedAt = input.updatedAt ?? createdAt;
		return this.withTransaction(async (tx) => {
			await this.upsertClientWithQueryable(tx, input.clientId, createdAt);
			const row = await this.queryOne<SessionRow>(
				tx,
				`INSERT INTO sessions (
					session_id,
					client_id,
					title,
					model_json,
					thinking_level,
					created_at,
					updated_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7)
				RETURNING ${SESSION_COLUMNS}`,
				[input.sessionId, input.clientId, input.title, input.model, input.thinkingLevel, createdAt, updatedAt],
			);
			return row
				? toSessionRecord(row)
				: {
						sessionId: input.sessionId,
						clientId: input.clientId,
						title: input.title,
						model: input.model,
						thinkingLevel: input.thinkingLevel,
						createdAt,
						updatedAt,
					};
		});
	}

	async listSessions(clientId: string): Promise<RuntimeSessionRecord[]> {
		const rows = await this.queryRows<SessionRow>(
			this.queryable,
			`SELECT ${SESSION_COLUMNS}
			FROM sessions
			WHERE client_id = $1
			ORDER BY updated_at DESC, session_id ASC`,
			[clientId],
		);
		return rows.map(toSessionRecord);
	}

	async getSession(clientId: string, sessionId: string): Promise<RuntimeSessionRecord | undefined> {
		const row = await this.selectSession(this.queryable, clientId, sessionId);
		return row ? toSessionRecord(row) : undefined;
	}

	async updateSessionTitle(
		clientId: string,
		sessionId: string,
		title: string,
	): Promise<RuntimeSessionRecord | undefined> {
		const row = await this.queryOne<SessionRow>(
			this.queryable,
			`UPDATE sessions
			SET title = $3, updated_at = $4
			WHERE client_id = $1 AND session_id = $2
			RETURNING ${SESSION_COLUMNS}`,
			[clientId, sessionId, title, now()],
		);
		return row ? toSessionRecord(row) : undefined;
	}

	async appendMessage(input: AppendMessageInput): Promise<RuntimeMessageRecord> {
		const createdAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			const row = await this.queryOne<MessageRow>(
				tx,
				`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES ($1, $2, $3, $4, $5)
				RETURNING ${MESSAGE_COLUMNS}`,
				[input.sessionId, input.clientId, input.role, input.payload, createdAt],
			);
			await this.query(tx, "UPDATE sessions SET updated_at = $1 WHERE client_id = $2 AND session_id = $3", [
				createdAt,
				input.clientId,
				input.sessionId,
			]);
			return row
				? toMessageRecord(row)
				: {
						messageId: 0,
						sessionId: input.sessionId,
						clientId: input.clientId,
						role: input.role,
						payload: input.payload,
						createdAt,
					};
		});
	}

	async listMessages(clientId: string, sessionId: string): Promise<RuntimeMessageRecord[]> {
		const rows = await this.queryRows<MessageRow>(
			this.queryable,
			`SELECT ${MESSAGE_COLUMNS}
			FROM messages
			WHERE client_id = $1 AND session_id = $2
			ORDER BY id ASC`,
			[clientId, sessionId],
		);
		return rows.map(toMessageRecord);
	}

	async getSessionMessageStats(
		clientId: string,
		sessionId: string,
	): Promise<{ messageCount: number; totalPayloadBytes: number; largestPayloadBytes: number }> {
		const row = await this.queryOne<MessageStatsRow>(
			this.queryable,
			`SELECT
				COUNT(*) AS message_count,
				COALESCE(SUM(octet_length(payload_json::text)), 0) AS total_payload_bytes,
				COALESCE(MAX(octet_length(payload_json::text)), 0) AS largest_payload_bytes
			FROM messages
			WHERE client_id = $1 AND session_id = $2`,
			[clientId, sessionId],
		);
		return {
			messageCount: toNumber(row?.message_count),
			totalPayloadBytes: toNumber(row?.total_payload_bytes),
			largestPayloadBytes: toNumber(row?.largest_payload_bytes),
		};
	}

	async *iterateMessages(clientId: string, sessionId: string): AsyncIterable<RuntimeMessageRecord> {
		for (const row of await this.listMessages(clientId, sessionId)) yield row;
	}

	async getRun(clientId: string, runId: string): Promise<RuntimeRunRecord | undefined> {
		const row = await this.selectRun(this.queryable, clientId, runId);
		return row ? toRunRecord(row) : undefined;
	}

	async getRunById(runId: string): Promise<RuntimeRunRecord | undefined> {
		const row = await this.queryOne<RunRow>(
			this.queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE run_id = $1
			ORDER BY updated_at DESC, client_id ASC
			LIMIT 1`,
			[runId],
		);
		return row ? toRunRecord(row) : undefined;
	}

	async listRuns(clientId: string): Promise<RuntimeRunRecord[]> {
		const rows = await this.queryRows<RunRow>(
			this.queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE client_id = $1
			ORDER BY updated_at DESC, run_id ASC`,
			[clientId],
		);
		return rows.map(toRunRecord);
	}

	async listRunsForSession(clientId: string, sessionId: string): Promise<RuntimeRunRecord[]> {
		const rows = await this.queryRows<RunRow>(
			this.queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE client_id = $1 AND session_id = $2
			ORDER BY updated_at DESC, run_id ASC`,
			[clientId, sessionId],
		);
		return rows.map(toRunRecord);
	}

	async listRunsByStatus(status: RunStatus, workerId?: string): Promise<RuntimeRunRecord[]> {
		const values = workerId === undefined ? [status] : [status, workerId];
		const rows = await this.queryRows<RunRow>(
			this.queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE status = $1${workerId === undefined ? "" : " AND worker_id = $2"}
			ORDER BY updated_at ASC, run_id ASC`,
			values,
		);
		return rows.map(toRunRecord);
	}

	async listRunningRunsByWorker(workerId: string): Promise<RuntimeRunRecord[]> {
		const rows = await this.queryRows<RunRow>(
			this.queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE worker_id = $1 AND status IN ('running', 'cancelling')
			ORDER BY updated_at ASC, run_id ASC`,
			[workerId],
		);
		return rows.map(toRunRecord);
	}

	async createRun(input: CreateRunInput): Promise<RuntimeRunRecord> {
		const updatedAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			await this.selectSession(tx, input.clientId, input.sessionId, true);
			if (await this.hasActiveRun(tx, input.clientId, input.sessionId)) {
				throw new Error("Active run already exists for session");
			}
			const row = await this.insertQueuedRun(tx, input, updatedAt);
			await this.updateSessionRun(tx, input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			return row ? toRunRecord(row) : requiredRecord(await this.getRun(input.clientId, input.runId), "run");
		});
	}

	async createContinuationRun(input: CreateRunInput): Promise<RuntimeRunRecord | undefined> {
		const updatedAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			const existingSession = await this.selectSession(tx, input.clientId, input.sessionId, true);
			if (!existingSession) return undefined;
			if (await this.hasActiveRun(tx, input.clientId, input.sessionId)) return undefined;
			const row = await this.insertQueuedRun(tx, input, updatedAt);
			await this.updateSessionRun(tx, input.clientId, input.sessionId, input.runId, "queued", updatedAt, {
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			return row ? toRunRecord(row) : requiredRecord(await this.getRun(input.clientId, input.runId), "run");
		});
	}

	async createRunWithMessage(input: CreateRunWithMessageInput): Promise<StartRunResult | undefined> {
		const createdAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			const existingSession = await this.selectSession(tx, input.clientId, input.sessionId, true);
			if (existingSession && (await this.hasActiveRun(tx, input.clientId, input.sessionId))) return undefined;

			if (!existingSession) {
				await this.upsertClientWithQueryable(tx, input.clientId, createdAt);
			}
			const insertedSession = existingSession
				? undefined
				: await this.queryOne<SessionRow>(
						tx,
						`INSERT INTO sessions (
							session_id,
							client_id,
							title,
							model_json,
							thinking_level,
							created_at,
							updated_at
						) VALUES ($1, $2, $3, $4, $5, $6, $7)
						RETURNING ${SESSION_COLUMNS}`,
						[
							input.sessionId,
							input.clientId,
							input.title,
							input.model,
							input.thinkingLevel,
							createdAt,
							createdAt,
						],
					);
			const baseSession = existingSession
				? toSessionRecord(existingSession)
				: insertedSession
					? toSessionRecord(insertedSession)
					: {
							sessionId: input.sessionId,
							clientId: input.clientId,
							title: input.title,
							model: input.model,
							thinkingLevel: input.thinkingLevel,
							createdAt,
							updatedAt: createdAt,
						};
			const messageRow = await this.queryOne<MessageRow>(
				tx,
				`INSERT INTO messages (session_id, client_id, role, payload_json, created_at)
				VALUES ($1, $2, $3, $4, $5)
				RETURNING ${MESSAGE_COLUMNS}`,
				[input.sessionId, input.clientId, input.messageRole, input.payload, createdAt],
			);
			const runRow = await this.insertQueuedRun(tx, input, createdAt);
			const updatedSession = await this.updateSessionRun(
				tx,
				input.clientId,
				input.sessionId,
				input.runId,
				"queued",
				createdAt,
				{ model: input.model, thinkingLevel: input.thinkingLevel },
			);
			return {
				session: updatedSession ?? {
					...baseSession,
					model: input.model,
					thinkingLevel: input.thinkingLevel,
					updatedAt: createdAt,
					lastRunStatus: "queued",
					lastRunId: input.runId,
				},
				message: messageRow
					? toMessageRecord(messageRow)
					: {
							messageId: 0,
							sessionId: input.sessionId,
							clientId: input.clientId,
							role: input.messageRole,
							payload: input.payload,
							createdAt,
						},
				run: runRow
					? toRunRecord(runRow)
					: {
							runId: input.runId,
							sessionId: input.sessionId,
							clientId: input.clientId,
							status: "queued",
							model: input.model,
							thinkingLevel: input.thinkingLevel,
							updatedAt: createdAt,
						},
			};
		});
	}

	async updateRunStatus(
		runId: string,
		clientId: string,
		status: RunStatus,
		patch: RunStatusPatch = {},
	): Promise<RuntimeRunRecord> {
		const updatedAt = patch.updatedAt ?? now();

		return this.withTransaction(async (tx) => {
			const current = toRunRecord(requiredRecord(await this.selectRun(tx, clientId, runId, true), "run"));
			const workerId = status === "running" ? (patch.workerId ?? current.workerId) : current.workerId;
			const startedAt =
				status === "running" ? (patch.startedAt ?? current.startedAt ?? updatedAt) : current.startedAt;
			const endedAt = TERMINAL_RUN_STATUSES.has(status) ? (patch.endedAt ?? updatedAt) : current.endedAt;
			const error = TERMINAL_RUN_STATUSES.has(status) ? (patch.error ?? current.error) : current.error;
			const row = await this.queryOne<RunRow>(
				tx,
				`UPDATE runs
				SET status = $3, worker_id = $4, started_at = $5, updated_at = $6, ended_at = $7, error = $8
				WHERE client_id = $1 AND run_id = $2
				RETURNING ${RUN_COLUMNS}`,
				[clientId, runId, status, workerId ?? null, startedAt ?? null, updatedAt, endedAt ?? null, error ?? null],
			);
			await this.updateSessionRun(tx, clientId, current.sessionId, runId, status, updatedAt);
			return requiredRecord(row ? toRunRecord(row) : undefined, "run");
		});
	}

	async appendRunEvent(input: AppendRunEventInput): Promise<RuntimeRunEventRecord> {
		const createdAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			const run = requiredRecord(await this.selectRun(tx, input.clientId, input.runId, true), "run");
			if (run.session_id !== input.sessionId) throw new Error("Run event session does not match run session");
			const seq =
				input.seq ??
				toNumber(
					(
						await this.queryOne<SeqRow>(
							tx,
							"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE client_id = $1 AND run_id = $2",
							[input.clientId, input.runId],
						)
					)?.seq,
				);
			const row = await this.queryOne<RunEventRow>(
				tx,
				`INSERT INTO run_events (run_id, session_id, client_id, seq, event_type, payload_json, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				RETURNING ${RUN_EVENT_COLUMNS}`,
				[input.runId, run.session_id, input.clientId, seq, input.type, input.payload, createdAt],
			);
			await this.query(tx, "UPDATE runs SET updated_at = $3 WHERE client_id = $1 AND run_id = $2", [
				input.clientId,
				input.runId,
				createdAt,
			]);
			await this.updateSessionRun(tx, input.clientId, run.session_id, run.run_id, run.status, createdAt);
			return requiredRecord(row ? toRunEventRecord(row) : undefined, "run event");
		});
	}

	async listRunEvents(clientId: string, runId: string, afterSeq: number): Promise<RuntimeRunEventRecord[]> {
		const rows = await this.queryRows<RunEventRow>(
			this.queryable,
			`SELECT ${RUN_EVENT_COLUMNS}
			FROM run_events
			WHERE client_id = $1 AND run_id = $2 AND seq > $3
			ORDER BY seq ASC`,
			[clientId, runId, afterSeq],
		);
		return rows.map(toRunEventRecord);
	}

	async *iterateRunEvents(clientId: string, runId: string, afterSeq: number): AsyncIterable<RuntimeRunEventRecord> {
		for (const row of await this.listRunEvents(clientId, runId, afterSeq)) yield row;
	}

	async getLatestRunCheckpoint(clientId: string, runId: string): Promise<RuntimeRunEventRecord | undefined> {
		const row = await this.queryOne<RunEventRow>(
			this.queryable,
			`SELECT ${RUN_EVENT_COLUMNS}
			FROM run_events
			WHERE client_id = $1 AND run_id = $2 AND event_type = 'message_update'
			ORDER BY seq DESC LIMIT 1`,
			[clientId, runId],
		);
		return row ? toRunEventRecord(row) : undefined;
	}

	async upsertAppPreviewGoal(input: UpsertAppPreviewGoalInput): Promise<AppPreviewGoalRecord> {
		const createdAt = input.createdAt ?? now();
		const updatedAt = input.updatedAt ?? createdAt;
		const row = await this.queryOne<AppPreviewGoalRow>(
			this.queryable,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
				completed_at = excluded.completed_at
			RETURNING ${APP_PREVIEW_GOAL_COLUMNS}`,
			[
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
			],
		);
		return requiredRecord(row ? toAppPreviewGoalRecord(row) : undefined, "app preview goal");
	}

	async getAppPreviewGoal(clientId: string, sessionId: string): Promise<AppPreviewGoalRecord | undefined> {
		const row = await this.queryOne<AppPreviewGoalRow>(
			this.queryable,
			`SELECT ${APP_PREVIEW_GOAL_COLUMNS}
			FROM app_preview_goals
			WHERE client_id = $1 AND session_id = $2`,
			[clientId, sessionId],
		);
		return row ? toAppPreviewGoalRecord(row) : undefined;
	}

	async updateAppPreviewGoal(input: UpdateAppPreviewGoalInput): Promise<AppPreviewGoalRecord | undefined> {
		return this.withTransaction(async (tx) => {
			const current = await this.queryOne<AppPreviewGoalRow>(
				tx,
				`SELECT ${APP_PREVIEW_GOAL_COLUMNS}
				FROM app_preview_goals
				WHERE client_id = $1 AND session_id = $2
				FOR UPDATE`,
				[input.clientId, input.sessionId],
			);
			if (!current) return undefined;
			const currentRecord = toAppPreviewGoalRecord(current);
			const updatedAt = input.updatedAt ?? now();
			const lastRunId = "lastRunId" in input ? input.lastRunId : currentRecord.lastRunId;
			const lastPreviewUrl = "lastPreviewUrl" in input ? input.lastPreviewUrl : currentRecord.lastPreviewUrl;
			const lastFailureReason =
				"lastFailureReason" in input ? input.lastFailureReason : currentRecord.lastFailureReason;
			const completedAt = "completedAt" in input ? input.completedAt : currentRecord.completedAt;
			const row = await this.queryOne<AppPreviewGoalRow>(
				tx,
				`UPDATE app_preview_goals
				SET status = $3,
					max_continuation_runs = $4,
					continuation_runs_used = $5,
					retry_attempts_used = $6,
					last_run_id = $7,
					last_preview_url = $8,
					last_failure_reason = $9,
					updated_at = $10,
					completed_at = $11
				WHERE client_id = $1 AND session_id = $2
				RETURNING ${APP_PREVIEW_GOAL_COLUMNS}`,
				[
					input.clientId,
					input.sessionId,
					input.status ?? currentRecord.status,
					input.maxContinuationRuns ?? currentRecord.maxContinuationRuns,
					input.continuationRunsUsed ?? currentRecord.continuationRunsUsed,
					input.retryAttemptsUsed ?? currentRecord.retryAttemptsUsed,
					lastRunId ?? null,
					lastPreviewUrl ?? null,
					lastFailureReason ?? null,
					updatedAt,
					completedAt ?? null,
				],
			);
			return row ? toAppPreviewGoalRecord(row) : undefined;
		});
	}

	async appendAppPreviewGoalEvent(input: AppendAppPreviewGoalEventInput): Promise<AppPreviewGoalEventRecord> {
		const createdAt = input.createdAt ?? now();
		const payload = input.payload ?? {};
		return this.withTransaction(async (tx) => {
			const goal = await this.queryOne<AppPreviewGoalRow>(
				tx,
				`SELECT ${APP_PREVIEW_GOAL_COLUMNS}
				FROM app_preview_goals
				WHERE client_id = $1 AND session_id = $2
				FOR UPDATE`,
				[input.clientId, input.sessionId],
			);
			const goalRecord = requiredRecord(goal ? toAppPreviewGoalRecord(goal) : undefined, "app preview goal");
			if (goalRecord.goalId !== input.goalId)
				throw new Error("App preview goal event goal id does not match session goal");
			const row = await this.queryOne<AppPreviewGoalEventRow>(
				tx,
				`INSERT INTO app_preview_goal_events (
					goal_id,
					client_id,
					session_id,
					run_id,
					event_type,
					reason_code,
					payload_json,
					created_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				RETURNING ${APP_PREVIEW_GOAL_EVENT_COLUMNS}`,
				[
					input.goalId,
					input.clientId,
					input.sessionId,
					input.runId ?? null,
					input.eventType,
					input.reasonCode ?? null,
					payload,
					createdAt,
				],
			);
			return requiredRecord(row ? toAppPreviewGoalEventRecord(row) : undefined, "app preview goal event");
		});
	}

	async listAppPreviewGoalEvents(
		clientId: string,
		sessionId: string,
		afterEventId: number,
	): Promise<AppPreviewGoalEventRecord[]> {
		const rows = await this.queryRows<AppPreviewGoalEventRow>(
			this.queryable,
			`SELECT ${APP_PREVIEW_GOAL_EVENT_COLUMNS}
			FROM app_preview_goal_events
			WHERE client_id = $1 AND session_id = $2 AND id > $3
			ORDER BY id ASC`,
			[clientId, sessionId, afterEventId],
		);
		return rows.map(toAppPreviewGoalEventRecord);
	}

	async createAgentV2Run(input: CreateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		const run = buildAgentV2Run(input);
		return this.withTransaction(async (tx) => {
			await this.upsertClientWithQueryable(tx, run.clientId, run.createdAt);
			const row = await this.queryOne<AgentV2RunRow>(
				tx,
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
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
				RETURNING ${AGENT_V2_RUN_COLUMNS}`,
				[
					run.clientId,
					run.runId,
					run.status,
					run.phase,
					run.attempt,
					run.input,
					run.model,
					run.workerId ?? null,
					run.createdAt,
					run.updatedAt,
					run.startedAt ?? null,
					run.endedAt ?? null,
					run.error ?? null,
				],
			);
			return requiredRecord(row ? toAgentV2RunRecord(row) : undefined, "agent v2 run");
		});
	}

	async getAgentV2Run(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		const row = await this.queryOne<AgentV2RunRow>(
			this.queryable,
			`SELECT ${AGENT_V2_RUN_COLUMNS}
			FROM agent_v2_runs
			WHERE client_id = $1 AND run_id = $2`,
			[clientId, runId],
		);
		return row ? toAgentV2RunRecord(row) : undefined;
	}

	async listAgentV2Runs(clientId: string): Promise<AgentV2RunSnapshot[]> {
		const rows = await this.queryRows<AgentV2RunRow>(
			this.queryable,
			`SELECT ${AGENT_V2_RUN_COLUMNS}
			FROM agent_v2_runs
			WHERE client_id = $1
			ORDER BY updated_at DESC, run_id ASC`,
			[clientId],
		);
		return rows.map(toAgentV2RunRecord);
	}

	async listAgentV2RunsByWorker(workerId: string): Promise<AgentV2RunSnapshot[]> {
		const rows = await this.queryRows<AgentV2RunRow>(
			this.queryable,
			`SELECT ${AGENT_V2_RUN_COLUMNS}
			FROM agent_v2_runs
			WHERE worker_id = $1 AND status IN ('running', 'cancelling')
			ORDER BY updated_at ASC, run_id ASC`,
			[workerId],
		);
		return rows.map(toAgentV2RunRecord);
	}

	async updateAgentV2Run(input: UpdateAgentV2RunInput): Promise<AgentV2RunSnapshot> {
		return (await this.updateAgentV2RunWithResult(input)).run;
	}

	async updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): Promise<AgentV2RunUpdateResult> {
		return this.withTransaction(async (tx) => {
			const currentRow = await this.queryOne<AgentV2RunRow>(
				tx,
				`SELECT ${AGENT_V2_RUN_COLUMNS}
				FROM agent_v2_runs
				WHERE client_id = $1 AND run_id = $2
				FOR UPDATE`,
				[input.clientId, input.runId],
			);
			const current = requiredRecord(currentRow ? toAgentV2RunRecord(currentRow) : undefined, "agent v2 run");
			if (input.expectedStatuses && !input.expectedStatuses.includes(current.status)) {
				return { run: current, applied: false };
			}
			const next = applyAgentV2RunUpdate(current, input);
			const row = await this.queryOne<AgentV2RunRow>(
				tx,
				`UPDATE agent_v2_runs
				SET status = $3,
					phase = $4,
					attempt = $5,
					worker_id = $6,
					updated_at = $7,
					started_at = $8,
					ended_at = $9,
					error_json = $10
				WHERE client_id = $1 AND run_id = $2
				RETURNING ${AGENT_V2_RUN_COLUMNS}`,
				[
					input.clientId,
					input.runId,
					next.status,
					next.phase,
					next.attempt,
					next.workerId ?? null,
					next.updatedAt,
					next.startedAt ?? null,
					next.endedAt ?? null,
					next.error ?? null,
				],
			);
			return {
				run: requiredRecord(row ? toAgentV2RunRecord(row) : undefined, "agent v2 run"),
				applied: true,
			};
		});
	}

	async appendAgentV2RunEvent(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		const createdAt = input.createdAt ?? now();
		return this.withTransaction(async (tx) => {
			requiredRecord(await this.getAgentV2Run(input.clientId, input.runId), "agent v2 run");
			const seq =
				input.seq ??
				toNumber(
					(
						await this.queryOne<SeqRow>(
							tx,
							"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_v2_run_events WHERE client_id = $1 AND run_id = $2",
							[input.clientId, input.runId],
						)
					)?.seq,
				);
			const row = await this.queryOne<AgentV2RunEventRow>(
				tx,
				`INSERT INTO agent_v2_run_events (
					client_id,
					run_id,
					seq,
					event_type,
					payload_json,
					created_at
				) VALUES ($1, $2, $3, $4, $5, $6)
				RETURNING ${AGENT_V2_RUN_EVENT_COLUMNS}`,
				[input.clientId, input.runId, seq, input.type, input.payload, createdAt],
			);
			return requiredRecord(row ? toAgentV2RunEventRecord(row) : undefined, "agent v2 run event");
		});
	}

	async listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		const rows = await this.queryRows<AgentV2RunEventRow>(
			this.queryable,
			`SELECT ${AGENT_V2_RUN_EVENT_COLUMNS}
			FROM agent_v2_run_events
			WHERE client_id = $1 AND run_id = $2 AND seq > $3
			ORDER BY seq ASC`,
			[clientId, runId, afterSeq],
		);
		return rows.map(toAgentV2RunEventRecord);
	}

	async upsertAgentV2Task(input: UpsertAgentV2TaskInput): Promise<AgentV2TaskNode> {
		const task = buildAgentV2Task(input);
		const row = await this.queryOne<AgentV2TaskRow>(
			this.queryable,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
				error_json = excluded.error_json
			RETURNING ${AGENT_V2_TASK_COLUMNS}`,
			[
				input.clientId,
				input.runId,
				task.taskId,
				task.parentTaskId ?? null,
				task.kind,
				task.title,
				task.status,
				task.dependsOn,
				task.acceptanceCriteria,
				task.input,
				task.output,
				task.createdAt,
				task.updatedAt,
				task.startedAt ?? null,
				task.endedAt ?? null,
				task.error ?? null,
			],
		);
		return requiredRecord(row ? toAgentV2TaskRecord(row) : undefined, "agent v2 task");
	}

	async listAgentV2Tasks(clientId: string, runId: string): Promise<AgentV2TaskNode[]> {
		const rows = await this.queryRows<AgentV2TaskRow>(
			this.queryable,
			`SELECT ${AGENT_V2_TASK_COLUMNS}
			FROM agent_v2_tasks
			WHERE client_id = $1 AND run_id = $2
			ORDER BY created_at ASC, task_id ASC`,
			[clientId, runId],
		);
		return rows.map(toAgentV2TaskRecord);
	}

	async upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInput): Promise<AgentV2ArtifactRecord> {
		const artifact = buildAgentV2Artifact(input);
		const row = await this.queryOne<AgentV2ArtifactRow>(
			this.queryable,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			ON CONFLICT(client_id, run_id, artifact_id) DO UPDATE SET
				kind = excluded.kind,
				path = excluded.path,
				media_type = excluded.media_type,
				checksum = excluded.checksum,
				version = excluded.version,
				source_task_id = excluded.source_task_id,
				validation_status = excluded.validation_status,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at
			RETURNING ${AGENT_V2_ARTIFACT_COLUMNS}`,
			[
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
				artifact.metadataJson,
				artifact.createdAt,
				artifact.updatedAt,
			],
		);
		return requiredRecord(row ? toAgentV2ArtifactRecord(row) : undefined, "agent v2 artifact");
	}

	async listAgentV2Artifacts(clientId: string, runId: string): Promise<AgentV2ArtifactRecord[]> {
		const rows = await this.queryRows<AgentV2ArtifactRow>(
			this.queryable,
			`SELECT ${AGENT_V2_ARTIFACT_COLUMNS}
			FROM agent_v2_artifacts
			WHERE client_id = $1 AND run_id = $2
			ORDER BY created_at ASC, artifact_id ASC`,
			[clientId, runId],
		);
		return rows.map(toAgentV2ArtifactRecord);
	}

	async upsertAgentV2Document(input: UpsertAgentV2DocumentInput): Promise<AgentV2DocumentRecord> {
		const document = buildAgentV2Document(input);
		const row = await this.queryOne<AgentV2DocumentRow>(
			this.queryable,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT(client_id, run_id, document_id) DO UPDATE SET
				kind = excluded.kind,
				version = excluded.version,
				content_markdown = excluded.content_markdown,
				content_json = excluded.content_json,
				source_task_id = excluded.source_task_id,
				updated_at = excluded.updated_at
			RETURNING ${AGENT_V2_DOCUMENT_COLUMNS}`,
			[
				document.clientId,
				document.runId,
				document.documentId,
				document.kind,
				document.version,
				document.contentMarkdown,
				document.contentJson,
				document.sourceTaskId ?? null,
				document.createdAt,
				document.updatedAt,
			],
		);
		return requiredRecord(row ? toAgentV2DocumentRecord(row) : undefined, "agent v2 document");
	}

	async listAgentV2Documents(clientId: string, runId: string): Promise<AgentV2DocumentRecord[]> {
		const rows = await this.queryRows<AgentV2DocumentRow>(
			this.queryable,
			`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
			FROM agent_v2_documents
			WHERE client_id = $1 AND run_id = $2
			ORDER BY created_at ASC, document_id ASC`,
			[clientId, runId],
		);
		return rows.map(toAgentV2DocumentRecord);
	}

	async getAgentV2Document(
		clientId: string,
		runId: string,
		documentId: string,
	): Promise<AgentV2DocumentRecord | undefined> {
		const row = await this.queryOne<AgentV2DocumentRow>(
			this.queryable,
			`SELECT ${AGENT_V2_DOCUMENT_COLUMNS}
			FROM agent_v2_documents
			WHERE client_id = $1 AND run_id = $2 AND document_id = $3`,
			[clientId, runId, documentId],
		);
		return row ? toAgentV2DocumentRecord(row) : undefined;
	}

	async upsertAgentV2Validation(input: UpsertAgentV2ValidationInput): Promise<AgentV2ValidationRecord> {
		const validation = buildAgentV2Validation(input);
		const row = await this.queryOne<AgentV2ValidationRow>(
			this.queryable,
			`INSERT INTO agent_v2_validations (
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT(client_id, run_id, validation_id) DO UPDATE SET
				task_id = excluded.task_id,
				artifact_id = excluded.artifact_id,
				status = excluded.status,
				summary = excluded.summary,
				details_json = excluded.details_json,
				updated_at = excluded.updated_at
			RETURNING ${AGENT_V2_VALIDATION_COLUMNS}`,
			[
				validation.clientId,
				validation.runId,
				validation.validationId,
				validation.taskId ?? null,
				validation.artifactId ?? null,
				validation.status,
				validation.summary,
				validation.details,
				validation.createdAt,
				validation.updatedAt,
			],
		);
		return requiredRecord(row ? toAgentV2ValidationRecord(row) : undefined, "agent v2 validation");
	}

	async listAgentV2Validations(clientId: string, runId: string): Promise<AgentV2ValidationRecord[]> {
		const rows = await this.queryRows<AgentV2ValidationRow>(
			this.queryable,
			`SELECT ${AGENT_V2_VALIDATION_COLUMNS}
			FROM agent_v2_validations
			WHERE client_id = $1 AND run_id = $2
			ORDER BY created_at ASC, validation_id ASC`,
			[clientId, runId],
		);
		return rows.map(toAgentV2ValidationRecord);
	}

	async appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): Promise<AgentV2DiagnosticEvent> {
		const row = await this.queryOne<AgentV2DiagnosticRow>(
			this.queryable,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			RETURNING ${AGENT_V2_DIAGNOSTIC_COLUMNS}`,
			[
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
				input.data,
				input.createdAt,
			],
		);
		return requiredRecord(row ? toAgentV2DiagnosticRecord(row) : undefined, "agent v2 diagnostic");
	}

	async listAgentV2Diagnostics(clientId: string, runId: string): Promise<AgentV2DiagnosticEvent[]> {
		const rows = await this.queryRows<AgentV2DiagnosticRow>(
			this.queryable,
			`SELECT ${AGENT_V2_DIAGNOSTIC_COLUMNS}
			FROM agent_v2_diagnostics
			WHERE client_id = $1 AND run_id = $2
			ORDER BY created_at ASC, diagnostic_id ASC`,
			[clientId, runId],
		);
		return rows.map(toAgentV2DiagnosticRecord);
	}

	async resetAgentV2RuntimeData(options: ResetAgentV2RuntimeDataOptions = {}): Promise<ResetAgentV2RuntimeDataResult> {
		await this.ensureSchema();
		await this.ensureAgentV2Schema();

		const appliedAt = options.now?.() ?? now();
		return this.withTransaction(async (tx) => {
			const legacyRowsDeletedBase = await this.deleteAllRows(tx, LEGACY_RESET_TABLES);
			const agentV2RowsDeleted = await this.deleteAllRows(tx, AGENT_V2_RESET_TABLES);
			const legacyRowsDeleted = {
				...legacyRowsDeletedBase,
				clients: options.includeClients === true ? await this.deleteTableRows(tx, "clients") : 0,
			};
			await this.query(
				tx,
				`INSERT INTO agent_v2_schema_metadata (schema_version, applied_at)
				VALUES ($1, $2)`,
				[AGENT_V2_SCHEMA_VERSION, appliedAt],
			);

			return {
				legacyRowsDeleted,
				agentV2RowsDeleted,
				schemaVersion: AGENT_V2_SCHEMA_VERSION,
			};
		});
	}

	async deleteSession(clientId: string, sessionId: string): Promise<boolean> {
		return this.withTransaction(async (tx) => {
			await this.query(tx, "DELETE FROM app_preview_goal_events WHERE client_id = $1 AND session_id = $2", [
				clientId,
				sessionId,
			]);
			await this.query(tx, "DELETE FROM app_preview_goals WHERE client_id = $1 AND session_id = $2", [
				clientId,
				sessionId,
			]);
			await this.query(tx, "DELETE FROM run_events WHERE client_id = $1 AND session_id = $2", [clientId, sessionId]);
			await this.query(tx, "DELETE FROM runs WHERE client_id = $1 AND session_id = $2", [clientId, sessionId]);
			await this.query(tx, "DELETE FROM messages WHERE client_id = $1 AND session_id = $2", [clientId, sessionId]);
			const result = await this.query(tx, "DELETE FROM sessions WHERE client_id = $1 AND session_id = $2", [
				clientId,
				sessionId,
			]);
			return (result.rowCount ?? 0) > 0;
		});
	}

	private async insertQueuedRun(
		queryable: Queryable,
		input: CreateRunInput,
		updatedAt: string,
	): Promise<RunRow | undefined> {
		return this.queryOne<RunRow>(
			queryable,
			`INSERT INTO runs (
				run_id,
				session_id,
				client_id,
				status,
				model_json,
				thinking_level,
				updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING ${RUN_COLUMNS}`,
			[input.runId, input.sessionId, input.clientId, "queued", input.model, input.thinkingLevel, updatedAt],
		);
	}

	private async updateSessionRun(
		queryable: Queryable,
		clientId: string,
		sessionId: string,
		runId: string,
		status: RunStatus,
		updatedAt: string,
		context?: SessionRunContext,
	): Promise<RuntimeSessionRecord | undefined> {
		const row = context
			? await this.queryOne<SessionRow>(
					queryable,
					`UPDATE sessions
					SET updated_at = $1, last_run_status = $2, last_run_id = $3, model_json = $4, thinking_level = $5
					WHERE client_id = $6 AND session_id = $7
					RETURNING ${SESSION_COLUMNS}`,
					[updatedAt, status, runId, context.model, context.thinkingLevel, clientId, sessionId],
				)
			: await this.queryOne<SessionRow>(
					queryable,
					`UPDATE sessions
					SET updated_at = $1, last_run_status = $2, last_run_id = $3
					WHERE client_id = $4 AND session_id = $5
					RETURNING ${SESSION_COLUMNS}`,
					[updatedAt, status, runId, clientId, sessionId],
				);
		return row ? toSessionRecord(row) : undefined;
	}

	private async hasActiveRun(queryable: Queryable, clientId: string, sessionId: string): Promise<boolean> {
		const row = await this.queryOne<{ active: number }>(
			queryable,
			`SELECT 1 AS active
			FROM runs
			WHERE client_id = $1 AND session_id = $2 AND status = ANY($3::text[])
			LIMIT 1`,
			[clientId, sessionId, ACTIVE_RUN_STATUSES],
		);
		return Boolean(row);
	}

	private async selectSession(
		queryable: Queryable,
		clientId: string,
		sessionId: string,
		forUpdate = false,
	): Promise<SessionRow | undefined> {
		return this.queryOne<SessionRow>(
			queryable,
			`SELECT ${SESSION_COLUMNS}
			FROM sessions
			WHERE client_id = $1 AND session_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
			[clientId, sessionId],
		);
	}

	private async selectRun(
		queryable: Queryable,
		clientId: string,
		runId: string,
		forUpdate = false,
	): Promise<RunRow | undefined> {
		return this.queryOne<RunRow>(
			queryable,
			`SELECT ${RUN_COLUMNS}
			FROM runs
			WHERE client_id = $1 AND run_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
			[clientId, runId],
		);
	}

	private async upsertClientWithQueryable(queryable: Queryable, clientId: string, timestamp: string): Promise<void> {
		await this.query(
			queryable,
			`INSERT INTO clients (client_id, created_at, updated_at)
			VALUES ($1, $2, $2)
			ON CONFLICT(client_id) DO UPDATE SET updated_at = excluded.updated_at`,
			[clientId, timestamp],
		);
	}

	private async deleteAllRows<TableName extends string>(
		queryable: Queryable,
		tables: readonly TableName[],
	): Promise<Record<TableName, number>> {
		const counts = {} as Record<TableName, number>;
		for (const table of tables) {
			counts[table] = await this.deleteTableRows(queryable, table);
		}
		return counts;
	}

	private async deleteTableRows(queryable: Queryable, table: string): Promise<number> {
		const result = await this.query(queryable, `DELETE FROM ${table}`);
		return Number(result.rowCount ?? 0);
	}

	private async withTransaction<T>(callback: (queryable: Queryable) => Promise<T>): Promise<T> {
		const client = await this.connect();
		let transactionStarted = false;
		try {
			await client.query("BEGIN");
			transactionStarted = true;
			const result = await callback(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			if (transactionStarted) {
				try {
					await client.query("ROLLBACK");
				} catch {
					// Preserve the original transaction failure.
				}
			}
			throw error;
		} finally {
			client.release();
		}
	}

	private async connect(): Promise<ReleasableQueryable> {
		if (typeof this.queryable.connect === "function") return this.queryable.connect();
		return {
			query: (sql, values) => this.queryable.query(sql, values),
			release: () => {},
		};
	}

	private async query(queryable: Queryable, sql: string, values: readonly unknown[] = []): Promise<QueryResultLike> {
		return queryable.query(sql, values);
	}

	private async queryRows<T extends object>(
		queryable: Queryable,
		sql: string,
		values: readonly unknown[] = [],
	): Promise<T[]> {
		const result = await this.query(queryable, sql, values);
		return result.rows as unknown as T[];
	}

	private async queryOne<T extends object>(
		queryable: Queryable,
		sql: string,
		values: readonly unknown[] = [],
	): Promise<T | undefined> {
		const rows = await this.queryRows<T>(queryable, sql, values);
		return rows[0];
	}
}

function toSessionRecord(row: SessionRow): RuntimeSessionRecord {
	return {
		sessionId: row.session_id,
		clientId: row.client_id,
		title: row.title,
		model: parseJsonObject(row.model_json),
		thinkingLevel: row.thinking_level,
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
		...(row.last_run_status ? { lastRunStatus: row.last_run_status } : {}),
		...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
	};
}

function toMessageRecord(row: MessageRow): RuntimeMessageRecord {
	return {
		messageId: toNumber(row.id),
		sessionId: row.session_id,
		clientId: row.client_id,
		role: row.role,
		payload: parseJsonObject(row.payload_json),
		createdAt: toTimestamp(row.created_at),
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
		...(row.started_at ? { startedAt: toTimestamp(row.started_at) } : {}),
		updatedAt: toTimestamp(row.updated_at),
		...(row.ended_at ? { endedAt: toTimestamp(row.ended_at) } : {}),
		...(row.error ? { error: row.error } : {}),
	};
}

function toRunEventRecord(row: RunEventRow): RuntimeRunEventRecord {
	return {
		eventId: toNumber(row.id),
		runId: row.run_id,
		sessionId: row.session_id,
		clientId: row.client_id,
		seq: toNumber(row.seq),
		type: row.event_type,
		payload: parseJsonObject(row.payload_json),
		createdAt: toTimestamp(row.created_at),
	};
}

function toAppPreviewGoalRecord(row: AppPreviewGoalRow): AppPreviewGoalRecord {
	return {
		goalId: row.goal_id,
		clientId: row.client_id,
		sessionId: row.session_id,
		source: row.source,
		status: row.status,
		maxContinuationRuns: toNumber(row.max_continuation_runs),
		continuationRunsUsed: toNumber(row.continuation_runs_used),
		retryAttemptsUsed: toNumber(row.retry_attempts_used),
		...(row.last_run_id ? { lastRunId: row.last_run_id } : {}),
		...(row.last_preview_url ? { lastPreviewUrl: row.last_preview_url } : {}),
		...(row.last_failure_reason ? { lastFailureReason: row.last_failure_reason } : {}),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
		...(row.completed_at ? { completedAt: toTimestamp(row.completed_at) } : {}),
	};
}

function toAppPreviewGoalEventRecord(row: AppPreviewGoalEventRow): AppPreviewGoalEventRecord {
	return {
		eventId: toNumber(row.id),
		goalId: row.goal_id,
		clientId: row.client_id,
		sessionId: row.session_id,
		...(row.run_id ? { runId: row.run_id } : {}),
		eventType: row.event_type,
		...(row.reason_code ? { reasonCode: row.reason_code } : {}),
		payload: parseAppPreviewGoalEventPayload(row.payload_json),
		createdAt: toTimestamp(row.created_at),
	};
}

function parseAppPreviewGoalEventPayload(value: unknown): JsonObject {
	try {
		return parseJsonObject(value);
	} catch {
		return {};
	}
}

function parseJsonObject(value: unknown): JsonObject {
	if (typeof value === "string") {
		const parsed = JSON.parse(value) as unknown;
		return isJsonObject(parsed) ? parsed : {};
	}
	return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function toTimestamp(value: TimestampRowValue): string {
	return value instanceof Date ? value.toISOString() : value;
}

function requiredRecord<T>(record: T | undefined, label: string): T {
	if (!record) throw new Error(`Missing ${label} after write`);
	return record;
}

function now(): string {
	return new Date().toISOString();
}
