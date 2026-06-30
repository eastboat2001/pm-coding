import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPreviewGoalService } from "../src/app-preview-goal-service.js";
import { RunApiError, WorkspaceRunApiService } from "../src/run-api-service.js";
import { type ClaimedRun, InMemoryRunQueue, type RunQueue, type RunQueueItem } from "../src/run-queue.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { StartRunRequest } from "../src/types.js";

describe("WorkspaceRunApiService", () => {
	let db: RuntimeDbStore;
	let dir: string;
	let queue: InMemoryRunQueue;
	let service: WorkspaceRunApiService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-run-api-service-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		queue = new InMemoryRunQueue();
		service = new WorkspaceRunApiService(db, queue);
	});

	afterEach(async () => {
		await queue.close();
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("startRun creates a queued run, appends the user message, enqueues client identity, and rejects duplicate active runs", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Investigate bug",
			message: { content: "hello" },
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		expect(result.session.sessionId).toBe("session-1");
		expect(result.run.status).toBe("queued");
		expect(result.message?.role).toBe("user");
		expect(result.message?.payload).toEqual({ content: "hello" });
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({ clientId: "client-a", runId: result.run.runId });
		await expect(
			service.startRun("client-a", {
				sessionId: "session-1",
				title: "Investigate bug",
				message: { content: "second" },
				model: { provider: "openai", id: "gpt-5" },
				thinkingLevel: "high",
			}),
		).rejects.toThrow("already has an active run");
		expect(db.listMessages("client-a", "session-1")).toHaveLength(1);
	});

	it("records successful run enqueue diagnostics", async () => {
		const diagnostics = new RecordingDiagnostics();
		const diagnosticService = new WorkspaceRunApiService(db, queue, diagnostics);

		const result = await diagnosticService.startRun("client-a", {
			sessionId: "session-1",
			title: "Queue diagnostics",
			message: { content: "hello" },
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		expect(diagnostics.events).toContainEqual(
			expect.objectContaining({
				level: "info",
				category: "agent",
				eventType: "agent.run.enqueued",
				sessionId: "session-1",
				traceId: "session-1",
				data: expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					runId: result.run.runId,
					status: "queued",
				}),
			}),
		);
	});

	it("keeps a run queued when enqueue succeeds but diagnostic logging is locked", async () => {
		const diagnosticService = new WorkspaceRunApiService(db, queue, new LockedDiagnostics());

		const result = await diagnosticService.startRun("client-a", {
			sessionId: "session-1",
			title: "Queue diagnostics locked",
			message: { content: "hello" },
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		expect(result.run.status).toBe("queued");
		expect(db.getRun("client-a", result.run.runId)?.status).toBe("queued");
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({ clientId: "client-a", runId: result.run.runId });
	});

	it("allows only one concurrent startRun for the same session to create an active run", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Concurrent session",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});

		const results = await Promise.allSettled([
			service.startRun("client-a", {
				sessionId: "session-1",
				title: "Concurrent session",
				message: { content: "first" },
				model: { provider: "openai", id: "gpt-5" },
				thinkingLevel: "high",
			}),
			service.startRun("client-a", {
				sessionId: "session-1",
				title: "Concurrent session",
				message: { content: "second" },
				model: { provider: "openai", id: "gpt-5" },
				thinkingLevel: "high",
			}),
		]);

		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
		expect(db.listRunsForSession("client-a", "session-1").map((run) => run.status)).toEqual(["queued"]);
		expect(db.listMessages("client-a", "session-1")).toHaveLength(1);
		const runId = (fulfilled[0] as PromiseFulfilledResult<{ run: { runId: string } }>).value.run.runId;
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({
			clientId: "client-a",
			runId,
		});
		await expect(queue.claim("worker-1", 1)).resolves.toBeUndefined();
	});

	it("marks stale active runs terminal before listing sessions", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Old running app",
			message: { content: "build app" },
			model: {},
			thinkingLevel: "medium",
		});
		const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		db.updateRunStatus(result.run.runId, "client-a", "running", {
			workerId: "old-worker",
			startedAt: staleAt,
			updatedAt: staleAt,
		});

		const sessions = await service.listSessions("client-a");

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: "session-1",
				lastRunStatus: "interrupted",
			}),
		]);
		expect(db.getRun("client-a", result.run.runId)?.status).toBe("interrupted");
	});

	it("marks old cancelling runs terminal even when cancellation refreshed the update time", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Old cancelling app",
			message: { content: "build app" },
			model: {},
			thinkingLevel: "medium",
		});
		const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		db.updateRunStatus(result.run.runId, "client-a", "running", {
			workerId: "old-worker",
			startedAt: staleAt,
			updatedAt: staleAt,
		});
		db.updateRunStatus(result.run.runId, "client-a", "cancelling", {
			updatedAt: new Date().toISOString(),
		});

		const sessions = await service.listSessions("client-a");

		expect(sessions[0]?.lastRunStatus).toBe("interrupted");
		expect(db.getRun("client-a", result.run.runId)?.status).toBe("interrupted");
	});

	it("seeds request project files into the final runtime session before enqueueing", async () => {
		const seededFiles: Array<{
			clientId: string;
			sessionId: string;
			title: string;
			filename: string;
			content: string;
		}> = [];
		const seedingService = new WorkspaceRunApiService(db, queue, undefined, {
			writeFile: async (context, file) => {
				seededFiles.push({
					clientId: context.clientId,
					sessionId: context.sessionId,
					title: context.title,
					filename: file.filename,
					content: file.content,
				});
			},
		});

		const result = await seedingService.startRun("client-a", {
			sessionId: "session-1",
			title: "QDM Finish",
			message: { content: "read docs" },
			model: {},
			thinkingLevel: "high",
			projectFiles: [{ filename: "docs/需求.md", content: "# PRD" }],
		});

		expect(result.session.sessionId).toBe("session-1");
		expect(seededFiles).toEqual([
			{
				clientId: "client-a",
				sessionId: "session-1",
				title: "QDM Finish",
				filename: "docs/需求.md",
				content: "# PRD",
			},
		]);
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({ clientId: "client-a", runId: result.run.runId });
	});

	it("initializes a project workspace for a new run even when no project files are seeded", async () => {
		const initializedWorkspaces: Array<{ clientId: string; sessionId: string; title: string }> = [];
		const seedingService = new WorkspaceRunApiService(db, queue, undefined, {
			ensureWorkspace: async (context) => {
				initializedWorkspaces.push(context);
			},
			writeFile: async () => {
				throw new Error("No files should be seeded for this request");
			},
		});

		const result = await seedingService.startRun("client-a", {
			sessionId: "session-plain",
			title: "Plain Chat",
			message: { content: "hello" },
			model: {},
			thinkingLevel: "high",
		});

		expect(result.session.sessionId).toBe("session-plain");
		expect(initializedWorkspaces).toEqual([
			{ clientId: "client-a", sessionId: "session-plain", title: "Plain Chat" },
		]);
	});

	it("preserves user-with-attachments as the runtime message role", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-attachments",
			title: "Read upload",
			message: {
				role: "user-with-attachments",
				content: "read the upload",
				attachments: [
					{
						id: "doc-1",
						type: "document",
						fileName: "requirements.md",
						mimeType: "text/markdown",
						size: 5,
						content: "",
						extractedText: "# PRD",
					},
				],
			},
			model: {},
			thinkingLevel: "high",
		});

		expect(result.message?.role).toBe("user-with-attachments");
		expect(db.listMessages("client-a", "session-attachments")).toEqual([
			expect.objectContaining({
				role: "user-with-attachments",
				payload: expect.objectContaining({ role: "user-with-attachments" }),
			}),
		]);
	});

	it("starts an interrupted recovery continuation without appending a prompt message", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-continue",
			title: "Continue tool",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		const parentRun = db.createRun({
			clientId: "client-a",
			sessionId: "session-continue",
			runId: "run-interrupted-parent",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
		db.updateRunStatus(parentRun.runId, "client-a", "interrupted");
		db.appendMessage({
			clientId: "client-a",
			sessionId: "session-continue",
			role: "toolResult",
			payload: { role: "toolResult", toolCallId: "tool-1", content: "done" },
		});

		const result = await service.startRun("client-a", {
			sessionId: "session-continue",
			title: "Continue tool",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
			continuation: {
				source: "interrupted_recovery",
				parentRunId: parentRun.runId,
			},
		});

		expect(result.session.sessionId).toBe("session-continue");
		expect(result.message).toBeUndefined();
		expect(result.run.status).toBe("queued");
		expect(db.listMessages("client-a", "session-continue").map((message) => message.role)).toEqual(["toolResult"]);
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({ clientId: "client-a", runId: result.run.runId });
	});

	it("returns active run restore detail with the latest checkpoint", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-active-restore",
			title: "Restore active run",
			message: { content: "stream" },
			model: {},
			thinkingLevel: "high",
		});
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			runId: result.run.runId,
			seq: 1,
			type: "message_update",
			payload: { type: "message_update", message: { role: "assistant", content: "first" } },
		});
		const latestCheckpoint = db.appendRunEvent({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			runId: result.run.runId,
			seq: 3,
			type: "message_update",
			payload: { type: "message_update", message: { role: "assistant", content: "latest" } },
		});

		const detail = await service.getSession("client-a", "session-active-restore");

		expect(detail?.activeRun).toEqual({
			run: expect.objectContaining({ runId: result.run.runId, status: "queued" }),
			checkpointEvent: latestCheckpoint,
			afterSeq: 3,
		});
	});

	it("omits active run restore detail when the session has no active run", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-completed-restore",
			title: "Completed run",
			message: { content: "done" },
			model: {},
			thinkingLevel: "high",
		});
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			runId: result.run.runId,
			type: "message_update",
			payload: { type: "message_update", message: { role: "assistant", content: "complete" } },
		});
		db.updateRunStatus(result.run.runId, "client-a", "completed");

		const detail = await service.getSession("client-a", "session-completed-restore");

		expect(detail?.activeRun).toBeUndefined();
	});

	it("returns a synthetic cancelled assistant marker for cancelled runs without assistant output", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-cancelled-marker",
			title: "Cancelled run",
			message: { content: "stop me" },
			model: {},
			thinkingLevel: "high",
		});
		db.updateRunStatus(result.run.runId, "client-a", "cancelled", {
			endedAt: "2026-06-30T06:00:00.000Z",
			updatedAt: "2026-06-30T06:00:00.000Z",
		});

		const detail = await service.getSession("client-a", "session-cancelled-marker");

		expect(db.listMessages("client-a", "session-cancelled-marker")).toHaveLength(1);
		expect(detail?.messages).toHaveLength(2);
		expect(detail?.messages[1]).toMatchObject({
			role: "assistant",
			createdAt: "2026-06-30T06:00:00.000Z",
			synthetic: true,
			payload: {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request was aborted.",
			},
		});
	});

	it("returns a synthetic cancelled assistant marker when only a tool-use assistant exists", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-cancelled-after-tool-use",
			title: "Cancelled after tool use",
			message: { content: "stop after skill" },
			model: {},
			thinkingLevel: "high",
		});
		db.updateRunStatus(result.run.runId, "client-a", "running", {
			startedAt: result.run.updatedAt,
			updatedAt: result.run.updatedAt,
		});
		const afterRunStart = new Date(Date.parse(result.run.updatedAt) + 1000).toISOString();
		db.appendMessage({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			role: "assistant",
			payload: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "skill_load", arguments: { name: "frontend-design" } }],
				stopReason: "toolUse",
			},
			createdAt: afterRunStart,
		});
		db.appendMessage({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			role: "toolResult",
			payload: { role: "toolResult", toolCallId: "call-1", content: "Loaded skill frontend-design" },
			createdAt: afterRunStart,
		});
		db.updateRunStatus(result.run.runId, "client-a", "cancelled", {
			endedAt: new Date(Date.parse(afterRunStart) + 1000).toISOString(),
			updatedAt: new Date(Date.parse(afterRunStart) + 1000).toISOString(),
		});

		const detail = await service.getSession("client-a", "session-cancelled-after-tool-use");

		expect(db.listMessages("client-a", "session-cancelled-after-tool-use")).toHaveLength(3);
		expect(detail?.messages).toHaveLength(4);
		expect(detail?.messages.at(-1)).toMatchObject({
			role: "assistant",
			synthetic: true,
			payload: {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request was aborted.",
			},
		});
	});

	it("does not duplicate an existing cancelled assistant marker", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-existing-cancelled-marker",
			title: "Existing cancelled marker",
			message: { content: "stop me" },
			model: {},
			thinkingLevel: "high",
		});
		db.appendMessage({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			role: "assistant",
			payload: {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request was aborted.",
			},
			createdAt: "2026-06-30T06:00:00.000Z",
		});
		db.updateRunStatus(result.run.runId, "client-a", "cancelled", {
			endedAt: "2026-06-30T06:00:00.000Z",
			updatedAt: "2026-06-30T06:00:00.000Z",
		});

		const detail = await service.getSession("client-a", "session-existing-cancelled-marker");

		expect(detail?.messages).toHaveLength(2);
		expect(detail?.messages.filter((message) => message.payload.stopReason === "aborted")).toHaveLength(1);
	});

	it("updates an existing runtime session model snapshot when starting a new prompt run", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-model-refresh",
			title: "Refresh model",
			model: { provider: "custom-provider:local", id: "mimo", baseUrl: "https://old.example/v1" },
			thinkingLevel: "off",
		});
		const nextModel = { provider: "custom-provider:local", id: "mimo", baseUrl: "https://new.example/v1" };

		await service.startRun("client-a", {
			sessionId: "session-model-refresh",
			title: "Refresh model",
			message: { content: "use latest config" },
			model: nextModel,
			thinkingLevel: "minimal",
		});

		expect(db.getSession("client-a", "session-model-refresh")).toEqual(
			expect.objectContaining({
				model: nextModel,
				thinkingLevel: "minimal",
			}),
		);
	});

	it("updates an existing runtime session model snapshot when starting a continuation run", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-continuation-model-refresh",
			title: "Continue latest model",
			model: { provider: "custom-provider:local", id: "mimo", baseUrl: "https://old.example/v1" },
			thinkingLevel: "off",
		});
		const parentRun = db.createRun({
			clientId: "client-a",
			sessionId: "session-continuation-model-refresh",
			runId: "run-continuation-model-refresh-parent",
			model: { provider: "custom-provider:local", id: "mimo", baseUrl: "https://old.example/v1" },
			thinkingLevel: "off",
		});
		db.updateRunStatus(parentRun.runId, "client-a", "interrupted");
		const nextModel = { provider: "custom-provider:local", id: "mimo", baseUrl: "https://new.example/v1" };

		await service.startRun("client-a", {
			sessionId: "session-continuation-model-refresh",
			title: "Continue latest model",
			model: nextModel,
			thinkingLevel: "low",
			continuation: {
				source: "interrupted_recovery",
				parentRunId: parentRun.runId,
			},
		});

		expect(db.getSession("client-a", "session-continuation-model-refresh")).toEqual(
			expect.objectContaining({
				model: nextModel,
				thinkingLevel: "low",
			}),
		);
	});

	it("enables an app preview goal from startRun only after enqueue succeeds", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);

		const result = await goalService.startRun("client-a", {
			sessionId: "session-goal",
			title: "Preview app",
			message: { content: "build preview" },
			model: {},
			thinkingLevel: "high",
			appPreviewGoal: { enabled: true, source: "pm_handoff" },
		});

		expect(await goalService.getAppPreviewGoal("client-a", "session-goal")).toEqual(
			expect.objectContaining({
				clientId: "client-a",
				sessionId: "session-goal",
				source: "pm_handoff",
				status: "active",
				maxContinuationRuns: 8,
				lastRunId: result.run.runId,
			}),
		);
		expect(await goalService.listAppPreviewGoalEvents("client-a", "session-goal")).toEqual([
			expect.objectContaining({
				eventType: "goal_started",
				reasonCode: "enabled",
				runId: result.run.runId,
			}),
		]);

		const failingQueue = new FailingRunQueue();
		const failingGoalService = new WorkspaceRunApiService(db, failingQueue, undefined, undefined, undefined, goals);
		await expect(
			failingGoalService.startRun("client-b", {
				sessionId: "session-goal",
				title: "Preview app",
				message: { content: "build preview" },
				model: {},
				thinkingLevel: "high",
				appPreviewGoal: { enabled: true, source: "pm_handoff" },
			}),
		).rejects.toMatchObject({ statusCode: 503 });
		await expect(failingGoalService.getAppPreviewGoal("client-b", "session-goal")).resolves.toBeUndefined();
	});

	it("rejects startRun app preview goals with a missing source before creating work", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);
		const request = {
			sessionId: "session-missing-source",
			title: "Preview app",
			message: { content: "build preview" },
			model: {},
			thinkingLevel: "high",
			appPreviewGoal: { enabled: true },
		} as unknown as StartRunRequest;

		await expect(goalService.startRun("client-a", request)).rejects.toMatchObject({ statusCode: 400 });

		await expect(queue.claim("worker-1", 1)).resolves.toBeUndefined();
		expect(db.listRunsForSession("client-a", "session-missing-source")).toEqual([]);
		await expect(goalService.getAppPreviewGoal("client-a", "session-missing-source")).resolves.toBeUndefined();
	});

	it("rejects startRun app preview goals with an illegal source before creating work", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);
		const request = {
			sessionId: "session-illegal-source",
			title: "Preview app",
			message: { content: "build preview" },
			model: {},
			thinkingLevel: "high",
			appPreviewGoal: { enabled: true, source: "bogus" },
		} as unknown as StartRunRequest;

		await expect(goalService.startRun("client-a", request)).rejects.toMatchObject({ statusCode: 400 });

		await expect(queue.claim("worker-1", 1)).resolves.toBeUndefined();
		expect(db.listRunsForSession("client-a", "session-illegal-source")).toEqual([]);
		await expect(goalService.getAppPreviewGoal("client-a", "session-illegal-source")).resolves.toBeUndefined();
	});

	it("exposes app preview goal helpers for manual enable and disable", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);
		db.createSession({
			clientId: "client-a",
			sessionId: "session-manual",
			title: "Manual preview",
			model: {},
			thinkingLevel: "high",
		});

		const enabled = await goalService.enableAppPreviewGoal("client-a", "session-manual", "manual");

		expect(enabled).toEqual(
			expect.objectContaining({
				clientId: "client-a",
				sessionId: "session-manual",
				source: "manual",
				status: "active",
				maxContinuationRuns: 5,
			}),
		);
		expect((await goalService.getAppPreviewGoal("client-a", "session-manual"))?.status).toBe("active");
		const startedEvents = await goalService.listAppPreviewGoalEvents("client-a", "session-manual");
		expect(startedEvents).toEqual([expect.objectContaining({ eventType: "goal_started", reasonCode: "enabled" })]);

		const disabled = await goalService.disableAppPreviewGoal("client-a", "session-manual");

		expect(disabled).toEqual(expect.objectContaining({ status: "disabled" }));
		expect((await goalService.getAppPreviewGoal("client-a", "session-manual"))?.status).toBe("disabled");
		expect(
			await goalService.listAppPreviewGoalEvents("client-a", "session-manual", startedEvents[0]?.eventId),
		).toEqual([expect.objectContaining({ eventType: "goal_disabled", reasonCode: "user_disabled" })]);
	});

	it("returns not found when manually enabling an app preview goal for a missing session", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);

		await expect(goalService.enableAppPreviewGoal("client-a", "missing-session", "manual")).rejects.toMatchObject({
			message: "Runtime session not found",
			statusCode: 404,
		});
		await expect(goalService.getAppPreviewGoal("client-a", "missing-session")).resolves.toBeUndefined();
	});

	it("updates app preview goal lastRunId for continuation run requests", async () => {
		const goals = new AppPreviewGoalService(db);
		const goalService = new WorkspaceRunApiService(db, queue, undefined, undefined, undefined, goals);
		const first = await goalService.startRun("client-a", {
			sessionId: "session-continue-goal",
			title: "Preview app",
			message: { content: "build preview" },
			model: {},
			thinkingLevel: "high",
			appPreviewGoal: { enabled: true, source: "manual" },
		});
		await queue.claim("worker-1", 1);
		db.updateRunStatus(first.run.runId, "client-a", "interrupted");

		const continuation = await goalService.startRun("client-a", {
			sessionId: "session-continue-goal",
			model: {},
			thinkingLevel: "high",
			appPreviewGoal: { enabled: true, source: "manual" },
			continuation: {
				source: "interrupted_recovery",
				parentRunId: first.run.runId,
			},
		});

		expect(await goalService.getAppPreviewGoal("client-a", "session-continue-goal")).toEqual(
			expect.objectContaining({
				source: "manual",
				status: "active",
				lastRunId: continuation.run.runId,
			}),
		);
		expect(
			(await goalService.listAppPreviewGoalEvents("client-a", "session-continue-goal")).map((event) => event.runId),
		).toEqual([first.run.runId, continuation.run.runId]);
	});

	it("lists, details, deletes, runs, cancels, and events with client isolation", async () => {
		const clientA = await service.startRun("client-a", {
			sessionId: "shared-session",
			title: "Client A",
			message: { content: "a" },
			model: { id: "a" },
			thinkingLevel: "medium",
		});
		const clientB = await service.startRun("client-b", {
			sessionId: "shared-session",
			title: "Client B",
			message: { content: "b" },
			model: { id: "b" },
			thinkingLevel: "low",
		});
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: clientA.session.sessionId,
			runId: clientA.run.runId,
			type: "message.delta",
			payload: { text: "a" },
		});
		db.appendRunEvent({
			clientId: "client-b",
			sessionId: clientB.session.sessionId,
			runId: clientB.run.runId,
			type: "message.delta",
			payload: { text: "b" },
		});

		expect((await service.listSessions("client-a")).map((session) => session.title)).toEqual(["Client A"]);
		expect(
			(await service.getSession("client-a", "shared-session"))?.messages.map((message) => message.payload),
		).toEqual([{ content: "a" }]);
		expect((await service.getSession("client-a", "shared-session"))?.runs.map((run) => run.runId)).toEqual([
			clientA.run.runId,
		]);
		expect((await service.getSession("client-b", "shared-session"))?.runs.map((run) => run.runId)).toEqual([
			clientB.run.runId,
		]);
		expect((await service.listRuns("client-a")).map((run) => run.runId)).toEqual([clientA.run.runId]);
		await expect(service.getRunStatus("client-a", clientB.run.runId)).resolves.toBeUndefined();
		await expect(service.listRunEvents("client-a", clientB.run.runId, 0)).resolves.toEqual([]);
		expect((await service.listRunEvents("client-a", clientA.run.runId, 0)).map((event) => event.payload)).toEqual([
			{ text: "a" },
		]);
		await expect(service.deleteSession("client-a", "shared-session")).rejects.toThrow("already has an active run");

		const cancelled = await service.cancelRun("client-a", clientA.run.runId);
		expect(cancelled.status).toBe("cancelled");
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: clientA.run.runId })).resolves.toBe(true);
		await expect(queue.isCancelRequested({ clientId: "client-b", runId: clientA.run.runId })).resolves.toBe(false);

		const deleteResult = await service.deleteSession("client-a", "shared-session", { force: true });
		expect(deleteResult).toEqual({ deleted: true, sessionId: "shared-session" });
		await expect(service.getSession("client-a", "shared-session")).resolves.toBeUndefined();
		expect((await service.getSession("client-b", "shared-session"))?.session.title).toBe("Client B");
		await expect(service.listRuns("client-a")).resolves.toEqual([]);
		expect((await service.listRuns("client-b")).map((run) => run.runId)).toEqual([clientB.run.runId]);
	});

	it("returns owned runs for event streams and lists durable run events after a sequence", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-events",
			title: "Event stream",
			message: { content: "stream me" },
			model: {},
			thinkingLevel: "high",
		});
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			runId: result.run.runId,
			type: "message.delta",
			payload: { text: "first" },
		});
		db.appendRunEvent({
			clientId: "client-a",
			sessionId: result.session.sessionId,
			runId: result.run.runId,
			type: "message.delta",
			payload: { text: "second" },
		});

		await expect(service.getRunForEvents("client-a", result.run.runId)).resolves.toEqual(
			expect.objectContaining({
				clientId: "client-a",
				runId: result.run.runId,
				sessionId: result.session.sessionId,
			}),
		);
		await expect(service.listDurableRunEvents("client-a", result.run.runId, 1)).resolves.toEqual([
			expect.objectContaining({ seq: 2, payload: { text: "second" } }),
		]);
		await expect(service.getRunForEvents("client-b", result.run.runId)).rejects.toMatchObject({
			message: "Run not found.",
			statusCode: 404,
		});
	});

	it("deletes the client session workspace when deleting a SQLite session", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Delete files",
			model: {},
			thinkingLevel: "medium",
		});
		const sessionDir = join(dir, "clients", "client-a", "sessions", "session-1");
		mkdirSync(join(sessionDir, "project"), { recursive: true });
		writeFileSync(join(sessionDir, "project", "index.html"), "<h1>delete me</h1>", "utf8");
		const deletingService = new WorkspaceRunApiService(db, queue, undefined, undefined, {
			deleteSessionWorkspace: (clientId, sessionId) => {
				const target = join(dir, "clients", clientId, "sessions", sessionId);
				rmSync(target, { force: true, recursive: true });
				return true;
			},
		});

		const result = await deletingService.deleteSession("client-a", "session-1");

		expect(result).toEqual({ deleted: true, sessionId: "session-1" });
		expect(db.getSession("client-a", "session-1")).toBeUndefined();
		expect(existsSync(sessionDir)).toBe(false);
	});

	it("force delete cleans an orphaned client session workspace when the runtime session is missing", async () => {
		const deletedWorkspaces: Array<{ clientId: string; sessionId: string }> = [];
		const deletingService = new WorkspaceRunApiService(db, queue, undefined, undefined, {
			deleteSessionWorkspace: (clientId, sessionId) => {
				deletedWorkspaces.push({ clientId, sessionId });
				return true;
			},
		});

		const result = await deletingService.deleteSession("client-a", "missing-session", { force: true });

		expect(result).toEqual({ deleted: false, sessionId: "missing-session" });
		expect(deletedWorkspaces).toEqual([{ clientId: "client-a", sessionId: "missing-session" }]);
	});

	it("cancelRun marks queued runs cancelled so the session is no longer active", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Queued cancel",
			message: { content: "cancel me" },
			model: {},
			thinkingLevel: "medium",
		});

		const cancelled = await service.cancelRun("client-a", result.run.runId);

		expect(cancelled.status).toBe("cancelled");
		expect(db.getRun("client-a", result.run.runId)?.status).toBe("cancelled");
		await expect(
			service.startRun("client-a", {
				sessionId: "session-1",
				title: "Queued cancel",
				message: { content: "new work" },
				model: {},
				thinkingLevel: "medium",
			}),
		).resolves.toMatchObject({ run: { status: "queued" } });
	});

	it("rejects message-less continuation requests without continuation metadata", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-continuation-without-metadata",
			title: "Continuation metadata required",
			message: { content: "start" },
			model: {},
			thinkingLevel: "medium",
		});
		db.updateRunStatus(result.run.runId, "client-a", "interrupted");

		await expect(
			service.startRun("client-a", {
				sessionId: "session-continuation-without-metadata",
				title: "Continuation metadata required",
				model: {},
				thinkingLevel: "medium",
			}),
		).rejects.toMatchObject({
			statusCode: 400,
			message: "Continuation metadata is required for message-less runs",
		});
	});

	it("rejects interrupted recovery continuations unless the parent run is interrupted", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-cancelled-continuation",
			title: "Cancelled continuation",
			message: { content: "start" },
			model: {},
			thinkingLevel: "medium",
		});
		db.updateRunStatus(result.run.runId, "client-a", "cancelled");

		await expect(
			service.startRun("client-a", {
				sessionId: "session-cancelled-continuation",
				title: "Cancelled continuation",
				model: {},
				thinkingLevel: "medium",
				continuation: {
					source: "interrupted_recovery",
					parentRunId: result.run.runId,
				},
			}),
		).rejects.toMatchObject({
			statusCode: 409,
			message: "Interrupted recovery continuation requires an interrupted parent run",
		});
	});

	it("allows interrupted recovery continuations for interrupted parent runs", async () => {
		const result = await service.startRun("client-a", {
			sessionId: "session-interrupted-continuation",
			title: "Interrupted continuation",
			message: { content: "start" },
			model: {},
			thinkingLevel: "medium",
		});
		db.updateRunStatus(result.run.runId, "client-a", "interrupted");

		await expect(
			service.startRun("client-a", {
				sessionId: "session-interrupted-continuation",
				title: "Interrupted continuation",
				model: {},
				thinkingLevel: "medium",
				continuation: {
					source: "interrupted_recovery",
					parentRunId: result.run.runId,
				},
			}),
		).resolves.toMatchObject({ run: { status: "queued" } });
	});

	it("marks the created run failed when enqueue fails and surfaces a queue unavailable error", async () => {
		const failingQueue = new FailingRunQueue();
		const diagnostics = new RecordingDiagnostics();
		const failingService = new WorkspaceRunApiService(db, failingQueue, diagnostics);

		await expect(
			failingService.startRun("client-a", {
				sessionId: "session-1",
				title: "Queue down",
				message: { content: "hello" },
				model: {},
				thinkingLevel: "medium",
			}),
		).rejects.toMatchObject({ statusCode: 503 });
		await expect(
			failingService.startRun("client-b", {
				sessionId: "session-1",
				title: "Queue down",
				message: { content: "hello" },
				model: {},
				thinkingLevel: "medium",
			}),
		).rejects.toBeInstanceOf(RunApiError);

		const runs = db.listRunsForSession("client-a", "session-1");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.error).toContain("enqueue failed");
		expect(diagnostics.events).toHaveLength(2);
		expect(diagnostics.events[0]).toMatchObject({
			level: "error",
			category: "agent",
			eventType: "agent.run.enqueue.error",
			sessionId: "session-1",
			traceId: "session-1",
			data: {
				clientId: "client-a",
				runId: runs[0]?.runId,
				message: "redis unavailable",
			},
		});
		await expect(
			service.startRun("client-a", {
				sessionId: "session-1",
				title: "Queue restored",
				message: { content: "try again" },
				model: {},
				thinkingLevel: "medium",
			}),
		).resolves.toMatchObject({ run: { status: "queued" } });
	});

	it("force delete cancels active runs without physically deleting the session", async () => {
		const queued = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Force delete",
			message: { content: "queued" },
			model: {},
			thinkingLevel: "medium",
		});
		db.updateRunStatus(queued.run.runId, "client-a", "running", { workerId: "worker-1" });

		const result = await service.deleteSession("client-a", "session-1", { force: true });

		expect(result).toEqual({ deleted: false, sessionId: "session-1", cancelledRuns: 1 });
		expect((await service.getSession("client-a", "session-1"))?.session.sessionId).toBe("session-1");
		expect(db.getRun("client-a", queued.run.runId)?.status).toBe("cancelling");
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: queued.run.runId })).resolves.toBe(true);
	});

	it("force delete removes a session whose active run is stale", async () => {
		const queued = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Stale delete",
			message: { content: "stuck" },
			model: {},
			thinkingLevel: "medium",
		});
		const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		db.updateRunStatus(queued.run.runId, "client-a", "running", {
			workerId: "worker-1",
			startedAt: staleAt,
			updatedAt: staleAt,
		});

		const result = await service.deleteSession("client-a", "session-1", { force: true });

		expect(result).toEqual({ deleted: true, sessionId: "session-1", cancelledRuns: 1 });
		await expect(service.getSession("client-a", "session-1")).resolves.toBeUndefined();
	});

	it("force delete removes an old cancelling session even when cancellation refreshed the update time", async () => {
		const queued = await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Stale cancelling delete",
			message: { content: "stuck" },
			model: {},
			thinkingLevel: "medium",
		});
		const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		db.updateRunStatus(queued.run.runId, "client-a", "running", {
			workerId: "worker-1",
			startedAt: staleAt,
			updatedAt: staleAt,
		});
		db.updateRunStatus(queued.run.runId, "client-a", "cancelling", {
			updatedAt: new Date().toISOString(),
		});

		const result = await service.deleteSession("client-a", "session-1", { force: true });

		expect(result).toEqual({ deleted: true, sessionId: "session-1", cancelledRuns: 1 });
		await expect(service.getSession("client-a", "session-1")).resolves.toBeUndefined();
	});
});

class FailingRunQueue implements RunQueue {
	async enqueue(_run: RunQueueItem): Promise<void> {
		throw new Error("redis unavailable");
	}

	async claim(_workerId: string, _timeoutMs: number): Promise<ClaimedRun | undefined> {
		return undefined;
	}

	async complete(_run: RunQueueItem | ClaimedRun, _workerId: string): Promise<void> {}

	async requeueActive(_workerId: string): Promise<number> {
		return 0;
	}

	async requestCancel(_run: RunQueueItem | ClaimedRun): Promise<void> {}

	async isCancelRequested(_run: RunQueueItem | ClaimedRun): Promise<boolean> {
		return false;
	}

	async close(): Promise<void> {}
}

class RecordingDiagnostics {
	events: Array<Record<string, unknown>> = [];

	writeEvents(input: { events: Array<Record<string, unknown>> }): { accepted: number; dropped: number } {
		this.events.push(...input.events);
		return { accepted: input.events.length, dropped: 0 };
	}
}

class LockedDiagnostics {
	writeEvents(_input: { events: Array<Record<string, unknown>> }): never {
		throw new Error("database is locked");
	}
}
