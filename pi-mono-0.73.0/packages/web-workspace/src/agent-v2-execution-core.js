import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2FileAdapter } from "./agent-v2-file-adapter.js";
import { AGENT_V2_REPAIR_WORKSPACE_LIMITS, AgentV2ModelContractError, parseAgentV2ImplementationResult, parseAgentV2RepairResult, } from "./agent-v2-model-execution.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { inferAgentV2ResponseLanguage } from "./agent-v2-response-language.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "./agent-v2-runtime-core.js";
import { normalizeAgentV2ModelReference } from "./agent-v2-start-input.js";
import { phaseForAgentV2Task } from "./agent-v2-state-machine.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
import { assertAgentV2ToolAllowed, createAgentV2ToolRegistry, } from "./agent-v2-tool-governance.js";
import { runAgentV2StaticValidationGate, } from "./agent-v2-validation-gate.js";
import { PreviewReadinessChecker } from "./preview-readiness-checker.js";
import { assessProjectEntryConsistencyFiles, isProjectEntryConflictMessage } from "./project-entry-consistency.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
const MAX_REPAIR_MODEL_CONTRACT_RETRIES = 1;
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
        return executeValidationTask(input, snapshot.run, snapshot.contextPacket, snapshot.tasks, snapshot.artifacts, task, now);
    }
    if (task.kind === "implementation") {
        return executeImplementationTask(input, snapshot.run, snapshot.contextPacket, snapshot.artifacts, task, now);
    }
    if (task.kind === "repair") {
        try {
            return await executeRepairTask(input, snapshot.run, snapshot.contextPacket, snapshot.artifacts, snapshot.diagnostics, task, now);
        }
        catch (error) {
            throwIfAborted(input.signal);
            if (error instanceof AgentV2ModelContractError && isRecoverableRepairModelContractError(error)) {
                return commitRepairModelContractRecovery(input, snapshot.run, snapshot.tasks, task, now, error);
            }
            throw error;
        }
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
        readiness = await checkPreviewReadinessWithRetry(input.previewReadinessChecker ?? new PreviewReadinessChecker(input.config), input.context, input.signal ?? new AbortController().signal);
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
    const report = deliveryReportPayload(input, tasks, artifacts, transitioned, preview, now, inferAgentV2ResponseLanguage(run.input));
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
async function checkPreviewReadinessWithRetry(checker, context, signal) {
    const retryDelaysMs = [1_000, 2_500];
    let result = await checker.check(context);
    for (const delayMs of retryDelaysMs) {
        throwIfAborted(signal);
        if (result.ready || !isTransientPreviewReadinessFailure(result.reasonCode))
            return result;
        await abortableDelay(delayMs, signal);
        result = await checker.check(context);
    }
    return result;
}
function isTransientPreviewReadinessFailure(reasonCode) {
    return (reasonCode === "http_not_ok" ||
        reasonCode === "preview_url_missing" ||
        reasonCode === "html_error_page" ||
        reasonCode === "html_no_basic_content");
}
async function abortableDelay(delayMs, signal) {
    if (signal.aborted)
        throw agentV2AbortReason(signal);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(finish, delayMs);
        function finish() {
            signal.removeEventListener("abort", abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            reject(agentV2AbortReason(signal));
        }
        signal.addEventListener("abort", abort, { once: true });
    });
}
function agentV2AbortReason(signal) {
    if (signal.reason instanceof Error)
        return signal.reason;
    const error = new Error("Agent v2 execution was aborted.");
    error.name = "AbortError";
    return error;
}
function deliveryReportPayload(input, tasks, artifacts, deliveryTask, preview, now, responseLanguage) {
    const actionFiles = (action) => artifacts
        .filter((artifact) => artifact.metadataJson.action === action)
        .map((artifact) => artifact.path)
        .sort(compareStrings);
    const modelNotes = tasks
        .filter((candidate) => candidate.kind === "implementation" || candidate.kind === "repair")
        .map((candidate) => (typeof candidate.output.modelSummary === "string" ? candidate.output.modelSummary : ""))
        .filter(Boolean);
    const usedBuildStep = tasks
        .filter((candidate) => candidate.kind === "validation")
        .some((candidate) => candidate.output.usedBuildStep === true);
    return {
        type: "agent_v2.delivery_reported",
        taskId: deliveryTask.taskId,
        completedSummary: modelNotes.at(-1) ?? deliveryOutputSummary(artifacts.length, responseLanguage),
        appliedSkills: input.skillContext?.skills.map((skill) => skill.name) ?? [],
        createdFiles: actionFiles("created"),
        updatedFiles: actionFiles("updated"),
        validationStatus: "passed",
        buildStatus: usedBuildStep ? "passed" : "not_required",
        previewStatus: "running",
        previewReadiness: { verified: true, ready: true, reasonCode: "ready" },
        previewUrl: preview.previewUrl,
        projectId: preview.projectId,
        usageInstructions: usageInstructions(responseLanguage),
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
    if (messages.some(isProjectEntryConflictMessage)) {
        return {
            taxonomy: "publish_failed",
            code: "agent_v2.preview_entry_conflict",
            message: "Preview refused a project with multiple disconnected application implementations.",
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
    const diagnosticId = `${failure.code}:${task.taskId}:${run.attempt}`;
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
        data: { retryable: failure.retryable, taxonomy: failure.taxonomy, attempt: run.attempt },
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
async function executeImplementationTask(input, run, contextPacket, existingArtifacts, task, proposedNow) {
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
    const responseLanguage = inferAgentV2ResponseLanguage(run.input);
    const implementationSummary = sanitizeUserVisibleSummary(result.summary, generatedFiles.length, "implementation", responseLanguage, generatedFiles);
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
    const existingFiles = files.listFiles().files;
    assertNoWritePathCollisions(authorizedPaths, existingFiles);
    const generatedPathKeys = new Set(authorizedPaths.map(collisionKey));
    const obsoletePaths = task.input.recoveryMode === "full_regeneration"
        ? existingFiles.filter((path) => !generatedPathKeys.has(collisionKey(path)))
        : [];
    if (obsoletePaths.length > 0)
        assertAgentV2ToolAllowed(registry, "file.delete", "implementation");
    const obsoleteFiles = obsoletePaths.map((path) => ({ path, current: files.readFile(path) }));
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt, ...existingArtifacts.map((artifact) => artifact.updatedAt));
    const writes = generatedFiles.map((file) => files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }));
    for (const obsolete of obsoleteFiles)
        files.deleteFile(obsolete.path);
    const artifactById = new Map(existingArtifacts.map((artifact) => [artifact.artifactId, artifact]));
    const artifacts = [
        ...writes.map((write) => ({
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
            createdAt: artifactById.get(write.artifact.artifactId)?.createdAt ?? now,
            updatedAt: now,
        })),
        ...obsoleteFiles.map((obsolete) => deletedArtifactUpdate(input, artifactById, obsolete.path, obsolete.current.checksum, task.taskId, now)),
    ];
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    const implementationArtifactIds = artifacts
        .filter((artifact) => artifact.validationStatus !== "deleted")
        .map((artifact) => artifact.artifactId);
    const changedFiles = artifacts.map((artifact) => artifact.path);
    const deletedFiles = artifacts
        .filter((artifact) => artifact.validationStatus === "deleted")
        .map((artifact) => artifact.path);
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            modelSummary: implementationSummary,
            artifactIds,
            changedFiles,
            deletedFiles,
            phase4: {
                ...readPhase4TaskOutput(task.output),
                implementationArtifactIds,
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
        validationStatus: artifact.validationStatus === "deleted" ? "deleted" : "pending",
        revision: artifact.version,
        checksum: artifact.checksum,
        action: artifactAction(artifact),
        sourceTaskId: artifact.sourceTaskId,
        at: now,
    }));
    const outputPayload = {
        type: "agent_v2.output_recorded",
        taskId: task.taskId,
        summary: implementationSummary,
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
async function executeValidationTask(input, run, contextPacket, tasks, artifacts, task, proposedNow) {
    // Validation attempts include the initial pass. Eight attempts leave a small
    // bounded reserve for a new, independently repairable fingerprint introduced
    // by full regeneration or a late localized repair. Per-fingerprint budgets
    // still stop unchanged loops early, so this reserve cannot become an unbounded
    // retry cycle.
    const maxAttempts = input.maxRepairAttempts ?? 8;
    const { baseTaskId, attempt } = validationCoordinates(task);
    const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
    const productBlueprint = productBlueprintForValidation(contextPacket);
    const projectSources = productBlueprint ? projectSourcesForBlueprintValidation(input, artifacts) : [];
    throwIfAborted(input.signal);
    const result = await runAgentV2StaticValidationGate({
        config: input.config,
        context: input.context,
        runId: input.runId,
        taskId: task.taskId,
        now: proposedNow,
        toolRegistry: registry,
        ...(productBlueprint ? { productBlueprint, projectSources } : {}),
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
        summary: result.validation.summary,
        details: {
            failureCount: result.failures.length,
            blockingFailureCount: result.failures.filter((failure) => failure.blocking).length,
            nonBlockingFailureCount: result.failures.filter((failure) => !failure.blocking).length,
            failureCodes,
            retryableFailureCount: result.failures.filter((failure) => failure.blocking && failure.retryable).length,
            usedBuildStep: result.validation.details.usedBuildStep === true,
            warningCount: result.validation.details.warningCount,
            warnings: result.validation.details.warnings,
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
                usedBuildStep: result.validation.details.usedBuildStep === true,
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
        previousFingerprintAttempts: validationFingerprintAttempts(task),
        deliveryMode: repairDeliveryMode(contextPacket),
    });
    let retryableActions = repairActions.filter((action) => action.retryable);
    const eligibleForFullRegenerationFallback = attempt < maxAttempts &&
        attempt >= 2 &&
        retryableActions.length === 0 &&
        result.failures.some((failure) => failure.blocking && failure.retryable);
    if (eligibleForFullRegenerationFallback) {
        retryableActions = [createFullRegenerationRepairAction(task.taskId, result.failures)];
    }
    const canRecover = attempt < maxAttempts && retryableActions.length > 0;
    const requiresFullRegeneration = retryableActions.some((action) => action.type === "regenerate_app");
    const requiresFileRepair = retryableActions.some((action) => action.type === "file_patch");
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
            retryableFailureCount: result.failures.filter((failure) => failure.blocking && failure.retryable).length,
        },
        createdAt: now,
    });
    const failedArtifacts = relevantArtifacts.map((artifact) => validationArtifactUpdate(artifact, "failed", now));
    if (!canRecover) {
        const failureDetails = validationFailureDetails(result.failures);
        const fingerprintAttempts = mergeValidationFingerprintAttempts(task, result.failures);
        const primaryFailure = (result.failures.find((failure) => failure.blocking) ?? result.failures[0])?.message
            .trim()
            .slice(0, 1_000);
        const terminalMessage = primaryFailure
            ? `Static validation still failed after bounded recovery attempts: ${primaryFailure}`
            : "Static validation still failed after bounded recovery attempts.";
        const transitioned = transitionAgentV2Task({
            task,
            status: "failed",
            now,
            output: {
                ...task.output,
                validationId,
                attempt,
                maxAttempts,
                failureCodes,
                diagnosticIds: [diagnosticId],
            },
            error: {
                code: "agent_v2.validation_failed",
                message: terminalMessage,
                // Logical validation and repair retries are already represented by
                // distinct durable tasks and attempt identities. Requeueing this same
                // exhausted validation task would reuse its validation attempt key and
                // fail with an append conflict instead of creating a real recovery.
                retryable: false,
                data: {
                    validationId,
                    attempt,
                    maxAttempts,
                    failureCodes,
                    failureDetails,
                    diagnosticIds: [diagnosticId],
                    fingerprintAttempts,
                },
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
    const nextFingerprintAttempts = mergeValidationFingerprintAttempts(task, result.failures);
    if (!requiresFullRegeneration && !requiresFileRepair) {
        const revalidateTask = createDirectRevalidationTask(baseTaskId, task, attempt + 1, nextFingerprintAttempts, now);
        const transitioned = transitionAgentV2Task({
            task,
            status: "succeeded",
            now,
            output: {
                ...task.output,
                validationId,
                attempt,
                maxAttempts,
                recoveryMode: "rerun_validation",
                diagnosticIds: [diagnosticId],
            },
        });
        const rewiredDelivery = {
            ...delivery,
            dependsOn: [revalidateTask.taskId],
            updatedAt: now,
        };
        const phase = phaseForAgentV2Task(revalidateTask, revalidateTask.status);
        const changedTasks = [transitioned, revalidateTask, rewiredDelivery];
        const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
            clientId: input.context.clientId,
            runId: input.runId,
            expectedRun: expectedRunState(run),
            expectedTasks: [
                expectedTaskState(task),
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
    const repairTask = requiresFullRegeneration
        ? createFullRegenerationTask(baseTaskId, task, validationId, attempt, diagnosticId, retryableActions, now)
        : createRepairTask(baseTaskId, task, validationId, attempt, diagnosticId, retryableActions, now);
    const revalidateTask = createRevalidationTask(baseTaskId, repairTask, attempt + 1, nextFingerprintAttempts, now);
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
        severity: failure.severity,
        confidence: failure.confidence,
        blocking: failure.blocking,
        fingerprint: failure.fingerprint,
        repairBudget: failure.repairBudget,
        evidence: failure.evidence,
        ...(failure.path ? { path: failure.path.slice(0, 512) } : {}),
    }));
}
function repairDeliveryMode(contextPacket) {
    const content = contextPacket.documents.capabilityDecision?.contentJson;
    if (!isRecord(content))
        return undefined;
    const value = content.deliveryMode;
    return value === "static_app" ||
        value === "build_static_frontend" ||
        value === "static_simulation" ||
        value === "needs_clarification" ||
        value === "unsupported"
        ? value
        : undefined;
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
    const workspaceFiles = collectRepairWorkspaceFiles(files, artifacts, repairDiagnostics, repairIdentity.repairStrategy);
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
    const patches = [...(result.patches ?? [])].sort((left, right) => compareStrings(left.path, right.path));
    const deletedPaths = [...(result.deletedPaths ?? [])].sort(compareStrings);
    const workspaceByPath = new Map(workspaceFiles.map((file) => [file.path, file]));
    const existingFiles = files.listFiles().files;
    const existingSet = new Set(existingFiles);
    const dependencyFreeRootApplication = existingSet.has("index.html") &&
        ![...existingSet].some((path) => /(?:^|\/)package(?:-lock)?\.json$/iu.test(path));
    const authorizedPaths = generatedFiles.map((file) => {
        const authorizedPath = files.validateWritePath(file.path);
        if (authorizedPath !== file.path)
            throw new AgentV2ModelContractError("unsafe_path");
        if (dependencyFreeRootApplication &&
            !existingSet.has(authorizedPath) &&
            /^(?:src|app)\//iu.test(authorizedPath)) {
            // A localized repair must not create a second, unreferenced source-tree
            // implementation beside an already runnable dependency-free index.html.
            // Treat this as recoverable model-contract drift before it consumes the
            // next validation attempt with a deterministic project-entry conflict.
            throw new AgentV2ModelContractError("invalid_schema");
        }
        return authorizedPath;
    });
    const authorizedPatchPaths = patches.map((patch) => {
        const authorizedPath = files.validateWritePath(patch.path);
        if (authorizedPath !== patch.path || !existingSet.has(patch.path)) {
            throw new AgentV2ModelContractError("unsafe_path");
        }
        return authorizedPath;
    });
    const authorizedDeletedPaths = deletedPaths.map((path) => {
        const authorizedPath = files.validateWritePath(path);
        if (authorizedPath !== path || !existingSet.has(path) || !workspaceByPath.has(path)) {
            throw new AgentV2ModelContractError("unsafe_path");
        }
        return authorizedPath;
    });
    assertNoWritePathCollisions([...authorizedPaths, ...new Set(authorizedPatchPaths), ...authorizedDeletedPaths], existingFiles);
    if (authorizedDeletedPaths.length > 0)
        assertAgentV2ToolAllowed(registry, "file.delete", "repair");
    for (const file of generatedFiles) {
        if (workspaceByPath.get(file.path)?.contentMode === "excerpt") {
            throw new AgentV2ModelContractError("invalid_schema");
        }
    }
    const changedFiles = generatedFiles.filter((file) => {
        if (!existingSet.has(file.path))
            return true;
        const current = files.readFile(file.path);
        if (current.truncated)
            throw new AgentV2ModelContractError("limit_exceeded");
        return current.content !== file.content;
    });
    const changedPatchWrites = prepareRepairPatchWrites(patches, workspaceByPath, files);
    const deletions = authorizedDeletedPaths.map((path) => {
        const workspace = workspaceByPath.get(path);
        if (!workspace)
            throw new AgentV2ModelContractError("unsafe_path");
        const current = files.readFile(path);
        if (current.checksum !== workspace.checksum)
            throw new AgentV2ModelContractError("invalid_schema");
        return { path, checksum: current.checksum };
    });
    assertRepairChangedFileBudget(repairDiagnostics, changedFiles.map((file) => file.path), changedPatchWrites.map((write) => write.path), deletions.map((deletion) => deletion.path));
    assertRepairPreservesProjectEntry(files, existingFiles, changedFiles, changedPatchWrites, deletions);
    assertRepairPreservesInteractiveSurfaces(files, existingFiles, changedFiles, changedPatchWrites, deletions);
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt, ...artifacts.map((artifact) => artifact.updatedAt));
    if (changedFiles.length === 0 && changedPatchWrites.length === 0 && deletions.length === 0) {
        return commitNoChangeRepair(input, run, task, now);
    }
    const writes = [
        ...changedFiles.map((file) => files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now })),
        // Multiple checksum-bound edits for one file are validated against the
        // same original revision and persisted as one atomic rewrite. This avoids
        // a second patch observing the checksum/content produced by the first.
        ...changedPatchWrites.map((write) => files.writeFile({ path: write.path, content: write.content, mode: "rewrite", taskId: task.taskId, now })),
    ];
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    for (const deletion of deletions)
        files.deleteFile(deletion.path);
    const updatedArtifacts = [
        ...writes.map((write) => {
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
        }),
        ...deletions.map((deletion) => deletedArtifactUpdate(input, artifactById, deletion.path, deletion.checksum, task.taskId, now)),
    ];
    const responseLanguage = inferAgentV2ResponseLanguage(run.input);
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            modelSummary: repairOutputSummary(updatedArtifacts.length, responseLanguage),
            artifactIds: updatedArtifacts.map((artifact) => artifact.artifactId),
            changedFiles: updatedArtifacts.map((artifact) => artifact.path),
            deletedFiles: deletions.map((deletion) => deletion.path),
            addressedDiagnosticIds: diagnosticIds,
        },
    });
    const phase = phaseForAgentV2Task(task, transitioned.status);
    const usage = sanitizedUsage(envelope.usage);
    const events = [
        taskEvent(transitioned, phase, now),
        ...updatedArtifacts.map((artifact) => artifactEvent(artifact, artifact.validationStatus === "deleted" ? "deleted" : "pending", now)),
        {
            type: "agent_v2.output_recorded",
            payload: {
                type: "agent_v2.output_recorded",
                taskId: task.taskId,
                summary: repairOutputSummary(updatedArtifacts.length, responseLanguage),
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
function prepareRepairPatchWrites(patches, workspaceByPath, files) {
    const groups = new Map();
    for (const patch of patches) {
        const group = groups.get(patch.path) ?? [];
        group.push(patch);
        groups.set(patch.path, group);
    }
    const writes = [];
    for (const [path, group] of groups) {
        const workspace = workspaceByPath.get(path);
        const current = files.readFile(path);
        if (!workspace || current.truncated || current.checksum !== workspace.checksum) {
            throw new AgentV2ModelContractError("invalid_schema");
        }
        const byOldText = new Map();
        for (const patch of group) {
            if (patch.expectedChecksum !== workspace.checksum ||
                !workspace.content.includes(patch.oldText)) {
                throw new AgentV2ModelContractError("invalid_schema");
            }
            const duplicate = byOldText.get(patch.oldText);
            if (duplicate) {
                if (duplicate.newText !== patch.newText)
                    throw new AgentV2ModelContractError("duplicate_path");
                continue;
            }
            byOldText.set(patch.oldText, patch);
        }
        const replacements = [...byOldText.values()].map((patch) => {
            const start = current.content.indexOf(patch.oldText);
            if (start < 0 || current.content.indexOf(patch.oldText, start + 1) >= 0) {
                throw new AgentV2ModelContractError("invalid_schema");
            }
            return { patch, start, end: start + patch.oldText.length };
        });
        replacements.sort((left, right) => left.start - right.start || left.end - right.end);
        for (let index = 1; index < replacements.length; index += 1) {
            const previous = replacements[index - 1];
            const currentReplacement = replacements[index];
            if (!previous || !currentReplacement)
                throw new AgentV2ModelContractError("invalid_schema");
            if (currentReplacement.start < previous.end)
                throw new AgentV2ModelContractError("duplicate_path");
        }
        const changed = replacements.filter(({ patch }) => patch.oldText !== patch.newText);
        let content = current.content;
        for (const replacement of [...changed].sort((left, right) => right.start - left.start)) {
            content = `${content.slice(0, replacement.start)}${replacement.patch.newText}${content.slice(replacement.end)}`;
        }
        if (content === current.content)
            continue;
        writes.push({ path, content, patches: changed.map(({ patch }) => patch) });
    }
    return writes;
}
function assertRepairChangedFileBudget(diagnostics, filePaths, patchPaths, deletedPaths) {
    const limits = [];
    const blockingPaths = new Set();
    let hasPathlessBlockingFinding = false;
    for (const diagnostic of diagnostics) {
        const details = diagnostic.data.failureDetails;
        if (!Array.isArray(details))
            continue;
        for (const detail of details) {
            if (!detail || typeof detail !== "object" || Array.isArray(detail))
                continue;
            const typedDetail = detail;
            if (typedDetail.blocking === true) {
                const path = typeof typedDetail.path === "string" ? typedDetail.path.trim().replaceAll("\\", "/") : "";
                if (path)
                    blockingPaths.add(path);
                else
                    hasPathlessBlockingFinding = true;
            }
            const repairBudget = typedDetail.repairBudget;
            if (!repairBudget || typeof repairBudget !== "object" || Array.isArray(repairBudget))
                continue;
            const maxChangedFiles = repairBudget.maxChangedFiles;
            if (typeof maxChangedFiles === "number" && Number.isSafeInteger(maxChangedFiles) && maxChangedFiles >= 0) {
                limits.push(maxChangedFiles);
            }
        }
    }
    if (limits.length === 0)
        return;
    // Several independent, explicit failures can legitimately require several
    // sibling files (for example two missing scripts plus one missing stylesheet).
    // A strict max-of-one-detail budget makes a correct atomic repair impossible
    // and encourages repeated schema failures. Keep the expansion evidence-bound
    // and globally capped; one vague pathless failure can authorize at most one
    // additional related file, never an unrestricted project rewrite.
    const evidenceBoundAllowance = Math.min(4, blockingPaths.size + (hasPathlessBlockingFinding ? 1 : 0));
    const maxChangedFiles = Math.max(...limits, evidenceBoundAllowance);
    const changedPaths = new Set([...filePaths, ...patchPaths, ...deletedPaths]);
    if (changedPaths.size > maxChangedFiles)
        throw new AgentV2ModelContractError("invalid_schema");
}
function assertRepairPreservesProjectEntry(files, existingFiles, changedFiles, changedPatchWrites, deletions) {
    const projectedFiles = new Map(existingFiles.map((path) => [path, path.toLowerCase() === "index.html" ? files.readFile(path).content : ""]));
    const baseline = assessProjectEntryConsistencyFiles([...projectedFiles].map(([path, content]) => ({ path, content })));
    for (const file of changedFiles)
        projectedFiles.set(file.path, file.content);
    for (const write of changedPatchWrites)
        projectedFiles.set(write.path, write.content);
    for (const deletion of deletions)
        projectedFiles.delete(deletion.path);
    const projected = assessProjectEntryConsistencyFiles([...projectedFiles].map(([path, content]) => ({ path, content })));
    if (baseline.valid && !projected.valid) {
        // Repair is a bounded correction, not permission to replace a valid entry
        // topology with disconnected implementations or build source that cannot run.
        // Reject before writing so a model detour does not consume validation budget.
        throw new AgentV2ModelContractError("invalid_schema");
    }
}
function assertRepairPreservesInteractiveSurfaces(files, existingFiles, changedFiles, changedPatchWrites, deletions) {
    const htmlPaths = existingFiles.filter((path) => /(?:^|\/)index\.html?$|\.html?$/iu.test(path));
    if (htmlPaths.length === 0)
        return;
    const projectedFiles = new Map();
    for (const path of htmlPaths) {
        const current = files.readFile(path);
        // A truncated source cannot support a high-confidence structural comparison.
        // Fail open here and let normal validation inspect the persisted revision.
        if (current.truncated)
            return;
        projectedFiles.set(path, current.content);
    }
    const baseline = interactiveSurfaceInventory([...projectedFiles.values()].join("\n"));
    for (const file of changedFiles) {
        if (/\.html?$/iu.test(file.path))
            projectedFiles.set(file.path, file.content);
    }
    for (const write of changedPatchWrites) {
        if (!/\.html?$/iu.test(write.path))
            continue;
        if (projectedFiles.has(write.path))
            projectedFiles.set(write.path, write.content);
    }
    for (const deletion of deletions)
        projectedFiles.delete(deletion.path);
    const projected = interactiveSurfaceInventory([...projectedFiles.values()].join("\n"));
    const removedSelect = [...baseline.selectIds].some((id) => !projected.selectIds.has(id));
    const removedChartHost = [...baseline.chartHostIds].some((id) => !projected.chartHostIds.has(id));
    const removedTable = baseline.hasTableSurface && !projected.hasTableSurface;
    if (removedSelect || removedChartHost || removedTable) {
        // A targeted repair may change data derivation or chart technology, but it is
        // not permission to make the validator pass by deleting an existing control,
        // chart host, or detail table. Reject before writing so bounded contract
        // recovery can request a localized correction without spending a validation
        // attempt on a deterministic product regression.
        throw new AgentV2ModelContractError("invalid_schema");
    }
}
function interactiveSurfaceInventory(source) {
    const selectIds = new Set();
    const chartHostIds = new Set();
    for (const element of source.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/gu)) {
        const tag = element[1]?.toLowerCase();
        const attributes = element[2] ?? "";
        const id = htmlAttributeValue(attributes, "id");
        if (tag === "select" && id)
            selectIds.add(id);
        if (!id)
            continue;
        const className = htmlAttributeValue(attributes, "class");
        if (/(?:^|[-_\s])(?:chart|trend|graph|plot|pareto|donut|histogram|visuali[sz]ation|viz|heatmap|treemap|choropleth|map|gauge|network|diagram|timeline|calendar|matrix)(?:$|[-_\s])/iu.test(`${id} ${className}`)) {
            chartHostIds.add(id);
        }
    }
    return {
        selectIds,
        chartHostIds,
        hasTableSurface: /<table\b/iu.test(source) ||
            /<[A-Za-z][\w:-]*\b[^>]*\brole\s*=\s*(["'])\s*(?:table|grid|treegrid)\s*\1/iu.test(source),
    };
}
function htmlAttributeValue(attributes, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(String.raw `\b${escapedName}\s*=\s*(["'])(.*?)\1`, "iu").exec(attributes)?.[2]?.trim() ?? "";
}
function validationCoordinates(task) {
    const match = /^revalidate:([A-Za-z0-9][A-Za-z0-9._:~-]*):([2-9][0-9]*)$/u.exec(task.taskId);
    if (!match)
        return { baseTaskId: task.taskId, attempt: 1 };
    return { baseTaskId: match[1], attempt: Number(match[2]) };
}
function createRepairTask(baseTaskId, validationTask, validationId, attempt, diagnosticId, repairActions, now) {
    const previousFingerprintAttempts = validationFingerprintAttempts(validationTask);
    const repeatedFinding = repairActions.some((action) => (previousFingerprintAttempts[action.validationFingerprint] ?? 0) > 0);
    // Global validation attempt numbers can be high after a full regeneration,
    // while the current fingerprint is brand new and narrowly scoped. Escalate to
    // rewriting affected files only after this exact finding has already survived
    // a repair; a late first occurrence still receives a localized patch.
    const repairStrategy = repeatedFinding ? "rewrite_affected_files" : "targeted_patch";
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
            repairStrategy,
            repairActions: repairActions.map((action) => ({
                actionId: action.actionId,
                type: action.type,
                reason: action.reason,
                validationCode: action.validationCode,
                validationFingerprint: action.validationFingerprint,
                ...(action.targetPath ? { targetPath: action.targetPath } : {}),
            })),
        },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function createFullRegenerationTask(baseTaskId, validationTask, validationId, attempt, diagnosticId, repairActions, now) {
    const recoveryEvidence = repairActions
        .map((action) => `${action.validationCode}: ${action.reason}`)
        .join(" | ")
        .slice(0, 4_000);
    const failedCanvasRecovery = repairActions.some((action) => action.validationCode.startsWith("static.canvas_"));
    return {
        taskId: `regenerate:${baseTaskId}:${attempt}`,
        parentTaskId: validationTask.taskId,
        kind: "implementation",
        title: `Regenerate application after validation attempt ${attempt}`,
        status: "pending",
        dependsOn: [validationTask.taskId],
        acceptanceCriteria: [
            "Generate a complete browser-ready application entry point.",
            "Prefer a self-contained implementation that does not depend on previously failing files.",
            ...(failedCanvasRecovery
                ? [
                    "The previous native Canvas implementation could not be repaired reliably. Regenerate ordinary dashboard charts as responsive SVG with bounded viewports and matching viewBox coordinates unless the source explicitly requires pixel APIs; do not reproduce the failing Canvas implementation.",
                ]
                : []),
            ...(recoveryEvidence
                ? [`Resolve the latest runtime evidence before returning files: ${recoveryEvidence}`]
                : []),
        ],
        input: {
            baseValidationTaskId: baseTaskId,
            failedValidationTaskId: validationTask.taskId,
            validationId,
            validationAttempt: attempt,
            diagnosticIds: [diagnosticId],
            recoveryMode: "full_regeneration",
            repairActions: repairActions.map((action) => ({
                actionId: action.actionId,
                type: action.type,
                reason: action.reason,
                validationCode: action.validationCode,
                validationFingerprint: action.validationFingerprint,
            })),
        },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function createFullRegenerationRepairAction(taskId, failures) {
    const failure = failures.find((candidate) => candidate.blocking && candidate.retryable);
    if (!failure)
        throw new AgentV2ModelContractError("invalid_schema");
    return {
        actionId: `repair:${taskId}:full_regeneration`,
        taskId,
        type: "regenerate_app",
        retryable: true,
        reason: `Targeted repair made no durable progress; regenerate a complete self-contained application. Latest runtime evidence: ${failure.message.slice(0, 2_000)}`,
        validationCode: failure.code,
        validationFingerprint: failure.fingerprint,
    };
}
function createDirectRevalidationTask(baseTaskId, failedValidationTask, attempt, validationFingerprintAttempts, now) {
    return {
        taskId: `revalidate:${baseTaskId}:${attempt}`,
        parentTaskId: failedValidationTask.taskId,
        kind: "validation",
        title: `Retry validation attempt ${attempt}`,
        status: "pending",
        dependsOn: [failedValidationTask.taskId],
        acceptanceCriteria: ["Repeat validation without changing project files."],
        input: {
            baseValidationTaskId: baseTaskId,
            validationAttempt: attempt,
            validationFingerprintAttempts,
            recoveryMode: "rerun_validation",
        },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function createRevalidationTask(baseTaskId, repairTask, attempt, validationFingerprintAttempts, now) {
    return {
        taskId: `revalidate:${baseTaskId}:${attempt}`,
        parentTaskId: repairTask.taskId,
        kind: "validation",
        title: `Revalidate after repair attempt ${attempt - 1}`,
        status: "pending",
        dependsOn: [repairTask.taskId],
        acceptanceCriteria: ["Validate the latest persisted artifact revision."],
        input: {
            baseValidationTaskId: baseTaskId,
            validationAttempt: attempt,
            validationFingerprintAttempts,
            ...(repairTask.input.recoveryMode === "full_regeneration" ? { fullRegenerationUsed: true } : {}),
        },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function validationFingerprintAttempts(task) {
    const value = task.input.validationFingerprintAttempts;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const result = {};
    for (const [fingerprint, attempts] of Object.entries(value)) {
        if (!fingerprint.startsWith("sha256:") || typeof attempts !== "number" || !Number.isSafeInteger(attempts))
            continue;
        if (attempts < 1 || attempts > 32)
            continue;
        result[fingerprint] = attempts;
    }
    return result;
}
function mergeValidationFingerprintAttempts(task, failures) {
    const result = validationFingerprintAttempts(task);
    for (const failure of failures) {
        result[failure.fingerprint] = Math.min(32, (result[failure.fingerprint] ?? 0) + 1);
    }
    return result;
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
function deletedArtifactUpdate(input, artifactById, path, checksum, sourceTaskId, now) {
    const artifactId = `file:${path}`;
    const existing = artifactById.get(artifactId);
    return {
        clientId: input.context.clientId,
        runId: input.runId,
        artifactId,
        kind: existing?.kind ?? "source",
        path,
        mediaType: existing?.mediaType ?? "text/plain",
        checksum,
        version: checksum,
        sourceTaskId,
        validationStatus: "deleted",
        metadataJson: { action: "deleted" },
        createdAt: existing?.createdAt ?? now,
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
function isRecoverableRepairModelContractError(error) {
    return (error.code === "invalid_protocol" ||
        error.code === "invalid_schema" ||
        error.code === "invalid_identifier" ||
        error.code === "invalid_unicode" ||
        error.code === "limit_exceeded" ||
        error.code === "duplicate_path");
}
async function commitRepairModelContractRecovery(input, run, tasks, task, proposedNow, error) {
    const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
    const diagnosticId = `agent_v2.repair_model_contract_recovery:${task.taskId}`;
    const recoveryAttempt = repairModelContractRecoveryAttempt(task);
    const revalidationTask = tasks.find((candidate) => candidate.kind === "validation" &&
        (candidate.status === "pending" || candidate.status === "ready") &&
        candidate.dependsOn.length === 1 &&
        candidate.dependsOn[0] === task.taskId);
    const canRetryContract = recoveryAttempt < MAX_REPAIR_MODEL_CONTRACT_RETRIES && revalidationTask !== undefined;
    const diagnostic = createAgentV2DiagnosticEvent({
        diagnosticId,
        clientId: input.context.clientId,
        runId: input.runId,
        severity: "warn",
        category: "model",
        code: "agent_v2.repair_model_contract_recovery",
        phase: "repair",
        taskId: task.taskId,
        message: canRetryContract
            ? "Repair output was unusable; retrying the repair contract once without consuming a static-validation attempt."
            : "Repair output remained unusable after bounded contract recovery; the unchanged workspace will be revalidated with complete diagnostics.",
        data: {
            modelContractCode: error.code,
            ...(canRetryContract ? { nextContractRecoveryAttempt: recoveryAttempt + 1 } : {}),
        },
        createdAt: now,
    });
    if (canRetryContract && revalidationTask) {
        const retryTask = createRepairModelContractRetryTask(task, recoveryAttempt + 1, now);
        const transitioned = transitionAgentV2Task({
            task,
            status: "succeeded",
            now,
            output: {
                ...task.output,
                changedFiles: [],
                recoveryMode: "model_contract_retry",
                modelContractCode: error.code,
                contractRecoveryAttempt: recoveryAttempt,
            },
        });
        const rewiredRevalidation = {
            ...revalidationTask,
            dependsOn: [retryTask.taskId],
            updatedAt: now,
        };
        const phase = phaseForAgentV2Task(retryTask, retryTask.status);
        const changedTasks = [transitioned, retryTask, rewiredRevalidation];
        const mutation = await Promise.resolve(input.store.commitAgentV2ExecutionMutation({
            clientId: input.context.clientId,
            runId: input.runId,
            expectedRun: expectedRunState(run),
            expectedTasks: [
                expectedTaskState(task),
                { taskId: retryTask.taskId, absent: true },
                expectedTaskState(revalidationTask),
            ],
            updatedAt: now,
            nextRunPhase: phase,
            tasks: changedTasks.map((candidate) => toUpsertTaskInput(input.context.clientId, input.runId, candidate)),
            diagnostics: [diagnostic],
            events: [
                diagnosticEvent(diagnostic, now),
                ...changedTasks.map((candidate) => taskEvent(candidate, phase, now)),
            ],
        }));
        return mutation.applied
            ? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [diagnosticId] }
            : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
    }
    const transitioned = transitionAgentV2Task({
        task,
        status: "succeeded",
        now,
        output: {
            ...task.output,
            changedFiles: [],
            recoveryMode: "model_contract_revalidation",
            modelContractCode: error.code,
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
        ? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [diagnosticId] }
        : { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}
function repairModelContractRecoveryAttempt(task) {
    const value = task.input.contractRecoveryAttempt;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 0;
}
function createRepairModelContractRetryTask(task, contractRecoveryAttempt, now) {
    return {
        ...task,
        taskId: `${baseRepairTaskId(task)}:contract-retry:${contractRecoveryAttempt}`,
        parentTaskId: task.taskId,
        title: `Retry ${task.title} after model contract recovery`,
        status: "pending",
        dependsOn: [task.taskId],
        acceptanceCriteria: [
            ...task.acceptanceCriteria,
            "Return the exact repair JSON contract and change only the disclosed affected files.",
        ],
        input: { ...task.input, contractRecoveryAttempt },
        output: {},
        createdAt: now,
        updatedAt: now,
    };
}
function baseRepairTaskId(task) {
    return task.taskId.replace(/:contract-retry:[1-9][0-9]*$/u, "");
}
function requireRepairIdentity(task) {
    const baseValidationTaskId = requireStableExecutionIdentifier(task.input.baseValidationTaskId);
    const failedValidationTaskId = requireStableExecutionIdentifier(task.input.failedValidationTaskId);
    const validationId = requireStableExecutionIdentifier(task.input.validationId);
    const validationAttempt = task.input.validationAttempt;
    const diagnosticIds = requireStringArray(task.input.diagnosticIds);
    const repairStrategy = task.input.repairStrategy;
    const expectedDiagnosticId = `agent_v2.validation_failed:${baseValidationTaskId}:${String(validationAttempt)}`;
    const recoveryAttempt = repairModelContractRecoveryAttempt(task);
    const expectedBaseTaskId = `repair:${baseValidationTaskId}:${String(validationAttempt)}`;
    const expectedTaskId = recoveryAttempt === 0 ? expectedBaseTaskId : `${expectedBaseTaskId}:contract-retry:${recoveryAttempt}`;
    const expectedDependency = recoveryAttempt === 0
        ? failedValidationTaskId
        : recoveryAttempt === 1
            ? expectedBaseTaskId
            : `${expectedBaseTaskId}:contract-retry:${recoveryAttempt - 1}`;
    if (task.kind !== "repair" ||
        !Number.isSafeInteger(validationAttempt) ||
        validationAttempt < 1 ||
        !Number.isSafeInteger(recoveryAttempt) ||
        recoveryAttempt < 0 ||
        recoveryAttempt > MAX_REPAIR_MODEL_CONTRACT_RETRIES ||
        task.taskId !== expectedTaskId ||
        task.parentTaskId !== expectedDependency ||
        task.dependsOn.length !== 1 ||
        task.dependsOn[0] !== expectedDependency ||
        validationId !== `static:${baseValidationTaskId}` ||
        diagnosticIds.length !== 1 ||
        diagnosticIds[0] !== expectedDiagnosticId ||
        (repairStrategy !== "targeted_patch" && repairStrategy !== "rewrite_affected_files")) {
        throw new AgentV2ModelContractError("invalid_schema");
    }
    return {
        baseValidationTaskId,
        failedValidationTaskId,
        validationId,
        validationAttempt: validationAttempt,
        diagnosticIds: [diagnosticIds[0]],
        repairStrategy,
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
function collectRepairWorkspaceFiles(files, artifacts, diagnostics, repairStrategy) {
    const eligible = artifacts
        .filter((artifact) => artifact.kind === "source" &&
        (artifact.validationStatus === "failed" || artifact.validationStatus === "pending") &&
        isRepairTextMediaType(artifact.mediaType))
        .sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.artifactId, right.artifactId));
    const diagnosticPaths = repairDiagnosticPaths(diagnostics);
    const targeted = eligible.filter((artifact) => diagnosticPaths.has(artifact.path));
    const candidates = hasCrossFileRepairDiagnostic(diagnostics) ? eligible : targeted.length > 0 ? targeted : eligible;
    if (candidates.length === 0)
        throw new AgentV2ModelContractError("invalid_schema");
    // Repair context is a batch budget, never a project/file-size admission rule.
    // Keep enough evidence per selected file and let the following validation pass
    // surface any remaining files for the next repair batch.
    const minimumContextBytesPerFile = 8_192;
    const batchSize = Math.min(candidates.length, AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFiles, Math.max(1, Math.floor(AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalContextBytes / minimumContextBytesPerFile)));
    const selectedCandidates = candidates.slice(0, batchSize);
    const existingPaths = new Set(files.listFiles().files);
    const seenPaths = new Set();
    const seenArtifacts = new Set();
    let totalBytes = 0;
    return selectedCandidates.map((artifact, index) => {
        if (seenPaths.has(artifact.path) ||
            seenArtifacts.has(artifact.artifactId) ||
            !existingPaths.has(artifact.path) ||
            files.validateWritePath(artifact.path) !== artifact.path) {
            throw new AgentV2ModelContractError("invalid_schema");
        }
        seenPaths.add(artifact.path);
        seenArtifacts.add(artifact.artifactId);
        const current = files.readFile(artifact.path);
        if (current.path !== artifact.path ||
            !isStrictRepairText(current.content) ||
            current.checksum !== artifact.checksum) {
            throw new AgentV2ModelContractError("invalid_schema");
        }
        const remainingContextBytes = AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalContextBytes - totalBytes;
        const remainingFiles = selectedCandidates.length - index;
        const allocatedContextBytes = Math.min(AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxContextBytesPerFile, Math.floor(remainingContextBytes / remainingFiles));
        const fullByteLength = current.byteLength;
        // Several findings against one generated file are still one localized repair.
        // Excerpt mode prevents a model from spending its complete output budget on a
        // full-file rewrite merely because the file happened to fit in the input
        // context. Later rewrite_affected_files recovery retains the explicit escape
        // hatch when a localized patch genuinely cannot converge.
        const forceExcerpt = repairStrategy === "targeted_patch" && repairFailureDetailCount(diagnostics, artifact.path) > 1;
        const fullFits = !forceExcerpt && !current.truncated && fullByteLength <= allocatedContextBytes;
        const content = fullFits
            ? current.content
            : buildRepairExcerpt(current.content, diagnostics, artifact.path, allocatedContextBytes);
        const contentByteLength = Buffer.byteLength(content, "utf8");
        if (contentByteLength === 0)
            throw new AgentV2ModelContractError("repair_workspace_limit_exceeded");
        totalBytes += contentByteLength;
        return {
            artifactId: artifact.artifactId,
            path: artifact.path,
            mediaType: artifact.mediaType,
            checksum: current.checksum,
            byteLength: fullByteLength,
            content,
            contentMode: fullFits ? "full" : "excerpt",
            contentByteLength,
        };
    });
}
function repairFailureDetailCount(diagnostics, path) {
    let count = 0;
    for (const diagnostic of diagnostics) {
        const details = diagnostic.data.failureDetails;
        if (!Array.isArray(details))
            continue;
        for (const detail of details) {
            if (!detail || typeof detail !== "object" || Array.isArray(detail))
                continue;
            const detailPath = detail.path;
            if (typeof detailPath === "string" && detailPath.replaceAll("\\", "/") === path)
                count += 1;
        }
    }
    return count;
}
function hasCrossFileRepairDiagnostic(diagnostics) {
    const crossFileCodes = new Set([
        "static.project_entry_conflict",
        "static.build_manifest_missing",
        "build.output_missing",
    ]);
    return diagnostics.some((diagnostic) => {
        const failureCodes = diagnostic.data.failureCodes;
        return (Array.isArray(failureCodes) &&
            failureCodes.some((code) => typeof code === "string" && crossFileCodes.has(code)));
    });
}
function repairDiagnosticPaths(diagnostics) {
    const paths = new Set();
    for (const diagnostic of diagnostics) {
        const details = diagnostic.data.failureDetails;
        if (!Array.isArray(details))
            continue;
        for (const detail of details) {
            if (!detail || typeof detail !== "object" || Array.isArray(detail))
                continue;
            const path = detail.path;
            if (typeof path === "string" && path.trim())
                paths.add(path.replaceAll("\\", "/"));
        }
    }
    return paths;
}
function buildRepairExcerpt(content, diagnostics, path, maxBytes) {
    const anchors = new Set(["addEventListener", "DOMContentLoaded"]);
    for (const diagnostic of diagnostics) {
        const details = diagnostic.data.failureDetails;
        if (!Array.isArray(details))
            continue;
        for (const detail of details) {
            if (!detail || typeof detail !== "object" || Array.isArray(detail))
                continue;
            const record = detail;
            if (typeof record.path === "string" && record.path.replaceAll("\\", "/") !== path)
                continue;
            if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
                const selector = record.data.selector;
                if (typeof selector === "string" && selector.trim()) {
                    anchors.add(selector);
                    anchors.add(selector.replace(/^#/u, ""));
                }
            }
            if (Array.isArray(record.evidence)) {
                for (const item of record.evidence) {
                    if (!item || typeof item !== "object" || Array.isArray(item))
                        continue;
                    const selector = item.selector;
                    if (typeof selector !== "string" || !selector.trim())
                        continue;
                    anchors.add(selector);
                    anchors.add(selector.replace(/^#/u, ""));
                }
            }
            if (typeof record.message === "string") {
                for (const match of record.message.matchAll(/#[A-Za-z][\w-]*/gu)) {
                    anchors.add(match[0]);
                    anchors.add(match[0].slice(1));
                }
            }
        }
    }
    const ranges = [];
    const radius = 8_192;
    for (const anchor of anchors) {
        let index = content.indexOf(anchor);
        while (index >= 0 && ranges.length < 16) {
            ranges.push({
                start: Math.max(0, index - radius),
                end: Math.min(content.length, index + anchor.length + radius),
            });
            index = content.indexOf(anchor, index + anchor.length);
        }
    }
    ranges.push({ start: 0, end: Math.min(content.length, 8_192) });
    ranges.push({ start: Math.max(0, content.length - 8_192), end: content.length });
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end)
            previous.end = Math.max(previous.end, range.end);
        else
            merged.push({ ...range });
    }
    if (merged.length === 1 && merged[0]?.start === 0 && merged[0].end === content.length) {
        return utf8Prefix(content, Math.min(maxBytes, Buffer.byteLength(content, "utf8")));
    }
    const sections = merged.map((range) => `\n<!-- AGENT_V2_EXCERPT ${range.start}:${range.end} -->\n${content.slice(range.start, range.end)}`);
    // Range labels are repair guidance, not source bytes. Never let those labels
    // make an excerpt larger than the checksum-bound source file: the prompt
    // contract intentionally rejects impossible excerpt metadata.
    return utf8Prefix(sections.join(""), Math.min(maxBytes, Buffer.byteLength(content, "utf8")));
}
function utf8Prefix(value, maxBytes) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes)
            low = middle;
        else
            high = middle - 1;
    }
    let end = low;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return value.slice(0, end);
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
function repairOutputSummary(fileCount, language) {
    if (language === "zh")
        return `修复已更新 ${fileCount} 个生成文件。`;
    if (language === "de")
        return `Die Reparatur hat ${fileCount} generierte ${fileCount === 1 ? "Datei" : "Dateien"} aktualisiert.`;
    if (language === "ms")
        return `Pembaikan mengemas kini ${fileCount} fail yang dijana.`;
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
    if (artifact.metadataJson?.action === "deleted")
        return "deleted";
    return artifact.metadataJson?.action === "updated" ? "updated" : "created";
}
function sanitizeUserVisibleSummary(value, fileCount, mode, language, projectFiles = []) {
    let summary = value.trim();
    summary = summary.replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]");
    summary = summary.replace(/\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
    summary = summary.replace(/\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}\b/gu, "[redacted]");
    summary = summary.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/gu, "[redacted]");
    summary = summary.replace(/\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/gu, "[local-path]");
    summary = summary.replace(/(^|[\s(])\/(?:Users|home|var|tmp|opt|private|workspace)\/[^\s),;]+/gmu, "$1[local-path]");
    summary = summary.slice(0, 4000).trim();
    if (mode === "implementation" && summaryClaimsAbsentProjectSurface(summary, projectFiles)) {
        return implementationOutputSummary(fileCount, language);
    }
    if (summary && summary !== "[redacted]" && (language !== "zh" || /\p{Script=Han}/u.test(summary)))
        return summary;
    return mode === "repair"
        ? repairOutputSummary(fileCount, language)
        : implementationOutputSummary(fileCount, language);
}
function summaryClaimsAbsentProjectSurface(summary, projectFiles) {
    if (projectFiles.length === 0)
        return false;
    const source = projectFiles.map((file) => file.content).join("\n");
    const claimsChartJs = /\bChart\.?js\b/iu.test(summary);
    const claimsSvgCharts = /\b(?:native\s+)?SVG\s+(?:charts?|graphs?|plots?|visualizations?)\b/iu.test(summary);
    const claimsCanvasCharts = /\b(?:native\s+)?Canvas(?:\s*2D)?\s+(?:charts?|graphs?|plots?|visualizations?)\b/iu.test(summary);
    const claimsDataTable = /\b(?:detail(?:ed)?\s+(?:data\s+)?(?:table|grid)|data\s+grid)\b/iu.test(summary);
    const hasChartJs = /\bnew\s+Chart\s*\(|\bChart\s*\.\s*register\s*\(|chart(?:\.min)?\.js/iu.test(source);
    const visualizationSemantic = "(?:chart|graph|plot|trend|pareto|donut|visuali[sz]ation|viz|heatmap|treemap|choropleth|map|gauge|network|diagram|timeline|calendar|matrix)";
    const hasSvgChart = new RegExp(`<svg\\b[^>]*(?:id|class)\\s*=\\s*["'][^"']*${visualizationSemantic}`, "iu").test(source) ||
        new RegExp(`createElementNS\\s*\\([\\s\\S]{0,160}?["']svg["'][\\s\\S]{0,320}?${visualizationSemantic}`, "iu").test(source);
    const hasCanvasChart = new RegExp(`<canvas\\b[^>]*(?:id|class)\\s*=\\s*["'][^"']*${visualizationSemantic}`, "iu").test(source) &&
        /getContext\s*\(\s*["']2d["']\s*\)/iu.test(source);
    const hasDataTable = /<table\b/iu.test(source) ||
        /(?:createElement|createElementNS)\s*\(\s*["']table["']\s*\)/iu.test(source) ||
        /<(?:[A-Z][\w.]*Table|DataGrid)\b/u.test(source) ||
        /\brole\s*=\s*["'](?:table|grid)["']/iu.test(source);
    return ((claimsChartJs && !hasChartJs) ||
        (claimsSvgCharts && !hasSvgChart) ||
        (claimsCanvasCharts && !hasCanvasChart) ||
        (claimsDataTable && !hasDataTable));
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
function implementationOutputSummary(fileCount, language) {
    if (language === "zh")
        return `已生成 ${fileCount} 个文件。`;
    if (language === "de")
        return `${fileCount} ${fileCount === 1 ? "Datei wurde" : "Dateien wurden"} generiert.`;
    if (language === "ms")
        return `${fileCount} fail telah dijana.`;
    return `Generated ${fileCount} ${fileCount === 1 ? "file" : "files"}.`;
}
function deliveryOutputSummary(fileCount, language) {
    if (language === "zh")
        return `已创建并验证 ${fileCount} 个生成文件。`;
    if (language === "de")
        return `${fileCount} generierte ${fileCount === 1 ? "Datei wurde" : "Dateien wurden"} erstellt und geprüft.`;
    if (language === "ms")
        return `${fileCount} fail yang dijana telah dicipta dan disahkan.`;
    return `Created and validated ${fileCount} generated ${fileCount === 1 ? "file" : "files"}.`;
}
function usageInstructions(language) {
    if (language === "zh")
        return "打开预览链接即可使用并检查生成的应用。";
    if (language === "de")
        return "Öffnen Sie den Vorschaulink, um die generierte Anwendung zu verwenden und zu prüfen.";
    if (language === "ms")
        return "Buka pautan pratonton untuk menggunakan dan menyemak aplikasi yang dijana.";
    return "Open the preview URL to use and review the generated application.";
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function readPhase4TaskOutput(taskOutput) {
    return isRecord(taskOutput.phase4) ? taskOutput.phase4 : {};
}
const BLUEPRINT_VALIDATION_SOURCE_PATTERN = /\.(?:html?|css|js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/iu;
const BLUEPRINT_VALIDATION_MAX_FILES = 64;
const BLUEPRINT_VALIDATION_MAX_FILE_BYTES = 1_048_576;
const BLUEPRINT_VALIDATION_MAX_TOTAL_BYTES = 4_194_304;
function productBlueprintForValidation(contextPacket) {
    const content = contextPacket.documents.productBlueprint?.contentJson;
    return content?.kind === "product_blueprint" ? content : undefined;
}
function projectSourcesForBlueprintValidation(input, artifacts) {
    const files = createAgentV2FileAdapter({ config: input.config, context: input.context });
    const currentPaths = new Set(files.listFiles().files);
    const paths = [
        ...new Set(artifacts
            .filter((artifact) => artifact.kind === "source" &&
            artifact.metadataJson.action !== "deleted" &&
            currentPaths.has(artifact.path) &&
            BLUEPRINT_VALIDATION_SOURCE_PATTERN.test(artifact.path))
            .map((artifact) => artifact.path)),
    ].sort(compareStrings);
    // Scope inspection is a secondary, fail-open validator. Large or incomplete
    // source sets are not proof that a requirement is absent, so never block them.
    if (paths.length === 0 || paths.length > BLUEPRINT_VALIDATION_MAX_FILES)
        return [];
    const sources = [];
    let totalBytes = 0;
    for (const path of paths) {
        const current = files.readFile(path);
        if (current.truncated ||
            current.byteLength > BLUEPRINT_VALIDATION_MAX_FILE_BYTES ||
            totalBytes + current.byteLength > BLUEPRINT_VALIDATION_MAX_TOTAL_BYTES) {
            return [];
        }
        totalBytes += current.byteLength;
        sources.push({ path: current.path, content: current.content });
    }
    return sources;
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