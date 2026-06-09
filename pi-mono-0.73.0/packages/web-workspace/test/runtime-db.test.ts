import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
