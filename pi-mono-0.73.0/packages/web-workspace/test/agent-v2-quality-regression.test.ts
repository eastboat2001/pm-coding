import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { createAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
import { createAgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import { AGENT_V2_RESET_CONFIRMATION, resetAgentV2Runtime } from "../src/agent-v2-maintenance.js";
import { InMemoryRunQueue } from "../src/run-queue.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("agent v2 quality regression", () => {
	afterEach(async () => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("keeps v2 runtime state isolated from legacy rows across reset and id collisions", async () => {
		const { root, store, dbFile } = createSqliteStore();
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const events = new RecordingEventLog();
		const service = new AgentV2RunApiService({
			store,
			queue,
			events,
			createRunId: () => "shared-run",
		});
		seedLegacyRuntime(store, "shared-run");

		await service.startRun("client-a", {
			runId: "shared-run",
			input: { prompt: "Build the dashboard", sessionId: "agent-v2-session", title: "Dashboard" },
			model: { provider: "test", id: "local" },
			createdAt: "2026-07-09T09:00:00.000Z",
		});
		await store.updateAgentV2Run({
			clientId: "client-a",
			runId: "shared-run",
			status: "running",
			phase: "implementation",
			workerId: "worker-a",
			startedAt: "2026-07-09T09:00:10.000Z",
			updatedAt: "2026-07-09T09:00:10.000Z",
		});
		await store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "shared-run",
			taskId: "plan",
			kind: "plan",
			title: "Write plan",
			status: "succeeded",
			dependsOn: [],
			acceptanceCriteria: ["Plan is explicit"],
			input: { documentId: "plan-doc" },
			output: { summary: "done" },
			createdAt: "2026-07-09T09:00:11.000Z",
			updatedAt: "2026-07-09T09:00:12.000Z",
		});
		await store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "shared-run",
			taskId: "implement",
			parentTaskId: "plan",
			kind: "implementation",
			title: "Implement dashboard",
			status: "running",
			dependsOn: ["plan"],
			acceptanceCriteria: ["Files build cleanly"],
			input: { files: ["src/dashboard.tsx"] },
			output: {},
			createdAt: "2026-07-09T09:00:13.000Z",
			updatedAt: "2026-07-09T09:00:14.000Z",
			startedAt: "2026-07-09T09:00:14.000Z",
		});
		await store.upsertAgentV2Artifact({
			clientId: "client-a",
			runId: "shared-run",
			artifactId: "artifact-dashboard",
			kind: "file",
			path: "src/dashboard.tsx",
			mediaType: "text/typescript",
			checksum: "sha256:dashboard",
			version: "v1",
			sourceTaskId: "implement",
			validationStatus: "accepted",
			metadataJson: { language: "ts" },
			createdAt: "2026-07-09T09:00:15.000Z",
			updatedAt: "2026-07-09T09:00:15.000Z",
		});
		await store.upsertAgentV2Validation({
			clientId: "client-a",
			runId: "shared-run",
			validationId: "validation-dashboard",
			taskId: "implement",
			artifactId: "artifact-dashboard",
			status: "passed",
			summary: "Dashboard compiles",
			details: { command: "npm run build" },
			createdAt: "2026-07-09T09:00:16.000Z",
			updatedAt: "2026-07-09T09:00:16.000Z",
		});
		await store.appendAgentV2Diagnostic(
			createAgentV2DiagnosticEvent({
				diagnosticId: "diag-dashboard",
				clientId: "client-a",
				runId: "shared-run",
				severity: "warn",
				category: "task_graph",
				code: "waiting_on_plan",
				phase: "implementation",
				taskId: "implement",
				message: "Task graph waits on its parent task edge.",
				data: { blockedBy: ["plan"] },
				createdAt: "2026-07-09T09:00:17.000Z",
			}),
		);
		await store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "shared-run",
			type: "agent_v2.task_updated",
			payload: { taskId: "implement", status: "running" },
			createdAt: "2026-07-09T09:00:18.000Z",
		});

		expect(store.getRun("client-a", "shared-run")).toMatchObject({
			clientId: "client-a",
			runId: "shared-run",
			status: "queued",
		});
		expect(store.getAgentV2Run("client-a", "shared-run")).toMatchObject({
			clientId: "client-a",
			runId: "shared-run",
			status: "running",
			phase: "implementation",
			workerId: "worker-a",
		});
		expect((await store.listAgentV2Tasks("client-a", "shared-run")).map((task) => [task.taskId, task.dependsOn])).toEqual([
			["plan", []],
			["implement", ["plan"]],
		]);
		expect(await store.listAgentV2Artifacts("client-a", "shared-run")).toEqual([
			expect.objectContaining({
				artifactId: "artifact-dashboard",
				path: "src/dashboard.tsx",
				sourceTaskId: "implement",
			}),
		]);
		expect(await store.listAgentV2Validations("client-a", "shared-run")).toEqual([
			expect.objectContaining({
				validationId: "validation-dashboard",
				taskId: "implement",
				artifactId: "artifact-dashboard",
				status: "passed",
			}),
		]);
		expect(await store.listAgentV2Diagnostics("client-a", "shared-run")).toEqual([
			expect.objectContaining({
				diagnosticId: "diag-dashboard",
				category: "task_graph",
				code: "waiting_on_plan",
			}),
		]);
		expect(await store.listAgentV2RunEvents("client-a", "shared-run", 0)).toEqual([
			expect.objectContaining({
				type: "agent_v2.task_updated",
				payload: { taskId: "implement", status: "running" },
			}),
		]);
		expect(events.appendCalls).toEqual([
			expect.objectContaining({
				type: "agent_v2.run_created",
				payload: expect.objectContaining({ status: "queued", phase: "intake" }),
			}),
		]);
		expect(countRows(dbFile, "runs")).toBe(1);
		expect(countRows(dbFile, "run_events")).toBe(1);
		expect(countRows(dbFile, "app_preview_goals")).toBe(1);
		expect(countRows(dbFile, "agent_v2_runs")).toBe(1);
		expect(countRows(dbFile, "agent_v2_tasks")).toBe(2);
		expect(countRows(dbFile, "agent_v2_artifacts")).toBe(1);
		expect(countRows(dbFile, "agent_v2_validations")).toBe(1);
		expect(countRows(dbFile, "agent_v2_diagnostics")).toBe(1);
		expect(countRows(dbFile, "agent_v2_run_events")).toBe(1);

		const eventBus = {
			purge: vi.fn(async () => ({ streamsDeleted: 3 })),
		};
		const diagnostics = {
			clearAgentV2Diagnostics: vi.fn(async () => 1),
		};
		const resetResult = await resetAgentV2Runtime({
			store,
			queue,
			eventBus,
			diagnostics,
			clientsRootDir: join(root, "clients"),
			confirmation: AGENT_V2_RESET_CONFIRMATION,
			includeQueue: true,
			includeLiveEvents: true,
			includeDiagnostics: true,
		});

		expect(resetResult.queue).toEqual({ queueItemsDeleted: 1, activeClaimsDeleted: 0, cancelKeysDeleted: 0 });
		expect(resetResult.liveEvents).toEqual({ streamsDeleted: 3 });
		expect(resetResult.diagnosticsDeleted).toBe(1);
		expect(eventBus.purge).toHaveBeenCalledTimes(1);
		expect(diagnostics.clearAgentV2Diagnostics).toHaveBeenCalledTimes(1);
		expect(countRows(dbFile, "sessions")).toBe(0);
		expect(countRows(dbFile, "runs")).toBe(0);
		expect(countRows(dbFile, "agent_v2_runs")).toBe(0);
		expect(countRows(dbFile, "agent_v2_tasks")).toBe(0);
		expect(countRows(dbFile, "agent_v2_artifacts")).toBe(0);
		expect(countRows(dbFile, "agent_v2_validations")).toBe(0);
		expect(countRows(dbFile, "agent_v2_run_events")).toBe(0);

		seedLegacyRuntime(store, "shared-run");

		expect(store.getRun("client-a", "shared-run")).toMatchObject({
			clientId: "client-a",
			runId: "shared-run",
			status: "queued",
		});
		expect(store.getAgentV2Run("client-a", "shared-run")).toBeUndefined();
		expect(await store.listAgentV2Tasks("client-a", "shared-run")).toEqual([]);
		expect(await store.listAgentV2Artifacts("client-a", "shared-run")).toEqual([]);
		expect(await store.listAgentV2Validations("client-a", "shared-run")).toEqual([]);
		expect(await store.listAgentV2Diagnostics("client-a", "shared-run")).toEqual([]);
		expect(await store.listAgentV2RunEvents("client-a", "shared-run", 0)).toEqual([]);
		expect(await store.listRunEvents("client-a", "shared-run", 0)).toEqual([
			expect.objectContaining({
				runId: "shared-run",
				type: "agent_start",
			}),
		]);
	});

	it("records the current schema-only Agent v2 initialization limitation without forcing production changes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-schema-only-"));
		const dbFile = join(root, "runtime.sqlite");
		const store = new RuntimeDbStore(dbFile);
		cleanupRoots.push(root);
		cleanupStores.push(store);

		store.ensureAgentV2Schema();

		expect(tableExists(dbFile, "agent_v2_runs")).toBe(true);
		expect(tableExists(dbFile, "agent_v2_schema_metadata")).toBe(true);
		expect(tableExists(dbFile, "clients")).toBe(false);
		expect(() =>
			store.createAgentV2Run({
				clientId: "client-a",
				runId: "schema-only-run",
				input: { prompt: "schema only" },
				model: { provider: "test" },
				createdAt: "2026-07-09T09:30:00.000Z",
			}),
		).toThrow(/no such table: clients/i);
	});

	it("rejects runtime-switch strategy wording in product docs and records the reset procedure", () => {
		const envFiles = [
			join(repoRoot, "apps", "pi-coding-web", ".env.example"),
			join(repoRoot, "docker", "pi-coding-web", ".env.example"),
		];
		const docs = [
			join(repoRoot, "docs", "superpowers", "specs", "2026-07-08-application-generation-agent-v2-phase3-design.md"),
			join(repoRoot, "docs", "superpowers", "specs", "2026-07-08-application-generation-agent-v2-phase4-design.md"),
		];
		const sourceFiles = [
			join(repoRoot, "apps", "pi-coding-web", "src", "agent-v2", "runtime-entry.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "worker", "main.ts"),
			join(repoRoot, "packages", "web-workspace", "src", "vite-plugin.ts"),
		];

		for (const file of envFiles) {
			expect(readFileSync(file, "utf8"), file).not.toContain("PI_APP_AGENT_VERSION");
		}
		const forbiddenDocPatterns = [
			/PI_APP_AGENT_VERSION/i,
			/short-term.+(switch|flag)/i,
			/runtime.+(switch|flag)/i,
			/version.+switch/i,
			/dev-switch/i,
			/开发开关/,
			/调试开关/,
			/旧 v1 入口默认禁用/,
		];
		for (const file of docs) {
			const source = readFileSync(file, "utf8");
			for (const pattern of forbiddenDocPatterns) {
				expect(source, `${file} must not contain ${String(pattern)}`).not.toMatch(pattern);
			}
		}
		for (const file of sourceFiles) {
			expect(readFileSync(file, "utf8"), file).not.toContain("PI_APP_AGENT_VERSION");
		}

		const combinedDocs = docs.map((file) => readFileSync(file, "utf8")).join("\n");
		for (const line of [
			"1. Stop v2 workers.",
			"2. Run the Agent v2 reset maintenance operation with confirmation token application-generation-agent-v2.",
			"3. Start v2 workers.",
			"4. Verify /api/agent-v2/runs/start and event replay.",
			"Rollback: redeploy the previous code version and restore from backup if required.",
		]) {
			expect(combinedDocs).toContain(line);
		}
	});
});

