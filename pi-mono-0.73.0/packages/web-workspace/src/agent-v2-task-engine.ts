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
const FAILED_DEPENDENCY_CAUSING_STATUSES = new Set<AgentV2TaskStatus>(["failed", "cancelled"]);

export function selectNextAgentV2Task(tasks: AgentV2TaskNode[]): AgentV2TaskSelection {
	if (tasks.length === 0) return selection("empty_graph");

	const running = tasks.find((task) => task.status === "running");
	if (running) return selection("running", running);

	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	const terminalFailedTaskIds = tasks
		.filter((task) => FAILED_DEPENDENCY_CAUSING_STATUSES.has(task.status))
		.map((task) => task.taskId);
	const terminalBlockedTaskIds = tasks.filter((task) => task.status === "blocked").map((task) => task.taskId);
	const blockedTaskIds: string[] = [];
	const failedOrCancelledDependencyTaskIds = new Set<string>(terminalFailedTaskIds);

	for (const task of tasks) {
		if (!isSelectableTask(task)) continue;

		const dependencyStatuses = task.dependsOn.map((taskId) => taskById.get(taskId)?.status);
		if (dependencyStatuses.some((status) => status && FAILED_DEPENDENCY_CAUSING_STATUSES.has(status))) {
			failedOrCancelledDependencyTaskIds.add(task.taskId);
			continue;
		}
		if (dependencyStatuses.every((status) => status === "succeeded")) {
			return {
				task,
				reason: "ready",
				blockedTaskIds: collectBlockedTaskIds(tasks, taskById, task.taskId),
				failedDependencyTaskIds: dedupe(terminalFailedTaskIds.concat(Array.from(failedOrCancelledDependencyTaskIds)).filter(Boolean)),
			};
		}
		blockedTaskIds.push(task.taskId);
	}

	const failedDependencyTaskIdsArray = dedupe(Array.from(failedOrCancelledDependencyTaskIds));
	if (failedDependencyTaskIdsArray.length > 0) {
		return {
			reason: "failed_dependency",
			blockedTaskIds: dedupe(blockedTaskIds),
			failedDependencyTaskIds: failedDependencyTaskIdsArray,
		};
	}

	if (tasks.every((task) => task.status === "succeeded")) return selection("complete");

	if (blockedTaskIds.length > 0 || terminalBlockedTaskIds.length > 0) {
		const blockedClosure = collectTaskClosure(taskById, terminalBlockedTaskIds);
		if (blockedClosure.length > 0) {
			return {
				reason: "blocked_by_dependencies",
				blockedTaskIds: dedupe([...terminalBlockedTaskIds, ...blockedClosure, ...blockedTaskIds]),
				failedDependencyTaskIds: [],
			};
		}
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

	const isTerminal = TERMINAL_STATUSES.has(input.status);
	const shouldClearOutput = input.status === "running" && input.output === undefined;
	const output = shouldClearOutput ? {} : input.output ?? input.task.output;
	const error = input.status === "failed" ? input.error : undefined;
	const startedAt = input.status === "running" ? input.task.startedAt ?? input.now : input.task.startedAt;
	const endedAt = isTerminal ? input.now : undefined;

	return {
		...input.task,
		status: input.status,
		output,
		error,
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

function collectTaskClosure(taskById: Map<string, AgentV2TaskNode>, rootTaskIds: string[]): string[] {
	const reverseDeps = new Map<string, string[]>();
	for (const task of taskById.values()) {
		for (const dependencyId of task.dependsOn) {
			let dependents = reverseDeps.get(dependencyId);
			if (!dependents) {
				dependents = [];
				reverseDeps.set(dependencyId, dependents);
			}
			dependents.push(task.taskId);
		}
	}

	const blockedTaskIds: string[] = [];
	const queue: string[] = [...rootTaskIds];
	const visited = new Set<string>(rootTaskIds);

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		const dependents = reverseDeps.get(current);
		if (!dependents) continue;
		for (const dependentId of dependents) {
			if (visited.has(dependentId)) continue;
			const dependent = taskById.get(dependentId);
			if (!dependent || dependent.status === "succeeded") continue;
			visited.add(dependentId);
			blockedTaskIds.push(dependentId);
			queue.push(dependentId);
		}
	}

	return blockedTaskIds;
}

function dedupe(values: string[]): string[] {
	const visited = new Set<string>();
	const dedupedValues: string[] = [];
	for (const value of values) {
		if (visited.has(value)) continue;
		visited.add(value);
		dedupedValues.push(value);
	}
	return dedupedValues;
}
