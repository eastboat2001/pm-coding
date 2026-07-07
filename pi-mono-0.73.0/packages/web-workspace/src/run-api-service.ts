import { randomUUID } from "node:crypto";
import type { AppPreviewGoalService } from "./app-preview-goal-service.js";
import { isObject } from "./json.js";
import type { RunQueue } from "./run-queue.js";
import type { RuntimeStore } from "./runtime-store.js";
import type {
	AppPreviewGoalEventRecord,
	AppPreviewGoalRecord,
	AppPreviewGoalSource,
	DeleteSessionResult,
	DiagnosticLogEventInput,
	JsonObject,
	RunStatus,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
	RuntimeSessionRecord,
	StartRunContinuationRequest,
	StartRunProjectFile,
	StartRunRequest,
	StartRunResult,
} from "./types.js";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running", "cancelling"]);
const STALLED_ACTIVE_RUN_STATUS_AGE_MS = 2 * 60 * 1000;
const STALE_ACTIVE_RUN_DELETE_AGE_MS = 30 * 60 * 1000;
const STALLED_ACTIVE_RUN_ERROR = "Stalled active run recovered by runtime status reconciliation";

export interface RunApiDiagnostics {
	writeEvents(input: { events: DiagnosticLogEventInput[] }): unknown;
	deleteSessionEvents?(clientId: string, sessionId: string): Promise<unknown> | unknown;
}

export interface RunProjectFileSeeder {
	ensureWorkspace?(context: { clientId: string; sessionId: string; title: string }): Promise<void> | void;
	writeFile(
		context: { clientId: string; sessionId: string; title: string },
		file: StartRunProjectFile,
	): Promise<void> | void;
}

export interface RunSessionWorkspaceCleaner {
	deleteSessionWorkspace(clientId: string, sessionId: string): Promise<unknown> | unknown;
}

export interface RunSessionLiveEventCleaner {
	deleteSessionEvents(clientId: string, sessionId: string, runIds: readonly string[]): Promise<unknown> | unknown;
}

export interface RunApiOptions {
	stalledActiveRunAgeMs?: number;
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
	private readonly stalledActiveRunAgeMs: number;

	constructor(
		private readonly db: RuntimeStore,
		private readonly queue: RunQueue,
		private readonly diagnostics?: RunApiDiagnostics,
		private readonly projectFiles?: RunProjectFileSeeder,
		private readonly sessionWorkspaces?: RunSessionWorkspaceCleaner,
		private readonly appPreviewGoals?: AppPreviewGoalService,
		private readonly liveEvents?: RunSessionLiveEventCleaner,
		options: RunApiOptions = {},
	) {
		this.stalledActiveRunAgeMs = normalizePositiveNumber(
			options.stalledActiveRunAgeMs,
			STALLED_ACTIVE_RUN_STATUS_AGE_MS,
		);
	}

	async startRun(clientId: string, request: StartRunRequest): Promise<StartRunResult> {
		const appPreviewGoalSource = request.appPreviewGoal?.enabled
			? normalizeAppPreviewGoalSourceForStartRun(request.appPreviewGoal.source)
			: undefined;
		const sessionId = normalizeOptionalString(request.sessionId) ?? randomUUID();
		const existingSession = await this.db.getSession(clientId, sessionId);
		if (existingSession && (await this.hasActiveRun(clientId, sessionId))) {
			throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
		}
		if (!existingSession && request.message === undefined) {
			throw new RunApiError("Start run message is required for new sessions", 400);
		}
		if (request.message !== undefined && request.continuation !== undefined) {
			throw new RunApiError("Continuation metadata is only valid for message-less runs", 400);
		}

		const model = isObject(request.model) ? request.model : (existingSession?.model ?? {});
		const thinkingLevel = normalizeOptionalString(request.thinkingLevel) ?? existingSession?.thinkingLevel ?? "high";
		const title = existingSession?.title ?? normalizeOptionalString(request.title) ?? "Untitled session";
		await this.ensureProjectWorkspace(clientId, sessionId, title);
		await this.seedProjectFiles(clientId, sessionId, title, request.projectFiles);
		if (request.message === undefined) {
			const continuation = normalizeContinuationRequest(request.continuation);
			await this.validateContinuationRequest(clientId, sessionId, continuation);
			const run = await this.db.createContinuationRun({
				clientId,
				sessionId,
				model,
				thinkingLevel,
				runId: randomUUID(),
			});
			if (!run) {
				throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
			}
			await this.enqueueRun(run, continuation);
			await this.applyAppPreviewGoalRequest(clientId, sessionId, run.runId, appPreviewGoalSource);
			return {
				session: await this.requiredSession(clientId, sessionId),
				run,
			};
		}

		const payload = normalizeMessage(request.message);
		const result = await this.db.createRunWithMessage({
			clientId,
			sessionId,
			title,
			model,
			thinkingLevel,
			messageRole: normalizeUserMessageRole(payload.role),
			payload,
			runId: randomUUID(),
		});
		if (!result) {
			throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
		}
		await this.enqueueRun(result.run);
		await this.applyAppPreviewGoalRequest(clientId, sessionId, result.run.runId, appPreviewGoalSource);
		return result;
	}

