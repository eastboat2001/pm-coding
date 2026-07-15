import { createHash } from "node:crypto";
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
	parseAgentV2ImplementationResult,
	parseAgentV2RepairResult,
} from "./agent-v2-model-execution.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
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
	AgentV2DiagnosticRecordedPayload,
	AgentV2OutputRecordedPayload,
	AgentV2RunSnapshot,
	AgentV2TaskNode,
	AgentV2TaskUpdatedPayload,
	AgentV2ValidationRecordedPayload,
} from "./agent-v2-types.js";
import {
	type AgentV2ValidationFailure,
	type AgentV2ValidationGateContext,
	runAgentV2StaticValidationGate,
} from "./agent-v2-validation-gate.js";
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
}

export interface ExecuteAgentV2NextTaskInput {
	store: AgentV2RuntimeStore & AgentV2ExecutionStore;
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	materializer: AgentV2InputMaterializer;
	modelExecution: AgentV2ModelExecution;
	now?: () => string;
	maxRepairAttempts?: number;
	toolRegistry?: AgentV2ToolRegistry;
	signal?: AbortSignal;
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
			return { status: "task_blocked", diagnosticIds: [] };
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
		return executeRepairTask(
			input,
			snapshot.run,
			snapshot.contextPacket,
			snapshot.artifacts,
			snapshot.diagnostics,
			task,
			now,
		);
	}
	if (task.kind === "delivery") {
		return executeDeliveryTask(input, snapshot.run, task, now);
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
	const mutation = await Promise.resolve(
		input.store.commitAgentV2ExecutionMutation({
			clientId: input.context.clientId,
			runId: input.runId,
			expectedRun: expectedRunState(run),
			expectedTasks: [expectedTaskState(task)],
			updatedAt: now,
			nextRunPhase: phase,
			tasks: [toUpsertTaskInput(input.context.clientId, input.runId, transitioned)],
			events: [taskEvent(transitioned, phase, now)],
		}),
	);
	return mutation.applied
		? { status: "task_succeeded", taskId: task.taskId, diagnosticIds: [] }
		: { status: "task_conflict", taskId: task.taskId, diagnosticIds: [] };
}

type AgentV2PreviewFailureTaxonomy = "workspace_empty" | "build_required" | "missing_entry" | "publish_failed";

interface AgentV2PreviewFailure {
	taxonomy: AgentV2PreviewFailureTaxonomy;
	code: string;
	message: string;
	retryable: boolean;
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

