import { randomUUID } from "node:crypto";
import type { AppPreviewGoalService } from "./app-preview-goal-service.js";
import type { PreviewReadinessChecker, PreviewReadinessResult } from "./preview-readiness-checker.js";
import { RetryPolicy } from "./retry-policy.js";
import type { RunQueue } from "./run-queue.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { RunStatus, RuntimeRunEventRecord, RuntimeRunRecord } from "./types.js";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["queued", "running", "cancelling"]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["cancelled", "completed", "failed", "interrupted"]);
const NON_DURABLE_PROVIDER_RETRY_EVENTS = new Set(["agent_retry_scheduled", "agent_retry_exhausted"]);
const PROVIDER_TRANSIENT_FAILURE_REASON = "provider_transient_error";
const RETRY_POLICY = new RetryPolicy();

export interface AppPreviewGoalSupervisorOptions {
	db: RuntimeStore;
	queue: RunQueue;
	goals: AppPreviewGoalService;
	readiness: Pick<PreviewReadinessChecker, "check">;
	createRunId?: () => string;
}

export class AppPreviewGoalSupervisor {
	private readonly db: RuntimeStore;
	private readonly queue: RunQueue;
	private readonly goals: AppPreviewGoalService;
	private readonly readiness: Pick<PreviewReadinessChecker, "check">;
	private readonly createRunId: () => string;

	constructor(options: AppPreviewGoalSupervisorOptions) {
		this.db = options.db;
		this.queue = options.queue;
		this.goals = options.goals;
		this.readiness = options.readiness;
		this.createRunId = options.createRunId ?? randomUUID;
	}

	async afterRunTerminal(run: RuntimeRunRecord): Promise<void> {
		if (!TERMINAL_RUN_STATUSES.has(run.status)) return;

		const goal = await this.goals.get(run.clientId, run.sessionId);
		if (!goal || goal.status !== "active") return;
		if (goal.lastRunId && goal.lastRunId !== run.runId) return;

		if (run.status === "cancelled") {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "cancelled",
				lastRunId: run.runId,
				lastFailureReason: "run_cancelled",
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.goals.event(updated, "blocked", "run_cancelled", { terminalStatus: run.status }, run.runId);
			}
			return;
		}

		if (run.status === "interrupted") {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "blocked",
				lastRunId: run.runId,
				lastFailureReason: "run_interrupted",
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.goals.event(updated, "blocked", "run_interrupted", { terminalStatus: run.status }, run.runId);
			}
			return;
		}

		if (
			isTransientProviderFailureWithoutDurableOutput(
				run,
				await this.db.listRunEvents(run.clientId, run.runId, 0),
			)
		) {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "blocked",
				lastRunId: run.runId,
				lastFailureReason: PROVIDER_TRANSIENT_FAILURE_REASON,
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.goals.event(
					updated,
					"retry_exhausted",
					"transient_provider_error",
					{ terminalStatus: run.status, errorMessage: run.error ?? "unknown provider error" },
					run.runId,
				);
			}
			return;
		}

		const session = await this.db.getSession(run.clientId, run.sessionId);
		if (!session) return;

		const readiness = await this.readiness.check({
			clientId: run.clientId,
			sessionId: run.sessionId,
			title: session.title,
		});

		if (readiness.ready) {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "preview_ready",
				lastRunId: run.runId,
				lastPreviewUrl: readiness.previewUrl,
				lastFailureReason: null,
				completedAt: new Date().toISOString(),
			});
			if (updated) await this.goals.event(updated, "preview_ready", "ready", readiness, run.runId);
			return;
		}

		if (goal.continuationRunsUsed >= goal.maxContinuationRuns) {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "budget_limited",
				lastRunId: run.runId,
				lastFailureReason: readiness.reasonCode,
				completedAt: new Date().toISOString(),
			});
			if (updated) await this.goals.event(updated, "budget_limited", readiness.reasonCode, readiness, run.runId);
			return;
		}

		if (await this.hasOtherActiveRun(run)) return;

		const continuationRunId = this.createRunId();
		const continuation = await this.db.createContinuationRun({
			runId: continuationRunId,
			clientId: run.clientId,
			sessionId: run.sessionId,
			model: run.model,
			thinkingLevel: run.thinkingLevel,
		});
		if (!continuation) return;

		try {
			await this.queue.enqueue({ clientId: continuation.clientId, runId: continuation.runId });
		} catch (error) {
			const message = safeErrorMessage(error);
			await this.db.updateRunStatus(continuation.runId, continuation.clientId, "failed", {
				error: `queue enqueue failed: ${message}`,
			});
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "blocked",
				lastRunId: continuation.runId,
				lastFailureReason: "queue_unavailable",
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.goals.event(
					updated,
					"queue_unavailable",
					"queue_unavailable",
					{
						errorMessage: message,
						failedRunId: continuation.runId,
						readiness,
					},
					continuation.runId,
				);
			}
			return;
		}
		const updated = await this.goals.mark({
			clientId: run.clientId,
			sessionId: run.sessionId,
			status: "active",
			continuationRunsUsed: goal.continuationRunsUsed + 1,
			lastRunId: continuation.runId,
			lastFailureReason: readiness.reasonCode,
		});
		if (!updated) return;

		await this.goals.event(updated, "preview_check_failed", readiness.reasonCode, readiness, run.runId);
		await this.goals.event(
			updated,
			"continuation_scheduled",
			"readiness_not_ready",
			continuationPayload(continuation.runId, readiness),
			continuation.runId,
		);
	}

	private async hasOtherActiveRun(run: RuntimeRunRecord): Promise<boolean> {
		return (await this.db.listRunsForSession(run.clientId, run.sessionId)).some(
			(candidate) => candidate.runId !== run.runId && ACTIVE_RUN_STATUSES.has(candidate.status),
		);
	}
}

function continuationPayload(
	runId: string,
	readiness: PreviewReadinessResult,
): PreviewReadinessResult & { runId: string } {
	return { ...readiness, runId };
}

function isTransientProviderFailureWithoutDurableOutput(
	run: RuntimeRunRecord,
	events: RuntimeRunEventRecord[],
): boolean {
	if (run.status !== "failed" || !run.error) return false;
	const classification = RETRY_POLICY.classify(new Error(run.error));
	if (!classification.retryable || classification.reasonCode !== "transient_provider_error") return false;
	return !events.some((event) => !NON_DURABLE_PROVIDER_RETRY_EVENTS.has(event.type));
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "unknown error";
}
