import { createHash } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2FileAdapter } from "./agent-v2-file-adapter.js";
import { AGENT_V2_REPAIR_WORKSPACE_LIMITS, AgentV2ModelContractError, parseAgentV2ImplementationResult, parseAgentV2RepairResult, } from "./agent-v2-model-execution.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "./agent-v2-runtime-core.js";
import { normalizeAgentV2ModelReference } from "./agent-v2-start-input.js";
import { phaseForAgentV2Task } from "./agent-v2-state-machine.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
import { assertAgentV2ToolAllowed, createAgentV2ToolRegistry, } from "./agent-v2-tool-governance.js";
import { runAgentV2StaticValidationGate, } from "./agent-v2-validation-gate.js";
import { PreviewReadinessChecker } from "./preview-readiness-checker.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
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
            const affectedTaskIds = [...selection.failedDependencyTaskIds, ...selection.blockedTaskIds];
            const blockingError = affectedTaskIds
                .map((taskId) => snapshot.tasks.find((candidate) => candidate.taskId === taskId)?.error)
                .find((error) => error !== undefined);
            return {
                status: "task_blocked",
                diagnosticIds: [],
                ...(blockingError ? { blockingError } : {}),
            };
        }
        return { status: "no_task", diagnosticIds: [] };
    }
    const task = selection.task;
    if (task.kind === "validation") {
        return executeValidationTask(input, snapshot.run, snapshot.tasks, snapshot.artifacts, task, now);
    }
    if (task.kind === "implementation") {
        return executeImplementationTask(input, snapshot.run, snapshot.contextPacket, task, now);
    }
    if (task.kind === "repair") {
        return executeRepairTask(input, snapshot.run, snapshot.contextPacket, snapshot.artifacts, snapshot.diagnostics, task, now);
    }
    if (task.kind === "delivery") {
        return executeDeliveryTask(input, snapshot.run, snapshot.tasks, snapshot.artifacts, task, now);
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
async function executeDeliveryTask(input, run, tasks, artifacts, task, proposedNow) {
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    assertAgentV2ToolAllowed(registry, "preview.publish", "delivery");
    throwIfAborted(input.signal);
    let preview;
    try {
        preview = await new WorkspacePreviewService(input.config).preview(input.context, { headers: {} });
    }
    catch (error) {
        throwIfAborted(input.signal);
        return commitDeliveryFailure(input, run, task, proposedNow, classifyPreviewFailure(error));
    }
    throwIfAborted(input.signal);
    if (preview.status !== "running" || !preview.previewUrl) {
        return commitDeliveryFailure(input, run, task, proposedNow, classifyPreviewFailure(preview.logs));
    }
    let readiness;
    try {
        readiness = await (input.previewReadinessChecker ?? new PreviewReadinessChecker(input.config)).check(input.context);
    }
    catch (error) {
        throwIfAborted(input.signal);
        return commitDeliveryFailure(input, run, task, proposedNow, previewReadinessFailure("probe_error", error));
    }
    throwIfAborted(input.signal);
    if (!readiness.ready || readiness.reasonCode !== "ready") {
        return commitDeliveryFailure(input, run, task, proposedNow, previewReadinessFailure(readiness.reasonCode, readiness.detail));
    }
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            projectId: preview.projectId,
            previewUrl: preview.previewUrl,
            fileCount: preview.fileCount,
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const report = deliveryReportPayload(input, tasks, artifacts, transitioned, preview, now);
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [expectedTaskState(task)],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
        events: [
            taskEvent(transitioned, phase, now),
            { type: report.type, payload: report, createdAt: now },
        ],
    }));
    return mutation.applied
        ? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}
