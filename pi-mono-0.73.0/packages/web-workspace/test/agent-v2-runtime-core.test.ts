import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "../src/agent-v2-runtime-core.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeStore } from "../src/runtime-store.js";

describe("agent v2 runtime core", () => {
	const cleanupRoots: string[] = [];
	const cleanupStores: RuntimeDbStore[] = [];

	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("loads a runtime snapshot from v2 records and context only", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-runtime",
			input: { prompt: "Build a static planning board" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		await persistAgentV2PlanningBootstrap(
			store,
			buildAgentV2PlanningBootstrap({
				run,
				now: () => "2026-07-08T00:01:00.000Z",
			}),
		);

		const snapshot = await loadAgentV2RuntimeSnapshot({
			store: forbidLegacyRuntimeReads(store),
			clientId: "client-a",
			runId: "run-v2-runtime",
		});

		expect(snapshot.run.runId).toBe("run-v2-runtime");
		expect(snapshot.tasks.map((task) => task.taskId)).toEqual([
			"capability",
			"spec",
			"plan",
			"implement",
			"validate",
			"deliver",
		]);
		expect(snapshot.documents.map((document) => document.documentId)).toEqual([
			"capability_decision",
			"spec",
			"plan",
			"tasks",
		]);
		expect(snapshot.artifacts.map((artifact) => artifact.artifactId)).toEqual([
			"capability_decision",
			"spec",
			"plan",
			"tasks",
		]);
		expect(snapshot.contextPacket.taskSelection.reason).toBe("ready");
		expect(snapshot.contextPacket.markdown).toContain("# Agent v2 Context Packet");
	});

	it("persists task transitions through v2 task storage and appends a v2 diagnostic", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-transition",
			input: { prompt: "Build a static app" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-v2-transition",
			taskId: "implement",
			kind: "implementation",
			title: "Implement app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const updated = await advanceAgentV2Task({
			store: forbidLegacyRuntimeReads(store),
			clientId: "client-a",
			runId: "run-v2-transition",
			taskId: "implement",
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(updated).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Tasks("client-a", "run-v2-transition")[0]).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-transition")).toEqual([
			expect.objectContaining({
				category: "task_graph",
				code: "agent_v2.task_transitioned",
				taskId: "implement",
				severity: "info",
			}),
		]);
	});

	it("keeps the task mutation when diagnostic append fails", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			input: { prompt: "Build a static app" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			taskId: "implement",
			kind: "implementation",
			title: "Implement app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const updated = await advanceAgentV2Task({
			store: forbidLegacyRuntimeReads(store, { failAgentV2DiagnosticWrites: true }),
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			taskId: "implement",
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(updated).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Tasks("client-a", "run-v2-diagnostic-failure")[0]).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-diagnostic-failure")).toEqual([]);
	});

	it("throws a clear run-not-found error without persisting a diagnostic", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);

		await expect(
			advanceAgentV2Task({
				store: forbidLegacyRuntimeReads(store),
				clientId: "client-a",
				runId: "missing-run",
				taskId: "implement",
				status: "running",
				now: "2026-07-08T00:02:00.000Z",
			}),
		).rejects.toThrow("Agent v2 run not found: client-a/missing-run");
		expect(store.listAgentV2Diagnostics("client-a", "missing-run")).toEqual([]);
	});
});

function createTempRuntimeDbStoreWithV2Schema(cleanupRoots: string[], cleanupStores: RuntimeDbStore[]): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-runtime-core-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}

function forbidLegacyRuntimeReads(
	store: RuntimeDbStore,
	options: { failAgentV2DiagnosticWrites?: boolean } = {},
): RuntimeStore {
	const legacyReadMethods = new Set([
		"getSession",
		"listSessions",
		"updateSessionTitle",
		"appendMessage",
		"listMessages",
		"iterateMessages",
		"getRun",
		"getRunById",
		"listRuns",
		"listRunsForSession",
		"listRunsByStatus",
		"listRunningRunsByWorker",
		"createRun",
		"createContinuationRun",
		"createRunWithMessage",
		"updateRunStatus",
		"appendRunEvent",
		"listRunEvents",
		"iterateRunEvents",
		"getLatestRunCheckpoint",
		"getSessionMessageStats",
		"upsertAppPreviewGoal",
		"getAppPreviewGoal",
		"updateAppPreviewGoal",
		"appendAppPreviewGoalEvent",
		"listAppPreviewGoalEvents",
	]);
	return new Proxy(store, {
		get(target, property, receiver) {
			if (typeof property !== "string") {
				return Reflect.get(target, property, receiver);
			}
			if (legacyReadMethods.has(property)) {
				throw new Error(`legacy runtime read is forbidden in agent v2 runtime core: ${property}`);
			}
			if (options.failAgentV2DiagnosticWrites && property === "appendAgentV2Diagnostic") {
				return () => {
					throw new Error("diagnostic write failed");
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeStore;
}