	private async validateContinuationRequest(
		clientId: string,
		sessionId: string,
		continuation: StartRunContinuationRequest,
	): Promise<void> {
		const parentRun = await this.db.getRun(clientId, continuation.parentRunId);
		if (!parentRun || parentRun.sessionId !== sessionId) {
			throw new RunApiError("Continuation parent run not found", 404);
		}
		if (continuation.source === "interrupted_recovery" && parentRun.status !== "interrupted") {
			throw new RunApiError("Interrupted recovery continuation requires an interrupted parent run", 409);
		}
		const session = await this.requiredSession(clientId, sessionId);
		if (session.lastRunId && session.lastRunId !== parentRun.runId) {
			throw new RunApiError("Continuation parent run must be the latest session run", 409);
		}
	}

	private async requiredSession(clientId: string, sessionId: string): Promise<RuntimeSessionRecord> {
		const session = await this.db.getSession(clientId, sessionId);
		if (!session) throw new RunApiError("Runtime session not found", 404);
		return session;
	}

	private async enqueueRun(run: RuntimeRunRecord, continuation?: StartRunContinuationRequest): Promise<void> {
		try {
			await this.queue.enqueue({ clientId: run.clientId, runId: run.runId });
		} catch (error) {
			const cause = errorMessage(error);
			const message = `queue enqueue failed: ${cause}`;
			await this.db.updateRunStatus(run.runId, run.clientId, "failed", { error: message });
			this.writeDiagnosticEvents([
				{
					level: "error",
					category: "agent",
					eventType: "agent.run.enqueue.error",
					sessionId: run.sessionId,
					traceId: run.sessionId,
					data: {
						clientId: run.clientId,
						sessionId: run.sessionId,
						runId: run.runId,
						status: "failed",
						message: cause,
						...(continuation
							? { continuationSource: continuation.source, parentRunId: continuation.parentRunId }
							: {}),
					},
				},
			]);
			throw new RunApiError("Run queue unavailable", 503);
		}
		this.writeDiagnosticEvents([
			{
				level: "info",
				category: "agent",
				eventType: "agent.run.enqueued",
				sessionId: run.sessionId,
				traceId: run.sessionId,
				data: {
					clientId: run.clientId,
					sessionId: run.sessionId,
					runId: run.runId,
					status: "queued",
					...(continuation
						? { continuationSource: continuation.source, parentRunId: continuation.parentRunId }
						: {}),
				},
			},
		]);
	}

	private writeDiagnosticEvents(events: DiagnosticLogEventInput[]): void {
		try {
			this.diagnostics?.writeEvents({ events });
		} catch {
			// Diagnostics must never interrupt runtime control paths.
		}
	}

	async listSessions(clientId: string): Promise<RuntimeSessionRecord[]> {
		await this.markStalledActiveRunsForClient(clientId);
		return await this.db.listSessions(clientId);
	}

