import { afterEach, describe, expect, it } from "vitest";
import { PostgresRuntimeStore, type Queryable } from "../src/postgres-runtime-store.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./helpers/postgres-test-schema.js";

const schemas: PostgresTestSchema[] = [];

describe("agent v2 PostgreSQL exact schema", () => {
	afterEach(async () => {
		for (const schema of schemas.splice(0)) await schema.close();
	});

	it("creates exact version 2 in an isolated schema without a clients table", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool });
		await store.ensureAgentV2Schema();
		await expect(store.ensureAgentV2Schema()).resolves.toBeUndefined();
		const tables = await isolated.pool.query<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'agent_v2_%' ORDER BY table_name",
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual([
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
		]);
		const metadata = await isolated.pool.query("SELECT singleton_id, schema_version FROM agent_v2_schema_metadata");
		expect(metadata.rows).toEqual([{ singleton_id: 1, schema_version: 2 }]);
		const clients = await isolated.pool.query<{ present: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'clients') AS present",
		);
		expect(clients.rows[0]?.present).toBe(false);
		await store.createAgentV2Run({ clientId: "v2-only", runId: "run-1", input: {}, model: {} });
		const validation = {
			clientId: "v2-only",
			runId: "run-1",
			validationId: "static",
			attempt: 1,
			status: "failed" as const,
			summary: "failed",
			details: { code: "x", nested: { z: 1, a: 2 } },
			createdAt: "2026-07-13T00:00:00.000Z",
			updatedAt: "2026-07-13T00:00:00.000Z",
		};
		const first = await store.appendAgentV2ValidationAttempt(validation);
		await expect(
			store.appendAgentV2ValidationAttempt({
				...validation,
				details: { nested: { a: 2, z: 1 }, code: "x" },
			}),
		).resolves.toEqual(first);
	});

	it("rejects incompatible metadata before performing DDL", async () => {
		const isolated = await createIsolated();
		await isolated.pool.query(
			"CREATE TABLE agent_v2_schema_metadata (schema_version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
		);
		const before = await objectSnapshot(isolated);
		const store = new PostgresRuntimeStore({ queryable: isolated.pool });
		await expect(store.ensureAgentV2Schema()).rejects.toThrow("Agent v2 schema reset required");
		expect(await objectSnapshot(isolated)).toEqual(before);
	});

	it("rejects exact-version column, index, uniqueness and constraint mismatches without repairing them", async () => {
		const mutations = [
			"ALTER TABLE agent_v2_runs ALTER COLUMN status SET DEFAULT 'queued'",
			"ALTER TABLE agent_v2_schema_metadata DROP CONSTRAINT agent_v2_schema_metadata_pkey; ALTER TABLE agent_v2_schema_metadata ADD CONSTRAINT agent_v2_schema_metadata_pkey PRIMARY KEY (schema_version, singleton_id)",
			"DROP INDEX idx_agent_v2_runs_status; CREATE INDEX idx_agent_v2_runs_status ON agent_v2_runs(updated_at, status)",
			"DROP INDEX uq_agent_v2_outbox_dedupe; CREATE INDEX uq_agent_v2_outbox_dedupe ON agent_v2_outbox(dedupe_key)",
			"ALTER TABLE agent_v2_runs DROP CONSTRAINT agent_v2_runs_attempt_check; ALTER TABLE agent_v2_runs ADD CONSTRAINT agent_v2_runs_attempt_check CHECK (TRUE)",
			"ALTER TABLE agent_v2_outbox DROP CONSTRAINT agent_v2_outbox_client_id_run_id_fkey; ALTER TABLE agent_v2_outbox ADD CONSTRAINT agent_v2_outbox_client_id_run_id_fkey FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_bootstraps(client_id, run_id) NOT DEFERRABLE",
			"CREATE UNIQUE INDEX unexpected_agent_v2_runs_identity ON agent_v2_runs(client_id, run_id, status)",
		];
		for (const mutation of mutations) {
			const isolated = await createIsolated();
			const store = new PostgresRuntimeStore({ queryable: isolated.pool });
			await store.ensureAgentV2Schema();
			await expect(store.ensureAgentV2Schema()).resolves.toBeUndefined();
			await isolated.pool.query(mutation);
			await expect(store.ensureAgentV2Schema()).rejects.toThrow("Agent v2 schema reset required");
		}
	});

	it("resets a pre-v2 shape transactionally while preserving shared legacy rows", async () => {
		const isolated = await createIsolated();
		await isolated.pool.query("CREATE TABLE clients (client_id TEXT PRIMARY KEY, marker TEXT NOT NULL)");
		await isolated.pool.query("INSERT INTO clients VALUES ('legacy-client', 'keep')");
		await isolated.pool.query(
			"CREATE TABLE agent_v2_runs (client_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY (client_id, run_id))",
		);
		await isolated.pool.query("INSERT INTO agent_v2_runs VALUES ('legacy-client', 'old-run')");
		await isolated.pool.query(
			"CREATE TABLE agent_v2_validations (client_id TEXT NOT NULL, run_id TEXT NOT NULL, validation_id TEXT NOT NULL, PRIMARY KEY (client_id, run_id, validation_id), FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id))",
		);
		await isolated.pool.query(
			"INSERT INTO agent_v2_validations VALUES ('legacy-client', 'old-run', 'old-validation')",
		);
		const store = new PostgresRuntimeStore({ queryable: isolated.pool });
		const result = await store.resetAgentV2RuntimeData({ now: () => "2026-07-13T00:00:00.000Z" });
		expect(result.schemaVersion).toBe(2);
		expect(result.agentV2RowsDeleted.agent_v2_validations).toBe(1);
		expect(result.agentV2RowsDeleted.agent_v2_runs).toBe(1);
		expect((await isolated.pool.query("SELECT * FROM clients")).rows).toEqual([
			{ client_id: "legacy-client", marker: "keep" },
		]);
		expect((await isolated.pool.query("SELECT schema_version FROM agent_v2_schema_metadata")).rows).toEqual([
			{ schema_version: 2 },
		]);
	});

	it("rolls back all drops when exact-schema recreation fails", async () => {
		const isolated = await createIsolated();
		await isolated.pool.query("CREATE TABLE agent_v2_validations (id TEXT PRIMARY KEY)");
		await isolated.pool.query("INSERT INTO agent_v2_validations VALUES ('old-validation')");
		const failingQueryable: Queryable & { connect(): Promise<Queryable & { release(): void }> } = {
			query: (sql, values) => isolated.pool.query(sql, values ? [...values] : undefined),
			async connect() {
				const client = await isolated.pool.connect();
				return {
					query: (sql, values) => {
						if (sql.includes("CREATE TABLE agent_v2_schema_metadata")) {
							return Promise.reject(new Error("injected schema create failure"));
						}
						return client.query(sql, values ? [...values] : undefined);
					},
					release: () => client.release(),
				};
			},
		};
		const store = new PostgresRuntimeStore({ queryable: failingQueryable });
		await expect(store.resetAgentV2RuntimeData()).rejects.toThrow("injected schema create failure");
		expect((await isolated.pool.query("SELECT * FROM agent_v2_validations")).rows).toEqual([
			{ id: "old-validation" },
		]);
		expect((await isolated.pool.query("SELECT to_regclass('agent_v2_runs') AS table_name")).rows).toEqual([
			{ table_name: null },
		]);
	});
});

async function createIsolated(): Promise<PostgresTestSchema> {
	const isolated = await createPostgresTestSchema();
	schemas.push(isolated);
	return isolated;
}

async function objectSnapshot(isolated: PostgresTestSchema): Promise<unknown[]> {
	return (
		await isolated.pool.query(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
		)
	).rows;
}