	const files = createAgentV2FileAdapter({
		config: input.config,
		context: input.context,
	});
	const authorizedPaths = generatedFiles.map((file) => {
		const authorizedPath = files.validateWritePath(file.path);
		if (authorizedPath !== file.path) throw new AgentV2ModelContractError("unsafe_path");
		return authorizedPath;
	});
	assertNoWritePathCollisions(authorizedPaths, files.listFiles().files);
	const now = nextExecutionRevision(proposedNow, run.updatedAt, task.updatedAt);
	const writes = generatedFiles.map((file) =>
		files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }),
	);
	const artifacts = writes.map(
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
			createdAt: now,
			updatedAt: now,
		}),
	);
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
		validationStatus: "pending",
		revision: artifact.version,
		at: now,
	}));
	const outputPayload: AgentV2OutputRecordedPayload = {
		type: "agent_v2.output_recorded",
		taskId: task.taskId,
		summary: implementationOutputSummary(artifacts.length),
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
			events: [taskPayload, ...artifactPayloads, outputPayload].map((payload) => ({
				type: payload.type,
				payload: payload as unknown as Record<string, unknown>,
				createdAt: now,
			})),
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
			failureCodes,
			retryableFailureCount: result.failures.filter((failure) => failure.retryable).length,
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
		const transitioned = transitionAgentV2Task({
			task,
			status: "failed",
			now,
			output: { ...task.output, validationId, attempt, maxAttempts },
			error: {
				code: "agent_v2.validation_failed",
				message: "Static validation failed and cannot be repaired.",
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
	const repairTask = createRepairTask(baseTaskId, task, validationId, attempt, diagnosticId, now);
	const revalidateTask = createRevalidationTask(baseTaskId, repairTask, attempt + 1, now);
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
	const workspaceFiles = collectRepairWorkspaceFiles(files, artifacts);
	const envelope = await input.modelExecution.generateRepair({
		run,
		contextPacket,
		task,
		inputs: materializedInputs,
		diagnostics: repairDiagnostics as AgentV2DiagnosticEvent[],
		workspaceFiles,
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
	const existingFiles = files.listFiles().files;
	const existingSet = new Set(existingFiles);
	const authorizedPaths = generatedFiles.map((file) => {
		const authorizedPath = files.validateWritePath(file.path);
		if (authorizedPath !== file.path) throw new AgentV2ModelContractError("unsafe_path");
		return authorizedPath;
	});
	assertNoWritePathCollisions(authorizedPaths, existingFiles);
	const changedFiles = generatedFiles.filter((file) => {
		if (!existingSet.has(file.path)) return true;
		const current = files.readFile(file.path);
		if (current.truncated) throw new AgentV2ModelContractError("limit_exceeded");
		return current.content !== file.content;
	});
	const now = nextExecutionRevision(
		proposedNow,
		run.updatedAt,
		task.updatedAt,
		...artifacts.map((artifact) => artifact.updatedAt),
	);
	if (changedFiles.length === 0) {
		return commitNoChangeRepair(input, run, task, now);
	}
	const writes = changedFiles.map((file) =>
		files.writeFile({ path: file.path, content: file.content, mode: "rewrite", taskId: task.taskId, now }),
	);
	const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
	const updatedArtifacts = writes.map((write): UpsertAgentV2ArtifactInput => {
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
	now: string,
): AgentV2TaskNode {
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

function createRevalidationTask(
	baseTaskId: string,
	repairTask: AgentV2TaskNode,
	attempt: number,
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
		input: { baseValidationTaskId: baseTaskId, validationAttempt: attempt },
		output: {},
		createdAt: now,
		updatedAt: now,
	};
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
): AgentV2RepairWorkspaceFile[] {
	const candidates = artifacts
		.filter(
			(artifact) =>
				artifact.kind === "source" &&
				(artifact.validationStatus === "failed" || artifact.validationStatus === "pending") &&
				isRepairTextMediaType(artifact.mediaType),
		)
		.sort(
			(left, right) => compareStrings(left.path, right.path) || compareStrings(left.artifactId, right.artifactId),
		);
	if (candidates.length === 0 || candidates.length > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFiles) {
		throw new AgentV2ModelContractError("limit_exceeded");
	}
	const existingPaths = new Set(files.listFiles().files);
	const seenPaths = new Set<string>();
	const seenArtifacts = new Set<string>();
	let totalBytes = 0;
	return candidates.map((artifact) => {
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
		if (current.path !== artifact.path || current.truncated || !isStrictRepairText(current.content)) {
			throw new AgentV2ModelContractError("invalid_schema");
		}
		const byteLength = Buffer.byteLength(current.content, "utf8");
		totalBytes += byteLength;
		if (
			byteLength > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxFileBytes ||
			totalBytes > AGENT_V2_REPAIR_WORKSPACE_LIMITS.maxTotalBytes
		) {
			throw new AgentV2ModelContractError("limit_exceeded");
		}
		const checksum = `sha256:${createHash("sha256").update(current.content).digest("hex")}`;
		if (checksum !== artifact.checksum) throw new AgentV2ModelContractError("invalid_schema");
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

function repairOutputSummary(fileCount: number): string {
	return `Repair updated ${fileCount} generated ${fileCount === 1 ? "file" : "files"}.`;
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

function implementationOutputSummary(fileCount: number): string {
	return `Generated ${fileCount} ${fileCount === 1 ? "file" : "files"}.`;
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
