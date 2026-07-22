import { type AgentV2DiagnosticEvent, createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2ExpectedRunState } from "./agent-v2-durable-store.js";
import { type AgentV2FileAdapter, createAgentV2FileAdapter } from "./agent-v2-file-adapter.js";
import type { AgentV2InputMaterializer } from "./agent-v2-input-materializer.js";
import {
	AGENT_V2_REPAIR_WORKSPACE_LIMITS,
	AgentV2ModelContractError,
	type AgentV2ModelExecution,
	type AgentV2ModelUsageSummary,
	type AgentV2RepairWorkspaceFile,
	type AgentV2SkillInstructionContext,
	parseAgentV2ImplementationResult,
	parseAgentV2RepairResult,
} from "./agent-v2-model-execution.js";
import { type AgentV2RepairAction, planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { type AgentV2ResponseLanguage, inferAgentV2ResponseLanguage } from "./agent-v2-response-language.js";
import { type AgentV2RuntimeStore, advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "./agent-v2-runtime-core.js";
import type { AgentV2ExecutionStore } from "./agent-v2-runtime-store.js";
import { normalizeAgentV2ModelReference } from "./agent-v2-start-input.js";
import { phaseForAgentV2Task } from "./agent-v2-state-machine.js";
import type {
	AgentV2ArtifactRecord,
	AppendAgentV2ValidationAttemptInput,
	UpsertAgentV2ArtifactInput,
	UpsertAgentV2TaskInput,
} from "./agent-v2-store.js";
import { transitionAgentV2Task } from "./agent-v2-task-engine.js";
import {
	type AgentV2ToolRegistry,
	assertAgentV2ToolAllowed,
	createAgentV2ToolRegistry,
} from "./agent-v2-tool-governance.js";
import type {
	AgentV2ArtifactIndexedPayload,
	AgentV2DeliveryReportPayload,
	AgentV2DiagnosticRecordedPayload,
	AgentV2Error,
	AgentV2OutputRecordedPayload,
	AgentV2RunSnapshot,
	AgentV2SkillAppliedPayload,
	AgentV2SkillResourceLoadedPayload,
	AgentV2TaskNode,
	AgentV2TaskUpdatedPayload,
	AgentV2ValidationRecordedPayload,
} from "./agent-v2-types.js";
import {
	type AgentV2ValidationFailure,
	type AgentV2ValidationGateContext,
	runAgentV2StaticValidationGate,
} from "./agent-v2-validation-gate.js";
import { PreviewReadinessChecker, type PreviewReadinessResult } from "./preview-readiness-checker.js";
import { isProjectEntryConflictMessage } from "./project-entry-consistency.js";
import type { StorageConfig } from "./types.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";

export type AgentV2ExecutionStepStatus =
	| "task_succeeded"
	| "task_failed"
	| "task_blocked"
	| "task_conflict"
	| "complete"
	| "no_task";

export interface AgentV2ExecutionStepResult {
	status: AgentV2ExecutionStepStatus;
	taskId?: string;
	diagnosticIds: string[];
	blockingError?: AgentV2Error;
}

export interface ExecuteAgentV2NextTaskInput {
	store: AgentV2RuntimeStore & AgentV2ExecutionStore;
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	materializer: AgentV2InputMaterializer;
	modelExecution: AgentV2ModelExecution;
	skillContext?: AgentV2SkillInstructionContext;
	now?: () => string;
	maxRepairAttempts?: number;
	toolRegistry?: AgentV2ToolRegistry;
	signal?: AbortSignal;
	previewReadinessChecker?: Pick<PreviewReadinessChecker, "check">;
}

export async function executeAgentV2NextTask(input: ExecuteAgentV2NextTaskInput): Promise<AgentV2ExecutionStepResult> {
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
				.find((error): error is AgentV2Error => error !== undefined);
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
		return executeImplementationTask(input, snapshot.run, snapshot.contextPacket, snapshot.artifacts, task, now);
	}
	if (task.kind === "repair") {
		try {
			return await executeRepairTask(
				input,
				snapshot.run,
				snapshot.contextPacket,
				snapshot.artifacts,
				snapshot.diagnostics,
				task,
				now,
			);
		} catch (error) {
			throwIfAborted(input.signal);
			if (error instanceof AgentV2ModelContractError && isRecoverableRepairModelContractError(error)) {
				return commitRepairModelContractRecovery(input, snapshot.run, task, now, error);
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

async function executeDeliveryTask(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	tasks: readonly AgentV2TaskNode[],
	artifacts: readonly AgentV2ArtifactRecord[],
	task: AgentV2TaskNode,
	proposedNow: string,
): Promise<AgentV2ExecutionStepResult> {
	const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
	assertAgentV2ToolAllowed(registry, "preview.publish", "delivery");
	throwIfAborted(input.signal);
	let preview: Awaited<ReturnType<WorkspacePreviewService["preview"]>>;
	try {
		preview = await new WorkspacePreviewService(input.config).preview(input.context, { headers: {} });
	} catch (error) {
		throwIfAborted(input.signal);
		return commitDeliveryFailure(input, run, task, proposedNow, classifyPreviewFailure(error));
	}
	throwIfAborted(input.signal);
	if (preview.status !== "running" || !preview.previewUrl) {
		return commitDeliveryFailure(input, run, task, proposedNow, classifyPreviewFailure(preview.logs));
	}
	let readiness: PreviewReadinessResult;
	try {
		readiness = await checkPreviewReadinessWithRetry(
			input.previewReadinessChecker ?? new PreviewReadinessChecker(input.config),
			input.context,
			input.signal ?? new AbortController().signal,
		);
	} catch (error) {
		throwIfAborted(input.signal);
		return commitDeliveryFailure(input, run, task, proposedNow, previewReadinessFailure("probe_error", error));
	}
	throwIfAborted(input.signal);
	if (!readiness.ready || readiness.reasonCode !== "ready") {
		return commitDeliveryFailure(
			input,
			run,
			task,
			proposedNow,
			previewReadinessFailure(readiness.reasonCode, readiness.detail),
		);
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
	const report = deliveryReportPayload(
		input,
		tasks,
		artifacts,
		transitioned,
		preview,
		now,
		inferAgentV2ResponseLanguage(run.input),
	);
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			events: [
				taskEvent(transitioned, phase, now),
				{ type: report.type, payload: report as unknown as Record<string, unknown>, createdAt: now },
			],
		}),
	);
	return mutation.applied
		? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

async function checkPreviewReadinessWithRetry(
	checker: Pick<PreviewReadinessChecker, "check">,
	context: ExecuteAgentV2NextTaskInput["context"],
	signal: AbortSignal,
): Promise<PreviewReadinessResult> {
	const retryDelaysMs = [1_000, 2_500] as const;
	let result = await checker.check(context);
	for (const delayMs of retryDelaysMs) {
		throwIfAborted(signal);
		if (result.ready || !isTransientPreviewReadinessFailure(result.reasonCode)) return result;
		await abortableDelay(delayMs, signal);
		result = await checker.check(context);
	}
	return result;
}

function isTransientPreviewReadinessFailure(reasonCode: PreviewReadinessResult["reasonCode"]): boolean {
	return (
		reasonCode === "http_not_ok" ||
		reasonCode === "preview_url_missing" ||
		reasonCode === "html_error_page" ||
		reasonCode === "html_no_basic_content"
	);
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw agentV2AbortReason(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(finish, delayMs);
		function finish(): void {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		function abort(): void {
			clearTimeout(timer);
			reject(agentV2AbortReason(signal));
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

function agentV2AbortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("Agent v2 execution was aborted.");
	error.name = "AbortError";
	return error;
}

function deliveryReportPayload(
	input: ExecuteAgentV2NextTaskInput,
	tasks: readonly AgentV2TaskNode[],
	artifacts: readonly AgentV2ArtifactRecord[],
	deliveryTask: AgentV2TaskNode,
	preview: Awaited<ReturnType<WorkspacePreviewService["preview"]>> & { previewUrl: string },
	now: string,
	responseLanguage: AgentV2ResponseLanguage,
): AgentV2DeliveryReportPayload {
	const actionFiles = (action: "created" | "updated") =>
		artifacts
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

type AgentV2PreviewFailureTaxonomy =
	| "workspace_empty"
	| "build_required"
	| "missing_entry"
	| "publish_failed"
	| "not_ready";

interface AgentV2PreviewFailure {
	taxonomy: AgentV2PreviewFailureTaxonomy;
	code: string;
	message: string;
	retryable: boolean;
}

function previewReadinessFailure(reasonCode: string, detail: unknown): AgentV2PreviewFailure {
	const boundedDetail = typeof detail === "string" && detail.trim() ? ` ${detail.trim().slice(0, 500)}` : "";
	return {
		taxonomy: "not_ready",
		code: "agent_v2.preview_not_ready",
		message: `Published preview did not pass readiness verification (${reasonCode}).${boundedDetail}`,
		retryable: true,
	};
}

function classifyPreviewFailure(value: unknown): AgentV2PreviewFailure {
	const messages = Array.isArray(value)
		? value.filter((candidate): candidate is string => typeof candidate === "string")
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
	if (
		messages.some(
			(message) =>
				message.includes("requires an index.html in the project root, dist, build, or public") ||
				message.includes("no index.html was found in the project root, dist, build, or public"),
		)
	) {
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

async function commitDeliveryFailure(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	task: AgentV2TaskNode,
	proposedNow: string,
	failure: AgentV2PreviewFailure,
): Promise<AgentV2ExecutionStepResult> {
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
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			diagnostics: [diagnostic],
			events: [diagnosticEvent(diagnostic, now), taskEvent(transitioned, phase, now)],
		}),
	);
	return mutation.applied
		? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

async function executeImplementationTask(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	contextPacket: Awaited<ReturnType<typeof loadAgentV2RuntimeSnapshot>>["contextPacket"],
	existingArtifacts: readonly AgentV2ArtifactRecord[],
	task: AgentV2TaskNode,
	proposedNow: string,
): Promise<AgentV2ExecutionStepResult> {
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
	if (typeof serialized !== "string") throw new AgentV2ModelContractError("invalid_schema");
	const result = parseAgentV2ImplementationResult(serialized, task.taskId);
	const generatedFiles = [...result.files].sort((left, right) => compareStrings(left.path, right.path));
	const responseLanguage = inferAgentV2ResponseLanguage(run.input);

	const files = createAgentV2FileAdapter({
		config: input.config,
		context: input.context,
	});
	const authorizedPaths = generatedFiles.map((file) => {
		const authorizedPath = files.validateWritePath(file.path);
		if (authorizedPath !== file.path) throw new AgentV2ModelContractError("unsafe_path");
		return authorizedPath;
	});
	const existingFiles = files.listFiles().files;
	assertNoWritePathCollisions(authorizedPaths, existingFiles);
	const generatedPathKeys = new Set(authorizedPaths.map(collisionKey));
	const obsoletePaths =
		task.input.recoveryMode === "full_regeneration"
			? existingFiles.filter((path) => !generatedPathKeys.has(collisionKey(path)))
			: [];
	if (obsoletePaths.length > 0) assertAgentV2ToolAllowed(registry, "file.delete", "implementation");
	const obsoleteFiles = obsoletePaths.map((path) => ({ path, current: files.readFile(path) }));
	const now = nextExecutionRevision(
		proposedNow,
		run.updatedAt,
		task.updatedAt,
		...existingArtifacts.map((artifact) => artifact.updatedAt),
	);
	const writes = generatedFiles.map((file) =>
		files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }),
	);
	for (const obsolete of obsoleteFiles) files.deleteFile(obsolete.path);
	const artifactById = new Map(existingArtifacts.map((artifact) => [artifact.artifactId, artifact]));
	const artifacts = [
		...writes.map(
			(write): UpsertAgentV2ArtifactInput => ({
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
			}),
		),
		...obsoleteFiles.map((obsolete) =>
			deletedArtifactUpdate(input, artifactById, obsolete.path, obsolete.current.checksum, task.taskId, now),
		),
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
			modelSummary: sanitizeUserVisibleSummary(result.summary, artifacts.length, "implementation", responseLanguage),
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
	const taskPayload: AgentV2TaskUpdatedPayload = {
		type: "agent_v2.task_updated",
		taskId: task.taskId,
		kind: task.kind,
		status: transitioned.status,
		phase,
		at: now,
	};
	const artifactPayloads: AgentV2ArtifactIndexedPayload[] = artifacts.map((artifact) => ({
		type: "agent_v2.artifact_indexed",
		artifactId: artifact.artifactId,
		path: artifact.path,
		validationStatus: artifact.validationStatus === "deleted" ? "deleted" : "pending",
		revision: artifact.version,
		checksum: artifact.checksum,
		action: artifactAction(artifact),
		sourceTaskId: artifact.sourceTaskId!,
		at: now,
	}));
	const outputPayload: AgentV2OutputRecordedPayload = {
		type: "agent_v2.output_recorded",
		taskId: task.taskId,
		summary: sanitizeUserVisibleSummary(result.summary, artifacts.length, "implementation", responseLanguage),
		provider: trustedModel.provider,
		model: trustedModel.id,
		...(usage ? { usage } : {}),
		at: now,
	};
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [{ taskId: task.taskId, status: task.status, updatedAt: task.updatedAt }],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			artifacts,
			events: [...skillEvents(input.skillContext, now), taskPayload, ...artifactPayloads, outputPayload].map(
				(payload) => ({
					type: payload.type,
					payload: payload as unknown as Record<string, unknown>,
					createdAt: now,
				}),
			),
		}),
	);
	if (!mutation.applied) {
		return { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
	}

	return {
		status: "task_succeeded",
		taskId: task.taskId,
		diagnosticIds: [],
	};
}

async function executeValidationTask(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	tasks: readonly AgentV2TaskNode[],
	artifacts: readonly AgentV2ArtifactRecord[],
	task: AgentV2TaskNode,
	proposedNow: string,
): Promise<AgentV2ExecutionStepResult> {
	// Validation attempts include the initial pass. Six attempts leave room for
	// one additional evidence-carrying full regeneration when the first complete
	// replacement introduces a new runtime error; per-fingerprint budgets still
	// stop unchanged localized repair loops early.
	const maxAttempts = input.maxRepairAttempts ?? 6;
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
	if (result.status === "failed" && delivery) revisionInputs.push(delivery.updatedAt);
	const now = nextExecutionRevision(proposedNow, ...revisionInputs);
	const validationId = `static:${baseTaskId}`;
	const failureCodes = [...new Set(result.failures.map((failure) => failure.code))].sort(compareStrings);
	const validation: AppendAgentV2ValidationAttemptInput = {
		...result.validation,
		validationId,
		attempt,
		taskId: task.taskId,
		summary: result.status === "passed" ? "Static validation passed" : "Static validation failed",
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
	const relevantArtifacts = artifacts.filter(
		(artifact) =>
			artifact.kind === "source" &&
			(artifact.validationStatus === "pending" || artifact.validationStatus === "failed"),
	);

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
		const mutation = await Promise.resolve(
			input.store.commitAgentV2ExecutionMutation({
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
			}),
		);
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
	});
	let retryableActions = repairActions.filter((action) => action.retryable);
	const eligibleForFullRegenerationFallback =
		attempt < maxAttempts &&
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
			retryableFailureCount: result.failures.filter((failure) => failure.retryable).length,
		},
		createdAt: now,
	});
	const failedArtifacts = relevantArtifacts.map((artifact) => validationArtifactUpdate(artifact, "failed", now));

	if (!canRecover) {
		const primaryFailure = result.failures[0]?.message.trim().slice(0, 1_000);
		const terminalMessage = primaryFailure
			? `Static validation still failed after bounded recovery attempts: ${primaryFailure}`
			: "Static validation still failed after bounded recovery attempts.";
		const transitioned = transitionAgentV2Task({
			task,
			status: "failed",
			now,
			output: { ...task.output, validationId, attempt, maxAttempts },
			error: {
				code: "agent_v2.validation_failed",
				message: terminalMessage,
				// Logical validation and repair retries are already represented by
				// distinct durable tasks and attempt identities. Requeueing this same
				// exhausted validation task would reuse its validation attempt key and
				// fail with an append conflict instead of creating a real recovery.
				retryable: false,
				data: { validationId, attempt, maxAttempts, failureCodes },
			},
		});
		const phase = phaseForAgentV2Task(task, transitioned.status);
		const mutation = await Promise.resolve(
			input.store.commitAgentV2ExecutionMutation({
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
			}),
		);
		return mutation.applied
			? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
			: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
	}

	if (!delivery) return { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
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
		const rewiredDelivery: AgentV2TaskNode = {
			...delivery,
			dependsOn: [revalidateTask.taskId],
			updatedAt: now,
		};
		const phase = phaseForAgentV2Task(revalidateTask, revalidateTask.status);
		const changedTasks = [transitioned, revalidateTask, rewiredDelivery];
		const mutation = await Promise.resolve(
			input.store.commitAgentV2ExecutionMutation({
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
			}),
		);
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
	const rewiredDelivery: AgentV2TaskNode = {
		...delivery,
		dependsOn: [revalidateTask.taskId],
		updatedAt: now,
	};
	const phase = phaseForAgentV2Task(repairTask, repairTask.status);
	const changedTasks = [transitioned, repairTask, revalidateTask, rewiredDelivery];
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
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
		}),
	);
	return mutation.applied
		? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

