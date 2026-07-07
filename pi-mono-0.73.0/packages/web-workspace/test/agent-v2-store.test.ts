import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeDbStore } from "../src/runtime-db.ts";
import { PostgresRuntimeStore, type Queryable } from "../src/postgres-runtime-store.ts";

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
		for (const handler of this.handlers) {
			const result = handler(query);
			if (result) return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
		}
		return { rows: [], rowCount: 0 };
	}

	statementsMatching(pattern: RegExp): RecordedQuery[] {
		return this.queries.filter((query) => pattern.test(normalizeSql(query.sql)));
	}
}

function normalizeSql(sql: string): string {
	return sql.replaceAll(/\s+/g, " ").trim();
}

describe("agent v2 runtime stores", () => {
	let dir: string;
	let store: RuntimeDbStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-runtime-agent-v2-db-"));
		store = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		store.ensureSchema();
		store.ensureAgentV2Schema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("initializes v2 schema independently from legacy sessions", () => {
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Legacy session",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
		});

		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-a",
			input: { prompt: "build a dashboard" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-07T00:00:00.000Z",
		});

		expect(run.status).toBe("queued");
		expect(run.phase).toBe("intake");
		expect(run.attempt).toBe(1);
		expect(store.getAgentV2Run("client-a", "run-v2-a")?.runId).toBe("run-v2-a");
	});

	it("does not read legacy runs as v2 runs", () => {
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Legacy session",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "same-id",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
		});

		expect(store.getAgentV2Run("client-a", "same-id")).toBeUndefined();
	});

	it("updates v2 runs with status, phase, timestamps, worker, and error patches", () => {
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-a",
			input: { prompt: "ship it" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-07T00:00:00.000Z",
		});

		const running = store.updateAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-a",
			status: "running",
			phase: "execution",
			workerId: "worker-1",
			startedAt: "2026-07-07T00:01:00.000Z",
			updatedAt: "2026-07-07T00:01:00.000Z",
		});
		const failed = store.updateAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-a",
			status: "failed",
			phase: "repair",
			endedAt: "2026-07-07T00:02:00.000Z",
			updatedAt: "2026-07-07T00:02:00.000Z",
			error: {
				code: "tool_failed",
				message: "Tool execution failed",
				retryable: true,
			},
		});

		expect(running.status).toBe("running");
		expect(running.phase).toBe("execution");
		expect(running.workerId).toBe("worker-1");
		expect(running.startedAt).toBe("2026-07-07T00:01:00.000Z");
		expect(failed.status).toBe("failed");
		expect(failed.phase).toBe("repair");
		expect(failed.endedAt).toBe("2026-07-07T00:02:00.000Z");
		expect(failed.error?.code).toBe("tool_failed");
	});

	it("stores and lists v2 tasks, artifacts, and diagnostics by run", () => {
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-a",
			input: { prompt: "build a dashboard" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-07T00:00:00.000Z",
		});

		const task = store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-v2-a",
			taskId: "task-2",
			parentTaskId: "task-1",
			kind: "implementation",
			title: "Implement the page",
			status: "running",
			dependsOn: ["task-1"],
			input: { files: ["src/app.ts"] },
			output: { changed: 1 },
			createdAt: "2026-07-07T00:01:00.000Z",
			updatedAt: "2026-07-07T00:02:00.000Z",
			startedAt: "2026-07-07T00:02:00.000Z",
		});
		const artifact = store.upsertAgentV2Artifact({
			clientId: "client-a",
			runId: "run-v2-a",
			artifactId: "artifact-1",
			taskId: "task-2",
			kind: "file",
			uri: "file:///workspace/src/app.ts",
			title: "Updated app file",
			description: "Implements the runtime store",
			metadata: { language: "ts" },
			createdAt: "2026-07-07T00:03:00.000Z",
			updatedAt: "2026-07-07T00:03:00.000Z",
		});
		const diagnostic = store.appendAgentV2Diagnostic({
			diagnosticId: "diag-1",
			clientId: "client-a",
			runId: "run-v2-a",
			severity: "warn",
			category: "task_graph",
			code: "dependency_wait",
			phase: "execution",
			taskId: "task-2",
			message: "Waiting on prerequisite task",
			data: { blockedBy: ["task-1"] },
			createdAt: "2026-07-07T00:04:00.000Z",
		});

		expect(task.taskId).toBe("task-2");
		expect(store.listAgentV2Tasks("client-a", "run-v2-a")).toEqual([task]);
		expect(artifact.artifactId).toBe("artifact-1");
		expect(store.listAgentV2Artifacts("client-a", "run-v2-a")).toEqual([artifact]);
		expect(diagnostic.diagnosticId).toBe("diag-1");
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-a")).toEqual([diagnostic]);
	});

	it("creates the expected SQLite agent v2 tables", () => {
		const db = new DatabaseSync(join(dir, "runtime.sqlite"));
		try {
			const tables = (
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_v2_%' ORDER BY name ASC").all() as {
					name: string;
				}[]
			).map((row) => row.name);

			expect(tables).toEqual([
				"agent_v2_artifacts",
				"agent_v2_diagnostics",
				"agent_v2_runs",
				"agent_v2_schema_metadata",
				"agent_v2_tasks",
				"agent_v2_validations",
			]);
		} finally {
			db.close();
		}
	});

	it("creates the expected PostgreSQL agent v2 schema and queries v2 tables directly", async () => {
		const runRow = {
			client_id: "client-a",
			run_id: "run-v2-a",
			status: "queued",
			phase: "intake",
			attempt: 1,
			input_json: { prompt: "build a dashboard" },
			model_json: { provider: "test", model: "local" },
			worker_id: null,
			created_at: "2026-07-07T00:00:00.000Z",
			updated_at: "2026-07-07T00:00:00.000Z",
			started_at: null,
			ended_at: null,
			error_json: null,
		};
		const taskRow = {
			client_id: "client-a",
			run_id: "run-v2-a",
			task_id: "task-1",
			parent_task_id: null,
			kind: "requirements",
			title: "Read the brief",
			status: "ready",
			depends_on_json: [],
			input_json: {},
			output_json: {},
			created_at: "2026-07-07T00:00:00.000Z",
			updated_at: "2026-07-07T00:00:00.000Z",
			started_at: null,
			ended_at: null,
			error_json: null,
		};
		const artifactRow = {
			client_id: "client-a",
			run_id: "run-v2-a",
			artifact_id: "artifact-1",
			task_id: null,
			kind: "file",
			uri: "file:///workspace/brief.md",
			title: "Brief copy",
			description: null,
			metadata_json: {},
			created_at: "2026-07-07T00:00:00.000Z",
			updated_at: "2026-07-07T00:00:00.000Z",
		};
		const queryable = new RecordingQueryable().on((query) => {
			const sql = normalizeSql(query.sql);
			if (/^CREATE /i.test(sql)) return { rowCount: 0 };
			if (/FROM agent_v2_runs/i.test(sql)) return { rows: [runRow] };
			if (/FROM agent_v2_tasks/i.test(sql)) return { rows: [taskRow] };
			if (/FROM agent_v2_artifacts/i.test(sql)) {
				return { rows: [artifactRow] };
			}
			return undefined;
		});
		const store = new PostgresRuntimeStore({ queryable });

		await store.ensureAgentV2Schema();
		const run = await store.getAgentV2Run("client-a", "run-v2-a");
		const tasks = await store.listAgentV2Tasks("client-a", "run-v2-a");
		const artifacts = await store.listAgentV2Artifacts("client-a", "run-v2-a");

		const statements = queryable.queries.map((query) => normalizeSql(query.sql));
		for (const table of [
			"agent_v2_schema_metadata",
			"agent_v2_runs",
			"agent_v2_tasks",
			"agent_v2_artifacts",
			"agent_v2_validations",
			"agent_v2_diagnostics",
		]) {
			expect(statements.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`))).toBe(true);
		}
		expect(
			statements.some((statement) =>
				statement.includes("CREATE INDEX IF NOT EXISTS idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at)"),
			),
		).toBe(true);
		expect(
			statements.some((statement) =>
				statement.includes(
					"CREATE INDEX IF NOT EXISTS idx_agent_v2_tasks_run_updated ON agent_v2_tasks(client_id, run_id, updated_at DESC)",
				),
			),
		).toBe(true);
		expect(
			statements.some((statement) =>
				statement.includes(
					"CREATE INDEX IF NOT EXISTS idx_agent_v2_artifacts_run_updated ON agent_v2_artifacts(client_id, run_id, updated_at DESC)",
				),
			),
		).toBe(true);
		expect(run?.runId).toBe("run-v2-a");
		expect(tasks[0]?.taskId).toBe("task-1");
		expect(artifacts[0]?.artifactId).toBe("artifact-1");
		expect(queryable.statementsMatching(/FROM runs/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM tasks/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM artifacts/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM agent_v2_runs/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/FROM agent_v2_tasks/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/FROM agent_v2_artifacts/i)).toHaveLength(1);
	});
});
