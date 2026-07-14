import { describe, expect, it } from "vitest";
import { PostgresRuntimeStore, type Queryable } from "../src/postgres-runtime-store.js";

type RecordedQuery = {
	sql: string;
	values: readonly unknown[];
};

type QueryHandler = (query: RecordedQuery) => { rows?: Record<string, unknown>[]; rowCount?: number } | undefined;

class RecordingQueryable implements Queryable {
	readonly queries: RecordedQuery[] = [];
	private readonly handlers: QueryHandler[] = [];

	on(handler: QueryHandler): this {
		this.handlers.push(handler);
		return this;
	}

	async query(
		sql: string,
		values: readonly unknown[] = [],
	): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
		const query = { sql, values };
		this.queries.push(query);
		if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalizeSql(sql))) {
			return { rows: [], rowCount: 0 };
		}
		for (const handler of this.handlers) {
			const result = handler(query);
			if (result) return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
		}
		throw new Error(`Unhandled query: ${normalizeSql(sql)} values=${JSON.stringify(values)}`);
	}

	statementsMatching(pattern: RegExp): RecordedQuery[] {
		return this.queries.filter((query) => pattern.test(normalizeSql(query.sql)));
	}
}

class BeginFailingClient extends RecordingQueryable {
	releaseCalls = 0;

	override async query(
		sql: string,
		values: readonly unknown[] = [],
	): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
		this.queries.push({ sql, values });
		if (/^BEGIN$/i.test(normalizeSql(sql))) throw new Error("BEGIN failed");
		return super.query(sql, values);
	}

	release(): void {
		this.releaseCalls += 1;
	}
}

class RecordingClient extends RecordingQueryable {
	releaseCalls = 0;

	release(): void {
		this.releaseCalls += 1;
	}
}

const normalizeSql = (sql: string): string => sql.replaceAll(/\s+/g, " ").trim();

const statementIndex = (queryable: RecordingQueryable, pattern: RegExp): number =>
	queryable.queries.findIndex((query) => pattern.test(normalizeSql(query.sql)));

