import { randomUUID } from "node:crypto";
import type { AppPreviewGoalService } from "./app-preview-goal-service.js";
import type { PreviewReadinessChecker } from "./preview-readiness-checker.js";
import { RetryPolicy } from "./retry-policy.js";
import type { RunQueue } from "./run-queue.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { AppPreviewGoalRecord, JsonObject, RunStatus, RuntimeRunEventRecord, RuntimeRunRecord } from "./types.js";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["queued", "running", "cancelling"]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["cancelled", "completed", "failed", "interrupted"]);
const NON_DURABLE_PROVIDER_RETRY_EVENTS = new Set(["agent_retry_scheduled", "agent_retry_exhausted"]);
const PROVIDER_TRANSIENT_FAILURE_REASON = "provider_transient_error";
const RETRY_POLICY = new RetryPolicy();

interface RunGuardFailure {
	reasonCode: string;
	guardLimit: string;
}

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

		const runGuardFailure = classifyRunGuardFailure(run);
		if (runGuardFailure) {
			const updated = await this.goals.mark({
				clientId: run.clientId,
				sessionId: run.sessionId,
				status: "blocked",
				lastRunId: run.runId,
				lastFailureReason: runGuardFailure.reasonCode,
				completedAt: new Date().toISOString(),
			});
			if (updated) {
				await this.goals.event(
					updated,
					"blocked",
					runGuardFailure.reasonCode,
					{
						terminalStatus: run.status,
						errorMessage: run.error ?? "run guard limit exceeded",
						guardLimit: runGuardFailure.guardLimit,
					},
					run.runId,
				);
			}
			return;
		}

		const runEvents = await this.db.listRunEvents(run.clientId, run.runId, 0);
		if (isTransientProviderFailureWithoutDurableOutput(run, runEvents)) {
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

		if (isNonReplayableTransientProviderFailureWithDurableOutput(run, runEvents)) {
			if (goal.continuationRunsUsed >= goal.maxContinuationRuns) {
				const updated = await this.goals.mark({
					clientId: run.clientId,
					sessionId: run.sessionId,
					status: "budget_limited",
					lastRunId: run.runId,
					lastFailureReason: PROVIDER_TRANSIENT_FAILURE_REASON,
					completedAt: new Date().toISOString(),
				});
				if (updated) {
					await this.goals.event(
						updated,
						"budget_limited",
						"transient_provider_error",
						{ terminalStatus: run.status, errorMessage: run.error },
						run.runId,
					);
				}
				return;
			}
			if (await this.hasOtherActiveRun(run)) return;
			await this.scheduleContinuation(run, goal, PROVIDER_TRANSIENT_FAILURE_REASON, "transient_provider_error", {
				terminalStatus: run.status,
				errorMessage: run.error ?? "unknown provider error",
			});
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

		await this.scheduleContinuation(run, goal, readiness.reasonCode, "readiness_not_ready", readiness, { readiness });
	}

	private async scheduleContinuation(
		run: RuntimeRunRecord,
		goal: AppPreviewGoalRecord,
		lastFailureReason: string,
		eventReasonCode: string,
		eventPayload: JsonObject,
		queueFailurePayload: JsonObject = eventPayload,
	): Promise<void> {
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
						...queueFailurePayload,
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
			lastFailureReason,
		});
		if (!updated) return;

		if (eventReasonCode === "readiness_not_ready") {
			await this.goals.event(updated, "preview_check_failed", lastFailureReason, eventPayload, run.runId);
		}
		await this.goals.event(
			updated,
			"continuation_scheduled",
			eventReasonCode,
			{ ...eventPayload, runId: continuation.runId },
			continuation.runId,
		);
	}

	private async hasOtherActiveRun(run: RuntimeRunRecord): Promise<boolean> {
		return (await this.db.listRunsForSession(run.clientId, run.sessionId)).some(
			(candidate) => candidate.runId !== run.runId && ACTIVE_RUN_STATUSES.has(candidate.status),
		);
	}
}

function classifyRunGuardFailure(run: RuntimeRunRecord): RunGuardFailure | undefined {
	if (run.status !== "failed" || !run.error) return undefined;
	const error = run.error.toLowerCase();
	if (!error.includes("run guard exceeded")) return undefined;
	if (error.includes("max agent turns")) return { reasonCode: "max_agent_turns", guardLimit: "agent_turns" };
	if (error.includes("max agent tool executions")) {
		return { reasonCode: "max_agent_tool_executions", guardLimit: "agent_tool_executions" };
	}
	return { reasonCode: "run_guard_limit_exceeded", guardLimit: "unknown" };
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

function isNonReplayableTransientProviderFailureWithDurableOutput(
	run: RuntimeRunRecord,
	events: RuntimeRunEventRecord[],
): boolean {
	if (run.status !== "failed" || !run.error) return false;
	if (!run.error.includes("non-replayable side effects")) return false;
	const classification = RETRY_POLICY.classify(new Error(run.error));
	if (!classification.retryable || classification.reasonCode !== "transient_provider_error") return false;
	return events.some((event) => !NON_DURABLE_PROVIDER_RETRY_EVENTS.has(event.type));
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "unknown error";
}