function createSqliteStore(): { root: string; store: RuntimeDbStore; dbFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-quality-regression-"));
	const dbFile = join(root, "runtime.sqlite");
	const store = new RuntimeDbStore(dbFile);
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return { root, store, dbFile };
}

function seedLegacyRuntime(store: RuntimeDbStore, runId: string): void {
	store.createSession({
		clientId: "client-a",
		sessionId: `legacy-session-${runId}`,
		title: "Legacy runtime session",
		model: { provider: "test", id: "legacy" },
		thinkingLevel: "medium",
		createdAt: "2026-07-09T08:00:00.000Z",
	});
	store.appendMessage({
		clientId: "client-a",
		sessionId: `legacy-session-${runId}`,
		role: "user",
		payload: { content: "legacy hello" },
		createdAt: "2026-07-09T08:00:01.000Z",
	});
	store.createRun({
		clientId: "client-a",
		sessionId: `legacy-session-${runId}`,
		runId,
		model: { provider: "test", id: "legacy" },
		thinkingLevel: "medium",
		createdAt: "2026-07-09T08:00:02.000Z",
	});
	store.appendRunEvent({
		clientId: "client-a",
		sessionId: `legacy-session-${runId}`,
		runId,
		type: "agent_start",
		payload: { ok: true },
		createdAt: "2026-07-09T08:00:03.000Z",
	});
	store.upsertAppPreviewGoal({
		goalId: `goal-${runId}`,
		clientId: "client-a",
		sessionId: `legacy-session-${runId}`,
		source: "pm_handoff",
		status: "active",
		maxContinuationRuns: 4,
		continuationRunsUsed: 1,
		retryAttemptsUsed: 0,
		lastRunId: runId,
		createdAt: "2026-07-09T08:00:04.000Z",
		updatedAt: "2026-07-09T08:00:04.000Z",
	});
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

function tableExists(dbFile: string, table: string): boolean {
	const db = new DatabaseSync(dbFile);
	try {
		const row = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
			.get(table) as { present?: number } | undefined;
		return row?.present === 1;
	} finally {
		db.close();
	}
}

class RecordingEventLog {
	readonly appendCalls: AgentV2RunEventRecord[] = [];

	async append(input: {
		clientId: string;
		runId: string;
		seq?: number;
		type: string;
		payload: Record<string, unknown>;
		createdAt?: string;
	}): Promise<AgentV2RunEventRecord> {
		const event = {
			clientId: input.clientId,
			runId: input.runId,
			seq: input.seq ?? this.appendCalls.length + 1,
			type: input.type,
			payload: input.payload,
			createdAt: input.createdAt ?? "2026-07-09T00:00:00.000Z",
		} satisfies AgentV2RunEventRecord;
		this.appendCalls.push(event);
		return event;
	}

	async list(): Promise<AgentV2RunEventRecord[]> {
		return [];
	}
}
