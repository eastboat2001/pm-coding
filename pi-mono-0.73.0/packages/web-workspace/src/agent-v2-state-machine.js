import { AGENT_V2_PHASES, AGENT_V2_RUN_STATUSES, } from "./agent-v2-types.js";
const RUN_TRANSITIONS = {
    queued: ["running", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
};
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export function assertAgentV2RunTransition(from, to) {
    if (!RUN_TRANSITIONS[from].includes(to)) {
        throw new Error(`Invalid Agent v2 run transition: ${from} -> ${to}`);
    }
}
export function advanceAgentV2Phase(phase) {
    const index = AGENT_V2_PHASES.indexOf(phase);
    return index === -1 || index === AGENT_V2_PHASES.length - 1 ? phase : AGENT_V2_PHASES[index + 1];
}
export function createAgentV2RunSnapshot(input) {
    const timestamp = input.createdAt ?? input.updatedAt ?? new Date().toISOString();
    const snapshot = {
        clientId: input.clientId,
        runId: input.runId,
        status: "queued",
        phase: "intake",
        attempt: 1,
        input: input.input,
        model: input.model,
        createdAt: timestamp,
        updatedAt: input.updatedAt ?? timestamp,
    };
    if (input.workerId !== undefined)
        snapshot.workerId = input.workerId;
    if (input.startedAt !== undefined)
        snapshot.startedAt = input.startedAt;
    if (input.endedAt !== undefined)
        snapshot.endedAt = input.endedAt;
    if (input.error !== undefined)
        snapshot.error = input.error;
    return snapshot;
}
export function transitionAgentV2RunSnapshot(snapshot, to, patch = {}) {
    assertAgentV2RunTransition(snapshot.status, to);
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    const startedAt = to === "running" ? patch.startedAt ?? snapshot.startedAt ?? updatedAt : snapshot.startedAt;
    const endedAt = TERMINAL_RUN_STATUSES.has(to) ? patch.endedAt ?? updatedAt : snapshot.endedAt;
    const error = TERMINAL_RUN_STATUSES.has(to) ? patch.error ?? snapshot.error : snapshot.error;
    const next = {
        ...snapshot,
        status: to,
        phase: patch.phase ?? snapshot.phase,
        attempt: patch.attempt ?? snapshot.attempt,
        updatedAt,
    };
    if (to === "running") {
        if (patch.workerId !== undefined || snapshot.workerId !== undefined) {
            next.workerId = patch.workerId ?? snapshot.workerId;
        }
        if (startedAt !== undefined) {
            next.startedAt = startedAt;
        }
    }
    else if (snapshot.workerId !== undefined) {
        next.workerId = snapshot.workerId;
    }
    if (endedAt !== undefined) {
        next.endedAt = endedAt;
    }
    if (error !== undefined) {
        next.error = error;
    }
    return next;
}
export function getReadyAgentV2TaskIds(tasks) {
    const succeeded = new Set(tasks.filter((task) => task.status === "succeeded").map((task) => task.taskId));
    return tasks
        .filter((task) => task.status === "pending")
        .filter((task) => task.dependsOn.every((taskId) => succeeded.has(taskId)))
        .map((task) => task.taskId);
}
export { AGENT_V2_PHASES, AGENT_V2_RUN_STATUSES };
//# sourceMappingURL=agent-v2-state-machine.js.map