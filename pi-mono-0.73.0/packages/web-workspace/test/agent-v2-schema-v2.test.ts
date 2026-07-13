import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_V2_SCHEMA_VERSION } from "../src/agent-v2-types.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];

const EXPECTED_TABLES = [
	"agent_v2_artifacts",
	"agent_v2_bootstraps",
	"agent_v2_diagnostics",
	"agent_v2_documents",
	"agent_v2_input_blobs",
	"agent_v2_input_references",
	"agent_v2_outbox",
	"agent_v2_run_events",
	"agent_v2_runs",
	"agent_v2_schema_metadata",
	"agent_v2_tasks",
	"agent_v2_validation_attempts",
] as const;

const EXPECTED_COLUMNS: Record<(typeof EXPECTED_TABLES)[number], readonly string[]> = {
	agent_v2_schema_metadata: ["singleton_id", "schema_version", "applied_at"],
	agent_v2_runs: [
		"client_id",
		"run_id",
		"status",
		"phase",
		"attempt",
		"input_json",
		"model_json",
		"worker_id",
		"created_at",
		"updated_at",
		"started_at",
		"ended_at",
		"error_json",
	],
	agent_v2_run_events: ["client_id", "run_id", "seq", "event_type", "payload_json", "created_at"],
	agent_v2_tasks: [
		"client_id",
		"run_id",
		"task_id",
		"kind",
		"title",
		"status",
		"parent_task_id",
		"depends_on_json",
		"acceptance_criteria_json",
		"input_json",
		"output_json",
		"created_at",
		"updated_at",
		"started_at",
		"ended_at",
		"error_json",
	],
	agent_v2_artifacts: [
		"client_id",
		"run_id",
		"artifact_id",
		"kind",
		"path",
		"media_type",
		"checksum",
		"version",
		"validation_status",
		"source_task_id",
		"metadata_json",
		"created_at",
		"updated_at",
	],
	agent_v2_documents: [
		"client_id",
		"run_id",
		"document_id",
		"kind",
		"version",
		"content_markdown",
		"content_json",
		"source_task_id",
		"created_at",
		"updated_at",
	],
	agent_v2_diagnostics: [
		"client_id",
		"run_id",
		"diagnostic_id",
		"severity",
		"category",
		"code",
		"message",
		"phase",
		"task_id",
		"artifact_id",
		"trace_id",
		"data_json",
		"created_at",
	],
	agent_v2_validation_attempts: [
		"client_id",
		"run_id",
		"validation_id",
		"attempt",
		"task_id",
		"artifact_id",
		"status",
		"summary",
		"details_json",
		"created_at",
		"updated_at",
	],
	agent_v2_input_blobs: [
		"client_id",
		"run_id",
		"input_id",
		"logical_path",
		"media_type",
		"encoding",
		"bytes",
		"byte_length",
		"checksum",
		"created_at",
	],
	agent_v2_input_references: [
		"client_id",
		"run_id",
		"input_id",
		"logical_path",
		"media_type",
		"checksum",
		"kind",
		"ordinal",
		"display_name",
		"byte_length",
	],
	agent_v2_bootstraps: ["client_id", "run_id", "bootstrap_version", "bootstrap_checksum", "created_at"],
	agent_v2_outbox: [
		"intent_id",
		"dedupe_key",
		"client_id",
		"run_id",
		"kind",
		"status",
		"available_at",
		"created_at",
		"updated_at",
		"reference_json",
		"attempt_count",
		"lease_owner",
		"lease_expires_at",
		"last_error_code",
		"last_error_message",
		"delivered_at",
	],
};

const EXPECTED_INDEXES = [
	"idx_agent_v2_artifacts_run_updated",
	"idx_agent_v2_diagnostics_run_created",
	"idx_agent_v2_documents_run_updated",
	"idx_agent_v2_outbox_dispatch",
	"idx_agent_v2_outbox_lease",
	"idx_agent_v2_outbox_run",
	"idx_agent_v2_runs_status",
	"idx_agent_v2_runs_worker_active",
	"idx_agent_v2_tasks_run_updated",
	"idx_agent_v2_validation_attempts_run_created",
	"uq_agent_v2_input_blobs_logical_path",
	"uq_agent_v2_outbox_dedupe",
] as const;

