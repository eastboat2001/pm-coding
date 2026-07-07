import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAgentV2RunEvent } from "../src/agent-v2-run-events.js";
import { PostgresRuntimeStore, type Queryable } from "../src/postgres-runtime-store.js";
import { InMemoryRunEventBus } from "../src/run-event-bus.js";
import { RunEventSink } from "../src/run-event-sink.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

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

	it("keeps v2 reads undefined when only legacy runs and run_events exist for replay", async () => {
		store.createSession({
			clientId: "client-a",
			sessionId: "session-transport",
			title: "Transport session",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
		});
		const legacyRun = store.createRun({
			clientId: "client-a",
			sessionId: "session-transport",
			runId: "run-v2-transport",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
			createdAt: "2026-07-07T00:00:00.000Z",
		});
		const sink = new RunEventSink({
			store,
			bus: new InMemoryRunEventBus(),
			checkpointIntervalMs: 1_000,
			checkpointMinChars: 100,
		});

		await appendAgentV2RunEvent(sink, legacyRun, {
			type: "agent_v2.run_created",
			status: "queued",
			phase: "intake",
			attempt: 1,
			at: "2026-07-07T00:00:00.000Z",
		});
		await appendAgentV2RunEvent(sink, legacyRun, {
			type: "agent_v2.validation_recorded",
			validationId: "validation-1",
			status: "passed",
			summary: "Transport replay projection recorded",
			at: "2026-07-07T00:01:00.000Z",
		});

		expect(store.getRun("client-a", "run-v2-transport")?.runId).toBe("run-v2-transport");
		const events = store.listRunEvents("client-a", "run-v2-transport", 0);
		expect(events.map((event) => event.type)).toEqual(["agent_v2.run_created", "agent_v2.validation_recorded"]);
		expect(events[0]?.payload).toEqual({
			type: "agent_v2.run_created",
			status: "queued",
			phase: "intake",
			attempt: 1,
			at: "2026-07-07T00:00:00.000Z",
		});
		expect(events[1]?.payload).toEqual({
			type: "agent_v2.validation_recorded",
			validationId: "validation-1",
			status: "passed",
			summary: "Transport replay projection recorded",
			at: "2026-07-07T00:01:00.000Z",
		});
		expect(store.getAgentV2Run("client-a", "run-v2-transport")).toBeUndefined();
		expect(store.listAppPreviewGoalEvents("client-a", "session-transport", 0)).toEqual([]);
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
			phase: "implementation",
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
		expect(running.phase).toBe("implementation");
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
			acceptanceCriteria: ["Render the page", "Persist generated files metadata"],
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
			kind: "file",
			path: "src/app.ts",
			mediaType: "text/typescript",
			checksum: "sha256:artifact-1",
			version: "v1",
			sourceTaskId: "task-2",
			validationStatus: "accepted",
			metadataJson: { language: "ts" },
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
			phase: "implementation",
			taskId: "task-2",
			message: "Waiting on prerequisite task",
			data: { blockedBy: ["task-1"] },
			createdAt: "2026-07-07T00:04:00.000Z",
		});

		expect(task.taskId).toBe("task-2");
		expect(task.acceptanceCriteria).toEqual(["Render the page", "Persist generated files metadata"]);
		expect(store.listAgentV2Tasks("client-a", "run-v2-a")).toEqual([task]);
		expect(artifact.artifactId).toBe("artifact-1");
		expect(artifact.sourceTaskId).toBe("task-2");
		expect(artifact.metadataJson).toEqual({ language: "ts" });
		expect(store.listAgentV2Artifacts("client-a", "run-v2-a")).toEqual([artifact]);
		expect(diagnostic.diagnosticId).toBe("diag-1");
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-a")).toEqual([diagnostic]);
	});

	it("creates the expected SQLite agent v2 tables", () => {
		const db = new DatabaseSync(join(dir, "runtime.sqlite"));
		try {
			const tables = (
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_v2_%' ORDER BY name ASC",
					)
					.all() as {
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

			const artifactColumns = (db.prepare("PRAGMA table_info(agent_v2_artifacts)").all() as { name: string }[]).map(
				(row) => row.name,
			);
			expect(artifactColumns).toEqual([
				"client_id",
				"run_id",
				"artifact_id",
				"kind",
				"path",
				"media_type",
				"checksum",
				"version",
				"source_task_id",
				"validation_status",
				"metadata_json",
				"created_at",
				"updated_at",
			]);
			const taskColumns = (db.prepare("PRAGMA table_info(agent_v2_tasks)").all() as { name: string }[]).map(
				(row) => row.name,
			);
			expect(taskColumns).toEqual([
				"client_id",
				"run_id",
				"task_id",
				"parent_task_id",
				"kind",
				"title",
				"status",
				"depends_on_json",
				"acceptance_criteria_json",
				"input_json",
				"output_json",
				"created_at",
				"updated_at",
				"started_at",
				"ended_at",
				"error_json",
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
			kind: "spec",
			title: "Read the brief",
			status: "ready",
			depends_on_json: [],
			acceptance_criteria_json: ["Task graph nodes include acceptance criteria"],
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
			kind: "file",
			path: "brief.md",
			media_type: "text/markdown",
			checksum: "sha256:artifact-1",
			version: "v1",
			source_task_id: null,
			validation_status: "accepted",
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
				statement.includes(
					"CREATE INDEX IF NOT EXISTS idx_agent_v2_runs_status ON agent_v2_runs(status, updated_at)",
				),
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
					"ALTER TABLE agent_v2_tasks ADD COLUMN IF NOT EXISTS acceptance_criteria_json JSONB NOT NULL DEFAULT '[]'::jsonb",
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
		const artifactTableStatement = statements.find((statement) =>
			statement.includes("CREATE TABLE IF NOT EXISTS agent_v2_artifacts"),
		);
		const taskTableStatement = statements.find((statement) =>
			statement.includes("CREATE TABLE IF NOT EXISTS agent_v2_tasks"),
		);
		expect(taskTableStatement).toContain("acceptance_criteria_json JSONB NOT NULL DEFAULT '[]'::jsonb");
		expect(artifactTableStatement).toContain("path TEXT NOT NULL");
		expect(artifactTableStatement).toContain("media_type TEXT NOT NULL");
		expect(artifactTableStatement).toContain("checksum TEXT NOT NULL");
		expect(artifactTableStatement).toContain("version TEXT NOT NULL");
		expect(artifactTableStatement).toContain("source_task_id TEXT");
		expect(artifactTableStatement).toContain("validation_status TEXT NOT NULL");
		expect(artifactTableStatement).not.toMatch(/(^|[ (])task_id TEXT([, )]|$)/);
		expect(artifactTableStatement).not.toContain("uri TEXT NOT NULL");
		expect(artifactTableStatement).not.toContain("title TEXT NOT NULL");
		expect(artifactTableStatement).not.toContain("description TEXT");
		expect(run?.runId).toBe("run-v2-a");
		expect(tasks[0]?.taskId).toBe("task-1");
		expect(tasks[0]?.acceptanceCriteria).toEqual(["Task graph nodes include acceptance criteria"]);
		expect(artifacts[0]?.artifactId).toBe("artifact-1");
		expect(queryable.statementsMatching(/FROM runs/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM tasks/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM artifacts/i)).toHaveLength(0);
		expect(queryable.statementsMatching(/FROM agent_v2_runs/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/FROM agent_v2_tasks/i)).toHaveLength(1);
		expect(queryable.statementsMatching(/FROM agent_v2_artifacts/i)).toHaveLength(1);
	});
});