describe("PostgresRuntimeStore", () => {
	it("leases outbox intents in one SKIP LOCKED transaction", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (sql.startsWith("WITH candidates AS") && sql.includes("FOR UPDATE SKIP LOCKED")) {
				return {
					rows: [
						{
							intent_id: "outbox:1",
							dedupe_key: "live_event:client-a:run-a:1",
							client_id: "client-a",
							run_id: "run-a",
							kind: "live_event",
							status: "leased",
							available_at: "2026-07-13T00:00:00.000Z",
							created_at: "2026-07-13T00:00:00.000Z",
							updated_at: "2026-07-13T00:00:01.000Z",
							reference_json: { kind: "live_event", eventSeq: 1 },
							attempt_count: 1,
							lease_owner: "owner-a",
							lease_expires_at: "2026-07-13T00:00:02.000Z",
							last_error_code: null,
							last_error_message: null,
							delivered_at: null,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });
		const leased = await store.leaseAgentV2Outbox({
			ownerId: "owner-a",
			limit: 1,
			now: "2026-07-13T00:00:01.000Z",
			leaseTtlMs: 1000,
		});
		expect(leased).toHaveLength(1);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual([
			"BEGIN",
			expect.stringContaining("FOR UPDATE SKIP LOCKED"),
			"COMMIT",
		]);
	});

	it("can be constructed with a provided queryable and creates the runtime schema", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			if (/^CREATE /i.test(normalizeSql(query.sql))) return { rowCount: 0 };
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		await store.ensureSchema();

		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		for (const table of [
			"clients",
			"sessions",
			"messages",
			"runs",
			"run_events",
			"app_preview_goals",
			"app_preview_goal_events",
		]) {
			expect(statements.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`))).toBe(true);
		}
		expect(
			statements.some((statement) => statement.includes("CREATE INDEX IF NOT EXISTS idx_sessions_client_updated")),
		).toBe(true);
		expect(
			statements.some((statement) => statement.includes("CREATE INDEX IF NOT EXISTS idx_run_events_run_seq")),
		).toBe(true);
		expect(
			statements.some((statement) =>
				statement.includes(
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_session ON runs(client_id, session_id)",
				),
			),
		).toBe(true);
		expect(
			statements.some((statement) => statement.includes("WHERE status IN ('queued', 'running', 'cancelling')")),
		).toBe(true);
	});

	it("creates the independent exact Agent v2 schema without shared client identity", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			if (/^SELECT table_name FROM information_schema\.tables/i.test(normalizeSql(query.sql))) return { rows: [] };
			if (/^(CREATE |ALTER TABLE|INSERT INTO agent_v2_schema_metadata)/i.test(normalizeSql(query.sql))) {
				return { rowCount: 0 };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		await store.ensureAgentV2Schema();

		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		for (const table of [
			"agent_v2_schema_metadata",
			"agent_v2_runs",
			"agent_v2_run_events",
			"agent_v2_tasks",
			"agent_v2_artifacts",
			"agent_v2_documents",
			"agent_v2_validation_attempts",
			"agent_v2_diagnostics",
			"agent_v2_input_blobs",
			"agent_v2_input_references",
			"agent_v2_bootstraps",
			"agent_v2_outbox",
		]) {
			expect(
				statements.some((statement) => statement.includes(`CREATE TABLE ${table}`)),
				table,
			).toBe(true);
		}
		for (const table of [
			"sessions",
			"messages",
			"runs",
			"run_events",
			"app_preview_goals",
			"app_preview_goal_events",
		]) {
			expect(
				statements.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
				table,
			).toBe(false);
		}
		expect(statements.some((statement) => statement.includes("CREATE TABLE clients"))).toBe(false);
	});

	it("resets Agent v2 data without creating legacy tables on a fresh schema-only Postgres store", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^(CREATE TABLE|CREATE INDEX|DROP TABLE|ALTER TABLE|BEGIN|COMMIT)/i.test(sql)) return { rowCount: 0 };
			if (/^INSERT INTO agent_v2_schema_metadata/i.test(sql)) return { rowCount: 1 };
			if (/^SELECT EXISTS \( SELECT 1 FROM information_schema\.tables/i.test(sql)) {
				const table = String(query.values[0] ?? "");
				return {
					rows: [
						{
							present: [
								"agent_v2_schema_metadata",
								"agent_v2_runs",
								"agent_v2_run_events",
								"agent_v2_tasks",
								"agent_v2_artifacts",
								"agent_v2_documents",
								"agent_v2_validation_attempts",
								"agent_v2_diagnostics",
							].includes(table),
						},
					],
				};
			}
			if (/^SELECT COUNT\(\*\) AS count FROM /i.test(sql)) return { rows: [{ count: 0 }] };
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const result = await store.resetAgentV2RuntimeData({
			now: () => "2026-07-09T10:00:00.000Z",
		});

		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		expect(result.schemaVersion).toBe(2);
		for (const table of [
			"sessions",
			"messages",
			"runs",
			"run_events",
			"app_preview_goals",
			"app_preview_goal_events",
		]) {
			expect(
				statements.some((statement) => statement.includes(`CREATE TABLE ${table}`)),
				table,
			).toBe(false);
			expect(
				statements.some((statement) => statement === `DELETE FROM ${table}`),
				table,
			).toBe(false);
		}
		expect(statements.some((statement) => statement.includes("CREATE TABLE agent_v2_runs"))).toBe(true);
		expect(statements.some((statement) => statement === "DROP TABLE IF EXISTS agent_v2_runs")).toBe(true);
		expect(statements.some((statement) => statement === "DROP TABLE IF EXISTS agent_v2_schema_metadata")).toBe(true);
	});

	it("rejects createRun when the session already has an active run before inserting", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM sessions WHERE client_id = \$1 AND session_id = \$2 FOR UPDATE$/i.test(sql)) {
				return {
					rows: [
						{
							session_id: "session-1",
							client_id: "client-a",
							title: "Existing session",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							created_at: "2026-06-29T01:02:03.000Z",
							updated_at: "2026-06-29T01:02:03.000Z",
							last_run_status: null,
							last_run_id: null,
						},
					],
				};
			}
			if (/SELECT 1 AS active FROM runs/i.test(sql)) {
				return { rows: [{ active: 1 }] };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		await expect(
			store.createRun({
				clientId: "client-a",
				sessionId: "session-1",
				runId: "run-2",
				model: { id: "gpt-5" },
				thinkingLevel: "medium",
				createdAt: "2026-06-29T01:02:03.000Z",
			}),
		).rejects.toThrow(/active run/i);

		expect(queryable.statementsMatching(/INSERT INTO runs/i)).toHaveLength(0);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual(
			expect.arrayContaining(["BEGIN", "ROLLBACK"]),
		);
		const activeCheck = queryable.statementsMatching(/SELECT 1 AS active FROM runs/i)[0];
		expect(activeCheck?.values).toEqual(["client-a", "session-1", ["queued", "running", "cancelling"]]);
	});

	it("releases the acquired client when BEGIN fails", async () => {
		const client = new BeginFailingClient();
		const queryable: Queryable & { connect(): Promise<BeginFailingClient> } = {
			query: (sql, values) => client.query(sql, values),
			connect: async () => client,
		};
		const store = new PostgresRuntimeStore({ queryable });

		await expect(
			store.createRun({
				clientId: "client-a",
				sessionId: "session-1",
				runId: "run-1",
				model: { id: "gpt-5" },
				thinkingLevel: "medium",
				createdAt: "2026-06-29T01:02:03.000Z",
			}),
		).rejects.toThrow("BEGIN failed");

		expect(client.releaseCalls).toBe(1);
		expect(client.queries.map((query) => normalizeSql(query.sql))).toEqual(["BEGIN"]);
		expect(client.statementsMatching(/^ROLLBACK$/i)).toHaveLength(0);
		expect(client.statementsMatching(/^COMMIT$/i)).toHaveLength(0);
	});

	it("creates a run with its first message in a transaction and writes client scoped rows", async () => {
		const createdAt = "2026-06-29T01:02:03.000Z";
		const queryable = new RecordingQueryable()
			.on((query) => {
				const sql = normalizeSql(query.sql);
				if (/^SELECT .* FROM sessions WHERE client_id = \$1 AND session_id = \$2 FOR UPDATE$/i.test(sql)) {
					return { rows: [] };
				}
				if (/^INSERT INTO clients/i.test(sql)) {
					return { rowCount: 1 };
				}
				return undefined;
			})
			.on((query) => {
				if (/^INSERT INTO sessions/i.test(normalizeSql(query.sql))) {
					return {
						rows: [
							{
								session_id: "session-1",
								client_id: "client-a",
								title: "New session",
								model_json: { id: "gpt-5" },
								thinking_level: "medium",
								created_at: createdAt,
								updated_at: createdAt,
								last_run_status: null,
								last_run_id: null,
							},
						],
					};
				}
				return undefined;
			})
			.on((query) => {
				if (/INSERT INTO messages/i.test(query.sql)) {
					return {
						rows: [
							{
								id: 17,
								session_id: "session-1",
								client_id: "client-a",
								role: "user",
								payload_json: { content: "hello" },
								created_at: createdAt,
							},
						],
					};
				}
				return undefined;
			})
			.on((query) => {
				if (/INSERT INTO runs/i.test(query.sql)) {
					return {
						rows: [
							{
								run_id: "run-1",
								session_id: "session-1",
								client_id: "client-a",
								status: "queued",
								worker_id: null,
								model_json: { id: "gpt-5" },
								thinking_level: "medium",
								started_at: null,
								updated_at: createdAt,
								ended_at: null,
								error: null,
							},
						],
					};
				}
				return undefined;
			})
			.on((query) => {
				if (
					/^UPDATE sessions SET updated_at = \$1, last_run_status = \$2, last_run_id = \$3, model_json = \$4, thinking_level = \$5/i.test(
						normalizeSql(query.sql),
					)
				) {
					return {
						rows: [
							{
								session_id: "session-1",
								client_id: "client-a",
								title: "New session",
								model_json: { id: "gpt-5" },
								thinking_level: "medium",
								created_at: createdAt,
								updated_at: createdAt,
								last_run_status: "queued",
								last_run_id: "run-1",
							},
						],
					};
				}
				return undefined;
			});
		const store = new PostgresRuntimeStore({ queryable });

		const result = await store.createRunWithMessage({
			clientId: "client-a",
			sessionId: "session-1",
			title: "New session",
			model: { id: "gpt-5" },
			thinkingLevel: "medium",
			messageRole: "user",
			payload: { content: "hello" },
			runId: "run-1",
			createdAt,
		});

		expect(result).toBeDefined();
		expect(result?.message).toBeDefined();
		if (!result?.message) throw new Error("Expected createRunWithMessage to return a message");
		expect(result.session.clientId).toBe("client-a");
		expect(result.message.clientId).toBe("client-a");
		expect(result.run.clientId).toBe("client-a");
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual(
			expect.arrayContaining(["BEGIN", "COMMIT"]),
		);
		expect(queryable.statementsMatching(/ROLLBACK/i)).toHaveLength(0);

		const sessionInsert = queryable.statementsMatching(/INSERT INTO sessions/i)[0];
		const messageInsert = queryable.statementsMatching(/INSERT INTO messages/i)[0];
		const runInsert = queryable.statementsMatching(/INSERT INTO runs/i)[0];
		expect(sessionInsert?.values).toContain("client-a");
		expect(messageInsert?.values).toContain("client-a");
		expect(runInsert?.values).toContain("client-a");
	});

	it("updates a run status and the session run marker inside one transaction", async () => {
		const updatedAt = "2026-06-29T02:03:04.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM runs WHERE client_id = \$1 AND run_id = \$2(?: FOR UPDATE)?$/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							status: "queued",
							worker_id: null,
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: null,
							updated_at: "2026-06-29T01:02:03.000Z",
							ended_at: null,
							error: null,
						},
					],
				};
			}
			if (/^UPDATE runs SET status = \$3/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							status: "running",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: updatedAt,
							updated_at: updatedAt,
							ended_at: null,
							error: null,
						},
					],
				};
			}
			if (/^UPDATE sessions SET updated_at = \$1, last_run_status = \$2, last_run_id = \$3/i.test(sql)) {
				return {
					rows: [
						{
							session_id: "session-1",
							client_id: "client-a",
							title: "Existing session",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							created_at: "2026-06-29T01:02:03.000Z",
							updated_at: updatedAt,
							last_run_status: "running",
							last_run_id: "run-1",
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const run = await store.updateRunStatus("run-1", "client-a", "running", {
			workerId: "worker-1",
			startedAt: updatedAt,
			updatedAt,
		});

		expect(run).toEqual({
			runId: "run-1",
			sessionId: "session-1",
			clientId: "client-a",
			status: "running",
			workerId: "worker-1",
			model: { id: "gpt-5" },
			thinkingLevel: "medium",
			startedAt: updatedAt,
			updatedAt,
		});
		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		expect(statements[0]).toBe("BEGIN");
		expect(statements.at(-1)).toBe("COMMIT");
		const runSelectIndex = statements.findIndex(
			(statement) =>
				statement.startsWith("SELECT") && statement.includes("FROM runs WHERE client_id = $1 AND run_id = $2"),
		);
		const runUpdateIndex = statements.findIndex((statement) => statement.startsWith("UPDATE runs SET status = $3"));
		const sessionUpdateIndex = statements.findIndex((statement) =>
			statement.startsWith("UPDATE sessions SET updated_at = $1, last_run_status = $2, last_run_id = $3"),
		);
		expect(runSelectIndex).toBeGreaterThan(0);
		expect(runUpdateIndex).toBeGreaterThan(runSelectIndex);
		expect(sessionUpdateIndex).toBeGreaterThan(runUpdateIndex);
		expect(queryable.queries[runUpdateIndex]?.values).toEqual([
			"client-a",
			"run-1",
			"running",
			"worker-1",
			updatedAt,
			updatedAt,
			null,
			null,
		]);
		expect(queryable.queries[sessionUpdateIndex]?.values).toEqual([
			updatedAt,
			"running",
			"run-1",
			"client-a",
			"session-1",
		]);
	});

	it("appends a message and touches the session updated timestamp inside one transaction", async () => {
		const createdAt = "2026-06-29T03:04:05.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^INSERT INTO messages/i.test(sql)) {
				return {
					rows: [
						{
							id: 21,
							session_id: "session-1",
							client_id: "client-a",
							role: "assistant",
							payload_json: { content: "done" },
							created_at: createdAt,
						},
					],
				};
			}
			if (/^UPDATE sessions SET updated_at = \$1 WHERE client_id = \$2 AND session_id = \$3$/i.test(sql)) {
				return { rowCount: 1 };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const message = await store.appendMessage({
			clientId: "client-a",
			sessionId: "session-1",
			role: "assistant",
			payload: { content: "done" },
			createdAt,
		});

		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		expect(message).toEqual({
			messageId: 21,
			sessionId: "session-1",
			clientId: "client-a",
			role: "assistant",
			payload: { content: "done" },
			createdAt,
		});
		expect(statements[0]).toBe("BEGIN");
		expect(statements.at(-1)).toBe("COMMIT");
		const messageInsertIndex = statementIndex(queryable, /^INSERT INTO messages/i);
		const sessionUpdateIndex = statementIndex(
			queryable,
			/^UPDATE sessions SET updated_at = \$1 WHERE client_id = \$2 AND session_id = \$3$/i,
		);
		expect(messageInsertIndex).toBeGreaterThan(0);
		expect(sessionUpdateIndex).toBeGreaterThan(messageInsertIndex);
		expect(sessionUpdateIndex).toBeLessThan(statements.length - 1);
		expect(queryable.queries[messageInsertIndex]?.values).toEqual([
			"session-1",
			"client-a",
			"assistant",
			{ content: "done" },
			createdAt,
		]);
		expect(queryable.queries[sessionUpdateIndex]?.values).toEqual([createdAt, "client-a", "session-1"]);
	});

	it("lists running and cancelling runs assigned to a worker", async () => {
		const updatedAt = "2026-06-29T03:04:05.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM runs WHERE worker_id = \$1 AND status IN \('running', 'cancelling'\)/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-running",
							session_id: "session-1",
							client_id: "client-a",
							status: "running",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: updatedAt,
							updated_at: updatedAt,
							ended_at: null,
							error: null,
						},
						{
							run_id: "run-cancelling",
							session_id: "session-2",
							client_id: "client-a",
							status: "cancelling",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: updatedAt,
							updated_at: "2026-06-29T03:05:05.000Z",
							ended_at: null,
							error: null,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const runs = await store.listRunningRunsByWorker("worker-1");

		expect(runs.map((run) => run.status)).toEqual(["running", "cancelling"]);
		expect(queryable.queries[0]?.values).toEqual(["worker-1"]);
		expect(normalizeSql(queryable.queries[0]?.sql ?? "")).toContain("status IN ('running', 'cancelling')");
	});

	it("lists agent v2 runs through the shared runtime store contract", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 ORDER BY updated_at DESC, run_id ASC$/i.test(sql)) {
				return {
					rows: [
						{
							client_id: "client-a",
							run_id: "run-newer",
							status: "cancelling",
							phase: "implementation",
							attempt: 1,
							input_json: { prompt: "Cancel this" },
							model_json: { provider: "openai", id: "gpt-5" },
							worker_id: "worker-1",
							created_at: "2026-07-08T09:00:00.000Z",
							updated_at: "2026-07-08T09:15:00.000Z",
							started_at: "2026-07-08T09:01:00.000Z",
							ended_at: null,
							error_json: null,
						},
						{
							client_id: "client-a",
							run_id: "run-older",
							status: "queued",
							phase: "intake",
							attempt: 1,
							input_json: { prompt: "Queued run" },
							model_json: { provider: "openai", id: "gpt-5" },
							worker_id: null,
							created_at: "2026-07-08T08:55:00.000Z",
							updated_at: "2026-07-08T08:55:00.000Z",
							started_at: null,
							ended_at: null,
							error_json: null,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const runs = await store.listAgentV2Runs("client-a");

		expect(runs.map((run) => [run.runId, run.status])).toEqual([
			["run-newer", "cancelling"],
			["run-older", "queued"],
		]);
		expect(queryable.queries[0]?.values).toEqual(["client-a"]);
		expect(normalizeSql(queryable.queries[0]?.sql ?? "")).toContain(
			"FROM agent_v2_runs WHERE client_id = $1 ORDER BY updated_at DESC, run_id ASC",
		);
	});

	it("locks the PostgreSQL agent v2 run on the transaction before allocating an event sequence", async () => {
		const createdAt = "2026-07-08T10:00:00.000Z";
		const runRow = {
			client_id: "client-a",
			run_id: "run-v2-events",
			status: "running",
			phase: "implementation",
			attempt: 1,
			input_json: { prompt: "stream events" },
			model_json: { provider: "test" },
			worker_id: "worker-1",
			created_at: "2026-07-08T09:59:00.000Z",
			updated_at: "2026-07-08T09:59:30.000Z",
			started_at: "2026-07-08T09:59:30.000Z",
			ended_at: null,
			error_json: null,
		};
		const poolQueries: RecordedQuery[] = [];
		const client = new RecordingClient().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return { rows: [runRow] };
			}
			if (/SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM agent_v2_run_events/i.test(sql)) {
				return { rows: [{ seq: "6" }] };
			}
			if (/^INSERT INTO agent_v2_run_events/i.test(sql)) {
				return {
					rows: [
						{
							client_id: "client-a",
							run_id: "run-v2-events",
							seq: 6,
							event_type: "task_completed",
							payload_json: { taskId: "task-1" },
							created_at: createdAt,
						},
					],
				};
			}
			return undefined;
		});
		const queryable: Queryable & { connect(): Promise<RecordingClient> } = {
			async query(sql, values: readonly unknown[] = []) {
				poolQueries.push({ sql, values });
				if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2$/i.test(normalizeSql(sql))) {
					return { rows: [runRow], rowCount: 1 };
				}
				throw new Error(`Unexpected pool query outside transaction: ${normalizeSql(sql)}`);
			},
			connect: async () => client,
		};
		const store = new PostgresRuntimeStore({ queryable });

		const event = await store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-v2-events",
			type: "task_completed",
			payload: { taskId: "task-1" },
			createdAt,
		});

		expect(event).toEqual({
			clientId: "client-a",
			runId: "run-v2-events",
			seq: 6,
			type: "task_completed",
			payload: { taskId: "task-1" },
			createdAt,
		});
		expect(poolQueries).toEqual([]);
		expect(client.statementsMatching(/^SELECT .* FROM agent_v2_runs .* FOR UPDATE$/i)).toHaveLength(1);
		expect(queryable.connect).toBeDefined();
		expect(client.releaseCalls).toBe(1);
		expect(client.statementsMatching(/^INSERT INTO agent_v2_run_events/i)[0]?.values).toEqual([
			"client-a",
			"run-v2-events",
			6,
			"task_completed",
			'{"taskId":"task-1"}',
			createdAt,
		]);
		const statements = client.queries.map((query) => normalizeSql(query.sql));
		expect(statements[0]).toBe("BEGIN");
		const runLockIndex = statementIndex(
			client,
			/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i,
		);
		const seqReadIndex = statementIndex(
			client,
			/SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM agent_v2_run_events/i,
		);
		const insertIndex = statementIndex(client, /^INSERT INTO agent_v2_run_events/i);
		const commitIndex = statementIndex(client, /^COMMIT$/i);
		expect(runLockIndex).toBeGreaterThan(0);
		expect(seqReadIndex).toBeGreaterThan(runLockIndex);
		expect(insertIndex).toBeGreaterThan(seqReadIndex);
		expect(commitIndex).toBeGreaterThan(insertIndex);
	});

	it("locks the PostgreSQL agent v2 run before inserting an event with a provided sequence", async () => {
		const createdAt = "2026-07-08T10:01:00.000Z";
		const runRow = {
			client_id: "client-a",
			run_id: "run-v2-explicit-seq",
			status: "running",
			phase: "implementation",
			attempt: 1,
			input_json: { prompt: "stream explicit event" },
			model_json: { provider: "test" },
			worker_id: "worker-1",
			created_at: "2026-07-08T09:59:00.000Z",
			updated_at: "2026-07-08T09:59:30.000Z",
			started_at: "2026-07-08T09:59:30.000Z",
			ended_at: null,
			error_json: null,
		};
		const poolQueries: RecordedQuery[] = [];
		const client = new RecordingClient().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return { rows: [runRow] };
			}
			if (/^INSERT INTO agent_v2_run_events/i.test(sql)) {
				return {
					rows: [
						{
							client_id: "client-a",
							run_id: "run-v2-explicit-seq",
							seq: 27,
							event_type: "run_finished",
							payload_json: { status: "succeeded" },
							created_at: createdAt,
						},
					],
				};
			}
			return undefined;
		});
		const queryable: Queryable & { connect(): Promise<RecordingClient> } = {
			async query(sql, values: readonly unknown[] = []) {
				poolQueries.push({ sql, values });
				if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2$/i.test(normalizeSql(sql))) {
					return { rows: [runRow], rowCount: 1 };
				}
				throw new Error(`Unexpected pool query outside transaction: ${normalizeSql(sql)}`);
			},
			connect: async () => client,
		};
		const store = new PostgresRuntimeStore({ queryable });

		const event = await store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-v2-explicit-seq",
			seq: 27,
			type: "run_finished",
			payload: { status: "succeeded" },
			createdAt,
		});

		expect(event.seq).toBe(27);
		expect(poolQueries).toEqual([]);
		expect(client.statementsMatching(/^SELECT .* FROM agent_v2_runs .* FOR UPDATE$/i)).toHaveLength(1);
		expect(
			client.statementsMatching(/SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM agent_v2_run_events/i),
		).toHaveLength(0);
		expect(client.statementsMatching(/^INSERT INTO agent_v2_run_events/i)[0]?.values).toEqual([
			"client-a",
			"run-v2-explicit-seq",
			27,
			"run_finished",
			'{"status":"succeeded"}',
			createdAt,
		]);
		expect(client.queries.map((query) => normalizeSql(query.sql))).toEqual([
			"BEGIN",
			expect.stringContaining("FOR UPDATE"),
			expect.stringMatching(/^INSERT INTO agent_v2_run_events/),
			"COMMIT",
		]);
	});

	it("returns applied false when a guarded PostgreSQL agent v2 run update misses the expected status", async () => {
		const cancellingRow = {
			client_id: "client-a",
			run_id: "run-v2-race",
			status: "cancelling",
			phase: "implementation",
			attempt: 1,
			input_json: { prompt: "build app" },
			model_json: { provider: "test" },
			worker_id: "worker-1",
			created_at: "2026-07-08T00:00:00.000Z",
			updated_at: "2026-07-08T00:02:00.000Z",
			started_at: "2026-07-08T00:01:00.000Z",
			ended_at: null,
			error_json: null,
		};
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return { rows: [cancellingRow] };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const result = await store.updateAgentV2RunWithResult({
			clientId: "client-a",
			runId: "run-v2-race",
			status: "succeeded" as const,
			phase: "delivery" as const,
			endedAt: "2026-07-08T00:03:00.000Z",
			updatedAt: "2026-07-08T00:03:00.000Z",
			expectedStatuses: ["running" as const],
		});

		expect(result).toMatchObject({
			run: {
				clientId: "client-a",
				runId: "run-v2-race",
				status: "cancelling",
				phase: "implementation",
			},
			applied: false,
		});
		expect(queryable.statementsMatching(/^SELECT .* FROM agent_v2_runs .* FOR UPDATE$/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/^UPDATE agent_v2_runs/i)).toHaveLength(0);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual([
			"BEGIN",
			expect.stringContaining("FOR UPDATE"),
			"COMMIT",
		]);
	});

	it("returns applied true when a guarded PostgreSQL agent v2 run update writes the row", async () => {
		const queuedRow = {
			client_id: "client-a",
			run_id: "run-v2-apply",
			status: "queued",
			phase: "intake",
			attempt: 1,
			input_json: { prompt: "build app" },
			model_json: { provider: "test" },
			worker_id: null,
			created_at: "2026-07-08T00:00:00.000Z",
			updated_at: "2026-07-08T00:00:00.000Z",
			started_at: null,
			ended_at: null,
			error_json: null,
		};
		const runningRow = {
			...queuedRow,
			status: "running",
			phase: "implementation",
			worker_id: "worker-1",
			updated_at: "2026-07-08T00:01:00.000Z",
			started_at: "2026-07-08T00:01:00.000Z",
		};
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM agent_v2_runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return { rows: [queuedRow] };
			}
			if (/^UPDATE agent_v2_runs/i.test(sql)) {
				return { rows: [runningRow] };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const result = await store.updateAgentV2RunWithResult({
			clientId: "client-a",
			runId: "run-v2-apply",
			status: "running",
			phase: "implementation",
			workerId: "worker-1",
			startedAt: "2026-07-08T00:01:00.000Z",
			updatedAt: "2026-07-08T00:01:00.000Z",
			expectedStatuses: ["queued"],
		});

		expect(result).toMatchObject({
			run: {
				clientId: "client-a",
				runId: "run-v2-apply",
				status: "running",
				phase: "implementation",
				workerId: "worker-1",
			},
			applied: true,
		});
		expect(queryable.statementsMatching(/^SELECT .* FROM agent_v2_runs .* FOR UPDATE$/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/^UPDATE agent_v2_runs/i)).toHaveLength(1);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual([
			"BEGIN",
			expect.stringContaining("FOR UPDATE"),
			expect.stringMatching(/^UPDATE agent_v2_runs/),
			"COMMIT",
		]);
	});

	it("lists owned active agent v2 runs for a worker through the shared runtime store contract", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (
				/^SELECT .* FROM agent_v2_runs WHERE worker_id = \$1 AND status IN \('running', 'cancelling'\) ORDER BY updated_at ASC, run_id ASC$/i.test(
					sql,
				)
			) {
				return {
					rows: [
						{
							client_id: "client-a",
							run_id: "run-running",
							status: "running",
							phase: "implementation",
							attempt: 1,
							input_json: { prompt: "Running run" },
							model_json: { provider: "openai", id: "gpt-5" },
							worker_id: "worker-1",
							created_at: "2026-07-08T09:00:00.000Z",
							updated_at: "2026-07-08T09:00:10.000Z",
							started_at: "2026-07-08T09:00:10.000Z",
							ended_at: null,
							error_json: null,
						},
						{
							client_id: "client-a",
							run_id: "run-cancelling",
							status: "cancelling",
							phase: "implementation",
							attempt: 1,
							input_json: { prompt: "Cancelling run" },
							model_json: { provider: "openai", id: "gpt-5" },
							worker_id: "worker-1",
							created_at: "2026-07-08T09:01:00.000Z",
							updated_at: "2026-07-08T09:01:20.000Z",
							started_at: "2026-07-08T09:01:10.000Z",
							ended_at: null,
							error_json: null,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const runs = await store.listAgentV2RunsByWorker("worker-1");

		expect(runs.map((run) => [run.runId, run.status])).toEqual([
			["run-running", "running"],
			["run-cancelling", "cancelling"],
		]);
		expect(queryable.queries[0]?.values).toEqual(["worker-1"]);
		expect(normalizeSql(queryable.queries[0]?.sql ?? "")).toContain(
			"FROM agent_v2_runs WHERE worker_id = $1 AND status IN ('running', 'cancelling') ORDER BY updated_at ASC, run_id ASC",
		);
	});

	it("appends and lists durable run events with client scoped queries", async () => {
		const createdAt = "2026-06-29T04:05:06.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							status: "running",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: "2026-06-29T01:02:03.000Z",
							updated_at: "2026-06-29T01:02:03.000Z",
							ended_at: null,
							error: null,
						},
					],
				};
			}
			if (/SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM run_events/i.test(sql)) {
				return { rows: [{ seq: "3" }] };
			}
			if (/^INSERT INTO run_events/i.test(sql)) {
				return {
					rows: [
						{
							id: 31,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 3,
							event_type: "message_update",
							payload_json: { delta: "one" },
							created_at: createdAt,
						},
					],
				};
			}
			if (/^UPDATE runs SET updated_at = \$3 WHERE client_id = \$1 AND run_id = \$2$/i.test(sql)) {
				return { rowCount: 1 };
			}
			if (/^UPDATE sessions SET updated_at = \$1, last_run_status = \$2, last_run_id = \$3/i.test(sql)) {
				return { rowCount: 1 };
			}
			if (
				/^SELECT .* FROM run_events WHERE client_id = \$1 AND run_id = \$2 AND seq > \$3 ORDER BY seq ASC$/i.test(
					sql,
				)
			) {
				return {
					rows: [
						{
							id: 31,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 3,
							event_type: "message_update",
							payload_json: { delta: "one" },
							created_at: createdAt,
						},
						{
							id: 32,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 4,
							event_type: "tool_result",
							payload_json: { ok: true },
							created_at: "2026-06-29T04:05:07.000Z",
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const appended = await store.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message_update",
			payload: { delta: "one" },
			createdAt,
		});
		const listed = await store.listRunEvents("client-a", "run-1", 2);

		expect(appended).toEqual({
			eventId: 31,
			runId: "run-1",
			sessionId: "session-1",
			clientId: "client-a",
			seq: 3,
			type: "message_update",
			payload: { delta: "one" },
			createdAt,
		});
		expect(listed).toEqual([
			appended,
			{
				eventId: 32,
				runId: "run-1",
				sessionId: "session-1",
				clientId: "client-a",
				seq: 4,
				type: "tool_result",
				payload: { ok: true },
				createdAt: "2026-06-29T04:05:07.000Z",
			},
		]);
		expect(queryable.statementsMatching(/INSERT INTO run_events/i)[0]?.values).toEqual([
			"run-1",
			"session-1",
			"client-a",
			3,
			"message_update",
			{ delta: "one" },
			createdAt,
		]);
		expect(
			queryable.statementsMatching(/FROM run_events WHERE client_id = \$1 AND run_id = \$2 AND seq > \$3/i)[0]
				?.values,
		).toEqual(["client-a", "run-1", 2]);
		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		expect(statements[0]).toBe("BEGIN");
		const runLockIndex = statementIndex(
			queryable,
			/^SELECT .* FROM runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i,
		);
		const seqReadIndex = statementIndex(queryable, /SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM run_events/i);
		const runTouchIndex = statementIndex(
			queryable,
			/^UPDATE runs SET updated_at = \$3 WHERE client_id = \$1 AND run_id = \$2$/i,
		);
		const sessionTouchIndex = statementIndex(
			queryable,
			/^UPDATE sessions SET updated_at = \$1, last_run_status = \$2, last_run_id = \$3/i,
		);
		const commitIndex = statementIndex(queryable, /^COMMIT$/i);
		expect(runLockIndex).toBeGreaterThan(0);
		expect(seqReadIndex).toBeGreaterThan(runLockIndex);
		expect(runTouchIndex).toBeGreaterThan(seqReadIndex);
		expect(sessionTouchIndex).toBeGreaterThan(runTouchIndex);
		expect(commitIndex).toBeGreaterThan(sessionTouchIndex);
	});

	it("uses the provided run event sequence when appending durable events", async () => {
		const createdAt = "2026-06-29T04:05:06.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM runs WHERE client_id = \$1 AND run_id = \$2 FOR UPDATE$/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							status: "running",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: "2026-06-29T01:02:03.000Z",
							updated_at: "2026-06-29T01:02:03.000Z",
							ended_at: null,
							error: null,
						},
					],
				};
			}
			if (/^INSERT INTO run_events/i.test(sql)) {
				return {
					rows: [
						{
							id: 37,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 27,
							event_type: "agent_end",
							payload_json: { type: "agent_end" },
							created_at: createdAt,
						},
					],
				};
			}
			if (/^UPDATE runs SET updated_at = \$3 WHERE client_id = \$1 AND run_id = \$2$/i.test(sql)) {
				return { rowCount: 1 };
			}
			if (/^UPDATE sessions SET updated_at = \$1, last_run_status = \$2, last_run_id = \$3/i.test(sql)) {
				return { rowCount: 1 };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const appended = await store.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			seq: 27,
			type: "agent_end",
			payload: { type: "agent_end" },
			createdAt,
		});

		expect(appended.seq).toBe(27);
		expect(
			queryable.statementsMatching(/SELECT COALESCE\(MAX\(seq\), 0\) \+ 1 AS seq FROM run_events/i),
		).toHaveLength(0);
		expect(queryable.statementsMatching(/INSERT INTO run_events/i)[0]?.values).toEqual([
			"run-1",
			"session-1",
			"client-a",
			27,
			"agent_end",
			{ type: "agent_end" },
			createdAt,
		]);
	});

	it("returns the latest message update checkpoint mapped as a runtime run event", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			if (/FROM run_events/i.test(query.sql)) {
				return {
					rows: [
						{
							id: 42,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 9,
							event_type: "message_update",
							payload_json: { text: "checkpoint" },
							created_at: "2026-06-29T01:02:03.000Z",
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const checkpoint = await store.getLatestRunCheckpoint("client-a", "run-1");

		expect(normalizeSql(queryable.queries[0]?.sql ?? "")).toContain("event_type = 'message_update'");
		expect(normalizeSql(queryable.queries[0]?.sql ?? "")).toContain("ORDER BY seq DESC LIMIT 1");
		expect(queryable.queries[0]?.values).toEqual(["client-a", "run-1"]);
		expect(checkpoint).toEqual({
			eventId: 42,
			runId: "run-1",
			sessionId: "session-1",
			clientId: "client-a",
			seq: 9,
			type: "message_update",
			payload: { text: "checkpoint" },
			createdAt: "2026-06-29T01:02:03.000Z",
		});
	});

	it("normalizes Date timestamp rows to ISO strings across runtime records", async () => {
		const sessionCreated = new Date("2026-06-29T06:00:00.000Z");
		const sessionUpdated = new Date("2026-06-29T06:01:00.000Z");
		const runStarted = new Date("2026-06-29T06:02:00.000Z");
		const runUpdated = new Date("2026-06-29T06:03:00.000Z");
		const runEnded = new Date("2026-06-29T06:04:00.000Z");
		const messageCreated = new Date("2026-06-29T06:05:00.000Z");
		const runEventCreated = new Date("2026-06-29T06:06:00.000Z");
		const goalCreated = new Date("2026-06-29T06:07:00.000Z");
		const goalUpdated = new Date("2026-06-29T06:08:00.000Z");
		const goalCompleted = new Date("2026-06-29T06:09:00.000Z");
		const goalEventCreated = new Date("2026-06-29T06:10:00.000Z");
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^SELECT .* FROM sessions WHERE client_id = \$1 AND session_id = \$2$/i.test(sql)) {
				return {
					rows: [
						{
							session_id: "session-1",
							client_id: "client-a",
							title: "Existing session",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							created_at: sessionCreated,
							updated_at: sessionUpdated,
							last_run_status: "completed",
							last_run_id: "run-1",
						},
					],
				};
			}
			if (/^SELECT .* FROM runs WHERE client_id = \$1 AND run_id = \$2$/i.test(sql)) {
				return {
					rows: [
						{
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							status: "completed",
							worker_id: "worker-1",
							model_json: { id: "gpt-5" },
							thinking_level: "medium",
							started_at: runStarted,
							updated_at: runUpdated,
							ended_at: runEnded,
							error: null,
						},
					],
				};
			}
			if (/^SELECT .* FROM messages WHERE client_id = \$1 AND session_id = \$2 ORDER BY id ASC$/i.test(sql)) {
				return {
					rows: [
						{
							id: 1,
							session_id: "session-1",
							client_id: "client-a",
							role: "user",
							payload_json: { content: "hello" },
							created_at: messageCreated,
						},
					],
				};
			}
			if (
				/^SELECT .* FROM run_events WHERE client_id = \$1 AND run_id = \$2 AND seq > \$3 ORDER BY seq ASC$/i.test(
					sql,
				)
			) {
				return {
					rows: [
						{
							id: 2,
							run_id: "run-1",
							session_id: "session-1",
							client_id: "client-a",
							seq: 1,
							event_type: "message_update",
							payload_json: { delta: "hello" },
							created_at: runEventCreated,
						},
					],
				};
			}
			if (/^SELECT .* FROM app_preview_goals WHERE client_id = \$1 AND session_id = \$2$/i.test(sql)) {
				return {
					rows: [
						{
							goal_id: "goal-1",
							client_id: "client-a",
							session_id: "session-1",
							source: "pm_handoff",
							status: "preview_ready",
							max_continuation_runs: 3,
							continuation_runs_used: 2,
							retry_attempts_used: 1,
							last_run_id: "run-1",
							last_preview_url: "http://localhost:4173",
							last_failure_reason: null,
							created_at: goalCreated,
							updated_at: goalUpdated,
							completed_at: goalCompleted,
						},
					],
				};
			}
			if (
				/^SELECT .* FROM app_preview_goal_events WHERE client_id = \$1 AND session_id = \$2 AND id > \$3 ORDER BY id ASC$/i.test(
					sql,
				)
			) {
				return {
					rows: [
						{
							id: 3,
							goal_id: "goal-1",
							client_id: "client-a",
							session_id: "session-1",
							run_id: "run-1",
							event_type: "preview_ready",
							reason_code: null,
							payload_json: { url: "http://localhost:4173" },
							created_at: goalEventCreated,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const session = await store.getSession("client-a", "session-1");
		const run = await store.getRun("client-a", "run-1");
		const [message] = await store.listMessages("client-a", "session-1");
		const [runEvent] = await store.listRunEvents("client-a", "run-1", 0);
		const goal = await store.getAppPreviewGoal("client-a", "session-1");
		const [goalEvent] = await store.listAppPreviewGoalEvents("client-a", "session-1", 0);

		expect(session?.createdAt).toBe(sessionCreated.toISOString());
		expect(session?.updatedAt).toBe(sessionUpdated.toISOString());
		expect(run?.startedAt).toBe(runStarted.toISOString());
		expect(run?.updatedAt).toBe(runUpdated.toISOString());
		expect(run?.endedAt).toBe(runEnded.toISOString());
		expect(message?.createdAt).toBe(messageCreated.toISOString());
		expect(runEvent?.createdAt).toBe(runEventCreated.toISOString());
		expect(goal?.createdAt).toBe(goalCreated.toISOString());
		expect(goal?.updatedAt).toBe(goalUpdated.toISOString());
		expect(goal?.completedAt).toBe(goalCompleted.toISOString());
		expect(goalEvent?.createdAt).toBe(goalEventCreated.toISOString());
	});

	it("upserts app preview goals and maps the returned durable row", async () => {
		const createdAt = "2026-06-29T05:06:07.000Z";
		const updatedAt = "2026-06-29T05:06:08.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			if (/INSERT INTO app_preview_goals/i.test(query.sql)) {
				return {
					rows: [
						{
							goal_id: "goal-1",
							client_id: "client-a",
							session_id: "session-1",
							source: "pm_handoff",
							status: "preview_ready",
							max_continuation_runs: "3",
							continuation_runs_used: "2",
							retry_attempts_used: "1",
							last_run_id: "run-1",
							last_preview_url: "http://localhost:4173",
							last_failure_reason: null,
							created_at: createdAt,
							updated_at: updatedAt,
							completed_at: updatedAt,
						},
					],
				};
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const goal = await store.upsertAppPreviewGoal({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			status: "preview_ready",
			maxContinuationRuns: 3,
			continuationRunsUsed: 2,
			retryAttemptsUsed: 1,
			lastRunId: "run-1",
			lastPreviewUrl: "http://localhost:4173",
			createdAt,
			updatedAt,
			completedAt: updatedAt,
		});

		expect(goal).toEqual({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			status: "preview_ready",
			maxContinuationRuns: 3,
			continuationRunsUsed: 2,
			retryAttemptsUsed: 1,
			lastRunId: "run-1",
			lastPreviewUrl: "http://localhost:4173",
			createdAt,
			updatedAt,
			completedAt: updatedAt,
		});
		expect(queryable.queries[0]?.values).toEqual([
			"goal-1",
			"client-a",
			"session-1",
			"pm_handoff",
			"preview_ready",
			3,
			2,
			1,
			"run-1",
			"http://localhost:4173",
			null,
			createdAt,
			updatedAt,
			updatedAt,
		]);
	});

	it("deletes sessions with a client scoped transaction", async () => {
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^DELETE FROM sessions/i.test(sql)) return { rowCount: 1 };
			if (/^DELETE FROM /i.test(sql)) return { rowCount: 0 };
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		const deleted = await store.deleteSession("client-a", "session-1");

		expect(deleted).toBe(true);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual(
			expect.arrayContaining(["BEGIN", "COMMIT"]),
		);
		for (const query of queryable.queries.filter((record) => /^DELETE FROM/i.test(normalizeSql(record.sql)))) {
			expect(normalizeSql(query.sql)).toContain("WHERE client_id = $1 AND session_id = $2");
			expect(query.values).toEqual(["client-a", "session-1"]);
		}
	});

	it("rejects non-monotonic durable transition and cancel revisions before mutation queries", async () => {
		const t0 = "2026-07-13T14:00:00.000Z";
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (sql.includes("FROM agent_v2_runs") && sql.includes("FOR UPDATE")) {
				return {
					rows: [
						{
							client_id: "client-a",
							run_id: "run-a",
							status: "queued",
							phase: "implementation",
							attempt: 1,
							input_json: {},
							model_json: {},
							worker_id: null,
							created_at: t0,
							updated_at: t0,
							started_at: null,
							ended_at: null,
							error_json: null,
						},
					],
				};
			}
			if (sql.startsWith("SELECT intent_id FROM agent_v2_outbox")) return { rows: [] };
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });
		const expectedRun = {
			status: "queued" as const,
			phase: "implementation" as const,
			attempt: 1,
			workerId: null,
			updatedAt: t0,
		};

		const transition = await store.commitAgentV2RunTransition({
			expectedRun,
			update: {
				clientId: "client-a",
				runId: "run-a",
				expectedStatuses: ["queued"],
				phase: "validation",
				updatedAt: t0,
			},
			event: { type: "must_not_write", payload: {}, createdAt: t0 },
		});
		expect(transition.update.applied).toBe(false);
		expect(queryable.statementsMatching(/^(UPDATE|INSERT) /i)).toEqual([]);

		queryable.queries.length = 0;
		await expect(
			store.commitAgentV2RunCancel({
				clientId: "client-a",
				runId: "run-a",
				expectedStatuses: ["queued"],
				expectedRun,
				queueName: "agent-v2",
				cancelToken: "invalid-revision",
				cancelledAt: "2026-07-13T14:00:00Z",
			}),
		).rejects.toThrow("compare-and-set conflict");
		expect(queryable.statementsMatching(/^(UPDATE|INSERT) /i)).toEqual([]);
		expect(queryable.queries.map((query) => normalizeSql(query.sql))).toEqual(
			expect.arrayContaining(["BEGIN", "ROLLBACK"]),
		);
	});

	it("binds every Agent v2 JSON slot as parseable JSON text with semantic round-trip", async () => {
		const createdAt = "2026-07-13T15:00:00.000Z";
		let runRow: Record<string, unknown> | undefined;
		const parseBoundJson = (value: unknown): unknown =>
			typeof value === "string" ? (JSON.parse(value) as unknown) : value;
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			const value = (index: number): unknown => query.values[index];
			if (/^SELECT pg_advisory_xact_lock/i.test(sql)) return { rows: [{}] };
			if (
				/^SELECT .* FROM agent_v2_runs WHERE client_id\s*=\s*\$1 AND run_id\s*=\s*\$2(?: FOR UPDATE)?$/i.test(sql)
			) {
				return { rows: runRow ? [runRow] : [] };
			}
			if (/^INSERT INTO agent_v2_runs/i.test(sql)) {
				runRow = {
					client_id: value(0),
					run_id: value(1),
					status: value(2),
					phase: value(3),
					attempt: value(4),
					input_json: parseBoundJson(value(5)),
					model_json: parseBoundJson(value(6)),
					worker_id: value(7),
					created_at: value(8),
					updated_at: value(9),
					started_at: value(10),
					ended_at: value(11),
					error_json: value(12) === null ? null : parseBoundJson(value(12)),
				};
				return { rows: [runRow] };
			}
			if (/^UPDATE agent_v2_runs/i.test(sql)) {
				if (!runRow) throw new Error("missing recorded run");
				runRow = {
					...runRow,
					status: value(2),
					phase: value(3),
					attempt: value(4),
					worker_id: value(5),
					updated_at: value(6),
					started_at: value(7),
					ended_at: value(8),
					error_json: value(9) === null ? null : parseBoundJson(value(9)),
				};
				return { rows: [runRow] };
			}
			if (/^INSERT INTO agent_v2_run_events/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							seq: value(2),
							event_type: value(3),
							payload_json: parseBoundJson(value(4)),
							created_at: value(5),
						},
					],
				};
			}
			if (/^INSERT INTO agent_v2_tasks/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							task_id: value(2),
							parent_task_id: value(3),
							kind: value(4),
							title: value(5),
							status: value(6),
							depends_on_json: parseBoundJson(value(7)),
							acceptance_criteria_json: parseBoundJson(value(8)),
							input_json: parseBoundJson(value(9)),
							output_json: parseBoundJson(value(10)),
							created_at: value(11),
							updated_at: value(12),
							started_at: value(13),
							ended_at: value(14),
							error_json: value(15) === null ? null : parseBoundJson(value(15)),
						},
					],
				};
			}
			if (/^INSERT INTO agent_v2_artifacts/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							artifact_id: value(2),
							kind: value(3),
							path: value(4),
							media_type: value(5),
							checksum: value(6),
							version: value(7),
							source_task_id: value(8),
							validation_status: value(9),
							metadata_json: parseBoundJson(value(10)),
							created_at: value(11),
							updated_at: value(12),
						},
					],
				};
			}
			if (/^INSERT INTO agent_v2_documents/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							document_id: value(2),
							kind: value(3),
							version: value(4),
							content_markdown: value(5),
							content_json: parseBoundJson(value(6)),
							source_task_id: value(7),
							created_at: value(8),
							updated_at: value(9),
						},
					],
				};
			}
			if (/^INSERT INTO agent_v2_diagnostics/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							diagnostic_id: value(2),
							severity: value(3),
							category: value(4),
							code: value(5),
							phase: value(6),
							task_id: value(7),
							artifact_id: value(8),
							trace_id: value(9),
							message: value(10),
							data_json: parseBoundJson(value(11)),
							created_at: value(12),
						},
					],
				};
			}
			if (/^INSERT INTO agent_v2_validation_attempts/i.test(sql)) {
				return {
					rows: [
						{
							client_id: value(0),
							run_id: value(1),
							validation_id: value(2),
							attempt: value(3),
							task_id: value(4),
							artifact_id: value(5),
							status: value(6),
							summary: value(7),
							details_json: parseBoundJson(value(8)),
							created_at: value(9),
							updated_at: value(10),
						},
					],
				};
			}
			if (/^SELECT intent_id, reference_json FROM agent_v2_outbox/i.test(sql)) return { rows: [] };
			if (/^INSERT INTO agent_v2_(bootstraps|outbox)/i.test(sql)) return { rowCount: 1 };
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });
		const runError = { code: "run_error", message: "run error", retryable: false, data: { causes: ["a"] } };
		const updatedRunError = {
			code: "updated_run_error",
			message: "updated run error",
			retryable: true,
			data: { causes: ["updated"] },
		};
		const taskError = { code: "task_error", message: "task error", retryable: true, data: { causes: ["b"] } };
		const documentContent = {
			kind: "spec" as const,
			title: "JSON spec",
			objective: "verify JSON bindings",
			summary: "Verify PostgreSQL JSON bindings",
			scope: ["postgres-adapter"],
			goals: ["round-trip"],
			nonGoals: [],
			assumptions: [],
			requirements: ["r1"],
			capabilityBoundaries: [],
			acceptanceCriteria: ["all bindings are JSON text"],
			platformContract: {
				runtime: "browser",
				framework: "none",
				deliveryMode: "static_app" as const,
				entrypoints: ["index.html"],
				deliverables: ["static application"],
				constraints: [],
			},
		};

		await store.commitAgentV2RunStart({
			run: {
				clientId: "client-json",
				runId: "run-json",
				input: { sessionId: "session-json", title: "JSON", objective: "verify JSON bindings" },
				model: { provider: "test", id: "model-json" },
				createdAt,
				updatedAt: createdAt,
				error: runError,
			},
			bootstrapVersion: "agent-v2-planning-v1",
			bootstrapChecksum: "sha256:bootstrap-json",
			inputBlobs: [],
			inputReferences: [],
			readyPhase: "implementation",
			documents: [
				{
					clientId: "client-json",
					runId: "run-json",
					documentId: "spec",
					kind: "spec",
					version: "v2",
					contentMarkdown: "# Spec",
					contentJson: documentContent,
					sourceTaskId: "task-json",
					createdAt,
					updatedAt: createdAt,
				},
			],
			tasks: [
				{
					clientId: "client-json",
					runId: "run-json",
					taskId: "task-json",
					kind: "implementation",
					title: "JSON task",
					status: "pending",
					dependsOn: ["capability"],
					acceptanceCriteria: ["round-trips"],
					input: { paths: ["src/index.ts"] },
					output: { artifacts: ["artifact-json"] },
					error: taskError,
					createdAt,
					updatedAt: createdAt,
				},
			],
			artifacts: [
				{
					clientId: "client-json",
					runId: "run-json",
					artifactId: "artifact-json",
					kind: "source",
					path: "src/index.ts",
					mediaType: "text/typescript",
					checksum: "sha256:artifact-json",
					version: "v2",
					sourceTaskId: "task-json",
					validationStatus: "pending",
					metadataJson: { tags: ["source"] },
					createdAt,
					updatedAt: createdAt,
				},
			],
			diagnostics: [
				{
					diagnosticId: "diagnostic-json",
					clientId: "client-json",
					runId: "run-json",
					severity: "info",
					category: "planning",
					code: "agent_v2.test.json",
					message: "JSON diagnostic",
					data: { evidence: ["recording-queryable"] },
					createdAt,
				},
			],
			queueName: "agent-v2",
			createdAt,
		});
		await store.updateAgentV2Run({
			clientId: "client-json",
			runId: "run-json",
			updatedAt: "2026-07-13T15:00:01.000Z",
			error: updatedRunError,
		});
		await store.upsertAgentV2Task({
			clientId: "client-json",
			runId: "run-json",
			taskId: "task-json-null-error",
			kind: "implementation",
			title: "Null error task",
			status: "pending",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt,
			updatedAt: createdAt,
		});
		await store.appendAgentV2ValidationAttempt({
			clientId: "client-json",
			runId: "run-json",
			validationId: "validation-json",
			attempt: 1,
			status: "passed",
			summary: "JSON validation",
			details: { checks: ["json-text"] },
			createdAt,
			updatedAt: createdAt,
		});

		const jsonBindings = queryable.queries.flatMap((query) => {
			const sql = normalizeSql(query.sql);
			const indexes = /^INSERT INTO agent_v2_runs/i.test(sql)
				? [5, 6, 12]
				: /^UPDATE agent_v2_runs/i.test(sql)
					? [9]
					: /^INSERT INTO agent_v2_run_events/i.test(sql)
						? [4]
						: /^INSERT INTO agent_v2_tasks/i.test(sql)
							? [7, 8, 9, 10, 15]
							: /^INSERT INTO agent_v2_artifacts/i.test(sql)
								? [10]
								: /^INSERT INTO agent_v2_documents/i.test(sql)
									? [6]
									: /^INSERT INTO agent_v2_diagnostics/i.test(sql)
										? [11]
										: /^INSERT INTO agent_v2_validation_attempts/i.test(sql)
											? [8]
											: /^INSERT INTO agent_v2_outbox/i.test(sql)
												? [6]
												: [];
			return indexes.map((index) => query.values[index]).filter((value) => value !== null);
		});
		expect(jsonBindings.length).toBeGreaterThanOrEqual(24);
		for (const binding of jsonBindings) {
			expect(typeof binding).toBe("string");
			expect(() => JSON.parse(binding as string)).not.toThrow();
		}
		expect(jsonBindings.map((binding) => JSON.parse(binding as string))).toEqual(
			expect.arrayContaining([
				["capability"],
				["round-trips"],
				{ paths: ["src/index.ts"] },
				{ artifacts: ["artifact-json"] },
				taskError,
				updatedRunError,
				{ tags: ["source"] },
				documentContent,
				{ evidence: ["recording-queryable"] },
				{ checks: ["json-text"] },
			]),
		);
		expect(
			queryable.statementsMatching(/^INSERT INTO agent_v2_tasks/i).some((query) => query.values[15] === null),
		).toBe(true);
	});
});
