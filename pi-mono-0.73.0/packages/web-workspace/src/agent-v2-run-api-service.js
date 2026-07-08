import { randomUUID } from "node:crypto";
export class AgentV2RunApiError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "AgentV2RunApiError";
    }
}
export class AgentV2RunApiService {
    createRunId;
    events;
    now;
    queue;
    store;
    constructor(options) {
        this.store = options.store;
        this.queue = options.queue;
        this.events = options.events;
        this.now = options.now ?? (() => new Date().toISOString());
        this.createRunId = options.createRunId ?? (() => randomUUID());
    }
    async startRun(clientId, request) {
        const createdAt = request.createdAt ?? this.now();
        const run = await this.store.createAgentV2Run({
            clientId,
            runId: request.runId ?? this.createRunId(),
            input: request.input,
            model: request.model ?? {},
            createdAt,
            updatedAt: request.updatedAt ?? createdAt,
        });
        await this.queue.enqueue({ clientId: run.clientId, runId: run.runId });
        await this.events.append({
            clientId: run.clientId,
            runId: run.runId,
            type: "agent_v2.run_created",
            payload: {
                type: "agent_v2.run_created",
                status: run.status,
                phase: run.phase,
                attempt: run.attempt,
                at: run.updatedAt,
            },
            createdAt: run.updatedAt,
        });
        return run;
    }
    async cancelRun(clientId, runId) {
        const run = await this.requireRun(clientId, runId);
        if (isTerminalRun(run.status)) {
            return run;
        }
        await this.queue.requestCancel({ clientId, runId });
        const updatedAt = this.now();
        if (run.status === "queued") {
            const cancelled = await this.store.updateAgentV2RunWithResult({
                clientId,
                runId,
                status: "cancelled",
                phase: "cancelled",
                updatedAt,
                endedAt: updatedAt,
                expectedStatuses: ["queued"],
            });
            if (cancelled.applied) {
                await this.appendPhaseEvent(cancelled.run, "cancelled");
            }
            return cancelled.run;
        }
        if (run.status === "cancelling") {
            return run;
        }
        const cancelling = await this.store.updateAgentV2RunWithResult({
            clientId,
            runId,
            status: "cancelling",
            updatedAt,
            expectedStatuses: ["running"],
        });
        if (cancelling.applied) {
            await this.appendPhaseEvent(cancelling.run, cancelling.run.status);
        }
        return cancelling.run;
    }
    async getRun(clientId, runId) {
        return await this.store.getAgentV2Run(clientId, runId);
    }
    async listRuns(clientId) {
        return await this.store.listAgentV2Runs(clientId);
    }
    async listRunEvents(clientId, runId, afterSeq) {
        return await this.events.list(clientId, runId, afterSeq);
    }
    async appendPhaseEvent(run, status) {
        await this.events.append({
            clientId: run.clientId,
            runId: run.runId,
            type: "agent_v2.phase_changed",
            payload: {
                type: "agent_v2.phase_changed",
                phase: run.phase,
                status,
                attempt: run.attempt,
                at: run.updatedAt,
            },
            createdAt: run.updatedAt,
        });
    }
    async requireRun(clientId, runId) {
        const run = await this.store.getAgentV2Run(clientId, runId);
        if (!run) {
            throw new AgentV2RunApiError("Agent v2 run not found", 404);
        }
        return run;
    }
}
function isTerminalRun(status) {
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}
//# sourceMappingURL=agent-v2-run-api-service.js.map