function deliveryReportPayload(input, tasks, artifacts, deliveryTask, preview, now) {
    const actionFiles = (action) => artifacts
        .filter((artifact) => artifact.metadataJson.action === action)
        .map((artifact) => artifact.path)
        .sort(compareStrings);
    const modelNotes = tasks
        .filter((candidate) => candidate.kind === "implementation" || candidate.kind === "repair")
        .map((candidate) => (typeof candidate.output.modelSummary === "string" ? candidate.output.modelSummary : ""))
        .filter(Boolean);
    return {
        type: "agent_v2.delivery_reported",
        taskId: deliveryTask.taskId,
        completedSummary: modelNotes.at(-1) ??
            `Created and validated ${artifacts.length} generated ${artifacts.length === 1 ? "file" : "files"}.`,
        appliedSkills: input.skillContext?.skills.map((skill) => skill.name) ?? [],
        createdFiles: actionFiles("created"),
        updatedFiles: actionFiles("updated"),
        validationStatus: "passed",
        buildStatus: "not_required",
        previewStatus: "running",
        previewReadiness: { verified: true, ready: true, reasonCode: "ready" },
        previewUrl: preview.previewUrl,
        projectId: preview.projectId,
        usageInstructions: "Open the preview URL to use and review the generated application.",
        at: now,
    };
}
function previewReadinessFailure(reasonCode, detail) {
    const boundedDetail = typeof detail === "string" && detail.trim() ? ` ${detail.trim().slice(0, 500)}` : "";
    return {
        taxonomy: "not_ready",
        code: "agent_v2.preview_not_ready",
        message: `Published preview did not pass readiness verification (${reasonCode}).${boundedDetail}`,
        retryable: true,
    };
}
function classifyPreviewFailure(value) {
    const messages = Array.isArray(value)
        ? value.filter((candidate) => typeof candidate === "string")
        : [value instanceof Error ? value.message : typeof value === "string" ? value : ""];
    if (messages.some((message) => message.includes("Cannot preview an empty project workspace."))) {
        return {
            taxonomy: "workspace_empty",
            code: "agent_v2.preview_workspace_empty",
            message: "Preview requires at least one project file.",
            retryable: true,
        };
    }
    if (messages.some((message) => message.includes("Static preview found a build source entry"))) {
        return {
            taxonomy: "build_required",
            code: "agent_v2.preview_build_required",
            message: "Preview requires browser-ready build output in dist, build, or public.",
            retryable: true,
        };
    }
    if (messages.some((message) => message.includes("requires an index.html in the project root, dist, build, or public") ||
        message.includes("no index.html was found in the project root, dist, build, or public"))) {
        return {
            taxonomy: "missing_entry",
            code: "agent_v2.preview_missing_entry",
            message: "Preview requires a browser-ready index.html in the project root, dist, build, or public.",
            retryable: true,
        };
    }
    return {
        taxonomy: "publish_failed",
        code: "agent_v2.preview_publish_failed",
        message: "Preview publication failed for an unclassified reason.",
        retryable: false,
    };
}
async function commitDeliveryFailure(input, run, task, proposedNow, failure) {
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
    const diagnosticId = `${failure.code}:${task.taskId}`;
    const diagnostic = createAgentV2DiagnosticEvent({
        diagnosticId,
        clientId: input.context.clientId,
        runId: input.runId,
        severity: "error",
        category: "preview",
        code: failure.code,
        phase: "preview",
        taskId: task.taskId,
        message: failure.message,
        data: { retryable: failure.retryable, taxonomy: failure.taxonomy },
        createdAt: now,
    });
    const transitioned = transitionAgentV2Task({
        task,
        status: "failed",
        now,
        output: task.output,
        error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            data: { diagnosticId, taxonomy: failure.taxonomy },
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [expectedTaskState(task)],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
        diagnostics: [diagnostic],
        events: [diagnosticEvent(diagnostic, now), taskEvent(transitioned, phase, now)],
    }));
    return mutation.applied
        ? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
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
        ...(input.skillContext ? { skillContext: input.skillContext } : {}),
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
            modelSummary: sanitizeUserVisibleSummary(result.summary, artifacts.length, "implementation"),
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
        checksum: artifact.checksum,
        action: artifactAction(artifact),
        sourceTaskId: artifact.sourceTaskId,
        at: now,
    }));
    const outputPayload = {
        type: "agent_v2.output_recorded",
        taskId: task.taskId,
        summary: sanitizeUserVisibleSummary(result.summary, artifacts.length, "implementation"),
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
        events: [...skillEvents(input.skillContext, now), taskPayload, ...artifactPayloads, outputPayload].map((payload) => ({
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
async function executeValidationTask(input, run, tasks, artifacts, task, proposedNow) {
    const maxAttempts = input.maxRepairAttempts ?? 3;
    const { baseTaskId, attempt } = validationCoordinates(task);
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    throwIfAborted(input.signal);
    const result = await runAgentV2StaticValidationGate({
        config: input.config,
        context: input.context,
        runId: input.runId,
        taskId: task.taskId,
        now: proposedNow,
        toolRegistry: registry,
        signal: input.signal,
    });
    throwIfAborted(input.signal);
    const delivery = tasks.find((candidate) => candidate.kind === "delivery");
    const revisionInputs = [run.updatedAt, task.updatedAt, ...artifacts.map((artifact) => artifact.updatedAt)];
    if (result.status === "failed" && delivery)
        revisionInputs.push(delivery.updatedAt);
    const now = nextExecutionRevision(proposedNow, ...revisionInputs);
    const validationId = `static:${baseTaskId}`;
    const failureCodes = [...new Set(result.failures.map((failure) => failure.code))].sort(compareStrings);
    const validation = {
        ...result.validation,
        validationId,
        attempt,
        taskId: task.taskId,
        summary: result.status === "passed" ? "Static validation passed" : "Static validation failed",
        details: {
            failureCount: result.failures.length,
            failureCodes,
            retryableFailureCount: result.failures.filter((failure) => failure.retryable).length,
        },
        createdAt: now,
        updatedAt: now,
    };
    const relevantArtifacts = artifacts.filter((artifact) => artifact.kind === "source" &&
        (artifact.validationStatus === "pending" || artifact.validationStatus === "failed"));
    if (result.status === "passed") {
        const transitioned = transitionAgentV2Task({
            task,
            status: "succeeded",
            now,
            output: {
                ...task.output,
                validationId,
                attempt,
                maxAttempts,
            },
        });
        const updatedArtifacts = relevantArtifacts.map((artifact) => validationArtifactUpdate(artifact, "passed", now));
        const phase = phaseForAgentV2Task(task, transitioned.status);
        const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
            clientId: input.context.clientId,
            runId: input.runId,
            expectedRun: expectedRunState(run),
            expectedTasks: [expectedTaskState(task)],
            updatedAt: now,
            nextRunPhase: phase,
            tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
            artifacts: updatedArtifacts,
            validation,
            events: validationEvents(validation, transitioned, updatedArtifacts, phase, now),
        }));
        return mutation.applied
            ? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
            : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
    }
    const repairActions = planAgentV2RepairActions({
        taskId: baseTaskId,
        failures: result.failures,
        attempt,
        maxAttempts,
    });
    const canRepair = attempt < maxAttempts && repairActions.some((action) => action.retryable);
    const diagnosticId = `agent_v2.validation_failed:${baseTaskId}:${attempt}`;
    const diagnostic = createAgentV2DiagnosticEvent({
        diagnosticId,
        clientId: input.context.clientId,
        runId: input.runId,
        severity: "error",
        category: "validation",
        code: "agent_v2.validation_failed",
        phase: "validation",
        taskId: task.taskId,
        message: "Static validation failed.",
        data: {
            validationId,
            attempt,
            maxAttempts,
            failureCount: result.failures.length,
            failureCodes,
            failureDetails: validationFailureDetails(result.failures),
            retryableFailureCount: result.failures.filter((failure) => failure.retryable).length,
        },
        createdAt: now,
    });
    const failedArtifacts = relevantArtifacts.map((artifact) => validationArtifactUpdate(artifact, "failed", now));
    if (!canRepair) {
        const primaryFailure = result.failures[0]?.message.trim().slice(0, 1_000);
        const terminalMessage = primaryFailure
            ? `Static validation failed and cannot be repaired: ${primaryFailure}`
            : "Static validation failed and cannot be repaired.";
        const transitioned = transitionAgentV2Task({
            task,
            status: "failed",
            now,
            output: { ...task.output, validationId, attempt, maxAttempts },
            error: {
                code: "agent_v2.validation_failed",
                message: terminalMessage,
                retryable: false,
                data: { validationId, attempt, maxAttempts, failureCodes },
            },
        });
        const phase = phaseForAgentV2Task(task, transitioned.status);
        const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
            clientId: input.context.clientId,
            runId: input.runId,
            expectedRun: expectedRunState(run),
            expectedTasks: [expectedTaskState(task)],
            updatedAt: now,
            nextRunPhase: phase,
            tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
            artifacts: failedArtifacts,
            validation,
            diagnostics: [diagnostic],
            events: validationFailureEvents(validation, diagnostic, transitioned, failedArtifacts, phase, now),
        }));
        return mutation.applied
            ? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
            : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
    }
    if (!delivery)
        return { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
    const repairTask = createRepairTask(baseTaskId, task, validationId, attempt, diagnosticId, now);
    const revalidateTask = createRevalidationTask(baseTaskId, repairTask, attempt + 1, now);
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: { ...task.output, validationId, attempt, maxAttempts, diagnosticIds: [diagnosticId] },
    });
    const rewiredDelivery = {
        ...delivery,
        dependsOn: [revalidateTask.taskId],
        updatedAt: now,
    };
    const phase = phaseForAgentV2Task(repairTask, repairTask.status);
    const changedTasks = [transitioned, repairTask, revalidateTask, rewiredDelivery];
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [
            expectedTaskState(task),
            { taskId: repairTask.taskId, absent: true },
            { taskId: revalidateTask.taskId, absent: true },
            expectedTaskState(delivery),
        ],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: changedTasks.map((candidate) => toUpsertTaskInput(input.context.clientId, input.runId, candidate)),
        artifacts: failedArtifacts,
        validation,
        diagnostics: [diagnostic],
        events: [
            ...validationFailureEvents(validation, diagnostic, transitioned, failedArtifacts, phase, now),
            ...changedTasks.slice(1).map((candidate) => taskEvent(candidate, phase, now)),
        ],
    }));
    return mutation.applied
        ? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}
