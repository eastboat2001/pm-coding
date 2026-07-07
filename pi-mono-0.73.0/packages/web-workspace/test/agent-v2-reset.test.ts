import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_V2_SCHEMA_VERSION } from "../src/agent-v2-types.js";
import {
	assertAgentV2ResetConfirmation,
	resetAgentV2RuntimeData,
	type AgentV2ResetDiagnosticsAdapter,
} from "../src/agent-v2-reset.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const CONFIRMATION_TOKEN = "application-generation-agent-v2";

describe("agent v2 destructive reset", () => {
	let dir: string;
	let dbFile: string;
	let store: RuntimeDbStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-reset-"));
		dbFile = join(dir, "runtime.sqlite");
		store = new RuntimeDbStore(dbFile);
		store.ensureSchema();
		store.ensureAgentV2Schema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("requires confirmation for destructive reset", () => {
		expect(() => resetAgentV2RuntimeData(store, {})).toThrow("confirmation token");
		expect(() => assertAgentV2ResetConfirmation(undefined)).toThrow("confirmation token");
	});

	it("clears legacy generation data but keeps clients by default", () => {
		seedLegacyRuntimeData(store);
		seedAgentV2RuntimeData(dbFile, store);

		const result = resetAgentV2RuntimeData(store, {
			confirmation: CONFIRMATION_TOKEN,
			now: () => "2026-07-07T00:00:00.000Z",
		});

		expect(result.legacyRowsDeleted.app_preview_goal_events).toBeGreaterThan(0);
		expect(result.legacyRowsDeleted.app_preview_goals).toBeGreaterThan(0);
		expect(result.legacyRowsDeleted.run_events).toBeGreaterThan(0);
		expect(result.legacyRowsDeleted.messages).toBeGreaterThan(0);
		expect(result.legacyRowsDeleted.runs).toBeGreaterThan(0);
		expect(result.legacyRowsDeleted.sessions).toBeGreaterThan(0);
		expect(countRows(dbFile, "clients")).toBe(1);
		expect(countRows(dbFile, "sessions")).toBe(0);
		expect(countRows(dbFile, "runs")).toBe(0);
		expect(countRows(dbFile, "agent_v2_runs")).toBe(0);
		expect(readAgentV2SchemaMetadata(dbFile)).toEqual([
			{ schemaVersion: AGENT_V2_SCHEMA_VERSION, appliedAt: "2026-07-07T00:00:00.000Z" },
		]);
	});

	it("clears v2 rows and rewrites schema metadata version 1", () => {
		seedAgentV2RuntimeData(dbFile, store);

		const result = resetAgentV2RuntimeData(store, {
			confirmation: CONFIRMATION_TOKEN,
			now: () => "2026-07-07T01:02:03.000Z",
		});

		expect(result.agentV2RowsDeleted.agent_v2_diagnostics).toBeGreaterThan(0);
		expect(result.agentV2RowsDeleted.agent_v2_artifacts).toBeGreaterThan(0);
		expect(result.agentV2RowsDeleted.agent_v2_tasks).toBeGreaterThan(0);
		expect(result.agentV2RowsDeleted.agent_v2_validations).toBeGreaterThan(0);
		expect(result.agentV2RowsDeleted.agent_v2_runs).toBeGreaterThan(0);
		expect(result.agentV2RowsDeleted.agent_v2_schema_metadata).toBe(1);
		expect(result.schemaVersion).toBe(AGENT_V2_SCHEMA_VERSION);
		expect(readAgentV2SchemaMetadata(dbFile)).toEqual([
			{ schemaVersion: AGENT_V2_SCHEMA_VERSION, appliedAt: "2026-07-07T01:02:03.000Z" },
		]);
	});

	it("does not read a legacy run row as a v2 run after reset", () => {
		seedAgentV2RuntimeData(dbFile, store, { runId: "shared-run" });
		resetAgentV2RuntimeData(store, {
			confirmation: CONFIRMATION_TOKEN,
			now: () => "2026-07-07T02:00:00.000Z",
		});

		store.createSession({
			clientId: "client-a",
			sessionId: "session-after-reset",
			title: "Legacy session after reset",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
			createdAt: "2026-07-07T02:01:00.000Z",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "session-after-reset",
			runId: "shared-run",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
			createdAt: "2026-07-07T02:02:00.000Z",
		});

		expect(store.getRun("client-a", "shared-run")?.runId).toBe("shared-run");
		expect(store.getAgentV2Run("client-a", "shared-run")).toBeUndefined();
	});

	it("invokes the optional diagnostics adapter only when requested", () => {
		seedAgentV2RuntimeData(dbFile, store);

		let calls = 0;
		const adapter: AgentV2ResetDiagnosticsAdapter = {
			clearAgentV2Diagnostics() {
				calls += 1;
				return 7;
			},
		};

		const withoutDiagnostics = resetAgentV2RuntimeData(
			store,
			{
				confirmation: CONFIRMATION_TOKEN,
				now: () => "2026-07-07T03:00:00.000Z",
			},
			adapter,
		);
		expect(calls).toBe(0);
		expect(withoutDiagnostics.diagnosticsDeleted).toBeUndefined();

		const withDiagnostics = resetAgentV2RuntimeData(
			store,
			{
				confirmation: CONFIRMATION_TOKEN,
				includeDiagnostics: true,
				now: () => "2026-07-07T03:05:00.000Z",
			},
			adapter,
		);
		expect(calls).toBe(1);
		expect(withDiagnostics.diagnosticsDeleted).toBe(7);
	});

	it("deletes clients too when includeClients is true", () => {
		seedLegacyRuntimeData(store);
		seedAgentV2RuntimeData(dbFile, store);

		const result = resetAgentV2RuntimeData(store, {
			confirmation: CONFIRMATION_TOKEN,
			includeClients: true,
			now: () => "2026-07-07T04:00:00.000Z",
		});

		expect(result.legacyRowsDeleted.clients).toBe(1);
		expect(countRows(dbFile, "clients")).toBe(0);
		expect(countRows(dbFile, "sessions")).toBe(0);
		expect(readAgentV2SchemaMetadata(dbFile)).toEqual([
			{ schemaVersion: AGENT_V2_SCHEMA_VERSION, appliedAt: "2026-07-07T04:00:00.000Z" },
		]);
	});
});

