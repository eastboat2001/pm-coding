import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2FileAdapter } from "./agent-v2-file-adapter.js";
import { AgentV2ModelContractError, parseAgentV2ImplementationResult, } from "./agent-v2-model-execution.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "./agent-v2-runtime-core.js";
import { normalizeAgentV2ModelReference } from "./agent-v2-start-input.js";
import { phaseForAgentV2Task } from "./agent-v2-state-machine.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
import { assertAgentV2ToolAllowed, createAgentV2ToolRegistry, } from "./agent-v2-tool-governance.js";
import { runAgentV2StaticValidationGate } from "./agent-v2-validation-gate.js";
export async function executeAgentV2NextTask(input) {
    throwIfAborted(input.signal);
    const now = input.now?.() ?? new Date().toISOString();
    const snapshot = await loadAgentV2RuntimeSnapshot({
        store: input.store,
        clientId: input.context.clientId,
        runId: input.runId,
    });
    throwIfAborted(input.signal);
    const selection = snapshot.contextPacket.taskSelection;
    if (!selection.task) {
        if (selection.reason === "complete") {
            return { status: "complete", diagnosticIds: [] };
        }
        if (selection.reason === "blocked_by_dependencies" || selection.reason === "failed_dependency") {
            return { status: "task_blocked", diagnosticIds: [] };
        }
        return { status: "no_task", diagnosticIds: [] };
    }
    const task = selection.task;
    if (task.kind === "validation") {
        return executeValidationTask(input, {
            taskId: task.taskId,
            taskOutput: task.output,
            now,
        });
    }
    if (task.kind === "implementation") {
        return executeImplementationTask(input, snapshot.run, snapshot.contextPacket, task, now);
    }
    await advanceAgentV2Task({
        store: input.store,
        clientId: input.context.clientId,
        runId: input.runId,
        taskId: task.taskId,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            phase4: {
                deterministic: true,
                completedBy: "agent-v2-execution-core",
            },
        },
    });
    return {
        status: "task_succeeded",
        taskId: task.taskId,
        diagnosticIds: [],
    };
}
async function executeImplementationTask(input, run, contextPacket, task, proposedNow) {
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    assertAgentV2ToolAllowed(registry, "file.write", "implementation");
    const signal = input.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const materializedInputs = await input.materializer.materialize({ run, signal });
    throwIfAborted(signal);
    const envelope = await input.modelExecution.generateImplementation({
        run,
        contextPacket,
        task,
        inputs: materializedInputs,
        signal,
    });
    throwIfAborted(signal);
    const trustedModel = normalizeAgentV2ModelReference(run.model);
    if (envelope.provider !== trustedModel.provider || envelope.model !== trustedModel.id) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
    const serialized = JSON.stringify(envelope.result);
    if (typeof serialized !== "string")
        throw new AgentV2ModelContractError("invalid_schema");
    const result = parseAgentV2ImplementationResult(serialized, task.taskId);
    const generatedFiles = [...result.files].sort((left, right) => compareStrings(left.path, right.path));
    const files = createAgentV2FileAdapter({
        config: input.config,
        context: input.context,
    });
    const authorizedPaths = generatedFiles.map((file) => {
        const authorizedPath = files.validateWritePath(file.path);
        if (authorizedPath !== file.path)
            throw new AgentV2ModelContractError("unsafe_path");
        return authorizedPath;
    });
    assertNoWritePathCollisions(authorizedPaths, files.listFiles().files);
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
    const writes = generatedFiles.map((file) => files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }));
    const artifacts = writes.map((write) => ({
        clientId: input.context.clientId,
        runId: input.runId,
        artifactId: write.artifact.artifactId,
        kind: write.artifact.kind,
        path: write.artifact.path,
        mediaType: write.artifact.mediaType,
        checksum: write.artifact.checksum,
        version: write.artifact.checksum,
        sourceTaskId: write.artifact.sourceTaskId,
        validationStatus: "pending",
        metadataJson: { action: write.action },
        createdAt: now,
        updatedAt: now,
    }));
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    const changedFiles = artifacts.map((artifact) => artifact.path);
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            artifactIds,
            changedFiles,
            phase4: {
                ...readPhase4TaskOutput(task.output),
                implementationArtifactIds: artifactIds,
                completedBy: "agent-v2-execution-core",
            },
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const usage = sanitizedUsage(envelope.usage);
    const taskPayload = {
        type: "agent_v2.task_updated",
        taskId: task.taskId,
        kind: task.kind,
        status: transitioned.status,
        phase,
        at: now,
    };
    const artifactPayloads = artifacts.map((artifact) => ({
        type: "agent_v2.artifact_indexed",
        artifactId: artifact.artifactId,
        path: artifact.path,
        validationStatus: "pending",
        revision: artifact.version,
        at: now,
    }));
    const outputPayload = {
        type: "agent_v2.output_recorded",
        taskId: task.taskId,
        summary: implementationOutputSummary(artifacts.length),
        provider: trustedModel.provider,
        model: trustedModel.id,
        ...(usage ? { usage } : {}),
        at: now,
    };
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [{ taskId: task.taskId, status: task.status, updatedAt: task.updatedAt }],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
        artifacts,
        events: [taskPayload, ...artifactPayloads, outputPayload].map((payload) => ({
            type: payload.type,
            payload: payload,
            createdAt: now,
        })),
    }));
    if (!mutation.applied) {
        return { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
    }
    return {
        status: "task_succeeded",
        taskId: task.taskId,
        diagnosticIds: [],
    };
}
async function executeValidationTask(input, state) {
    const maxAttempts = input.maxRepairAttempts ?? 3;
    const attempt = nextValidationRepairAttempt(state.taskOutput);
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    throwIfAborted(input.signal);
    const result = await runAgentV2StaticValidationGate({
        config: input.config,
        context: input.context,
        runId: input.runId,
        taskId: state.taskId,
        now: state.now,
        toolRegistry: registry,
        signal: input.signal,
    });
    await Promise.resolve(input.store.appendAgentV2ValidationAttempt({ ...result.validation, attempt }));
    if (result.status === "passed") {
        await advanceAgentV2Task({
            store: input.store,
            clientId: input.context.clientId,
            runId: input.runId,
            taskId: state.taskId,
            status: "succeeded",
            now: state.now,
            output: {
                ...state.taskOutput,
                validationId: result.validation.validationId,
            },
        });
        return {
            status: "task_succeeded",
            taskId: state.taskId,
            diagnosticIds: [],
        };
    }
    const repairActions = planAgentV2RepairActions({
        taskId: state.taskId,
        failures: result.failures,
        attempt,
        maxAttempts,
    });
    const hasRetryableRepairAction = repairActions.some((action) => action.retryable);
    const diagnosticId = `agent_v2.validation_failed:${state.taskId}:${randomUUID()}`;
    await Promise.resolve(input.store.appendAgentV2Diagnostic(createAgentV2DiagnosticEvent({
        diagnosticId,
        clientId: input.context.clientId,
        runId: input.runId,
        severity: "error",
        category: "validation",
        code: "agent_v2.validation_failed",
        phase: "validation",
        taskId: state.taskId,
        message: result.validation.summary,
        data: {
            validationId: result.validation.validationId,
            failures: result.failures,
            attempt,
            maxAttempts,
            repairActions,
        },
        createdAt: state.now,
    })));
    const nextStatus = hasRetryableRepairAction && attempt < maxAttempts ? "ready" : "failed";
    await advanceAgentV2Task({
        store: input.store,
        clientId: input.context.clientId,
        runId: input.runId,
        taskId: state.taskId,
        status: nextStatus,
        now: state.now,
        output: {
            ...state.taskOutput,
            validationId: result.validation.validationId,
            repairActions,
            attempt,
            maxAttempts,
            phase4: {
                ...readPhase4TaskOutput(state.taskOutput),
                validationRepairAttempt: attempt,
                validationMaxRepairAttempts: maxAttempts,
            },
        },
        ...(nextStatus === "failed"
            ? {
                error: {
                    code: "agent_v2.validation_failed",
                    message: result.validation.summary,
                    retryable: false,
                    data: {
                        validationId: result.validation.validationId,
                        attempt,
                        maxAttempts,
                        repairActions,
                    },
                },
            }
            : {}),
    });
    return {
        status: "task_failed",
        taskId: state.taskId,
        diagnosticIds: [diagnosticId],
    };
}
function expectedRunState(run) {
    return {
        status: run.status,
        phase: run.phase,
        attempt: run.attempt,
        workerId: run.workerId ?? null,
        updatedAt: run.updatedAt,
    };
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
function nextExecutionRevision(proposed, ...current) {
    const proposedMs = canonicalTimestamp(proposed);
    const currentMs = current.map(canonicalTimestamp);
    return new Date(Math.max(proposedMs, ...currentMs.map((value) => value + 1))).toISOString();
}
function canonicalTimestamp(value) {
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
        throw new Error("Agent v2 execution revision must be a canonical UTC millisecond timestamp");
    }
    return epoch;
}
function sanitizedUsage(value) {
    if (!value)
        return undefined;
    const entries = [value.input, value.output, value.totalTokens, value.costTotal];
    if (entries.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > Number.MAX_SAFE_INTEGER))
        return undefined;
    return {
        input: value.input,
        output: value.output,
        totalTokens: value.totalTokens,
        costTotal: value.costTotal,
    };
}
function assertNoWritePathCollisions(generatedPaths, existingFiles) {
    const generated = generatedPaths.map((path) => ({ path, key: collisionKey(path) }));
    for (let index = 0; index < generated.length; index += 1) {
        const left = generated[index];
        for (let candidateIndex = index + 1; candidateIndex < generated.length; candidateIndex += 1) {
            const right = generated[candidateIndex];
            if (pathsShareFileIdentity(left.key, right.key))
                throw new AgentV2ModelContractError("duplicate_path");
        }
    }
    for (const candidate of generated) {
        for (const existingPath of existingFiles) {
            const existing = { path: existingPath, key: collisionKey(existingPath) };
            if (candidate.key === existing.key) {
                if (candidate.path !== existing.path)
                    throw new AgentV2ModelContractError("duplicate_path");
                continue;
            }
            if (pathsShareFileIdentity(candidate.key, existing.key)) {
                throw new AgentV2ModelContractError("duplicate_path");
            }
        }
    }
}
function collisionKey(path) {
    return path.normalize("NFC").toLocaleLowerCase("en-US");
}
function pathsShareFileIdentity(left, right) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function implementationOutputSummary(fileCount) {
    return `Generated ${fileCount} ${fileCount === 1 ? "file" : "files"}.`;
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function nextValidationRepairAttempt(taskOutput) {
    const phase4Attempt = positiveInteger(readPhase4TaskOutput(taskOutput).validationRepairAttempt);
    return (phase4Attempt ?? 0) + 1;
}
function readPhase4TaskOutput(taskOutput) {
    return isRecord(taskOutput.phase4) ? taskOutput.phase4 : {};
}
function positiveInteger(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return undefined;
    const integer = Math.trunc(value);
    return integer >= 1 ? integer : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw signal.reason ?? new Error("Agent v2 execution was aborted.");
}
//# sourceMappingURL=agent-v2-execution-core.js.map