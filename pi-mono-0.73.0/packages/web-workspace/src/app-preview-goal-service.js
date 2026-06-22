import { randomUUID } from "node:crypto";
const PM_HANDOFF_CONTINUATION_BUDGET = 8;
const MANUAL_CONTINUATION_BUDGET = 5;
export function budgetForSource(source) {
    return source === "pm_handoff" ? PM_HANDOFF_CONTINUATION_BUDGET : MANUAL_CONTINUATION_BUDGET;
}
export class AppPreviewGoalService {
    db;
    constructor(db) {
        this.db = db;
    }
    enable(input) {
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
    disable(input) {
        const existing = this.db.getAppPreviewGoal(input.clientId, input.sessionId);
        if (!existing)
            return undefined;
        const goal = this.db.updateAppPreviewGoal({
            clientId: input.clientId,
            sessionId: input.sessionId,
            status: "disabled",
            lastRunId: input.runId ?? existing.lastRunId,
        });
        if (!goal)
            return undefined;
        this.event(goal, "goal_disabled", "user_disabled", {}, input.runId);
        return goal;
    }
    get(clientId, sessionId) {
        return this.db.getAppPreviewGoal(clientId, sessionId);
    }
    events(clientId, sessionId, afterEventId) {
        return this.db.listAppPreviewGoalEvents(clientId, sessionId, afterEventId);
    }
    mark(input) {
        return this.db.updateAppPreviewGoal(input);
    }
    event(goal, eventType, reasonCode, payload, runId) {
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
//# sourceMappingURL=app-preview-goal-service.js.map