	async getSession(clientId: string, sessionId: string): Promise<RuntimeSessionDetail | undefined> {
		let session = await this.db.getSession(clientId, sessionId);
		if (!session) return undefined;
		const storedMessages = await this.db.listMessages(clientId, sessionId);
		const runs = await this.reconcileStalledActiveRuns(await this.db.listRunsForSession(clientId, sessionId));
		session = (await this.db.getSession(clientId, sessionId)) ?? session;
		const messages = withSyntheticCancelledRunMarker(storedMessages, runs);
		const activeRun = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
		if (!activeRun) {
			return {
				session,
				messages,
				runs,
			};
		}
		const checkpointEvent = await this.db.getLatestRunCheckpoint(clientId, activeRun.runId);
		return {
			session,
			messages,
			runs,
			activeRun: {
				run: activeRun,
				...(checkpointEvent ? { checkpointEvent } : {}),
				afterSeq: checkpointEvent?.seq ?? 0,
			},
		};
	}

	async renameSession(clientId: string, sessionId: string, title: string): Promise<RuntimeSessionRecord> {
		const nextTitle = normalizeOptionalString(title);
		if (!nextTitle) throw new RunApiError("Session title is required", 400);
		if (nextTitle.length > 160) throw new RunApiError("Session title must be 160 characters or fewer", 400);
		const session = await this.db.updateSessionTitle(clientId, sessionId, nextTitle);
		if (!session) throw new RunApiError("Session not found.", 404);
		return session;
	}

	async deleteSession(
		clientId: string,
		sessionId: string,
		options: { force?: boolean } = {},
	): Promise<DeleteSessionResult> {
		const activeRuns = await this.activeRuns(clientId, sessionId);
		if (activeRuns.length > 0 && !options.force) {
			throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
		}
		if (activeRuns.length > 0 && options.force) {
			if (activeRuns.every((run) => isStaleActiveRun(run, STALE_ACTIVE_RUN_DELETE_AGE_MS))) {
				for (const run of activeRuns) {
					await this.markStaleActiveRunTerminal(run);
				}
				const runIds = await this.sessionRunIds(clientId, sessionId);
				const deleted = await this.db.deleteSession(clientId, sessionId);
				if (deleted || options.force) await this.sessionWorkspaces?.deleteSessionWorkspace(clientId, sessionId);
				if (deleted || options.force) await this.cleanupDeletedSession(clientId, sessionId, runIds);
				return { deleted, sessionId, cancelledRuns: activeRuns.length };
			}
			await Promise.all(activeRuns.map((run) => this.cancelActiveRun(run)));
			return { deleted: false, sessionId, cancelledRuns: activeRuns.length };
		}
		const runIds = await this.sessionRunIds(clientId, sessionId);
		const deleted = await this.db.deleteSession(clientId, sessionId);
		if (deleted || options.force) await this.sessionWorkspaces?.deleteSessionWorkspace(clientId, sessionId);
		if (deleted || options.force) await this.cleanupDeletedSession(clientId, sessionId, runIds);
		return { deleted, sessionId };
	}

	async listRuns(clientId: string): Promise<RuntimeRunRecord[]> {
		return await this.reconcileStalledActiveRuns(await this.db.listRuns(clientId));
	}

	async getRunStatus(clientId: string, runId: string): Promise<RuntimeRunRecord | undefined> {
		const run = await this.db.getRun(clientId, runId);
		return run ? await this.reconcileStalledActiveRun(run) : undefined;
	}

	async getRunForEvents(clientId: string, runId: string): Promise<RuntimeRunRecord> {
		const run = await this.db.getRun(clientId, runId);
		if (!run) throw new RunApiError("Run not found.", 404);
		return await this.reconcileStalledActiveRun(run);
	}

	async cancelRun(clientId: string, runId: string): Promise<RuntimeRunRecord> {
		const run = await this.db.getRun(clientId, runId);
		if (!run) throw new RunApiError("Run not found", 404);
		if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;

		return this.cancelActiveRun(run);
	}

