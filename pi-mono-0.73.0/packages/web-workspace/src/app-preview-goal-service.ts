import { randomUUID } from "node:crypto";
import type { RuntimeDbStore } from "./runtime-db.js";
import type {
	AppPreviewGoalEventRecord,
	AppPreviewGoalEventType,
	AppPreviewGoalRecord,
	AppPreviewGoalSource,
	JsonObject,
	UpdateAppPreviewGoalInput,
} from "./types.js";

const PM_HANDOFF_CONTINUATION_BUDGET = 8;
const MANUAL_CONTINUATION_BUDGET = 5;

export interface EnableAppPreviewGoalInput {
	clientId: string;
	sessionId: string;
	source: AppPreviewGoalSource;
	runId?: string;
}

export interface DisableAppPreviewGoalInput {
	clientId: string;
	sessionId: string;
	runId?: string;
}

export function budgetForSource(source: AppPreviewGoalSource): number {
	return source === "pm_handoff" ? PM_HANDOFF_CONTINUATION_BUDGET : MANUAL_CONTINUATION_BUDGET;
}

export class AppPreviewGoalService {
	constructor(private readonly db: RuntimeDbStore) {}

	enable(input: EnableAppPreviewGoalInput): AppPreviewGoalRecord {
		const existing = this.db.getAppPreviewGoal(input.clientId, input.sessionId);
		const resumeActive = existing?.status === "active";
		const goal = this.db.upsertAppPreviewGoal({
			goalId: existing?.goalId ?? randomUUID(),
			clientId: input.clientId,
			sessionId: input.sessionId,
			source: input.source,
			status: "active",
			maxContinuationRuns: budgetForSource(input.source),
			continuationRunsUsed: resumeActive ? existing.continuationRunsUsed : 0,
			retryAttemptsUsed: resumeActive ? existing.retryAttemptsUsed : 0,
			lastRunId: input.runId ?? (resumeActive ? existing.lastRunId : undefined),
			lastPreviewUrl: resumeActive ? existing.lastPreviewUrl : undefined,
			lastFailureReason: resumeActive ? existing.lastFailureReason : undefined,
			createdAt: existing?.createdAt,
			completedAt: resumeActive ? existing.completedAt : undefined,
		});
		this.event(goal, "goal_started", "enabled", { source: input.source }, input.runId);
		return goal;
	}

	disable(input: DisableAppPreviewGoalInput): AppPreviewGoalRecord | undefined {
		const existing = this.db.getAppPreviewGoal(input.clientId, input.sessionId);
		if (!existing) return undefined;

		const goal = this.db.updateAppPreviewGoal({
			clientId: input.clientId,
			sessionId: input.sessionId,
			status: "disabled",
			lastRunId: input.runId ?? existing.lastRunId,
		});
		if (!goal) return undefined;

		this.event(goal, "goal_disabled", "user_disabled", {}, input.runId);
		return goal;
	}

	get(clientId: string, sessionId: string): AppPreviewGoalRecord | undefined {
		return this.db.getAppPreviewGoal(clientId, sessionId);
	}

	events(clientId: string, sessionId: string, afterEventId: number): AppPreviewGoalEventRecord[] {
		return this.db.listAppPreviewGoalEvents(clientId, sessionId, afterEventId);
	}

	mark(input: UpdateAppPreviewGoalInput): AppPreviewGoalRecord | undefined {
		return this.db.updateAppPreviewGoal(input);
	}

	event(
		goal: AppPreviewGoalRecord,
		eventType: AppPreviewGoalEventType,
		reasonCode?: string,
		payload?: JsonObject,
		runId?: string,
	): AppPreviewGoalEventRecord {
		return this.db.appendAppPreviewGoalEvent({
			goalId: goal.goalId,
			clientId: goal.clientId,
			sessionId: goal.sessionId,
			runId,
			eventType,
			reasonCode,
			payload,
		});
	}
}