function validationFailureDetails(failures) {
    return failures.slice(0, 16).map((failure) => ({
        code: failure.code,
        message: failure.message.slice(0, 1_000),
        retryable: failure.retryable,
        source: failure.source,
        ...(failure.path ? { path: failure.path.slice(0, 512) } : {}),
    }));
}
async function executeRepairTask(input, run, contextPacket, artifacts, diagnostics, task, proposedNow) {
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    assertAgentV2ToolAllowed(registry, "file.write", "repair");
    const signal = input.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const repairIdentity = requireRepairIdentity(task);
    const diagnosticIds = repairIdentity.diagnosticIds;
    const repairDiagnostics = diagnosticIds.map((diagnosticId) => diagnostics.find((item) => item.diagnosticId === diagnosticId));
    if (repairDiagnostics.some((diagnostic) => !diagnostic))
        throw new AgentV2ModelContractError("invalid_schema");
    assertRepairDiagnostics(repairIdentity, repairDiagnostics, run);
    const materializedInputs = await input.materializer.materialize({ run, signal });
    throwIfAborted(signal);
    const files = createAgentV2FileAdapter({ config: input.config, context: input.context });
    const workspaceFiles = collectRepairWorkspaceFiles(files, artifacts);
    const envelope = await input.modelExecution.generateRepair({
        run,
        contextPacket,
        task,
        inputs: materializedInputs,
        diagnostics: repairDiagnostics,
        workspaceFiles,
        ...(input.skillContext ? { skillContext: input.skillContext } : {}),
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
    const result = parseAgentV2RepairResult(serialized, task.taskId);
    if (!sameStrings(result.addressedDiagnosticIds, diagnosticIds))
        throw new AgentV2ModelContractError("invalid_schema");
    const generatedFiles = [...result.files].sort((left, right) => compareStrings(left.path, right.path));
    const existingFiles = files.listFiles().files;
    const existingSet = new Set(existingFiles);
    const authorizedPaths = generatedFiles.map((file) => {
        const authorizedPath = files.validateWritePath(file.path);
        if (authorizedPath !== file.path)
            throw new AgentV2ModelContractError("unsafe_path");
        return authorizedPath;
    });
    assertNoWritePathCollisions(authorizedPaths, existingFiles);
    const changedFiles = generatedFiles.filter((file) => {
        if (!existingSet.has(file.path))
            return true;
        const current = files.readFile(file.path);
        if (current.truncated)
            throw new AgentV2ModelContractError("limit_exceeded");
        return current.content !== file.content;
    });
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt, ...artifacts.map((artifact) => artifact.updatedAt));
    if (changedFiles.length === 0) {
        return commitNoChangeRepair(input, run, task, now);
    }
    const writes = changedFiles.map((file) => files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }));
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const updatedArtifacts = writes.map((write) => {
        const existing = artifactById.get(write.artifact.artifactId);
        return {
            clientId: input.context.clientId,
            runId: input.runId,
            artifactId: write.artifact.artifactId,
            kind: write.artifact.kind,
            path: write.artifact.path,
            mediaType: write.artifact.mediaType,
            checksum: write.artifact.checksum,
            version: write.artifact.checksum,
            sourceTaskId: task.taskId,
            validationStatus: "pending",
            metadataJson: { action: write.action },
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
    });
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            modelSummary: repairOutputSummary(updatedArtifacts.length),
            artifactIds: updatedArtifacts.map((artifact) => artifact.artifactId),
            changedFiles: updatedArtifacts.map((artifact) => artifact.path),
            addressedDiagnosticIds: diagnosticIds,
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const usage = sanitizedUsage(envelope.usage);
    const events = [
        taskEvent(transitioned, phase, now),
        ...updatedArtifacts.map((artifact) => artifactEvent(artifact, "pending", now)),
        {
            type: "agent_v2.output_recorded",
            payload: {
                type: "agent_v2.output_recorded",
                taskId: task.taskId,
                summary: repairOutputSummary(updatedArtifacts.length),
                provider: trustedModel.provider,
                model: trustedModel.id,
                ...(usage ? { usage } : {}),
                at: now,
            },
            createdAt: now,
        },
    ];
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [expectedTaskState(task)],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
        artifacts: updatedArtifacts,
        events,
    }));
    return mutation.applied
        ? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}
