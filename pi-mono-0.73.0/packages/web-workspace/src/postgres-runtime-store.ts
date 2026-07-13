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
	type AppendAgentV2ValidationAttemptInput,
	applyAgentV2RunUpdate,
	buildAgentV2Artifact,
	buildAgentV2Document,
	buildAgentV2Run,
	buildAgentV2Task,
	buildAgentV2Validation,
	type CreateAgentV2RunInput,
	equalAgentV2ValidationRecords,
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
} from "./agent-v2-store.js";
import {
	AGENT_V2_SCHEMA_INDEXES,
	AGENT_V2_SCHEMA_RESET_REQUIRED,
	AGENT_V2_SCHEMA_TABLE_COLUMNS,
	AGENT_V2_SCHEMA_TABLES,
	AGENT_V2_SCHEMA_VERSION,
	type AgentV2RunSnapshot,
	type AgentV2TaskNode,
} from "./agent-v2-types.js";
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

const POSTGRES_AGENT_V2_SCHEMA = `
	CREATE TABLE agent_v2_schema_metadata (
		singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 2), applied_at TEXT NOT NULL
	);
	CREATE TABLE agent_v2_runs (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
		phase TEXT NOT NULL CHECK(phase IN ('intake','capability_routing','spec_draft','spec_review','plan_draft','task_generation','implementation','validation','repair','preview','delivery','blocked','failed','cancelled')),
		attempt INTEGER NOT NULL CHECK(attempt >= 0), input_json JSONB NOT NULL, model_json JSONB NOT NULL,
		worker_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, error_json JSONB,
		PRIMARY KEY (client_id, run_id)
	);
	CREATE INDEX idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at);
	CREATE INDEX idx_agent_v2_runs_worker_active ON agent_v2_runs(worker_id, updated_at) WHERE worker_id IS NOT NULL AND status IN ('running','cancelling');
	CREATE TABLE agent_v2_run_events (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), event_type TEXT NOT NULL,
		payload_json JSONB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, seq),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_tasks (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('pending','ready','running','blocked','succeeded','failed','cancelled')),
		parent_task_id TEXT, depends_on_json JSONB NOT NULL, acceptance_criteria_json JSONB NOT NULL,
		input_json JSONB NOT NULL, output_json JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		started_at TEXT, ended_at TEXT, error_json JSONB, PRIMARY KEY (client_id, run_id, task_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_tasks_run_updated ON agent_v2_tasks(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_artifacts (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
		media_type TEXT NOT NULL, checksum TEXT NOT NULL, version TEXT NOT NULL, validation_status TEXT NOT NULL,
		source_task_id TEXT, metadata_json JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, artifact_id), FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_artifacts_run_updated ON agent_v2_artifacts(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_documents (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, document_id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
		content_markdown TEXT NOT NULL, content_json JSONB NOT NULL, source_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, document_id), FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_documents_run_updated ON agent_v2_documents(client_id, run_id, updated_at DESC);
	CREATE TABLE agent_v2_diagnostics (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, diagnostic_id TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL,
		code TEXT NOT NULL, message TEXT NOT NULL, phase TEXT, task_id TEXT, artifact_id TEXT, trace_id TEXT,
		data_json JSONB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, diagnostic_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_diagnostics_run_created ON agent_v2_diagnostics(client_id, run_id, created_at, diagnostic_id);
	CREATE TABLE agent_v2_validation_attempts (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, validation_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
		task_id TEXT, artifact_id TEXT, status TEXT NOT NULL CHECK(status IN ('passed','failed','blocked','warning')),
		summary TEXT NOT NULL, details_json JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id, validation_id, attempt),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE INDEX idx_agent_v2_validation_attempts_run_created ON agent_v2_validation_attempts(client_id, run_id, created_at, validation_id, attempt);
	CREATE TABLE agent_v2_input_blobs (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, input_id TEXT NOT NULL, logical_path TEXT NOT NULL, media_type TEXT NOT NULL,
		encoding TEXT NOT NULL CHECK(encoding IN ('utf8','binary')), bytes BYTEA NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
		checksum TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (client_id, run_id, input_id),
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE UNIQUE INDEX uq_agent_v2_input_blobs_logical_path ON agent_v2_input_blobs(client_id, run_id, logical_path);
	CREATE TABLE agent_v2_input_references (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, input_id TEXT NOT NULL, logical_path TEXT NOT NULL, media_type TEXT NOT NULL,
		checksum TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('attachment','project_file')), ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
		display_name TEXT, byte_length INTEGER NOT NULL CHECK(byte_length >= 0), PRIMARY KEY (client_id, run_id, kind, ordinal),
		FOREIGN KEY (client_id, run_id, input_id) REFERENCES agent_v2_input_blobs(client_id, run_id, input_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE,
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_bootstraps (
		client_id TEXT NOT NULL, run_id TEXT NOT NULL, bootstrap_version TEXT NOT NULL, bootstrap_checksum TEXT NOT NULL, created_at TEXT NOT NULL,
		PRIMARY KEY (client_id, run_id), FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE TABLE agent_v2_outbox (
		intent_id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, client_id TEXT NOT NULL, run_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK(kind IN ('run_enqueue','run_cancel','live_event','workspace_diagnostic','langfuse_diagnostic')),
		status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered','dead_letter')), available_at TEXT NOT NULL,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reference_json JSONB NOT NULL, attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
		lease_owner TEXT, lease_expires_at TEXT, last_error_code TEXT, last_error_message TEXT, delivered_at TEXT,
		FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE
	);
	CREATE UNIQUE INDEX uq_agent_v2_outbox_dedupe ON agent_v2_outbox(dedupe_key);
	CREATE INDEX idx_agent_v2_outbox_dispatch ON agent_v2_outbox(status, available_at, created_at, intent_id);
	CREATE INDEX idx_agent_v2_outbox_lease ON agent_v2_outbox(status, lease_expires_at, intent_id);
	CREATE INDEX idx_agent_v2_outbox_run ON agent_v2_outbox(client_id, run_id, created_at, intent_id);
`;

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
		await this.ensureClientIdentitySchema();
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
		const tables = await this.listAgentV2TableNames(this.queryable);
		if (tables.length > 0) {
			await this.assertExactAgentV2Schema(this.queryable, tables);
			return;
		}
		await this.withTransaction(async (tx) => {
			await this.createAgentV2Schema(tx, now());
		});
	}

	private async createAgentV2Schema(queryable: Queryable, appliedAt: string): Promise<void> {
		await this.query(queryable, POSTGRES_AGENT_V2_SCHEMA);
		await this.query(
			queryable,
			"INSERT INTO agent_v2_schema_metadata (singleton_id, schema_version, applied_at) VALUES (1, $1, $2)",
			[AGENT_V2_SCHEMA_VERSION, appliedAt],
		);
	}

	private async listAgentV2TableNames(queryable: Queryable): Promise<string[]> {
		const rows = await this.queryRows<{ table_name: string }>(
			queryable,
			"SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'agent_v2_%' ORDER BY table_name",
		);
		return rows.map((row) => row.table_name);
	}

	private async assertExactAgentV2Schema(queryable: Queryable, tables: readonly string[]): Promise<void> {
		if (JSON.stringify(tables) !== JSON.stringify(AGENT_V2_SCHEMA_TABLES))
			throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
		const metadataColumns = await this.queryRows<{ column_name: string }>(
			queryable,
			`SELECT column_name FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'agent_v2_schema_metadata'
			ORDER BY ordinal_position`,
		);
		if (
			JSON.stringify(metadataColumns.map((row) => row.column_name)) !==
			JSON.stringify(["singleton_id", "schema_version", "applied_at"])
		) {
			throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
		}
		const metadata = await this.queryRows<{ singleton_id: number; schema_version: number }>(
			queryable,
			"SELECT singleton_id, schema_version FROM agent_v2_schema_metadata",
		);
		const indexes = await this.queryRows<{
			table_name: string;
			index_name: string;
			is_unique: boolean;
			index_definition: string;
		}>(
			queryable,
			`SELECT table_class.relname AS table_name, index_class.relname AS index_name,
			index_catalog.indisunique AS is_unique, pg_get_indexdef(index_catalog.indexrelid) AS index_definition
			FROM pg_index index_catalog
			JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
			JOIN pg_class index_class ON index_class.oid = index_catalog.indexrelid
			JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
			WHERE table_namespace.nspname = current_schema()
			AND table_class.relname LIKE 'agent_v2_%' AND NOT index_catalog.indisprimary
			ORDER BY index_class.relname`,
		);
		if (
			metadata.length !== 1 ||
			metadata[0]?.singleton_id !== 1 ||
			metadata[0]?.schema_version !== AGENT_V2_SCHEMA_VERSION ||
			JSON.stringify(indexes.map((row) => row.index_name)) !== JSON.stringify([...AGENT_V2_SCHEMA_INDEXES].sort())
		) {
			throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
		}
		const columns = await this.queryRows<{
			table_name: string;
			column_name: string;
			data_type: string;
			is_nullable: "NO" | "YES";
			column_default: string | null;
			is_identity: "NO" | "YES";
			identity_generation: string | null;
			is_generated: "NEVER" | "ALWAYS";
			generation_expression: string | null;
		}>(
			queryable,
			`SELECT table_name, column_name, data_type, is_nullable, column_default,
			is_identity, identity_generation, is_generated, generation_expression
			FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name LIKE 'agent_v2_%'
			ORDER BY table_name, ordinal_position`,
		);
		for (const table of AGENT_V2_SCHEMA_TABLES) {
			const tableColumns = columns.filter((row) => row.table_name === table);
			const actual = tableColumns.map((row) => row.column_name);
			if (
				JSON.stringify(actual) !==
				JSON.stringify(AGENT_V2_SCHEMA_TABLE_COLUMNS[table as keyof typeof AGENT_V2_SCHEMA_TABLE_COLUMNS])
			)
				throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
			for (const column of tableColumns) {
				const key = `${table}.${column.column_name}`;
				if (column.data_type !== expectedPostgresAgentV2ColumnType(key))
					throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
				if ((column.is_nullable === "YES") !== POSTGRES_AGENT_V2_NULLABLE_COLUMNS.has(key)) {
					throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
				}
				if (
					column.column_default !== null ||
					column.is_identity !== "NO" ||
					column.identity_generation !== null ||
					column.is_generated !== "NEVER" ||
					column.generation_expression !== null
				) {
					throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
				}
			}
		}
		const indexShapes = postgresAgentV2IndexShapes();
		for (const index of indexes) {
			const expected = indexShapes[index.index_name];
			const normalized = normalizePostgresDefinition(index.index_definition);
			const usingOffset = normalized.indexOf(" using ");
			if (
				!expected ||
				index.table_name !== expected.table ||
				index.is_unique !== expected.unique ||
				usingOffset < 0 ||
				normalized.slice(usingOffset) !== expected.definition
			) {
				throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
			}
		}
		const constraints = await this.queryRows<{
			table_name: string;
			constraint_type: string;
			definition: string;
			deferrable: boolean;
			update_action: string;
			delete_action: string;
		}>(
			queryable,
			`SELECT table_class.relname AS table_name, c.contype AS constraint_type,
			pg_get_constraintdef(c.oid) AS definition,
			c.condeferrable AS deferrable, c.confupdtype AS update_action, c.confdeltype AS delete_action
			FROM pg_constraint c
			JOIN pg_class table_class ON table_class.oid = c.conrelid
			WHERE c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
			AND table_class.relname LIKE 'agent_v2_%'`,
		);
		if (
			JSON.stringify(constraints.map(postgresAgentV2ConstraintSignature).sort()) !==
			JSON.stringify(postgresAgentV2ExpectedConstraintSignatures())
		) {
			throw new Error(AGENT_V2_SCHEMA_RESET_REQUIRED);
		}
	}

	private async ensureClientIdentitySchema(): Promise<void> {
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
			const runRow = await this.queryOne<AgentV2RunRow>(
				tx,
				`SELECT ${AGENT_V2_RUN_COLUMNS}
				FROM agent_v2_runs
				WHERE client_id = $1 AND run_id = $2
				FOR UPDATE`,
				[input.clientId, input.runId],
			);
			requiredRecord(runRow ? toAgentV2RunRecord(runRow) : undefined, "agent v2 run");
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

	async appendAgentV2ValidationAttempt(input: AppendAgentV2ValidationAttemptInput): Promise<AgentV2ValidationRecord> {
		const validation = buildAgentV2Validation(input);
		const row = await this.queryOne<AgentV2ValidationRow>(
			this.queryable,
			`INSERT INTO agent_v2_validation_attempts (
				client_id, run_id, validation_id, attempt, task_id, artifact_id,
				status, summary, details_json, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			ON CONFLICT (client_id, run_id, validation_id, attempt) DO NOTHING
			RETURNING ${AGENT_V2_VALIDATION_COLUMNS}`,
			[
				validation.clientId,
				validation.runId,
				validation.validationId,
				validation.attempt,
				validation.taskId ?? null,
				validation.artifactId ?? null,
				validation.status,
				validation.summary,
				validation.details,
				validation.createdAt,
				validation.updatedAt,
			],
		);
		if (row) return toAgentV2ValidationRecord(row);
		const existing = (await this.listAgentV2Validations(validation.clientId, validation.runId)).find(
			(record) => record.validationId === validation.validationId && record.attempt === validation.attempt,
		);
		if (existing && equalAgentV2ValidationRecords(existing, validation)) return existing;
		throw new Error("Agent v2 validation attempt conflict");
	}

	async listAgentV2Validations(clientId: string, runId: string): Promise<AgentV2ValidationRecord[]> {
		const rows = await this.queryRows<AgentV2ValidationRow>(
			this.queryable,
			`SELECT ${AGENT_V2_VALIDATION_COLUMNS}
				FROM agent_v2_validation_attempts
				WHERE client_id = $1 AND run_id = $2
				ORDER BY created_at ASC, validation_id ASC, attempt ASC`,
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
		const appliedAt = options.now?.() ?? now();
		return this.withTransaction(async (tx) => {
			const tables = [...AGENT_V2_PRE_V2_TABLES, ...AGENT_V2_RESET_TABLES] as const;
			const agentV2RowsDeleted = {} as Record<(typeof tables)[number], number>;
			for (const table of tables) {
				agentV2RowsDeleted[table] = await this.countTableRows(tx, table);
				await this.query(tx, `DROP TABLE IF EXISTS ${table}`);
			}
			await this.createAgentV2Schema(tx, appliedAt);
			return { agentV2RowsDeleted, schemaVersion: AGENT_V2_SCHEMA_VERSION };
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

	private async countTableRows(queryable: Queryable, table: string): Promise<number> {
		if (!(await this.tableExists(queryable, table))) return 0;
		const row = await this.queryOne<{ count: number | string }>(queryable, `SELECT COUNT(*) AS count FROM ${table}`);
		return Number(row?.count ?? 0);
	}

	private async tableExists(queryable: Queryable, table: string): Promise<boolean> {
		const rows = await this.queryRows<{ present: boolean }>(
			queryable,
			`SELECT EXISTS (
				SELECT 1
				FROM information_schema.tables
				WHERE table_schema = current_schema()
					AND table_name = $1
			) AS present`,
			[table],
		);
		return rows[0]?.present === true;
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

const POSTGRES_AGENT_V2_NULLABLE_COLUMNS = new Set([
	"agent_v2_runs.worker_id",
	"agent_v2_runs.started_at",
	"agent_v2_runs.ended_at",
	"agent_v2_runs.error_json",
	"agent_v2_tasks.parent_task_id",
	"agent_v2_tasks.started_at",
	"agent_v2_tasks.ended_at",
	"agent_v2_tasks.error_json",
	"agent_v2_artifacts.source_task_id",
	"agent_v2_documents.source_task_id",
	"agent_v2_diagnostics.phase",
	"agent_v2_diagnostics.task_id",
	"agent_v2_diagnostics.artifact_id",
	"agent_v2_diagnostics.trace_id",
	"agent_v2_validation_attempts.task_id",
	"agent_v2_validation_attempts.artifact_id",
	"agent_v2_input_references.display_name",
	"agent_v2_outbox.lease_owner",
	"agent_v2_outbox.lease_expires_at",
	"agent_v2_outbox.last_error_code",
	"agent_v2_outbox.last_error_message",
	"agent_v2_outbox.delivered_at",
]);

const POSTGRES_AGENT_V2_JSON_COLUMNS = new Set([
	"agent_v2_runs.input_json",
	"agent_v2_runs.model_json",
	"agent_v2_runs.error_json",
	"agent_v2_run_events.payload_json",
	"agent_v2_tasks.depends_on_json",
	"agent_v2_tasks.acceptance_criteria_json",
	"agent_v2_tasks.input_json",
	"agent_v2_tasks.output_json",
	"agent_v2_tasks.error_json",
	"agent_v2_artifacts.metadata_json",
	"agent_v2_documents.content_json",
	"agent_v2_diagnostics.data_json",
	"agent_v2_validation_attempts.details_json",
	"agent_v2_outbox.reference_json",
]);

const POSTGRES_AGENT_V2_INTEGER_COLUMNS = new Set([
	"agent_v2_schema_metadata.singleton_id",
	"agent_v2_schema_metadata.schema_version",
	"agent_v2_runs.attempt",
	"agent_v2_run_events.seq",
	"agent_v2_validation_attempts.attempt",
	"agent_v2_input_blobs.byte_length",
	"agent_v2_input_references.ordinal",
	"agent_v2_input_references.byte_length",
	"agent_v2_outbox.attempt_count",
]);

function expectedPostgresAgentV2ColumnType(key: string): string {
	if (POSTGRES_AGENT_V2_JSON_COLUMNS.has(key)) return "jsonb";
	if (POSTGRES_AGENT_V2_INTEGER_COLUMNS.has(key)) return "integer";
	if (key === "agent_v2_input_blobs.bytes") return "bytea";
	return "text";
}

function postgresAgentV2IndexShapes(): Record<string, { table: string; unique: boolean; definition: string }> {
	return {
		idx_agent_v2_artifacts_run_updated: {
			table: "agent_v2_artifacts",
			unique: false,
			definition: " using btree(client_id,run_id,updated_at desc)",
		},
		idx_agent_v2_diagnostics_run_created: {
			table: "agent_v2_diagnostics",
			unique: false,
			definition: " using btree(client_id,run_id,created_at,diagnostic_id)",
		},
		idx_agent_v2_documents_run_updated: {
			table: "agent_v2_documents",
			unique: false,
			definition: " using btree(client_id,run_id,updated_at desc)",
		},
		idx_agent_v2_outbox_dispatch: {
			table: "agent_v2_outbox",
			unique: false,
			definition: " using btree(status,available_at,created_at,intent_id)",
		},
		idx_agent_v2_outbox_lease: {
			table: "agent_v2_outbox",
			unique: false,
			definition: " using btree(status,lease_expires_at,intent_id)",
		},
		idx_agent_v2_outbox_run: {
			table: "agent_v2_outbox",
			unique: false,
			definition: " using btree(client_id,run_id,created_at,intent_id)",
		},
		idx_agent_v2_runs_status: {
			table: "agent_v2_runs",
			unique: false,
			definition: " using btree(status,updated_at)",
		},
		idx_agent_v2_runs_worker_active: {
			table: "agent_v2_runs",
			unique: false,
			definition:
				" using btree(worker_id,updated_at)where((worker_id is not null)and(status = any(array['running'::text,'cancelling'::text])))",
		},
		idx_agent_v2_tasks_run_updated: {
			table: "agent_v2_tasks",
			unique: false,
			definition: " using btree(client_id,run_id,updated_at desc)",
		},
		idx_agent_v2_validation_attempts_run_created: {
			table: "agent_v2_validation_attempts",
			unique: false,
			definition: " using btree(client_id,run_id,created_at,validation_id,attempt)",
		},
		uq_agent_v2_input_blobs_logical_path: {
			table: "agent_v2_input_blobs",
			unique: true,
			definition: " using btree(client_id,run_id,logical_path)",
		},
		uq_agent_v2_outbox_dedupe: {
			table: "agent_v2_outbox",
			unique: true,
			definition: " using btree(dedupe_key)",
		},
	};
}

const POSTGRES_AGENT_V2_PRIMARY_KEYS: Record<string, readonly string[]> = {
	agent_v2_schema_metadata: ["singleton_id"],
	agent_v2_runs: ["client_id", "run_id"],
	agent_v2_run_events: ["client_id", "run_id", "seq"],
	agent_v2_tasks: ["client_id", "run_id", "task_id"],
	agent_v2_artifacts: ["client_id", "run_id", "artifact_id"],
	agent_v2_documents: ["client_id", "run_id", "document_id"],
	agent_v2_diagnostics: ["client_id", "run_id", "diagnostic_id"],
	agent_v2_validation_attempts: ["client_id", "run_id", "validation_id", "attempt"],
	agent_v2_input_blobs: ["client_id", "run_id", "input_id"],
	agent_v2_input_references: ["client_id", "run_id", "kind", "ordinal"],
	agent_v2_bootstraps: ["client_id", "run_id"],
	agent_v2_outbox: ["intent_id"],
};

const POSTGRES_AGENT_V2_FOREIGN_KEYS = [
	["agent_v2_run_events", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_tasks", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_artifacts", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_documents", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_diagnostics", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_validation_attempts", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_input_blobs", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	[
		"agent_v2_input_references",
		["client_id", "run_id", "input_id"],
		"agent_v2_input_blobs",
		["client_id", "run_id", "input_id"],
	],
	["agent_v2_input_references", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_bootstraps", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
	["agent_v2_outbox", ["client_id", "run_id"], "agent_v2_runs", ["client_id", "run_id"]],
] as const;

const POSTGRES_AGENT_V2_CHECKS: Record<string, readonly string[]> = {
	agent_v2_schema_metadata: ["CHECK ((singleton_id = 1))", "CHECK ((schema_version = 2))"],
	agent_v2_runs: [
		"CHECK ((attempt >= 0))",
		"CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'cancelling'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text])))",
		"CHECK ((phase = ANY (ARRAY['intake'::text, 'capability_routing'::text, 'spec_draft'::text, 'spec_review'::text, 'plan_draft'::text, 'task_generation'::text, 'implementation'::text, 'validation'::text, 'repair'::text, 'preview'::text, 'delivery'::text, 'blocked'::text, 'failed'::text, 'cancelled'::text])))",
	],
	agent_v2_run_events: ["CHECK ((seq > 0))"],
	agent_v2_tasks: [
		"CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'running'::text, 'blocked'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))",
	],
	agent_v2_validation_attempts: [
		"CHECK ((attempt > 0))",
		"CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'blocked'::text, 'warning'::text])))",
	],
	agent_v2_input_blobs: [
		"CHECK ((encoding = ANY (ARRAY['utf8'::text, 'binary'::text])))",
		"CHECK ((byte_length >= 0))",
	],
	agent_v2_input_references: [
		"CHECK ((kind = ANY (ARRAY['attachment'::text, 'project_file'::text])))",
		"CHECK ((ordinal >= 0))",
		"CHECK ((byte_length >= 0))",
	],
	agent_v2_outbox: [
		"CHECK ((kind = ANY (ARRAY['run_enqueue'::text, 'run_cancel'::text, 'live_event'::text, 'workspace_diagnostic'::text, 'langfuse_diagnostic'::text])))",
		"CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'delivered'::text, 'dead_letter'::text])))",
		"CHECK ((attempt_count >= 0))",
	],
};

function postgresAgentV2ConstraintSignature(constraint: {
	table_name: string;
	constraint_type: string;
	definition: string;
	deferrable: boolean;
	update_action: string;
	delete_action: string;
}): string {
	const actions = constraint.constraint_type === "f" ? `${constraint.update_action}:${constraint.delete_action}` : "";
	return `${constraint.table_name}|${constraint.constraint_type}|${normalizePostgresDefinition(constraint.definition)}|${constraint.deferrable ? "1" : "0"}|${actions}`;
}

function postgresAgentV2ExpectedConstraintSignatures(): string[] {
	const signatures: string[] = [];
	for (const [table, columns] of Object.entries(POSTGRES_AGENT_V2_PRIMARY_KEYS)) {
		signatures.push(`${table}|p|${normalizePostgresDefinition(`PRIMARY KEY (${columns.join(", ")})`)}|0|`);
	}
	for (const [table, columns, referenceTable, referenceColumns] of POSTGRES_AGENT_V2_FOREIGN_KEYS) {
		const definition = `FOREIGN KEY (${columns.join(", ")}) REFERENCES ${referenceTable}(${referenceColumns.join(", ")})`;
		signatures.push(`${table}|f|${normalizePostgresDefinition(definition)}|0|a:a`);
	}
	for (const [table, checks] of Object.entries(POSTGRES_AGENT_V2_CHECKS)) {
		for (const check of checks) signatures.push(`${table}|c|${normalizePostgresDefinition(check)}|0|`);
	}
	return signatures.sort();
}

function normalizePostgresDefinition(value: string): string {
	return value
		.toLowerCase()
		.replaceAll(/\s+/g, " ")
		.replaceAll(/\s*([(),])\s*/g, "$1")
		.trim();
}

function now(): string {
	return new Date().toISOString();
}
