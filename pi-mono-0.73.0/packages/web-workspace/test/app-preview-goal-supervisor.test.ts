import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPreviewGoalService } from "../src/app-preview-goal-service.js";
import { AppPreviewGoalSupervisor } from "../src/app-preview-goal-supervisor.js";
import type { PreviewReadinessResult } from "../src/preview-readiness-checker.js";
import type { RunQueueItem } from "../src/run-queue.js";
import { InMemoryRunQueue } from "../src/run-queue.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeRunRecord } from "../src/types.js";

describe("AppPreviewGoalSupervisor", () => {
	let dir: string;
	let db: RuntimeDbStore;
	let goals: AppPreviewGoalService;
	let queue: InMemoryRunQueue;
	let readinessResult: PreviewReadinessResult;
	let supervisor: AppPreviewGoalSupervisor;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-app-preview-goal-supervisor-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		goals = new AppPreviewGoalService(db);
		queue = new InMemoryRunQueue();
		readinessResult = { ready: false, reasonCode: "index_html_missing" };
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: { check: async () => readinessResult },
			createRunId: () => "continuation-1",
		});
	});

	afterEach(async () => {
		await queue.close();
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("marks the goal preview_ready when readiness succeeds", async () => {
		readinessResult = {
			ready: true,
			reasonCode: "ready",
			projectId: "project-client-a-session-1",
			previewUrl: "http://localhost:5173/preview/project-client-a-session-1/",
			status: "running",
		};
		const terminalRun = createTerminalRun("run-1");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const events = goals.events("client-a", "session-1", 0);
		expect(goal?.status).toBe("preview_ready");
		expect(goal?.lastRunId).toBe("run-1");
		expect(goal?.lastPreviewUrl).toBe("http://localhost:5173/preview/project-client-a-session-1/");
		expect(goal?.completedAt).toBeDefined();
		expect(events.at(-1)?.eventType).toBe("preview_ready");
		expect(events.at(-1)?.reasonCode).toBe("ready");
	});

	it("schedules and enqueues a continuation when readiness fails and budget remains", async () => {
		readinessResult = {
			ready: false,
			reasonCode: "html_no_basic_content",
			previewUrl: "http://localhost:5173/preview/project-client-a-session-1/",
			detail: "empty body",
		};
		const terminalRun = createTerminalRun("run-1");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const continuation = db.getRun("client-a", "continuation-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(goal?.status).toBe("active");
		expect(goal?.continuationRunsUsed).toBe(1);
		expect(goal?.lastRunId).toBe("continuation-1");
		expect(goal?.lastFailureReason).toBe("html_no_basic_content");
		expect(continuation?.model).toEqual(terminalRun.model);
		expect(continuation?.thinkingLevel).toBe(terminalRun.thinkingLevel);
		expect(claimed).toEqual({ clientId: "client-a", runId: "continuation-1" });
		expect(events.map((event) => event.eventType)).toContain("preview_check_failed");
		expect(events.map((event) => event.eventType)).toContain("continuation_scheduled");
	});

	it("checks readiness and schedules a continuation after a failed run with recoverable preview output", async () => {
		readinessResult = {
			ready: false,
			reasonCode: "preview_url_missing",
			projectId: "project-client-a-session-1",
			status: "failed",
		};
		const terminalRun = createTerminalRun("run-1", "failed", "Connection error.");
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message_end",
			payload: { type: "message_end", message: { role: "assistant", content: "Created project files." } },
		});
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const continuation = db.getRun("client-a", "continuation-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(goal?.status).toBe("active");
		expect(goal?.continuationRunsUsed).toBe(1);
		expect(goal?.lastRunId).toBe("continuation-1");
		expect(goal?.lastFailureReason).toBe("preview_url_missing");
		expect(continuation?.status).toBe("queued");
		expect(claimed).toEqual({ clientId: "client-a", runId: "continuation-1" });
		expect(events.map((event) => event.eventType)).toContain("preview_check_failed");
		expect(events.map((event) => event.eventType)).toContain("continuation_scheduled");
	});

	it("blocks without spending continuation budget after a transient provider failure with no durable output", async () => {
		let readinessChecks = 0;
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: {
				check: async () => {
					readinessChecks += 1;
					return { ready: false, reasonCode: "missing_project_metadata" };
				},
			},
			createRunId: () => "continuation-1",
		});
		const terminalRun = createTerminalRun("run-1", "failed", "Connection error.");
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "agent_retry_scheduled",
			payload: { type: "agent_retry_scheduled", attempt: 4, maxAttempts: 5, reasonCode: "transient_provider_error" },
		});
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(readinessChecks).toBe(0);
		expect(goal?.status).toBe("blocked");
		expect(goal?.continuationRunsUsed).toBe(0);
		expect(goal?.lastRunId).toBe("run-1");
		expect(goal?.lastFailureReason).toBe("provider_transient_error");
		expect(goal?.completedAt).toBeDefined();
		expect(db.getRun("client-a", "continuation-1")).toBeUndefined();
		expect(claimed).toBeUndefined();
		expect(events.at(-1)?.eventType).toBe("retry_exhausted");
		expect(events.at(-1)?.reasonCode).toBe("transient_provider_error");
		expect(events.at(-1)?.runId).toBe("run-1");
	});

	it("marks the goal cancelled without scheduling a continuation when the terminal run was cancelled", async () => {
		let readinessChecks = 0;
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: {
				check: async () => {
					readinessChecks += 1;
					return { ready: false, reasonCode: "html_no_basic_content" };
				},
			},
			createRunId: () => "continuation-1",
		});
		const terminalRun = createTerminalRun("run-1", "cancelled");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(readinessChecks).toBe(0);
		expect(goal?.status).toBe("cancelled");
		expect(goal?.lastRunId).toBe("run-1");
		expect(goal?.lastFailureReason).toBe("run_cancelled");
		expect(goal?.completedAt).toBeDefined();
		expect(db.getRun("client-a", "continuation-1")).toBeUndefined();
		expect(claimed).toBeUndefined();
		expect(events.at(-1)?.eventType).toBe("blocked");
		expect(events.at(-1)?.reasonCode).toBe("run_cancelled");
		expect(events.at(-1)?.runId).toBe("run-1");
	});

	it("blocks the goal without scheduling a continuation when the terminal run was interrupted", async () => {
		let readinessChecks = 0;
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: {
				check: async () => {
					readinessChecks += 1;
					return { ready: false, reasonCode: "html_no_basic_content" };
				},
			},
			createRunId: () => "continuation-1",
		});
		const terminalRun = createTerminalRun("run-1", "interrupted");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(readinessChecks).toBe(0);
		expect(goal?.status).toBe("blocked");
		expect(goal?.lastRunId).toBe("run-1");
		expect(goal?.lastFailureReason).toBe("run_interrupted");
		expect(goal?.completedAt).toBeDefined();
		expect(db.getRun("client-a", "continuation-1")).toBeUndefined();
		expect(claimed).toBeUndefined();
		expect(events.at(-1)?.eventType).toBe("blocked");
		expect(events.at(-1)?.reasonCode).toBe("run_interrupted");
		expect(events.at(-1)?.runId).toBe("run-1");
	});

	it("marks continuation failed and blocks the goal when enqueue fails", async () => {
		readinessResult = {
			ready: false,
			reasonCode: "html_no_basic_content",
			previewUrl: "http://localhost:5173/preview/project-client-a-session-1/",
		};
		queue = new FailingEnqueueRunQueue("redis unavailable");
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: { check: async () => readinessResult },
			createRunId: () => "continuation-1",
		});
		const terminalRun = createTerminalRun("run-1");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const continuation = db.getRun("client-a", "continuation-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		const queueUnavailable = events.find((event) => event.eventType === "queue_unavailable");
		expect(continuation?.status).toBe("failed");
		expect(continuation?.error).toBe("queue enqueue failed: redis unavailable");
		expect(goal?.status).toBe("blocked");
		expect(goal?.lastRunId).toBe("continuation-1");
		expect(goal?.lastFailureReason).toBe("queue_unavailable");
		expect(goal?.completedAt).toBeDefined();
		expect(claimed).toBeUndefined();
		expect(queueUnavailable?.reasonCode).toBe("queue_unavailable");
		expect(queueUnavailable?.runId).toBe("continuation-1");
		expect(queueUnavailable?.payload).toMatchObject({
			errorMessage: "redis unavailable",
			failedRunId: "continuation-1",
			readiness: readinessResult,
		});
	});

	it("marks the goal budget_limited when the continuation budget is exhausted", async () => {
		readinessResult = { ready: false, reasonCode: "http_not_ok", detail: "HTTP 404" };
		const terminalRun = createTerminalRun("run-1");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});
		goals.mark({
			clientId: "client-a",
			sessionId: "session-1",
			continuationRunsUsed: 5,
		});

		await supervisor.afterRunTerminal(terminalRun);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		const events = goals.events("client-a", "session-1", 0);
		expect(goal?.status).toBe("budget_limited");
		expect(goal?.lastRunId).toBe("run-1");
		expect(goal?.lastFailureReason).toBe("http_not_ok");
		expect(claimed).toBeUndefined();
		expect(events.at(-1)?.eventType).toBe("budget_limited");
	});

	it("ignores a stale terminal run when the goal points at a newer run", async () => {
		let readinessChecks = 0;
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: {
				check: async () => {
					readinessChecks += 1;
					return { ready: true, reasonCode: "ready", previewUrl: "http://localhost:5173/preview/app/" };
				},
			},
			createRunId: () => "continuation-1",
		});
		const staleRun = createTerminalRun("run-old");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-current",
		});

		await supervisor.afterRunTerminal(staleRun);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		expect(readinessChecks).toBe(0);
		expect(goal?.status).toBe("active");
		expect(goal?.lastRunId).toBe("run-current");
		expect(goal?.lastPreviewUrl).toBeUndefined();
		expect(db.getRun("client-a", "continuation-1")).toBeUndefined();
		expect(claimed).toBeUndefined();
	});

	it("ignores non-terminal runs", async () => {
		let readinessChecks = 0;
		supervisor = new AppPreviewGoalSupervisor({
			db,
			queue,
			goals,
			readiness: {
				check: async () => {
					readinessChecks += 1;
					return { ready: true, reasonCode: "ready", previewUrl: "http://localhost:5173/preview/app/" };
				},
			},
			createRunId: () => "continuation-1",
		});
		const run = createQueuedRun("run-1");
		goals.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});

		await supervisor.afterRunTerminal(run);

		const goal = goals.get("client-a", "session-1");
		const claimed = await queue.claim("worker-1", 1);
		expect(readinessChecks).toBe(0);
		expect(goal?.status).toBe("active");
		expect(goal?.lastRunId).toBe("run-1");
		expect(db.getRun("client-a", "continuation-1")).toBeUndefined();
		expect(claimed).toBeUndefined();
	});

	function createTerminalRun(
		runId: string,
		status: "cancelled" | "completed" | "failed" | "interrupted" = "completed",
		error?: string,
	): RuntimeRunRecord {
		createQueuedRun(runId);
		return db.updateRunStatus(runId, "client-a", status, error ? { error } : undefined);
	}

	function createQueuedRun(runId: string): RuntimeRunRecord {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Preview App",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		db.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId,
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		return db.getRun("client-a", runId) as RuntimeRunRecord;
	}
});

class FailingEnqueueRunQueue extends InMemoryRunQueue {
	constructor(private readonly message: string) {
		super();
	}

	override async enqueue(_run: RunQueueItem): Promise<void> {
		throw new Error(this.message);
	}
}