function validationCoordinates(task) {
    const match = /^revalidate:([A-Za-z0-9][A-Za-z0-9._:~-]*):([2-9][0-9]*)$/u.exec(task.taskId);
    if (!match)
        return { baseTaskId: task.taskId, attempt: 1 };
    return { baseTaskId: match[1], attempt: Number(match[2]) };
}
function createRepairTask(baseTaskId, validationTask, validationId, attempt, diagnosticId, now) {
    return {
        taskId: `repair:${baseTaskId}:${attempt}`,
        parentTaskId: validationTask.taskId,
        kind: "repair",
        title: `Repair validation attempt ${attempt}`,
        status: "pending",
        dependsOn: [validationTask.taskId],
        acceptanceCriteria: ["Produce at least one persisted file change before revalidation."],
        input: {
            baseValidationTaskId: baseTaskId,
            failedValidationTaskId: validationTask.taskId,
            validationId,
            validationAttempt: attempt,
            diagnosticIds: [diagnosticId],
        },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function createRevalidationTask(baseTaskId, repairTask, attempt, now) {
    return {
        taskId: `revalidate:${baseTaskId}:${attempt}`,
        parentTaskId: repairTask.taskId,
        kind: "validation",
        title: `Revalidate after repair attempt ${attempt - 1}`,
        status: "pending",
        dependsOn: [repairTask.taskId],
        acceptanceCriteria: ["Validate the latest persisted artifact revision."],
        input: { baseValidationTaskId: baseTaskId, validationAttempt: attempt },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function expectedTaskState(task) {
    return { taskId: task.taskId, status: task.status, updatedAt: task.updatedAt };
}
function validationArtifactUpdate(artifact, validationStatus, now) {
    return {
        clientId: artifact.clientId,
        runId: artifact.runId,
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        path: artifact.path,
        mediaType: artifact.mediaType,
        checksum: artifact.checksum,
        version: artifact.version,
        sourceTaskId: artifact.sourceTaskId,
        validationStatus,
        metadataJson: artifact.metadataJson,
        createdAt: artifact.createdAt,
        updatedAt: now,
    };
}
function taskEvent(task, phase, now) {
    const payload = {
        type: "agent_v2.task_updated",
        taskId: task.taskId,
        kind: task.kind,
        status: task.status,
        phase,
        at: now,
    };
    return { type: payload.type, payload: payload, createdAt: now };
}
function artifactEvent(artifact, validationStatus, now) {
    const payload = {
        type: "agent_v2.artifact_indexed",
        artifactId: artifact.artifactId,
        path: artifact.path,
        validationStatus,
        revision: artifact.version,
        checksum: artifact.checksum,
        action: artifactAction(artifact),
        sourceTaskId: artifact.sourceTaskId,
        at: now,
    };
    return { type: payload.type, payload: payload, createdAt: now };
}
function validationEvent(validation, now) {
    const payload = {
        type: "agent_v2.validation_recorded",
        validationId: validation.validationId,
        taskId: validation.taskId,
        attempt: validation.attempt,
        status: validation.status,
        summary: validation.summary,
        at: now,
    };
    return { type: payload.type, payload: payload, createdAt: now };
}
function diagnosticEvent(diagnostic, now) {
    const payload = {
        type: "agent_v2.diagnostic_recorded",
        diagnosticId: diagnostic.diagnosticId,
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        at: now,
    };
    return { type: payload.type, payload: payload, createdAt: now };
}
function validationEvents(validation, task, artifacts, phase, now) {
    return [
        validationEvent(validation, now),
        taskEvent(task, phase, now),
        ...artifacts.map((artifact) => artifactEvent(artifact, "passed", now)),
    ];
}
function validationFailureEvents(validation, diagnostic, task, artifacts, phase, now) {
    return [
        validationEvent(validation, now),
        diagnosticEvent(diagnostic, now),
        taskEvent(task, phase, now),
        ...artifacts.map((artifact) => artifactEvent(artifact, "failed", now)),
    ];
}
async function commitNoChangeRepair(input, run, task, now) {
    const diagnosticId = `agent_v2.repair_no_change:${task.taskId}`;
    const diagnostic = createAgentV2DiagnosticEvent({
        diagnosticId,
        clientId: input.context.clientId,
        runId: input.runId,
        severity: "error",
        category: "validation",
        code: "agent_v2.repair_no_change",
        phase: "repair",
        taskId: task.taskId,
        message: "Agent v2 repair produced no persisted file changes.",
        data: {},
        createdAt: now,
    });
    const transitioned = transitionAgentV2Task({
        task,
        status: "failed",
        now,
        output: { ...task.output, changedFiles: [] },
        error: {
            code: "agent_v2.repair_no_change",
            message: "Agent v2 repair produced no persisted file changes.",
            retryable: false,
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
        clientId: input.context.clientId,
        runId: input.runId,
        expectedRun: expectedRunState(run),
        expectedTasks: [expectedTaskState(task)],
        updatedAt: now,
        nextRunPhase: phase,
        tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
        diagnostics: [diagnostic],
        events: [diagnosticEvent(diagnostic, now), taskEvent(transitioned, phase, now)],
    }));
    return mutation.applied
        ? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}
function requireRepairIdentity(task) {
    const baseValidationTaskId = requireStableExecutionIdentifier(task.input.baseValidationTaskId);
    const failedValidationTaskId = requireStableExecutionIdentifier(task.input.failedValidationTaskId);
    const validationId = requireStableExecutionIdentifier(task.input.validationId);
    const validationAttempt = task.input.validationAttempt;
    const diagnosticIds = requireStringArray(task.input.diagnosticIds);
    const expectedDiagnosticId = `agent_v2.validation_failed:${baseValidationTaskId}:${String(validationAttempt)}`;
    if (task.kind !== "repair" ||
        !Number.isSafeInteger(validationAttempt) ||
        validationAttempt < 1 ||
        task.taskId !== `repair:${baseValidationTaskId}:${String(validationAttempt)}` ||
        task.parentTaskId !== failedValidationTaskId ||
        task.dependsOn.length !== 1 ||
        task.dependsOn[0] !== failedValidationTaskId ||
        validationId !== `static:${baseValidationTaskId}` ||
        diagnosticIds.length !== 1 ||
        diagnosticIds[0] !== expectedDiagnosticId) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
    return {
        baseValidationTaskId,
        failedValidationTaskId,
        validationId,
        validationAttempt: validationAttempt,
        diagnosticIds: [diagnosticIds[0]],
    };
}
function assertRepairDiagnostics(identity, diagnostics, run) {
    const diagnostic = diagnostics[0];
    const failureCodes = diagnostic?.data.failureCodes;
    if (diagnostics.length !== 1 ||
        !diagnostic ||
        diagnostic.clientId !== run.clientId ||
        diagnostic.runId !== run.runId ||
        diagnostic.diagnosticId !== identity.diagnosticIds[0] ||
        diagnostic.taskId !== identity.failedValidationTaskId ||
        diagnostic.category !== "validation" ||
        diagnostic.code !== "agent_v2.validation_failed" ||
        diagnostic.phase !== "validation" ||
        diagnostic.data.validationId !== identity.validationId ||
        diagnostic.data.attempt !== identity.validationAttempt ||
        !isFailureCodeArray(failureCodes)) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
}
function collectRepairWorkspaceFiles(files, artifacts) {
    const candidates = artifacts
        .filter((artifact) => artifact.kind === "source" &&
        (artifact.validationStatus === "failed" || artifact.validationStatus === "pending") &&
        isRepairTextMediaType(artifact.mediaType))
        .sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.artifactId, right.artifactId));
    if (candidates.length === 0 || candidates.length > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFiles) {
        throw new AgentV2ModelContractError("limit_exceeded");
    }
    const existingPaths = new Set(files.listFiles().files);
    const seenPaths = new Set();
    const seenArtifacts = new Set();
    let totalBytes = 0;
    return candidates.map((artifact) => {
        if (seenPaths.has(artifact.path) ||
            seenArtifacts.has(artifact.artifactId) ||
            !existingPaths.has(artifact.path) ||
            files.validateWritePath(artifact.path) !== artifact.path) {
            throw new AgentV2ModelContractError("invalid_schema");
        }
        seenPaths.add(artifact.path);
        seenArtifacts.add(artifact.artifactId);
        const current = files.readFile(artifact.path);
        if (current.path !== artifact.path || current.truncated || !isStrictRepairText(current.content)) {
            throw new AgentV2ModelContractError("invalid_schema");
        }
        const byteLength = Buffer.byteLength(current.content, "utf8");
        totalBytes += byteLength;
        if (byteLength > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFileBytes ||
            totalBytes > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalBytes) {
            throw new AgentV2ModelContractError("limit_exceeded");
        }
        const checksum = `sha256:${createHash("sha256").update(current.content).digest("hex")}`;
        if (checksum !== artifact.checksum)
            throw new AgentV2ModelContractError("invalid_schema");
        return {
            artifactId: artifact.artifactId,
            path: artifact.path,
            mediaType: artifact.mediaType,
            checksum,
            byteLength,
            content: current.content,
        };
    });
}
function requireStableExecutionIdentifier(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u.test(value)) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
    return value;
}
function isFailureCodeArray(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 64 &&
        value.every((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u.test(item)));
}
function isRepairTextMediaType(value) {
    return value.startsWith("text/") || value === "application/json";
}
function isStrictRepairText(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
            return false;
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff)
                return false;
            index += 1;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}