	private async cancelActiveRun(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
		const { clientId, runId } = run;
		await this.queue.requestCancel({ clientId, runId });
		if (run.status === "queued") {
			return await this.db.updateRunStatus(runId, clientId, "cancelled");
		}
		if (run.status === "cancelling") {
			return run;
		}
		return await this.db.updateRunStatus(runId, clientId, "cancelling");
	}

	private async markStaleActiveRunTerminal(
		run: RuntimeRunRecord,
		error = "Deleted stale active run",
	): Promise<RuntimeRunRecord> {
		const status = run.status === "queued" ? "cancelled" : "interrupted";
		const updated = await this.db.updateRunStatus(run.runId, run.clientId, status, {
			error,
		});
		await this.applyAppPreviewGoalTerminalStatus(updated);
		this.writeDiagnosticEvents([
			{
				level: "warn",
				category: "agent",
				eventType: "agent.run.stale_active_terminal",
				sessionId: run.sessionId,
				traceId: run.sessionId,
				data: {
					clientId: run.clientId,
					sessionId: run.sessionId,
					runId: run.runId,
					previousStatus: run.status,
					status: updated.status,
					error,
				},
			},
		]);
		return updated;
	}

	async listRunEvents(clientId: string, runId: string, afterSeq: number): Promise<RuntimeRunEventRecord[]> {
		return compactRunEventsForClient(await this.db.listRunEvents(clientId, runId, afterSeq));
	}

	async listDurableRunEvents(clientId: string, runId: string, afterSeq: number): Promise<RuntimeRunEventRecord[]> {
		return compactRunEventsForClient(await this.db.listRunEvents(clientId, runId, afterSeq));
	}

	async getAppPreviewGoal(clientId: string, sessionId: string): Promise<AppPreviewGoalRecord | undefined> {
		return await this.appPreviewGoals?.get(clientId, sessionId);
	}

	async listAppPreviewGoalEvents(
		clientId: string,
		sessionId: string,
		afterEventId = 0,
	): Promise<AppPreviewGoalEventRecord[]> {
		return (await this.appPreviewGoals?.events(clientId, sessionId, afterEventId)) ?? [];
	}

	async enableAppPreviewGoal(
		clientId: string,
		sessionId: string,
		source: AppPreviewGoalSource,
	): Promise<AppPreviewGoalRecord | undefined> {
		if (!this.appPreviewGoals) return undefined;
		await this.requiredSession(clientId, sessionId);
		return await this.appPreviewGoals.enable({ clientId, sessionId, source });
	}

	async disableAppPreviewGoal(clientId: string, sessionId: string): Promise<AppPreviewGoalRecord | undefined> {
		return await this.appPreviewGoals?.disable({ clientId, sessionId });
	}

	private async activeRuns(clientId: string, sessionId: string): Promise<RuntimeRunRecord[]> {
		return (await this.db.listRunsForSession(clientId, sessionId)).filter((run) =>
			ACTIVE_RUN_STATUSES.has(run.status),
		);
	}

	private async sessionRunIds(clientId: string, sessionId: string): Promise<string[]> {
		return (await this.db.listRunsForSession(clientId, sessionId)).map((run) => run.runId);
	}

	private async hasActiveRun(clientId: string, sessionId: string): Promise<boolean> {
		return (await this.activeRuns(clientId, sessionId)).length > 0;
	}

	private async markStalledActiveRunsForClient(clientId: string): Promise<void> {
		for (const session of await this.db.listSessions(clientId)) {
			for (const run of await this.activeRuns(clientId, session.sessionId)) {
				if (isStaleActiveRun(run, this.stalledActiveRunAgeMs)) {
					await this.markStaleActiveRunTerminal(run, STALLED_ACTIVE_RUN_ERROR);
				}
			}
		}
	}

	private async reconcileStalledActiveRuns(runs: RuntimeRunRecord[]): Promise<RuntimeRunRecord[]> {
		const reconciled: RuntimeRunRecord[] = [];
		for (const run of runs) {
			reconciled.push(await this.reconcileStalledActiveRun(run));
		}
		return reconciled;
	}

