import type { AgentV2Error, AgentV2TaskNode, AgentV2TaskStatus } from "./agent-v2-types.js";

export type AgentV2TaskSelectionReason =
	| "running"
	| "ready"
	| "complete"
	| "empty_graph"
	| "blocked_by_dependencies"
	| "failed_dependency";

export interface AgentV2TaskSelection {
	task?: AgentV2TaskNode;
	reason: AgentV2TaskSelectionReason;
	blockedTaskIds: string[];
	failedDependencyTaskIds: string[];
}

export interface AgentV2TaskTransitionInput {
	task: AgentV2TaskNode;
	status: AgentV2TaskStatus;
	now: string;
	output?: Record<string, unknown>;
	error?: AgentV2Error;
}

const TERMINAL_STATUSES = new Set<AgentV2TaskStatus>(["blocked", "succeeded", "failed", "cancelled"]);

export function selectNextAgentV2Task(tasks: AgentV2TaskNode[]): AgentV2TaskSelection {
	if (tasks.length === 0) return selection("empty_graph");

	const running = tasks.find((task) => task.status === "running");
	if (running) return selection("running", running);

	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	const blockedTaskIds: string[] = [];
	const failedDependencyTaskIds: string[] = [];

	for (const task of tasks) {
		if (!isSelectableTask(task)) continue;

		const dependencyStatuses = task.dependsOn.map((taskId) => taskById.get(taskId)?.status);
		if (dependencyStatuses.some((status) => status === "failed" || status === "cancelled" || status === "blocked")) {
			failedDependencyTaskIds.push(task.taskId);
			continue;
		}
		if (dependencyStatuses.every((status) => status === "succeeded")) {
			return {
				task,
				reason: "ready",
				blockedTaskIds: collectBlockedTaskIds(tasks, taskById, task.taskId),
				failedDependencyTaskIds,
			};
		}
		blockedTaskIds.push(task.taskId);
	}

	if (failedDependencyTaskIds.length > 0) {
		return {
			reason: "failed_dependency",
			blockedTaskIds,
			failedDependencyTaskIds,
		};
	}

	if (tasks.every((task) => task.status === "succeeded")) return selection("complete");

	const terminalFailureTaskIds = tasks
		.filter((task) => task.status !== "succeeded" && TERMINAL_STATUSES.has(task.status))
		.map((task) => task.taskId);
	if (terminalFailureTaskIds.length > 0) {
		return {
			reason: "failed_dependency",
			blockedTaskIds,
			failedDependencyTaskIds: terminalFailureTaskIds,
		};
	}

	if (blockedTaskIds.length > 0) {
		return {
			reason: "blocked_by_dependencies",
			blockedTaskIds,
			failedDependencyTaskIds: [],
		};
	}

	return selection("complete");
}

export function transitionAgentV2Task(input: AgentV2TaskTransitionInput): AgentV2TaskNode {
	if (input.status === "failed" && !input.error) {
		throw new Error("Agent v2 failed task transitions require an error");
	}

	const startedAt = input.status === "running" ? input.task.startedAt ?? input.now : input.task.startedAt;
	const endedAt = TERMINAL_STATUSES.has(input.status) ? input.now : input.task.endedAt;

	return {
		...input.task,
		status: input.status,
		output: input.output ?? input.task.output,
		error: input.error ?? (input.status === "failed" ? input.task.error : undefined),
		startedAt,
		endedAt,
		updatedAt: input.now,
	};
}

function selection(reason: AgentV2TaskSelectionReason, task?: AgentV2TaskNode): AgentV2TaskSelection {
	return {
		task,
		reason,
		blockedTaskIds: [],
		failedDependencyTaskIds: [],
	};
}

function isSelectableTask(task: AgentV2TaskNode): boolean {
	return task.status === "pending" || task.status === "ready";
}

function collectBlockedTaskIds(
	tasks: AgentV2TaskNode[],
	taskById: Map<string, AgentV2TaskNode>,
	selectedTaskId: string,
): string[] {
	const blockedTaskIds: string[] = [];
	for (const task of tasks) {
		if (!isSelectableTask(task) || task.taskId === selectedTaskId) continue;
		const dependencyStatuses = task.dependsOn.map((taskId) => taskById.get(taskId)?.status);
		if (!dependencyStatuses.every((status) => status === "succeeded")) blockedTaskIds.push(task.taskId);
	}
	return blockedTaskIds;
}