function requireStringArray(value) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        value.some((item) => typeof item !== "string" || item.length === 0)) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
    return [...value];
}
function sameStrings(left, right) {
    if (left.length !== right.length)
        return false;
    const sortedLeft = [...left].sort(compareStrings);
    const sortedRight = [...right].sort(compareStrings);
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
function repairOutputSummary(fileCount) {
    return `Repair updated ${fileCount} generated ${fileCount === 1 ? "file" : "files"}.`;
}
function skillEvents(context, now) {
    if (!context)
        return [];
    return [
        ...context.skills.map((skill) => ({
            type: "agent_v2.skill_applied",
            name: skill.name,
            location: skill.location,
            at: now,
        })),
        ...context.resources.map((resource) => ({
            type: "agent_v2.skill_resource_loaded",
            name: resource.skillName,
            path: resource.path,
            checksum: resource.checksum,
            at: now,
        })),
    ];
}
function artifactAction(artifact) {
    return artifact.metadataJson?.action === "updated" ? "updated" : "created";
}
function sanitizeUserVisibleSummary(value, fileCount, mode) {
    let summary = value.trim();
    summary = summary.replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]");
    summary = summary.replace(/\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
    summary = summary.replace(/\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}\b/gu, "[redacted]");
    summary = summary.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/gu, "[redacted]");
    summary = summary.replace(/\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/gu, "[local-path]");
    summary = summary.replace(/(^|[\s(])\/(?:Users|home|var|tmp|opt|private|workspace)\/[^\s),;]+/gmu, "$1[local-path]");
    summary = summary.slice(0, 4000).trim();
    if (summary && summary !== "[redacted]")
        return summary;
    return mode === "repair" ? repairOutputSummary(fileCount) : implementationOutputSummary(fileCount);
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
function readPhase4TaskOutput(taskOutput) {
    return isRecord(taskOutput.phase4) ? taskOutput.phase4 : {};
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