	private async reconcileStalledActiveRun(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
		if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
		if (!isStaleActiveRun(run, this.stalledActiveRunAgeMs)) return run;
		return await this.markStaleActiveRunTerminal(run, STALLED_ACTIVE_RUN_ERROR);
	}

	private async applyAppPreviewGoalTerminalStatus(run: RuntimeRunRecord): Promise<void> {
		if (!this.appPreviewGoals) return;
		const goal = await this.appPreviewGoals.get(run.clientId, run.sessionId);
		if (!goal || goal.status !== "active") return;
		if (goal.lastRunId && goal.lastRunId !== run.runId) return;

		if (run.status === "cancelled") {
			const updated = await this.appPreviewGoals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "cancelled",
				lastRunId: run.runId,
				lastFailureReason: "run_cancelled",
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.appPreviewGoals.event(
					updated,
					"blocked",
					"run_cancelled",
					{ terminalStatus: run.status },
					run.runId,
				);
			}
			return;
		}

		if (run.status === "interrupted") {
			const updated = await this.appPreviewGoals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "blocked",
				lastRunId: run.runId,
				lastFailureReason: "run_interrupted",
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.appPreviewGoals.event(
					updated,
					"blocked",
					"run_interrupted",
					{ terminalStatus: run.status },
					run.runId,
				);
			}
		}
	}

	private async ensureProjectWorkspace(clientId: string, sessionId: string, title: string): Promise<void> {
		if (!this.projectFiles?.ensureWorkspace) return;
		try {
			await this.projectFiles.ensureWorkspace({ clientId, sessionId, title });
		} catch (error) {
			if (error instanceof RunApiError) throw error;
			throw new RunApiError(`Project workspace init failed: ${errorMessage(error)}`, 500);
		}
	}

	private async seedProjectFiles(clientId: string, sessionId: string, title: string, value: unknown): Promise<void> {
		const files = normalizeProjectFiles(value);
		if (files.length === 0) return;
		if (!this.projectFiles) throw new RunApiError("Project file seeding is not configured", 500);
		try {
			for (const file of files) {
				await this.projectFiles.writeFile({ clientId, sessionId, title }, file);
			}
		} catch (error) {
			if (error instanceof RunApiError) throw error;
			throw new RunApiError(`Project file seed failed: ${errorMessage(error)}`, 500);
		}
	}

	private async applyAppPreviewGoalRequest(
		clientId: string,
		sessionId: string,
		runId: string,
		source: AppPreviewGoalSource | undefined,
	): Promise<void> {
		if (!source) return;
		await this.appPreviewGoals?.enable({
			clientId,
			sessionId,
			runId,
			source,
		});
	}

	private async cleanupDeletedSession(clientId: string, sessionId: string, runIds: readonly string[]): Promise<void> {
		const failures: Array<{ target: string; message: string }> = [];
		try {
			await this.diagnostics?.deleteSessionEvents?.(clientId, sessionId);
		} catch (error) {
			failures.push({ target: "diagnostics", message: errorMessage(error) });
		}
		try {
			await this.liveEvents?.deleteSessionEvents(clientId, sessionId, runIds);
		} catch (error) {
			failures.push({ target: "liveEvents", message: errorMessage(error) });
		}
		if (failures.length === 0) return;
		this.writeDiagnosticEvents([
			{
				level: "warn",
				category: "storage",
				eventType: "runtime.session_delete.cleanup_failed",
				sessionId,
				traceId: sessionId,
				data: {
					clientId,
					sessionId,
					runIds,
					failures,
				},
			},
		]);
	}
}

function normalizeMessage(value: unknown): JsonObject {
	if (!isObject(value)) throw new RunApiError("Start run message must be a JSON object", 400);
	return value;
}