describe("agent v2 exact schema version 2", () => {
	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("creates only the exact v2 tables, columns, indexes and singleton metadata", () => {
		const { dbFile, store } = createStore();
		store.ensureAgentV2Schema();
		const db = new DatabaseSync(dbFile);
		try {
			expect(AGENT_V2_SCHEMA_VERSION).toBe(2);
			expect(readNames(db, "table", "agent_v2_%")).toEqual(EXPECTED_TABLES);
			for (const table of EXPECTED_TABLES) {
				const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
				expect(
					columns.map((column) => column.name),
					table,
				).toEqual(EXPECTED_COLUMNS[table]);
			}
			expect(readNames(db, "index", "idx_agent_v2_%", "uq_agent_v2_%")).toEqual(EXPECTED_INDEXES);
			expect(db.prepare("SELECT * FROM agent_v2_schema_metadata").all()).toEqual([
				expect.objectContaining({ singleton_id: 1, schema_version: 2 }),
			]);
			expect(readSql(db, "agent_v2_runs")).toContain("CHECK(status IN");
			expect(readSql(db, "agent_v2_runs")).not.toContain("REFERENCES clients");
			expect(readSql(db, "agent_v2_validation_attempts")).toContain("CHECK(attempt > 0)");
			expect(readSql(db, "agent_v2_outbox")).toContain("dead_letter");
		} finally {
			db.close();
		}
	});

	it.each([
		[
			"empty v1",
			"CREATE TABLE agent_v2_schema_metadata (schema_version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
		],
		[
			"non-empty v1",
			"CREATE TABLE agent_v2_schema_metadata (schema_version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO agent_v2_schema_metadata VALUES (1, 'old')",
		],
		[
			"newer metadata",
			"CREATE TABLE agent_v2_schema_metadata (singleton_id INTEGER PRIMARY KEY, schema_version INTEGER, applied_at TEXT); INSERT INTO agent_v2_schema_metadata VALUES (1, 99, 'future')",
		],
	])("rejects %s without changing database objects", (_label, seedSql) => {
		const { dbFile, store } = createStore();
		const seed = new DatabaseSync(dbFile);
		seed.exec(seedSql);
		const before = snapshotSchema(seed);
		seed.close();
		expect(() => store.ensureAgentV2Schema()).toThrow("Agent v2 schema reset required");
		const verify = new DatabaseSync(dbFile);
		try {
			expect(snapshotSchema(verify)).toEqual(before);
		} finally {
			verify.close();
		}
	});

	it("rejects a version-2 metadata/table mismatch without repairing it", () => {
		const { dbFile, store } = createStore();
		const db = new DatabaseSync(dbFile);
		db.exec(
			"CREATE TABLE agent_v2_schema_metadata (singleton_id INTEGER PRIMARY KEY, schema_version INTEGER, applied_at TEXT); INSERT INTO agent_v2_schema_metadata VALUES (1, 2, 'bad')",
		);
		const before = snapshotSchema(db);
		db.close();
		expect(() => store.ensureAgentV2Schema()).toThrow("Agent v2 schema reset required");
		const verify = new DatabaseSync(dbFile);
		try {
			expect(snapshotSchema(verify)).toEqual(before);
		} finally {
			verify.close();
		}
	});

	it("rejects an exact-version index-shape mismatch without repairing it", () => {
		const { dbFile, store } = createStore();
		store.ensureAgentV2Schema();
		const db = new DatabaseSync(dbFile);
		db.exec(
			"DROP INDEX idx_agent_v2_runs_status; CREATE INDEX idx_agent_v2_runs_status ON agent_v2_runs(updated_at, status)",
		);
		const before = snapshotSchema(db);
		db.close();
		expect(() => store.ensureAgentV2Schema()).toThrow("Agent v2 schema reset required");
		const verify = new DatabaseSync(dbFile);
		try {
			expect(snapshotSchema(verify)).toEqual(before);
		} finally {
			verify.close();
		}
	});

	it("creates runs without creating or writing the shared clients table", () => {
		const { dbFile, store } = createStore();
		store.ensureAgentV2Schema();
		store.createAgentV2Run({ clientId: "v2-only", runId: "run-1", input: {}, model: {} });
		const db = new DatabaseSync(dbFile);
		try {
			expect(readNames(db, "table", "clients")).toEqual([]);
			expect(db.prepare("SELECT client_id FROM agent_v2_runs").all()).toEqual([{ client_id: "v2-only" }]);
		} finally {
			db.close();
		}
	});
});

function createStore(): { dbFile: string; store: RuntimeDbStore } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-schema-v2-"));
	const dbFile = join(root, "runtime.sqlite");
	const store = new RuntimeDbStore(dbFile);
	roots.push(root);
	stores.push(store);
	return { dbFile, store };
}

function readNames(db: DatabaseSync, type: string, ...patterns: string[]): string[] {
	const clauses = patterns.map(() => "name LIKE ?").join(" OR ");
	return (
		db
			.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND (${clauses}) ORDER BY name`)
			.all(type, ...patterns) as Array<{ name: string }>
	).map((row) => row.name);
}

function readSql(db: DatabaseSync, name: string): string {
	return String(
		(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql,
	).replaceAll(/\s+/g, " ");
}

function snapshotSchema(db: DatabaseSync): unknown[] {
	return db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'agent_v2_%' ORDER BY type, name")
		.all();
}
