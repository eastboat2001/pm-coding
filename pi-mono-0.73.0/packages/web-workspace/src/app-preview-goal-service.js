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
    async enable(input) {
        const existing = await this.db.getAppPreviewGoal(input.clientId, input.sessionId);
        const resumeActive = existing?.status === "active";
        const goal = await this.db.upsertAppPreviewGoal({
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
        await this.event(goal, "goal_started", "enabled", { source: input.source }, input.runId);
        return goal;
    }
    async disable(input) {
        const existing = await this.db.getAppPreviewGoal(input.clientId, input.sessionId);
        if (!existing)
            return undefined;
        const goal = await this.db.updateAppPreviewGoal({
            clientId: input.clientId,
            sessionId: input.sessionId,
            status: "disabled",
            lastRunId: input.runId ?? existing.lastRunId,
        });
        if (!goal)
            return undefined;
        await this.event(goal, "goal_disabled", "user_disabled", {}, input.runId);
        return goal;
    }
    async get(clientId, sessionId) {
        return await this.db.getAppPreviewGoal(clientId, sessionId);
    }
    async events(clientId, sessionId, afterEventId) {
        return await this.db.listAppPreviewGoalEvents(clientId, sessionId, afterEventId);
    }
    async mark(input) {
        return await this.db.updateAppPreviewGoal(input);
    }
    async event(goal, eventType, reasonCode, payload, runId) {
        return await this.db.appendAppPreviewGoalEvent({
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