function validationFailureDetails(failures: readonly AgentV2ValidationFailure[]) {
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

async function executeRepairTask(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	contextPacket: Awaited<ReturnType<typeof loadAgentV2RuntimeSnapshot>>["contextPacket"],
	artifacts: readonly AgentV2ArtifactRecord[],
	diagnostics: readonly AgentV2DiagnosticEvent[],
	task: AgentV2TaskNode,
	proposedNow: string,
): Promise<AgentV2ExecutionStepResult> {
	const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
	assertAgentV2ToolAllowed(registry, "file.write", "repair");
	const signal = input.signal ?? new AbortController().signal;
	throwIfAborted(signal);
	const repairIdentity = requireRepairIdentity(task);
	const diagnosticIds = repairIdentity.diagnosticIds;
	const repairDiagnostics = diagnosticIds.map((diagnosticId) =>
		diagnostics.find((item) => item.diagnosticId === diagnosticId),
	);
	if (repairDiagnostics.some((diagnostic) => !diagnostic)) throw new AgentV2ModelContractError("invalid_schema");
	assertRepairDiagnostics(repairIdentity, repairDiagnostics as AgentV2DiagnosticEvent[], run);
	const materializedInputs = await input.materializer.materialize({ run, signal });
	throwIfAborted(signal);
	const files = createAgentV2FileAdapter({ config: input.config, context: input.context });
	const workspaceFiles = collectRepairWorkspaceFiles(files, artifacts, repairDiagnostics as AgentV2DiagnosticEvent[]);
	const envelope = await input.modelExecution.generateRepair({
		run,
		contextPacket,
		task,
		inputs: materializedInputs,
		diagnostics: repairDiagnostics as AgentV2DiagnosticEvent[],
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
	if (typeof serialized !== "string") throw new AgentV2ModelContractError("invalid_schema");
	const result = parseAgentV2RepairResult(serialized, task.taskId);
	if (!sameStrings(result.addressedDiagnosticIds, diagnosticIds))
		throw new AgentV2ModelContractError("invalid_schema");
	const generatedFiles = [...result.files].sort((left, right) => compareStrings(left.path, right.path));
	const patches = [...(result.patches ?? [])].sort((left, right) => compareStrings(left.path, right.path));
	const deletedPaths = [...(result.deletedPaths ?? [])].sort(compareStrings);
	const workspaceByPath = new Map(workspaceFiles.map((file) => [file.path, file]));
	const existingFiles = files.listFiles().files;
	const existingSet = new Set(existingFiles);
	const authorizedPaths = generatedFiles.map((file) => {
		const authorizedPath = files.validateWritePath(file.path);
		if (authorizedPath !== file.path) throw new AgentV2ModelContractError("unsafe_path");
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
	assertNoWritePathCollisions([...authorizedPaths, ...authorizedPatchPaths, ...authorizedDeletedPaths], existingFiles);
	if (authorizedDeletedPaths.length > 0) assertAgentV2ToolAllowed(registry, "file.delete", "repair");
	for (const file of generatedFiles) {
		if (workspaceByPath.get(file.path)?.contentMode === "excerpt") {
			throw new AgentV2ModelContractError("invalid_schema");
		}
	}
	const changedFiles = generatedFiles.filter((file) => {
		if (!existingSet.has(file.path)) return true;
		const current = files.readFile(file.path);
		if (current.truncated) throw new AgentV2ModelContractError("limit_exceeded");
		return current.content !== file.content;
	});
	const changedPatches = patches.filter((patch) => {
		const workspace = workspaceByPath.get(patch.path);
		if (!workspace || workspace.checksum !== patch.expectedChecksum || !workspace.content.includes(patch.oldText)) {
			throw new AgentV2ModelContractError("invalid_schema");
		}
		const current = files.readFile(patch.path);
		if (current.checksum !== patch.expectedChecksum) throw new AgentV2ModelContractError("invalid_schema");
		const first = current.content.indexOf(patch.oldText);
		if (first < 0 || current.content.indexOf(patch.oldText, first + 1) >= 0) {
			throw new AgentV2ModelContractError("invalid_schema");
		}
		return patch.oldText !== patch.newText;
	});
	const deletions = authorizedDeletedPaths.map((path) => {
		const workspace = workspaceByPath.get(path);
		if (!workspace) throw new AgentV2ModelContractError("unsafe_path");
		const current = files.readFile(path);
		if (current.checksum !== workspace.checksum) throw new AgentV2ModelContractError("invalid_schema");
		return { path, checksum: current.checksum };
	});
	const now = nextExecutionRevision(
		proposedNow,
		run.updatedAt,
		task.updatedAt,
		...artifacts.map((artifact) => artifact.updatedAt),
	);
	if (changedFiles.length === 0 && changedPatches.length === 0 && deletions.length === 0) {
		return commitNoChangeRepair(input, run, task, now);
	}
	const writes = [
		...changedFiles.map((file) =>
			files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }),
		),
		...changedPatches.map((patch) =>
			files.patchFile({
				path: patch.path,
				oldText: patch.oldText,
				newText: patch.newText,
				taskId: task.taskId,
				now,
			}),
		),
	];
	const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
	for (const deletion of deletions) files.deleteFile(deletion.path);
	const updatedArtifacts = [
		...writes.map((write): UpsertAgentV2ArtifactInput => {
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
		...deletions.map((deletion) =>
			deletedArtifactUpdate(input, artifactById, deletion.path, deletion.checksum, task.taskId, now),
		),
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
		...updatedArtifacts.map((artifact) =>
			artifactEvent(artifact, artifact.validationStatus === "deleted" ? "deleted" : "pending", now),
		),
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
			} satisfies AgentV2OutputRecordedPayload as unknown as Record<string, unknown>,
			createdAt: now,
		},
	];
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			artifacts: updatedArtifacts,
			events,
		}),
	);
	return mutation.applied
		? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

function validationCoordinates(task: AgentV2TaskNode): { baseTaskId: string; attempt: number } {
	const match = /^revalidate:([A-Za-z0-9][A-Za-z0-9._:~-]*):([2-9][0-9]*)$/u.exec(task.taskId);
	if (!match) return { baseTaskId: task.taskId, attempt: 1 };
	return { baseTaskId: match[1]!, attempt: Number(match[2]) };
}

function createRepairTask(
	baseTaskId: string,
	validationTask: AgentV2TaskNode,
	validationId: string,
	attempt: number,
	diagnosticId: string,
	repairActions: readonly AgentV2RepairAction[],
	now: string,
): AgentV2TaskNode {
	const repairStrategy = attempt >= 3 ? "rewrite_affected_files" : "targeted_patch";
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

function createFullRegenerationTask(
	baseTaskId: string,
	validationTask: AgentV2TaskNode,
	validationId: string,
	attempt: number,
	diagnosticId: string,
	repairActions: readonly AgentV2RepairAction[],
	now: string,
): AgentV2TaskNode {
	const recoveryEvidence = repairActions
		.map((action) => `${action.validationCode}: ${action.reason}`)
		.join(" | ")
		.slice(0, 4_000);
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

function createFullRegenerationRepairAction(
	taskId: string,
	failures: readonly AgentV2ValidationFailure[],
): AgentV2RepairAction {
	const failure = failures.find((candidate) => candidate.blocking && candidate.retryable);
	if (!failure) throw new AgentV2ModelContractError("invalid_schema");
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

function createDirectRevalidationTask(
	baseTaskId: string,
	failedValidationTask: AgentV2TaskNode,
	attempt: number,
	validationFingerprintAttempts: Readonly<Record<string, number>>,
	now: string,
): AgentV2TaskNode {
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

function createRevalidationTask(
	baseTaskId: string,
	repairTask: AgentV2TaskNode,
	attempt: number,
	validationFingerprintAttempts: Readonly<Record<string, number>>,
	now: string,
): AgentV2TaskNode {
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

function validationFingerprintAttempts(task: AgentV2TaskNode): Record<string, number> {
	const value = task.input.validationFingerprintAttempts;
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, number> = {};
	for (const [fingerprint, attempts] of Object.entries(value)) {
		if (!fingerprint.startsWith("sha256:") || typeof attempts !== "number" || !Number.isSafeInteger(attempts))
			continue;
		if (attempts < 1 || attempts > 32) continue;
		result[fingerprint] = attempts;
	}
	return result;
}

function mergeValidationFingerprintAttempts(
	task: AgentV2TaskNode,
	failures: readonly AgentV2ValidationFailure[],
): Record<string, number> {
	const result = validationFingerprintAttempts(task);
	for (const failure of failures) {
		result[failure.fingerprint] = Math.min(32, (result[failure.fingerprint] ?? 0) + 1);
	}
	return result;
}

function expectedTaskState(task: AgentV2TaskNode): {
	taskId: string;
	status: AgentV2TaskNode["status"];
	updatedAt: string;
} {
	return { taskId: task.taskId, status: task.status, updatedAt: task.updatedAt };
}

function validationArtifactUpdate(
	artifact: AgentV2ArtifactRecord,
	validationStatus: "passed" | "failed",
	now: string,
): UpsertAgentV2ArtifactInput {
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

function deletedArtifactUpdate(
	input: ExecuteAgentV2NextTaskInput,
	artifactById: ReadonlyMap<string, AgentV2ArtifactRecord>,
	path: string,
	checksum: string,
	sourceTaskId: string,
	now: string,
): UpsertAgentV2ArtifactInput {
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

function taskEvent(task: AgentV2TaskNode, phase: AgentV2TaskUpdatedPayload["phase"], now: string) {
	const payload: AgentV2TaskUpdatedPayload = {
		type: "agent_v2.task_updated",
		taskId: task.taskId,
		kind: task.kind,
		status: task.status,
		phase,
		at: now,
	};
	return { type: payload.type, payload: payload as unknown as Record<string, unknown>, createdAt: now };
}

function artifactEvent(
	artifact: UpsertAgentV2ArtifactInput,
	validationStatus: AgentV2ArtifactIndexedPayload["validationStatus"],
	now: string,
) {
	const payload: AgentV2ArtifactIndexedPayload = {
		type: "agent_v2.artifact_indexed",
		artifactId: artifact.artifactId,
		path: artifact.path,
		validationStatus,
		revision: artifact.version,
		checksum: artifact.checksum,
		action: artifactAction(artifact),
		sourceTaskId: artifact.sourceTaskId!,
		at: now,
	};
	return { type: payload.type, payload: payload as unknown as Record<string, unknown>, createdAt: now };
}

function validationEvent(validation: AppendAgentV2ValidationAttemptInput, now: string) {
	const payload: AgentV2ValidationRecordedPayload = {
		type: "agent_v2.validation_recorded",
		validationId: validation.validationId,
		taskId: validation.taskId!,
		attempt: validation.attempt,
		status: validation.status,
		summary: validation.summary,
		at: now,
	};
	return { type: payload.type, payload: payload as unknown as Record<string, unknown>, createdAt: now };
}

function diagnosticEvent(diagnostic: AgentV2DiagnosticEvent, now: string) {
	const payload: AgentV2DiagnosticRecordedPayload = {
		type: "agent_v2.diagnostic_recorded",
		diagnosticId: diagnostic.diagnosticId,
		severity: diagnostic.severity,
		code: diagnostic.code,
		message: diagnostic.message,
		at: now,
	};
	return { type: payload.type, payload: payload as unknown as Record<string, unknown>, createdAt: now };
}

function validationEvents(
	validation: AppendAgentV2ValidationAttemptInput,
	task: AgentV2TaskNode,
	artifacts: readonly UpsertAgentV2ArtifactInput[],
	phase: AgentV2TaskUpdatedPayload["phase"],
	now: string,
) {
	return [
		validationEvent(validation, now),
		taskEvent(task, phase, now),
		...artifacts.map((artifact) => artifactEvent(artifact, "passed", now)),
	];
}

function validationFailureEvents(
	validation: AppendAgentV2ValidationAttemptInput,
	diagnostic: AgentV2DiagnosticEvent,
	task: AgentV2TaskNode,
	artifacts: readonly UpsertAgentV2ArtifactInput[],
	phase: AgentV2TaskUpdatedPayload["phase"],
	now: string,
) {
	return [
		validationEvent(validation, now),
		diagnosticEvent(diagnostic, now),
		taskEvent(task, phase, now),
		...artifacts.map((artifact) => artifactEvent(artifact, "failed", now)),
	];
}

async function commitNoChangeRepair(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	task: AgentV2TaskNode,
	now: string,
): Promise<AgentV2ExecutionStepResult> {
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
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			diagnostics: [diagnostic],
			events: [diagnosticEvent(diagnostic, now), taskEvent(transitioned, phase, now)],
		}),
	);
	return mutation.applied
		? { status: "task_failed", taskId: task.taskId, diagnosticIds: [diagnosticId] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

function isRecoverableRepairModelContractError(error: AgentV2ModelContractError): boolean {
	return (
		error.code === "invalid_protocol" ||
		error.code === "invalid_schema" ||
		error.code === "invalid_identifier" ||
		error.code === "invalid_unicode" ||
		error.code === "limit_exceeded"
	);
}

async function commitRepairModelContractRecovery(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	task: AgentV2TaskNode,
	proposedNow: string,
	error: AgentV2ModelContractError,
): Promise<AgentV2ExecutionStepResult> {
	const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
	const diagnosticId = `agent_v2.repair_model_contract_recovery:${task.taskId}`;
	const diagnostic = createAgentV2DiagnosticEvent({
		diagnosticId,
		clientId: input.context.clientId,
		runId: input.runId,
		severity: "warn",
		category: "model",
		code: "agent_v2.repair_model_contract_recovery",
		phase: "repair",
		taskId: task.taskId,
		message:
			"Repair output was unusable; the unchanged workspace will be revalidated before another bounded recovery attempt.",
		data: { modelContractCode: error.code },
		createdAt: now,
	});
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
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			diagnostics: [diagnostic],
			events: [diagnosticEvent(diagnostic, now), taskEvent(transitioned, phase, now)],
		}),
	);
	return mutation.applied
		? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [diagnosticId] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

interface AgentV2RepairIdentity {
	baseValidationTaskId: string;
	failedValidationTaskId: string;
	validationId: string;
	validationAttempt: number;
	diagnosticIds: [string];
}

function requireRepairIdentity(task: AgentV2TaskNode): AgentV2RepairIdentity {
	const baseValidationTaskId = requireStableExecutionIdentifier(task.input.baseValidationTaskId);
	const failedValidationTaskId = requireStableExecutionIdentifier(task.input.failedValidationTaskId);
	const validationId = requireStableExecutionIdentifier(task.input.validationId);
	const validationAttempt = task.input.validationAttempt;
	const diagnosticIds = requireStringArray(task.input.diagnosticIds);
	const expectedDiagnosticId = `agent_v2.validation_failed:${baseValidationTaskId}:${String(validationAttempt)}`;
	if (
		task.kind !== "repair" ||
		!Number.isSafeInteger(validationAttempt) ||
		(validationAttempt as number) < 1 ||
		task.taskId !== `repair:${baseValidationTaskId}:${String(validationAttempt)}` ||
		task.parentTaskId !== failedValidationTaskId ||
		task.dependsOn.length !== 1 ||
		task.dependsOn[0] !== failedValidationTaskId ||
		validationId !== `static:${baseValidationTaskId}` ||
		diagnosticIds.length !== 1 ||
		diagnosticIds[0] !== expectedDiagnosticId
	) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	return {
		baseValidationTaskId,
		failedValidationTaskId,
		validationId,
		validationAttempt: validationAttempt as number,
		diagnosticIds: [diagnosticIds[0]],
	};
}

function assertRepairDiagnostics(
	identity: AgentV2RepairIdentity,
	diagnostics: readonly AgentV2DiagnosticEvent[],
	run: AgentV2RunSnapshot,
): void {
	const diagnostic = diagnostics[0];
	const failureCodes = diagnostic?.data.failureCodes;
	if (
		diagnostics.length !== 1 ||
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
		!isFailureCodeArray(failureCodes)
	) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
}

function collectRepairWorkspaceFiles(
	files: AgentV2FileAdapter,
	artifacts: readonly AgentV2ArtifactRecord[],
	diagnostics: readonly AgentV2DiagnosticEvent[],
): AgentV2RepairWorkspaceFile[] {
	const eligible = artifacts
		.filter(
			(artifact) =>
				artifact.kind === "source" &&
				(artifact.validationStatus === "failed" || artifact.validationStatus === "pending") &&
				isRepairTextMediaType(artifact.mediaType),
		)
		.sort(
			(left, right) => compareStrings(left.path, right.path) || compareStrings(left.artifactId, right.artifactId),
		);
	const diagnosticPaths = repairDiagnosticPaths(diagnostics);
	const targeted = eligible.filter((artifact) => diagnosticPaths.has(artifact.path));
	const candidates = hasCrossFileRepairDiagnostic(diagnostics) ? eligible : targeted.length > 0 ? targeted : eligible;
	if (candidates.length === 0) throw new AgentV2ModelContractError("invalid_schema");
	// Repair context is a batch budget, never a project/file-size admission rule.
	// Keep enough evidence per selected file and let the following validation pass
	// surface any remaining files for the next repair batch.
	const minimumContextBytesPerFile = 8_192;
	const batchSize = Math.min(
		candidates.length,
		AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFiles,
		Math.max(1, Math.floor(AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalContextBytes / minimumContextBytesPerFile)),
	);
	const selectedCandidates = candidates.slice(0, batchSize);
	const existingPaths = new Set(files.listFiles().files);
	const seenPaths = new Set<string>();
	const seenArtifacts = new Set<string>();
	let totalBytes = 0;
	return selectedCandidates.map((artifact, index) => {
		if (
			seenPaths.has(artifact.path) ||
			seenArtifacts.has(artifact.artifactId) ||
			!existingPaths.has(artifact.path) ||
			files.validateWritePath(artifact.path) !== artifact.path
		) {
			throw new AgentV2ModelContractError("invalid_schema");
		}
		seenPaths.add(artifact.path);
		seenArtifacts.add(artifact.artifactId);
		const current = files.readFile(artifact.path);
		if (
			current.path !== artifact.path ||
			!isStrictRepairText(current.content) ||
			current.checksum !== artifact.checksum
		) {
			throw new AgentV2ModelContractError("invalid_schema");
		}
		const remainingContextBytes = AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalContextBytes - totalBytes;
		const remainingFiles = selectedCandidates.length - index;
		const allocatedContextBytes = Math.min(
			AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxContextBytesPerFile,
			Math.floor(remainingContextBytes / remainingFiles),
		);
		const fullByteLength = current.byteLength;
		const fullFits = !current.truncated && fullByteLength <= allocatedContextBytes;
		const content = fullFits
			? current.content
			: buildRepairExcerpt(current.content, diagnostics, artifact.path, allocatedContextBytes);
		const contentByteLength = Buffer.byteLength(content, "utf8");
		if (contentByteLength === 0) throw new AgentV2ModelContractError("repair_workspace_limit_exceeded");
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

function hasCrossFileRepairDiagnostic(diagnostics: readonly AgentV2DiagnosticEvent[]): boolean {
	const crossFileCodes = new Set([
		"static.project_entry_conflict",
		"static.build_manifest_missing",
		"build.output_missing",
	]);
	return diagnostics.some((diagnostic) => {
		const failureCodes = diagnostic.data.failureCodes;
		return (
			Array.isArray(failureCodes) &&
			failureCodes.some((code) => typeof code === "string" && crossFileCodes.has(code))
		);
	});
}

function repairDiagnosticPaths(diagnostics: readonly AgentV2DiagnosticEvent[]): Set<string> {
	const paths = new Set<string>();
	for (const diagnostic of diagnostics) {
		const details = diagnostic.data.failureDetails;
		if (!Array.isArray(details)) continue;
		for (const detail of details) {
			if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
			const path = (detail as { path?: unknown }).path;
			if (typeof path === "string" && path.trim()) paths.add(path.replaceAll("\\", "/"));
		}
	}
	return paths;
}

function buildRepairExcerpt(
	content: string,
	diagnostics: readonly AgentV2DiagnosticEvent[],
	path: string,
	maxBytes: number,
): string {
	const anchors = new Set<string>(["addEventListener", "DOMContentLoaded"]);
	for (const diagnostic of diagnostics) {
		const details = diagnostic.data.failureDetails;
		if (!Array.isArray(details)) continue;
		for (const detail of details) {
			if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
			const record = detail as { path?: unknown; data?: unknown; message?: unknown };
			if (typeof record.path === "string" && record.path.replaceAll("\\", "/") !== path) continue;
			if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
				const selector = (record.data as { selector?: unknown }).selector;
				if (typeof selector === "string" && selector.trim()) {
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
	const ranges: Array<{ start: number; end: number }> = [];
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
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	const sections = merged.map(
		(range) => `\n<!-- AGENT_V2_EXCERPT ${range.start}:${range.end} -->\n${content.slice(range.start, range.end)}`,
	);
	return utf8Prefix(sections.join(""), maxBytes);
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	const code = value.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return value.slice(0, end);
}

function requireStableExecutionIdentifier(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u.test(value)) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	return value;
}

function isFailureCodeArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 64 &&
		value.every((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u.test(item))
	);
}

function isRepairTextMediaType(value: string): boolean {
	return value.startsWith("text/") || value === "application/json";
}

function isStrictRepairText(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return false;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function requireStringArray(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new AgentV2ModelContractError("invalid_schema");
	}
	return [...value];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort(compareStrings);
	const sortedRight = [...right].sort(compareStrings);
	return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function repairOutputSummary(fileCount: number, language: AgentV2ResponseLanguage): string {
	if (language === "zh") return `修复已更新 ${fileCount} 个生成文件。`;
	if (language === "de")
		return `Die Reparatur hat ${fileCount} generierte ${fileCount === 1 ? "Datei" : "Dateien"} aktualisiert.`;
	if (language === "ms") return `Pembaikan mengemas kini ${fileCount} fail yang dijana.`;
	return `Repair updated ${fileCount} generated ${fileCount === 1 ? "file" : "files"}.`;
}

function skillEvents(
	context: AgentV2SkillInstructionContext | undefined,
	now: string,
): Array<AgentV2SkillAppliedPayload | AgentV2SkillResourceLoadedPayload> {
	if (!context) return [];
	return [
		...context.skills.map(
			(skill): AgentV2SkillAppliedPayload => ({
				type: "agent_v2.skill_applied",
				name: skill.name,
				location: skill.location,
				at: now,
			}),
		),
		...context.resources.map(
			(resource): AgentV2SkillResourceLoadedPayload => ({
				type: "agent_v2.skill_resource_loaded",
				name: resource.skillName,
				path: resource.path,
				checksum: resource.checksum,
				at: now,
			}),
		),
	];
}

function artifactAction(artifact: Pick<UpsertAgentV2ArtifactInput, "metadataJson">): "created" | "updated" | "deleted" {
	if (artifact.metadataJson?.action === "deleted") return "deleted";
	return artifact.metadataJson?.action === "updated" ? "updated" : "created";
}

function sanitizeUserVisibleSummary(
	value: string,
	fileCount: number,
	mode: "implementation" | "repair",
	language: AgentV2ResponseLanguage,
): string {
	let summary = value.trim();
	summary = summary.replace(/\b(Bearer\s+)[^\s,;]+/giu, "$1[redacted]");
	summary = summary.replace(
		/\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)\s*[:=]\s*[^\s,;]+/giu,
		"$1=[redacted]",
	);
	summary = summary.replace(/\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{16,}\b/gu, "[redacted]");
	summary = summary.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/gu, "[redacted]");
	summary = summary.replace(/\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/gu, "[local-path]");
	summary = summary.replace(/(^|[\s(])\/(?:Users|home|var|tmp|opt|private|workspace)\/[^\s),;]+/gmu, "$1[local-path]");
	summary = summary.slice(0, 4000).trim();
	if (summary && summary !== "[redacted]" && (language !== "zh" || /\p{Script=Han}/u.test(summary))) return summary;
	return mode === "repair"
		? repairOutputSummary(fileCount, language)
		: implementationOutputSummary(fileCount, language);
}

function expectedRunState(run: AgentV2RunSnapshot): AgentV2ExpectedRunState {
	return {
		status: run.status,
		phase: run.phase,
		attempt: run.attempt,
		workerId: run.workerId ?? null,
		updatedAt: run.updatedAt,
	};
}

function toUpsertTaskInput(clientId: string, runId: string, task: AgentV2TaskNode): UpsertAgentV2TaskInput {
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

function nextExecutionRevision(proposed: string, ...current: string[]): string {
	const proposedMs = canonicalTimestamp(proposed);
	const currentMs = current.map(canonicalTimestamp);
	return new Date(Math.max(proposedMs, ...currentMs.map((value) => value + 1))).toISOString();
}

function canonicalTimestamp(value: string): number {
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
		throw new Error("Agent v2 execution revision must be a canonical UTC millisecond timestamp");
	}
	return epoch;
}

function sanitizedUsage(value: AgentV2ModelUsageSummary | undefined): AgentV2ModelUsageSummary | undefined {
	if (!value) return undefined;
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

function assertNoWritePathCollisions(generatedPaths: readonly string[], existingFiles: readonly string[]): void {
	const generated = generatedPaths.map((path) => ({ path, key: collisionKey(path) }));
	for (let index = 0; index < generated.length; index += 1) {
		const left = generated[index]!;
		for (let candidateIndex = index + 1; candidateIndex < generated.length; candidateIndex += 1) {
			const right = generated[candidateIndex]!;
			if (pathsShareFileIdentity(left.key, right.key)) throw new AgentV2ModelContractError("duplicate_path");
		}
	}

	for (const candidate of generated) {
		for (const existingPath of existingFiles) {
			const existing = { path: existingPath, key: collisionKey(existingPath) };
			if (candidate.key === existing.key) {
				if (candidate.path !== existing.path) throw new AgentV2ModelContractError("duplicate_path");
				continue;
			}
			if (pathsShareFileIdentity(candidate.key, existing.key)) {
				throw new AgentV2ModelContractError("duplicate_path");
			}
		}
	}
}

function collisionKey(path: string): string {
	return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function pathsShareFileIdentity(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function implementationOutputSummary(fileCount: number, language: AgentV2ResponseLanguage): string {
	if (language === "zh") return `已生成 ${fileCount} 个文件。`;
	if (language === "de") return `${fileCount} ${fileCount === 1 ? "Datei wurde" : "Dateien wurden"} generiert.`;
	if (language === "ms") return `${fileCount} fail telah dijana.`;
	return `Generated ${fileCount} ${fileCount === 1 ? "file" : "files"}.`;
}

function deliveryOutputSummary(fileCount: number, language: AgentV2ResponseLanguage): string {
	if (language === "zh") return `已创建并验证 ${fileCount} 个生成文件。`;
	if (language === "de")
		return `${fileCount} generierte ${fileCount === 1 ? "Datei wurde" : "Dateien wurden"} erstellt und geprüft.`;
	if (language === "ms") return `${fileCount} fail yang dijana telah dicipta dan disahkan.`;
	return `Created and validated ${fileCount} generated ${fileCount === 1 ? "file" : "files"}.`;
}

function usageInstructions(language: AgentV2ResponseLanguage): string {
	if (language === "zh") return "打开预览链接即可使用并检查生成的应用。";
	if (language === "de") return "Öffnen Sie den Vorschaulink, um die generierte Anwendung zu verwenden und zu prüfen.";
	if (language === "ms") return "Buka pautan pratonton untuk menggunakan dan menyemak aplikasi yang dijana.";
	return "Open the preview URL to use and review the generated application.";
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function readPhase4TaskOutput(taskOutput: Record<string, unknown>): Record<string, unknown> {
	return isRecord(taskOutput.phase4) ? taskOutput.phase4 : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new Error("Agent v2 execution was aborted.");
}
