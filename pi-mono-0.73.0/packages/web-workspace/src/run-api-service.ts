import { randomUUID } from "node:crypto";
import { isObject } from "./json.js";
import type { RunQueue } from "./run-queue.js";
import type { RuntimeDbStore } from "./runtime-db.js";
import type {
	DeleteSessionResult,
	DiagnosticLogEventInput,
	JsonObject,
	RunStatus,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
	RuntimeSessionRecord,
	StartRunProjectFile,
	StartRunRequest,
	StartRunResult,
} from "./types.js";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running", "cancelling"]);

export interface RunApiDiagnostics {
	writeEvents(input: { events: DiagnosticLogEventInput[] }): unknown;
}

export interface RunProjectFileSeeder {
	writeFile(
		context: { sessionId: string; title: string },
		file: StartRunProjectFile,
	): Promise<void> | void;
}

export class RunApiError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "RunApiError";
	}
}

export class WorkspaceRunApiService {
	constructor(
		private readonly db: RuntimeDbStore,
		private readonly queue: RunQueue,
		private readonly diagnostics?: RunApiDiagnostics,
		private readonly projectFiles?: RunProjectFileSeeder,
	) {}

	async startRun(clientId: string, request: StartRunRequest): Promise<StartRunResult> {
		const sessionId = normalizeOptionalString(request.sessionId) ?? randomUUID();
		const existingSession = this.db.getSession(clientId, sessionId);
		if (existingSession && this.hasActiveRun(clientId, sessionId)) {
			throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
		}

		const model = isObject(request.model) ? request.model : (existingSession?.model ?? {});
		const thinkingLevel = normalizeOptionalString(request.thinkingLevel) ?? existingSession?.thinkingLevel ?? "high";
		const session =
			existingSession ??
			this.db.createSession({
				clientId,
				sessionId,
				title: normalizeOptionalString(request.title) ?? "Untitled session",
				model,
				thinkingLevel,
		});
		await this.seedProjectFiles(session.sessionId, session.title, request.projectFiles);
		const payload = normalizeMessage(request.message);
		const message = this.db.appendMessage({
			clientId,
			sessionId,
			role: normalizeUserMessageRole(payload.role),
			payload,
		});
		const run = this.db.createRun({
			clientId,
			sessionId,
			runId: randomUUID(),
			model,
			thinkingLevel,
		});
		try {
			await this.queue.enqueue({ clientId, runId: run.runId });
		} catch (error) {
			const cause = errorMessage(error);
			const message = `queue enqueue failed: ${cause}`;
			this.db.updateRunStatus(run.runId, clientId, "failed", { error: message });
			this.diagnostics?.writeEvents({
				events: [
					{
						level: "error",
						category: "agent",
						eventType: "agent.run.enqueue.error",
						sessionId,
						traceId: sessionId,
						data: {
							clientId,
							sessionId,
							runId: run.runId,
							status: "failed",
							message: cause,
						},
					},
				],
			});
			throw new RunApiError("Run queue unavailable", 503);
		}
		return { session, message, run };
	}

	listSessions(clientId: string): RuntimeSessionRecord[] {
		return this.db.listSessions(clientId);
	}

	getSession(clientId: string, sessionId: string): RuntimeSessionDetail | undefined {
		const session = this.db.getSession(clientId, sessionId);
		if (!session) return undefined;
		return {
			session,
			messages: this.db.listMessages(clientId, sessionId),
			runs: this.db.listRunsForSession(clientId, sessionId),
		};
	}

	async deleteSession(
		clientId: string,
		sessionId: string,
		options: { force?: boolean } = {},
	): Promise<DeleteSessionResult> {
		const activeRuns = this.activeRuns(clientId, sessionId);
		if (activeRuns.length > 0 && !options.force) {
			throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
		}
		if (activeRuns.length > 0 && options.force) {
			await Promise.all(activeRuns.map((run) => this.cancelActiveRun(run)));
			return { deleted: false, sessionId, cancelledRuns: activeRuns.length };
		}
		return { deleted: this.db.deleteSession(clientId, sessionId), sessionId };
	}

	listRuns(clientId: string): RuntimeRunRecord[] {
		return this.db.listRuns(clientId);
	}

	getRunStatus(clientId: string, runId: string): RuntimeRunRecord | undefined {
		return this.db.getRun(clientId, runId);
	}

	async cancelRun(clientId: string, runId: string): Promise<RuntimeRunRecord> {
		const run = this.db.getRun(clientId, runId);
		if (!run) throw new RunApiError("Run not found", 404);
		if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;

		return this.cancelActiveRun(run);
	}

	private async cancelActiveRun(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
		const { clientId, runId } = run;
		await this.queue.requestCancel({ clientId, runId });
		if (run.status === "queued") {
			return this.db.updateRunStatus(runId, clientId, "cancelled");
		}
		if (run.status === "cancelling") {
			return run;
		}
		return this.db.updateRunStatus(runId, clientId, "cancelling");
	}

	listRunEvents(clientId: string, runId: string, afterSeq: number): RuntimeRunEventRecord[] {
		return this.db.listRunEvents(clientId, runId, afterSeq);
	}

	private activeRuns(clientId: string, sessionId: string): RuntimeRunRecord[] {
		return this.db.listRunsForSession(clientId, sessionId).filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
	}

	private hasActiveRun(clientId: string, sessionId: string): boolean {
		return this.activeRuns(clientId, sessionId).length > 0;
	}

	private async seedProjectFiles(sessionId: string, title: string, value: unknown): Promise<void> {
		const files = normalizeProjectFiles(value);
		if (files.length === 0) return;
		if (!this.projectFiles) throw new RunApiError("Project file seeding is not configured", 500);
		try {
			for (const file of files) {
				await this.projectFiles.writeFile({ sessionId, title }, file);
			}
		} catch (error) {
			if (error instanceof RunApiError) throw error;
			throw new RunApiError(`Project file seed failed: ${errorMessage(error)}`, 500);
		}
	}
}

function normalizeMessage(value: unknown): JsonObject {
	if (!isObject(value)) throw new RunApiError("Start run message must be a JSON object", 400);
	return value;
}

function normalizeUserMessageRole(value: unknown): "user" | "user-with-attachments" {
	return value === "user-with-attachments" ? "user-with-attachments" : "user";
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProjectFiles(value: unknown): StartRunProjectFile[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new RunApiError("Start run projectFiles must be an array", 400);
	return value.map((entry, index) => {
		if (!isObject(entry)) throw new RunApiError(`projectFiles[${index}] must be an object`, 400);
		const filename = normalizeOptionalString(entry.filename);
		if (!filename) throw new RunApiError(`projectFiles[${index}].filename is required`, 400);
		if (typeof entry.content !== "string") {
			throw new RunApiError(`projectFiles[${index}].content is required`, 400);
		}
		return { filename, content: entry.content };
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
