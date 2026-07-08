import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { buildAgentV2ContextPacket } from "./agent-v2-context-packet.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
export async function loadAgentV2RuntimeSnapshot(input) {
    const run = await input.store.getAgentV2Run(input.clientId, input.runId);
    if (!run) {
        throw new Error(`Agent v2 run not found: ${input.clientId}/${input.runId}`);
    }
    const [tasks, artifacts, documents, diagnostics] = await Promise.all([
        input.store.listAgentV2Tasks(input.clientId, input.runId),
        input.store.listAgentV2Artifacts(input.clientId, input.runId),
        input.store.listAgentV2Documents(input.clientId, input.runId),
        input.store.listAgentV2Diagnostics(input.clientId, input.runId),
    ]);
    const contextPacket = buildAgentV2ContextPacket({
        run,
        tasks,
        artifacts,
        documents,
        diagnostics,
    });
    return { run, tasks, artifacts, documents, diagnostics, contextPacket };
}
export async function advanceAgentV2Task(input) {
    const run = await input.store.getAgentV2Run(input.clientId, input.runId);
    if (!run) {
        throw new Error(`Agent v2 run not found: ${input.clientId}/${input.runId}`);
    }
    const tasks = await input.store.listAgentV2Tasks(input.clientId, input.runId);
    const task = tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!task) {
        await appendRuntimeDiagnosticBestEffort(input.store, input.clientId, input.runId, {
            code: "agent_v2.task_not_found",
            severity: "error",
            message: `Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`,
            taskId: input.taskId,
            createdAt: input.now,
        });
        throw new Error(`Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`);
    }
    const transitioned = transitionAgentV2Task({
        task,
        status: input.status,
        now: input.now,
        output: input.output,
        error: input.error,
    });
    const persisted = await input.store.upsertAgentV2Task(toUpsertTaskInput(input.clientId, input.runId, transitioned));
    await appendRuntimeDiagnosticBestEffort(input.store, input.clientId, input.runId, {
        code: "agent_v2.task_transitioned",
        severity: "info",
        message: `Agent v2 task ${input.taskId} transitioned to ${input.status}`,
        taskId: input.taskId,
        createdAt: input.now,
    });
    return persisted;
}
function toUpsertTaskInput(clientId, runId, task) {
    return {
        clientId,
        runId,
        taskId: task.taskId,
        parentTaskId: task.parentTaskId,
        kind: task.kind,
        title: task.title,
        status: task.status,
        dependsOn: task.dependsOn,
        acceptanceCriteria: task.acceptanceCriteria,
        input: task.input,
        output: task.output,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        error: task.error,
    };
}
async function appendRuntimeDiagnostic(store, clientId, runId, input) {
    await store.appendAgentV2Diagnostic(createAgentV2DiagnosticEvent({
        diagnosticId: `${input.code}:${input.taskId ?? "run"}:${input.createdAt}:${randomUUID()}`,
        clientId,
        runId,
        severity: input.severity,
        category: "task_graph",
        code: input.code,
        taskId: input.taskId,
        message: input.message,
        data: {},
        createdAt: input.createdAt,
    }));
}
async function appendRuntimeDiagnosticBestEffort(store, clientId, runId, input) {
    try {
        await appendRuntimeDiagnostic(store, clientId, runId, input);
    }
    catch {
        // Diagnostics are advisory; task state mutation is the source of truth.
    }
}
//# sourceMappingURL=agent-v2-runtime-core.js.map