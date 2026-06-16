import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunApiError, WorkspaceRunApiService } from "../src/run-api-service.js";
import { type ClaimedRun, InMemoryRunQueue, type RunQueue, type RunQueueItem } from "../src/run-queue.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

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

	it("starts a continuation run for an existing interrupted session without appending a prompt message", async () => {
		db.createSession({
			clientId: "client-a",
			sessionId: "session-continue",
			title: "Continue tool",
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
		});
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
		});

		expect(result.session.sessionId).toBe("session-continue");
		expect(result.message).toBeUndefined();
		expect(result.run.status).toBe("queued");
		expect(db.listMessages("client-a", "session-continue").map((message) => message.role)).toEqual(["toolResult"]);
		await expect(queue.claim("worker-1", 1)).resolves.toEqual({ clientId: "client-a", runId: result.run.runId });
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

		expect(service.listSessions("client-a").map((session) => session.title)).toEqual(["Client A"]);
		expect(service.getSession("client-a", "shared-session")?.messages.map((message) => message.payload)).toEqual([
			{ content: "a" },
		]);
		expect(service.getSession("client-a", "shared-session")?.runs.map((run) => run.runId)).toEqual([
			clientA.run.runId,
		]);
		expect(service.getSession("client-b", "shared-session")?.runs.map((run) => run.runId)).toEqual([
			clientB.run.runId,
		]);
		expect(service.listRuns("client-a").map((run) => run.runId)).toEqual([clientA.run.runId]);
		expect(service.getRunStatus("client-a", clientB.run.runId)).toBeUndefined();
		expect(service.listRunEvents("client-a", clientB.run.runId, 0)).toEqual([]);
		expect(service.listRunEvents("client-a", clientA.run.runId, 0).map((event) => event.payload)).toEqual([
			{ text: "a" },
		]);
		await expect(service.deleteSession("client-a", "shared-session")).rejects.toThrow("already has an active run");

		const cancelled = await service.cancelRun("client-a", clientA.run.runId);
		expect(cancelled.status).toBe("cancelled");
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: clientA.run.runId })).resolves.toBe(true);
		await expect(queue.isCancelRequested({ clientId: "client-b", runId: clientA.run.runId })).resolves.toBe(false);

		const deleteResult = await service.deleteSession("client-a", "shared-session", { force: true });
		expect(deleteResult).toEqual({ deleted: true, sessionId: "shared-session" });
		expect(service.getSession("client-a", "shared-session")).toBeUndefined();
		expect(service.getSession("client-b", "shared-session")?.session.title).toBe("Client B");
		expect(service.listRuns("client-a")).toEqual([]);
		expect(service.listRuns("client-b").map((run) => run.runId)).toEqual([clientB.run.runId]);
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
		expect(service.getSession("client-a", "session-1")?.session.sessionId).toBe("session-1");
		expect(db.getRun("client-a", queued.run.runId)?.status).toBe("cancelling");
		await expect(queue.isCancelRequested({ clientId: "client-a", runId: queued.run.runId })).resolves.toBe(true);
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