function seedLegacyRuntimeData(store: RuntimeDbStore): void {
	store.createSession({
		clientId: "client-a",
		sessionId: "session-1",
		title: "Legacy session",
		model: { provider: "test", id: "legacy" },
		thinkingLevel: "medium",
		createdAt: "2026-07-07T00:00:00.000Z",
	});
	store.appendMessage({
		clientId: "client-a",
		sessionId: "session-1",
		role: "user",
		payload: { content: "hello" },
		createdAt: "2026-07-07T00:01:00.000Z",
	});
	store.createRun({
		clientId: "client-a",
		sessionId: "session-1",
		runId: "legacy-run-1",
		model: { provider: "test", id: "legacy" },
		thinkingLevel: "medium",
		createdAt: "2026-07-07T00:02:00.000Z",
	});
	store.appendRunEvent({
		clientId: "client-a",
		sessionId: "session-1",
		runId: "legacy-run-1",
		type: "agent_start",
		payload: { ok: true },
		createdAt: "2026-07-07T00:03:00.000Z",
	});
	store.upsertAppPreviewGoal({
		goalId: "goal-1",
		clientId: "client-a",
		sessionId: "session-1",
		source: "pm_handoff",
		status: "active",
		maxContinuationRuns: 4,
		continuationRunsUsed: 1,
		retryAttemptsUsed: 0,
		createdAt: "2026-07-07T00:04:00.000Z",
		updatedAt: "2026-07-07T00:04:00.000Z",
	});
	store.appendAppPreviewGoalEvent({
		goalId: "goal-1",
		clientId: "client-a",
		sessionId: "session-1",
		runId: "legacy-run-1",
		eventType: "goal_started",
		payload: { ok: true },
		createdAt: "2026-07-07T00:05:00.000Z",
	});
}

function seedAgentV2RuntimeData(
	dbFile: string,
	store: RuntimeDbStore,
	options: { runId?: string } = {},
): void {
	const runId = options.runId ?? "agent-v2-run-1";
	store.createAgentV2Run({
		clientId: "client-a",
		runId,
		input: { prompt: "build a dashboard" },
		model: { provider: "test", model: "local" },
		createdAt: "2026-07-07T00:10:00.000Z",
	});
	store.upsertAgentV2Task({
		clientId: "client-a",
		runId,
		taskId: "task-1",
		kind: "implementation",
		title: "Implement reset",
		status: "running",
		dependsOn: [],
		input: { files: ["src/reset.ts"] },
		output: {},
		createdAt: "2026-07-07T00:11:00.000Z",
		updatedAt: "2026-07-07T00:12:00.000Z",
	});
	store.upsertAgentV2Artifact({
		clientId: "client-a",
		runId,
		artifactId: "artifact-1",
		kind: "file",
		path: "src/reset.ts",
		mediaType: "text/typescript",
		checksum: "sha256:artifact-1",
		version: "v1",
		validationStatus: "accepted",
		metadataJson: { language: "ts" },
		createdAt: "2026-07-07T00:13:00.000Z",
		updatedAt: "2026-07-07T00:13:00.000Z",
	});
	store.appendAgentV2Diagnostic({
		diagnosticId: "diag-1",
		clientId: "client-a",
		runId,
		severity: "warn",
		category: "task_graph",
		code: "dependency_wait",
		message: "Waiting on dependency",
		data: { blockedBy: ["task-0"] },
		createdAt: "2026-07-07T00:14:00.000Z",
	});

	const db = new DatabaseSync(dbFile);
	try {
		db.prepare(
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
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"client-a",
			runId,
			"validation-1",
			"task-1",
			"artifact-1",
			"accepted",
			"Looks good",
			JSON.stringify({ ok: true }),
			"2026-07-07T00:15:00.000Z",
			"2026-07-07T00:15:00.000Z",
		);
	} finally {
		db.close();
	}
}

function countRows(dbFile: string, table: string): number {
	const db = new DatabaseSync(dbFile);
	try {
		const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
		return Number(row.count);
	} finally {
		db.close();
	}
}

function readAgentV2SchemaMetadata(dbFile: string): Array<{ schemaVersion: number; appliedAt: string }> {
	const db = new DatabaseSync(dbFile);
	try {
		return (
			db.prepare(
				"SELECT schema_version AS schemaVersion, applied_at AS appliedAt FROM agent_v2_schema_metadata ORDER BY schema_version ASC",
			).all() as Array<{ schemaVersion: number; appliedAt: string }>
		).map((row) => ({
			schemaVersion: Number(row.schemaVersion),
			appliedAt: row.appliedAt,
		}));
	} finally {
		db.close();
	}
}
