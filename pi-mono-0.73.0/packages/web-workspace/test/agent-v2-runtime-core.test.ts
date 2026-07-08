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
		expect(snapshot.tasks.map((task) => task.taskId)).toEqual(["capability", "spec", "plan", "implement", "validate", "deliver"]);
		expect(snapshot.documents.map((document) => document.documentId)).toEqual(["capability_decision", "spec", "plan", "tasks"]);
		expect(snapshot.artifacts.map((artifact) => artifact.artifactId)).toEqual(["capability_decision", "spec", "plan", "tasks"]);
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

	it("records a v2 diagnostic and throws when the run does not exist", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "missing-run",
			input: { prompt: "placeholder" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});

		await expect(
			loadAgentV2RuntimeSnapshot({
				store: forbidLegacyRuntimeReads(store, { hideAgentV2Run: true }),
				clientId: "client-a",
				runId: "missing-run",
			}),
		).rejects.toThrow("Agent v2 run not found: client-a/missing-run");
		expect(store.listAgentV2Diagnostics("client-a", "missing-run")).toEqual([
			expect.objectContaining({
				category: "task_graph",
				code: "agent_v2.run_not_found",
				severity: "error",
			}),
		]);
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
	options: { hideAgentV2Run?: boolean } = {},
): RuntimeStore {
	return new Proxy(store, {
		get(target, property, receiver) {
			if (options.hideAgentV2Run && property === "getAgentV2Run") {
				return () => undefined;
			}
			if (
				property === "getRun" ||
				property === "getRunById" ||
				property === "listRuns" ||
				property === "listRunsForSession" ||
				property === "listMessages" ||
				property === "iterateMessages" ||
				property === "getAppPreviewGoal" ||
				property === "listAppPreviewGoalEvents"
			) {
				return () => {
					throw new Error(`legacy runtime read is forbidden in agent v2 runtime core: ${String(property)}`);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeStore;
}