function normalizeContinuationRequest(value: unknown): StartRunContinuationRequest {
	if (!isObject(value)) throw new RunApiError("Continuation metadata is required for message-less runs", 400);
	if (value.source !== "interrupted_recovery") {
		throw new RunApiError('Continuation source must be "interrupted_recovery"', 400);
	}
	const parentRunId = normalizeOptionalString(value.parentRunId);
	if (!parentRunId) throw new RunApiError("Continuation parentRunId is required", 400);
	return {
		source: "interrupted_recovery",
		parentRunId,
	};
}

function withSyntheticCancelledRunMarker(
	messages: RuntimeMessageRecord[],
	runs: RuntimeRunRecord[],
): RuntimeMessageRecord[] {
	const latestCancelledRun = runs
		.filter((run) => run.status === "cancelled")
		.sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt))[0];
	if (!latestCancelledRun) return messages;
	if (hasCancelledAssistantMessageForRun(messages, latestCancelledRun)) return messages;
	return [...messages, createSyntheticCancelledRunMessage(latestCancelledRun, messages)];
}

function hasCancelledAssistantMessageForRun(messages: RuntimeMessageRecord[], run: RuntimeRunRecord): boolean {
	const startedAt = timestampValue(run.startedAt || run.updatedAt);
	return messages.some((message) => {
		if (message.role !== "assistant") return false;
		if (!isCancelledAssistantMessage(message)) return false;
		if (!startedAt) return true;
		return timestampValue(message.createdAt) >= startedAt;
	});
}

function isCancelledAssistantMessage(message: RuntimeMessageRecord): boolean {
	const payload = isObject(message.payload) ? message.payload : {};
	return payload.stopReason === "aborted" || payload.errorMessage === "Request was aborted.";
}

export function compactRunEventsForClient(events: RuntimeRunEventRecord[]): RuntimeRunEventRecord[] {
	const compacted: RuntimeRunEventRecord[] = [];
	let pendingMessageUpdate: RuntimeRunEventRecord | undefined;
	for (const event of events) {
		if (event.type === "message_update") {
			pendingMessageUpdate = event;
			continue;
		}
		if (event.type === "message_end") {
			pendingMessageUpdate = undefined;
			compacted.push(event);
			continue;
		}
		if (pendingMessageUpdate) {
			compacted.push(pendingMessageUpdate);
			pendingMessageUpdate = undefined;
		}
		compacted.push(event);
	}
	if (pendingMessageUpdate) compacted.push(pendingMessageUpdate);
	return compacted;
}

function createSyntheticCancelledRunMessage(
	run: RuntimeRunRecord,
	messages: RuntimeMessageRecord[],
): RuntimeMessageRecord {
	const createdAt = run.endedAt || run.updatedAt || new Date().toISOString();
	const timestamp = timestampValue(createdAt) || Date.now();
	return {
		messageId: Math.max(0, ...messages.map((message) => message.messageId)) + 1,
		sessionId: run.sessionId,
		clientId: run.clientId,
		role: "assistant",
		payload: {
			role: "assistant",
			content: [],
			api: "remote-run",
			provider: "remote-run",
			model: "remote-run",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
			timestamp,
		},
		createdAt,
		synthetic: true,
	};
}

function normalizeUserMessageRole(value: unknown): "user" | "user-with-attachments" {
	return value === "user-with-attachments" ? "user-with-attachments" : "user";
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeAppPreviewGoalSourceForStartRun(value: unknown): AppPreviewGoalSource {
	if (value === "manual" || value === "pm_handoff") return value;
	throw new RunApiError('App preview goal source must be "manual" or "pm_handoff"', 400);
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

function isStaleActiveRun(run: RuntimeRunRecord, ageMs: number): boolean {
	if (run.status === "cancelling" && run.startedAt && isStaleTimestamp(run.startedAt, ageMs)) return true;
	return isStaleTimestamp(run.updatedAt, ageMs);
}

function isStaleTimestamp(value: string, ageMs: number): boolean {
	const timestampMs = Date.parse(value);
	return Number.isFinite(timestampMs) && Date.now() - timestampMs >= ageMs;
}

function timestampValue(value: string | undefined): number {
	if (!value) return 0;
	const timestampMs = Date.parse(value);
	return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
