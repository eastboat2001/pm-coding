import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPreviewGoalService, budgetForSource } from "../src/app-preview-goal-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

describe("AppPreviewGoalService", () => {
	let dir: string;
	let db: RuntimeDbStore;
	let service: AppPreviewGoalService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-app-preview-goal-service-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		service = new AppPreviewGoalService(db);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("uses source-specific budgets when enabling a goal", async () => {
		createSession("session-pm");
		createSession("session-manual");

		const pmGoal = await service.enable({
			clientId: "client-a",
			sessionId: "session-pm",
			source: "pm_handoff",
			runId: "run-pm",
		});
		const manualGoal = await service.enable({
			clientId: "client-a",
			sessionId: "session-manual",
			source: "manual",
			runId: "run-manual",
		});

		expect(budgetForSource("pm_handoff")).toBe(8);
		expect(budgetForSource("manual")).toBe(5);
		expect(pmGoal.status).toBe("active");
		expect(pmGoal.maxContinuationRuns).toBe(8);
		expect(pmGoal.lastRunId).toBe("run-pm");
		expect(manualGoal.status).toBe("active");
		expect(manualGoal.maxContinuationRuns).toBe(5);
		expect(manualGoal.lastRunId).toBe("run-manual");
	});

	it("disables an existing goal without replacing its event history", async () => {
		createSession("session-1");
		const started = await service.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "pm_handoff",
			runId: "run-1",
		});

		const disabled = await service.disable({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-2",
		});
		const events = await service.events("client-a", "session-1", 0);

		expect(disabled?.goalId).toBe(started.goalId);
		expect(disabled?.status).toBe("disabled");
		expect(disabled?.lastRunId).toBe("run-2");
		expect(events).toHaveLength(2);
		expect(events.map((event) => event.eventType)).toEqual(["goal_started", "goal_disabled"]);
		expect(events.map((event) => event.goalId)).toEqual([started.goalId, started.goalId]);
		expect(events[0]?.reasonCode).toBe("enabled");
		expect(events[1]?.reasonCode).toBe("user_disabled");
	});

	it("resets counters and clears terminal fields when re-enabling a non-active goal", async () => {
		createSession("session-1");
		const started = await service.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-1",
		});
		const completedAt = new Date().toISOString();
		await service.mark({
			clientId: "client-a",
			sessionId: "session-1",
			status: "preview_ready",
			continuationRunsUsed: 3,
			retryAttemptsUsed: 2,
			lastPreviewUrl: "http://localhost:5173/preview/app/",
			lastFailureReason: "html_no_basic_content",
			completedAt,
		});

		const restarted = await service.enable({
			clientId: "client-a",
			sessionId: "session-1",
			source: "manual",
			runId: "run-2",
		});
		const events = await service.events("client-a", "session-1", 0);

		expect(restarted.goalId).toBe(started.goalId);
		expect(restarted.createdAt).toBe(started.createdAt);
		expect(restarted.status).toBe("active");
		expect(restarted.continuationRunsUsed).toBe(0);
		expect(restarted.retryAttemptsUsed).toBe(0);
		expect(restarted.lastRunId).toBe("run-2");
		expect(restarted.lastPreviewUrl).toBeUndefined();
		expect(restarted.lastFailureReason).toBeUndefined();
		expect(restarted.completedAt).toBeUndefined();
		expect(events.map((event) => event.eventType)).toEqual(["goal_started", "goal_started"]);
		expect(events[1]?.reasonCode).toBe("enabled");
		expect(events[1]?.runId).toBe("run-2");
	});

	function createSession(sessionId: string): void {
		db.createSession({
			clientId: "client-a",
			sessionId,
			title: "Preview App",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
	}
});
