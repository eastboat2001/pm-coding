import { randomUUID } from "node:crypto";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot, type AgentV2RuntimeStore } from "./agent-v2-runtime-core.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { runAgentV2StaticValidationGate, type AgentV2ValidationGateContext } from "./agent-v2-validation-gate.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { StorageConfig } from "./types.js";

export type AgentV2ExecutionStepStatus =
	| "task_succeeded"
	| "task_failed"
	| "task_blocked"
	| "complete"
	| "no_task";

export interface AgentV2ExecutionStepResult {
	status: AgentV2ExecutionStepStatus;
	taskId?: string;
	diagnosticIds: string[];
}

export interface ExecuteAgentV2NextTaskInput {
	store: AgentV2RuntimeStore &
		Pick<RuntimeStore, "upsertAgentV2Validation" | "appendAgentV2Diagnostic" | "upsertAgentV2Task">;
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	now?: () => string;
	maxRepairAttempts?: number;
}

export async function executeAgentV2NextTask(
	input: ExecuteAgentV2NextTaskInput,
): Promise<AgentV2ExecutionStepResult> {
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

async function executeValidationTask(
	input: ExecuteAgentV2NextTaskInput,
	state: { taskId: string; taskOutput: Record<string, unknown>; now: string },
): Promise<AgentV2ExecutionStepResult> {
	const result = await runAgentV2StaticValidationGate({
		config: input.config,
		context: input.context,
		runId: input.runId,
		taskId: state.taskId,
		now: state.now,
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

	const repairActions = planAgentV2RepairActions({
		taskId: state.taskId,
		failures: result.failures,
		attempt: 1,
		maxAttempts: input.maxRepairAttempts ?? 3,
	});
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
					repairActions,
				},
				createdAt: state.now,
			}),
		),
	);
	await advanceAgentV2Task({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
		taskId: state.taskId,
		status: "failed",
		now: state.now,
		output: {
			...state.taskOutput,
			validationId: result.validation.validationId,
			repairActions,
		},
		error: {
			code: "agent_v2.validation_failed",
			message: result.validation.summary,
			retryable: repairActions.some((action) => action.retryable),
			data: {
				validationId: result.validation.validationId,
			},
		},
	});

	return {
		status: "task_failed",
		taskId: state.taskId,
		diagnosticIds: [diagnosticId],
	};
}
