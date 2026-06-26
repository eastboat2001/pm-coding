import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeDbStore } from "../src/runtime-db.js";

describe("RuntimeDbStore", () => {
	let dir: string;
	let store: RuntimeDbStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-runtime-db-"));
		store = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		store.ensureSchema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("isolates sessions by client id", () => {
		store.upsertClient("client-a");
		store.upsertClient("client-b");

		const session = store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Client A session",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "medium",
		});

		expect(session.clientId).toBe("client-a");
		expect(store.listSessions("client-a")).toHaveLength(1);
		expect(store.getSession("client-a", "session-1")?.sessionId).toBe("session-1");
		expect(store.listSessions("client-b")).toEqual([]);
		expect(store.getSession("client-b", "session-1")).toBeUndefined();
	});

	it("stores messages, runs, and run events in order", () => {
		store.upsertClient("client-a");
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Client A session",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		store.appendMessage({
			clientId: "client-a",
			sessionId: "session-1",
			role: "user",
			payload: { content: "hello" },
		});
		const run = store.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		const updatedRun = store.updateRunStatus("run-1", "client-a", "running", {
			workerId: "worker-1",
			startedAt: "2026-06-08T00:00:00.000Z",
		});
		store.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message.delta",
			payload: { text: "hello" },
		});

		expect(run.status).toBe("queued");
		expect(updatedRun.status).toBe("running");
		expect(updatedRun.workerId).toBe("worker-1");
		expect(store.getSession("client-a", "session-1")?.lastRunId).toBe("run-1");
		expect(store.getSession("client-a", "session-1")?.lastRunStatus).toBe("running");
		expect(store.listMessages("client-a", "session-1")).toHaveLength(1);
		expect(store.listRunEvents("client-a", "run-1", 0)[0]?.seq).toBe(1);
		expect(store.listRunEvents("client-a", "run-1", 0)[0]?.type).toBe("message.delta");
		expect(store.listRunEvents("client-a", "run-1", 1)).toEqual([]);
	});

	it("updates run and session timestamps when appending run events", () => {
		store.upsertClient("client-a");
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Streaming session",
			model: {},
			thinkingLevel: "medium",
			createdAt: "2026-06-23T00:00:00.000Z",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			model: {},
			thinkingLevel: "medium",
			createdAt: "2026-06-23T00:00:00.000Z",
		});
		store.updateRunStatus("run-1", "client-a", "running", {
			workerId: "worker-1",
			updatedAt: "2026-06-23T00:00:00.000Z",
		});

		store.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message_update",
			payload: { content: "still streaming" },
			createdAt: "2026-06-23T00:45:00.000Z",
		});

		expect(store.getRun("client-a", "run-1")?.updatedAt).toBe("2026-06-23T00:45:00.000Z");
		expect(store.getSession("client-a", "session-1")?.updatedAt).toBe("2026-06-23T00:45:00.000Z");
		expect(store.getSession("client-a", "session-1")?.lastRunStatus).toBe("running");
	});

	it("rejects run events with a mismatched session id", () => {
		store.upsertClient("client-a");
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "First session",
			model: {},
			thinkingLevel: "off",
		});
		store.createSession({
			clientId: "client-a",
			sessionId: "session-2",
			title: "Second session",
			model: {},
			thinkingLevel: "off",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			model: {},
			thinkingLevel: "off",
		});

		expect(() =>
			store.appendRunEvent({
				clientId: "client-a",
				sessionId: "session-2",
				runId: "run-1",
				type: "agent_start",
				payload: { type: "agent_start" },
			}),
		).toThrow("Run event session does not match run session");
		expect(store.listRunEvents("client-a", "run-1", 0)).toEqual([]);
	});

	it("stores app preview goals and events by client and session", () => {
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Preview App",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		const goal = store.upsertAppPreviewGoal({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			status: "active",
			maxContinuationRuns: 8,
			continuationRunsUsed: 0,
			retryAttemptsUsed: 0,
		});

		expect(goal.goalId).toBe("goal-1");
		expect(goal.status).toBe("active");
		expect(goal.maxContinuationRuns).toBe(8);
		expect(store.getAppPreviewGoal("client-a", "session-1")?.source).toBe("pm_handoff");
		expect(store.getAppPreviewGoal("client-b", "session-1")).toBeUndefined();

		const updated = store.updateAppPreviewGoal({
			clientId: "client-a",
			sessionId: "session-1",
			status: "preview_ready",
			lastRunId: "run-1",
			lastPreviewUrl: "http://localhost:5173/preview/project-client-a-session-/",
			completedAt: "2026-06-16T00:00:00.000Z",
		});

		expect(updated?.status).toBe("preview_ready");
		expect(updated?.lastRunId).toBe("run-1");
		expect(updated?.lastPreviewUrl).toContain("/preview/");
		expect(updated?.completedAt).toBe("2026-06-16T00:00:00.000Z");

		const event = store.appendAppPreviewGoalEvent({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			eventType: "preview_ready",
			reasonCode: "ready",
			payload: { previewUrl: updated?.lastPreviewUrl },
		});

		expect(event.eventId).toBeGreaterThan(0);
		expect(event.eventType).toBe("preview_ready");
		expect(store.listAppPreviewGoalEvents("client-a", "session-1", 0)).toHaveLength(1);
		expect(store.listAppPreviewGoalEvents("client-a", "session-1", event.eventId)).toEqual([]);
	});

	it("only tolerates corrupt JSON for app preview goal event payloads", () => {
		const dbFile = join(dir, "runtime.sqlite");
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Preview App",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		store.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		store.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message.delta",
			payload: { text: "hello" },
		});
		store.upsertAppPreviewGoal({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			status: "active",
			maxContinuationRuns: 8,
			continuationRunsUsed: 0,
			retryAttemptsUsed: 0,
		});
		store.appendAppPreviewGoalEvent({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			eventType: "preview_check_failed",
			payload: { error: "broken" },
		});
		store.close();

		const db = new DatabaseSync(dbFile);
		try {
			db.prepare("UPDATE run_events SET payload_json = ? WHERE client_id = ? AND run_id = ?").run(
				"{",
				"client-a",
				"run-1",
			);
			db.prepare("UPDATE app_preview_goal_events SET payload_json = ? WHERE client_id = ? AND session_id = ?").run(
				"{",
				"client-a",
				"session-1",
			);
		} finally {
			db.close();
		}
		store = new RuntimeDbStore(dbFile);

		expect(() => store.listRunEvents("client-a", "run-1", 0)).toThrow(SyntaxError);
		expect(store.listAppPreviewGoalEvents("client-a", "session-1", 0)[0]?.payload).toEqual({});
	});

	it("clears optional app preview goal patch fields when null is passed", () => {
		store.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Preview App",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		store.upsertAppPreviewGoal({
			goalId: "goal-1",
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			status: "active",
			maxContinuationRuns: 8,
			continuationRunsUsed: 0,
			retryAttemptsUsed: 0,
		});
		store.updateAppPreviewGoal({
			clientId: "client-a",
			sessionId: "session-1",
			status: "preview_ready",
			lastRunId: "run-1",
			lastPreviewUrl: "http://localhost:5173/preview/project-client-a-session-/",
			lastFailureReason: "previous failure",
			completedAt: "2026-06-16T00:00:00.000Z",
		});

		const updated = store.updateAppPreviewGoal({
			clientId: "client-a",
			sessionId: "session-1",
			status: "active",
			lastRunId: null,
			lastPreviewUrl: null,
			lastFailureReason: null,
			completedAt: null,
		});
		const persisted = store.getAppPreviewGoal("client-a", "session-1");

		expect(updated?.status).toBe("active");
		expect(updated?.lastRunId).toBeUndefined();
		expect(updated?.lastPreviewUrl).toBeUndefined();
		expect(updated?.lastFailureReason).toBeUndefined();
		expect(updated?.completedAt).toBeUndefined();
		expect(persisted?.status).toBe("active");
		expect(persisted?.lastRunId).toBeUndefined();
		expect(persisted?.lastPreviewUrl).toBeUndefined();
		expect(persisted?.lastFailureReason).toBeUndefined();
		expect(persisted?.completedAt).toBeUndefined();
	});
});
