import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeDbStore } from "../src/runtime-db.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];
const runtimeDbModulePath = "../src/runtime-db.ts";
let RuntimeDbStoreCtor: typeof import("../src/runtime-db.js").RuntimeDbStore;

describe("agent v2 run event store", () => {
	beforeAll(async () => {
		({ RuntimeDbStore: RuntimeDbStoreCtor } = await import(runtimeDbModulePath));
	});

	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("appends and lists v2 run events by sequence", () => {
		const { store } = createStore();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "Build the run event store" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});

		const first = store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-a",
			type: "run_started",
			payload: { phase: "planning" },
			createdAt: "2026-07-08T00:01:00.000Z",
		});
		const second = store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-a",
			type: "task_completed",
			payload: { taskId: "task-1" },
			createdAt: "2026-07-08T00:02:00.000Z",
		});

		expect(first).toEqual({
			clientId: "client-a",
			runId: "run-a",
			seq: 1,
			type: "run_started",
			payload: { phase: "planning" },
			createdAt: "2026-07-08T00:01:00.000Z",
		});
		expect(second).toEqual({
			clientId: "client-a",
			runId: "run-a",
			seq: 2,
			type: "task_completed",
			payload: { taskId: "task-1" },
			createdAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2RunEvents("client-a", "run-a", 0)).toEqual([first, second]);
		expect(store.listAgentV2RunEvents("client-a", "run-a", 1)).toEqual([second]);
	});

	it("removes v2 run events on reset without reading legacy run_events", () => {
		const { dbFile, store } = createStore();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "shared-run",
			input: { prompt: "Reset the v2 event store" },
			model: { provider: "test" },
			createdAt: "2026-07-08T01:00:00.000Z",
		});
		store.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "shared-run",
			type: "run_started",
			payload: { phase: "planning" },
			createdAt: "2026-07-08T01:01:00.000Z",
		});

		expect(countRows(dbFile, "agent_v2_run_events")).toBe(1);

		const result = store.resetAgentV2RuntimeData({
			now: () => "2026-07-08T01:02:00.000Z",
		});

		store.createSession({
			clientId: "client-a",
			sessionId: "legacy-session",
			title: "Legacy session",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
			createdAt: "2026-07-08T01:03:00.000Z",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "legacy-session",
			runId: "shared-run",
			model: { provider: "test", id: "legacy" },
			thinkingLevel: "medium",
			createdAt: "2026-07-08T01:04:00.000Z",
		});
		store.appendRunEvent({
			clientId: "client-a",
			sessionId: "legacy-session",
			runId: "shared-run",
			type: "agent_start",
			payload: { legacy: true },
			createdAt: "2026-07-08T01:05:00.000Z",
		});

		expect(result.agentV2RowsDeleted.agent_v2_run_events).toBe(1);
		expect(countRows(dbFile, "agent_v2_run_events")).toBe(0);
		expect(store.listAgentV2RunEvents("client-a", "shared-run", 0)).toEqual([]);
	});
});

function createStore(): { dbFile: string; store: RuntimeDbStore } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-run-event-store-"));
	const dbFile = join(root, "runtime.sqlite");
	const store = new RuntimeDbStoreCtor(dbFile);
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return { dbFile, store };
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
