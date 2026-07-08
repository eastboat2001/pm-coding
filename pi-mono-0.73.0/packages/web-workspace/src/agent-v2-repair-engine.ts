import type { AgentV2ValidationFailure } from "./agent-v2-validation-gate.js";

export type AgentV2RepairActionType = "file_patch" | "rerun_validation" | "block_task";

export interface AgentV2RepairAction {
	actionId: string;
	taskId: string;
	type: AgentV2RepairActionType;
	retryable: boolean;
	reason: string;
	targetPath?: string;
	validationCode: string;
}

export interface PlanAgentV2RepairActionsInput {
	taskId: string;
	failures: AgentV2ValidationFailure[];
	attempt: number;
	maxAttempts: number;
}

export function planAgentV2RepairActions(input: PlanAgentV2RepairActionsInput): AgentV2RepairAction[] {
	if (input.attempt >= input.maxAttempts) {
		return [
			{
				actionId: `repair:${input.taskId}:max_attempts`,
				taskId: input.taskId,
				type: "block_task",
				retryable: false,
				reason: `Repair attempts exhausted (${input.attempt}/${input.maxAttempts}).`,
				validationCode: "repair.max_attempts_exceeded",
			},
		];
	}

	return input.failures.map((failure) => repairActionForFailure(input.taskId, failure));
}

function repairActionForFailure(taskId: string, failure: AgentV2ValidationFailure): AgentV2RepairAction {
	const targetPath = normalizeRepairTargetPath(failure.path);

	if (!failure.retryable) {
		return {
			actionId: `repair:${taskId}:${failure.code}:block`,
			taskId,
			type: "block_task",
			retryable: false,
			reason: failure.message,
			targetPath,
			validationCode: failure.code,
		};
	}

	return {
		actionId: `repair:${taskId}:${failure.code}:${targetPath ?? "run"}`,
		taskId,
		type: targetPath ? "file_patch" : "rerun_validation",
		retryable: true,
		reason: reasonForFailure(failure),
		targetPath,
		validationCode: failure.code,
	};
}

function reasonForFailure(failure: AgentV2ValidationFailure): string {
	if (failure.code === "static.loading_visible") {
		return "Visible loading state must be hidden or resolved before delivery.";
	}
	if (failure.code === "static.metric_placeholder") {
		return "Metric placeholders must be replaced with rendered values or an explicit empty state.";
	}
	if (failure.code === "static.script_error") {
		return "Client script errors must be fixed before delivery.";
	}
	return failure.message;
}

function normalizeRepairTargetPath(path: string | undefined): string | undefined {
	if (!path) {
		return undefined;
	}

	const normalized = path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^(?:\.\/)+/, "");

	return normalized || undefined;
}
