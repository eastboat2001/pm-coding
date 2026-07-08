import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2FileAdapter } from "./agent-v2-file-adapter.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { type AgentV2RuntimeStore, advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "./agent-v2-runtime-core.js";
import {
	type AgentV2ToolRegistry,
	assertAgentV2ToolAllowed,
	createAgentV2ToolRegistry,
} from "./agent-v2-tool-governance.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";
import { type AgentV2ValidationGateContext, runAgentV2StaticValidationGate } from "./agent-v2-validation-gate.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { StorageConfig } from "./types.js";

export type AgentV2ExecutionStepStatus = "task_succeeded" | "task_failed" | "task_blocked" | "complete" | "no_task";

export interface AgentV2ExecutionStepResult {
	status: AgentV2ExecutionStepStatus;
	taskId?: string;
	diagnosticIds: string[];
}

export interface ExecuteAgentV2NextTaskInput {
	store: AgentV2RuntimeStore &
		Pick<
			RuntimeStore,
			"upsertAgentV2Artifact" | "upsertAgentV2Validation" | "appendAgentV2Diagnostic" | "upsertAgentV2Task"
		>;
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	now?: () => string;
	maxRepairAttempts?: number;
	toolRegistry?: AgentV2ToolRegistry;
}

export async function executeAgentV2NextTask(input: ExecuteAgentV2NextTaskInput): Promise<AgentV2ExecutionStepResult> {
	const now = input.now?.() ?? new Date().toISOString();
	const snapshot = await loadAgentV2RuntimeSnapshot({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
	});
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
		return executeImplementationTask(input, snapshot.run, task, now);
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

async function executeImplementationTask(
	input: ExecuteAgentV2NextTaskInput,
	run: AgentV2RunSnapshot,
	task: AgentV2TaskNode,
	now: string,
): Promise<AgentV2ExecutionStepResult> {
	const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
	assertAgentV2ToolAllowed(registry, "file.write", "implementation");

	const files = createAgentV2FileAdapter({
		config: input.config,
		context: input.context,
	});
	const write = files.writeFile({
		path: "index.html",
		content: deterministicImplementationSource(run, task, input.context),
		mode: "create",
		taskId: task.taskId,
		now,
	});
	const artifact = await Promise.resolve(
		input.store.upsertAgentV2Artifact({
			clientId: input.context.clientId,
			runId: input.runId,
			artifactId: write.artifact.artifactId,
			kind: write.artifact.kind,
			path: write.artifact.path,
			mediaType: write.artifact.mediaType,
			checksum: write.artifact.checksum,
			version: write.artifact.version,
			sourceTaskId: write.artifact.sourceTaskId,
			validationStatus: write.artifact.validationStatus,
			metadataJson: write.artifact.metadataJson,
			createdAt: now,
			updatedAt: now,
		}),
	);

	await advanceAgentV2Task({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
		taskId: task.taskId,
		status: "succeeded",
		now,
		output: {
			...task.output,
			artifactIds: [artifact.artifactId],
			changedFiles: [write.path],
			phase4: {
				...readPhase4TaskOutput(task.output),
				implementationArtifactId: artifact.artifactId,
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

async function executeValidationTask(
	input: ExecuteAgentV2NextTaskInput,
	state: { taskId: string; taskOutput: Record<string, unknown>; now: string },
): Promise<AgentV2ExecutionStepResult> {
	const maxAttempts = input.maxRepairAttempts ?? 3;
	const registry = input.toolRegistry ?? createAgentV2ToolRegistry();
	const result = await runAgentV2StaticValidationGate({
		config: input.config,
		context: input.context,
		runId: input.runId,
		taskId: state.taskId,
		now: state.now,
		toolRegistry: registry,
	});
	await Promise.resolve(input.store.upsertAgentV2Validation(result.validation));

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

	const attempt = nextValidationRepairAttempt(state.taskOutput);
	const repairActions = planAgentV2RepairActions({
		taskId: state.taskId,
		failures: result.failures,
		attempt,
		maxAttempts,
	});
	const hasRetryableRepairAction = repairActions.some((action) => action.retryable);
	const diagnosticId = `agent_v2.validation_failed:${state.taskId}:${randomUUID()}`;
	await Promise.resolve(
		input.store.appendAgentV2Diagnostic(
			createAgentV2DiagnosticEvent({
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
			}),
		),
	);
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

function deterministicImplementationSource(
	run: AgentV2RunSnapshot,
	task: AgentV2TaskNode,
	context: AgentV2ValidationGateContext,
): string {
	const prompt = typeof run.input.prompt === "string" ? run.input.prompt : "Static application";
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'  <meta charset="utf-8">',
		'  <meta name="viewport" content="width=device-width, initial-scale=1">',
		`  <title>${escapeHtml(context.title)}</title>`,
		"</head>",
		"<body>",
		"  <main>",
		`    <h1>${escapeHtml(context.title)}</h1>`,
		`    <p>${escapeHtml(prompt)}</p>`,
		`    <small data-task-id="${escapeHtml(task.taskId)}">Generated by agent v2.</small>`,
		"  </main>",
		"</body>",
		"</html>",
		"",
	].join("\n");
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nextValidationRepairAttempt(taskOutput: Record<string, unknown>): number {
	const phase4Attempt = positiveInteger(readPhase4TaskOutput(taskOutput).validationRepairAttempt);
	return (phase4Attempt ?? 0) + 1;
}

function readPhase4TaskOutput(taskOutput: Record<string, unknown>): Record<string, unknown> {
	return isRecord(taskOutput.phase4) ? taskOutput.phase4 : {};
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const integer = Math.trunc(value);
	return integer >= 1 ? integer : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
