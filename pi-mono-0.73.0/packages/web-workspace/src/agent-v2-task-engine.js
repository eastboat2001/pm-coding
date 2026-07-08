const TERMINAL_STATUSES = new Set(["blocked", "succeeded", "failed", "cancelled"]);
const FAILED_DEPENDENCY_ROOT_STATUSES = new Set(["failed", "cancelled"]);
const ERROR_REQUIRED_STATUSES = new Set(["blocked", "failed"]);
export function selectNextAgentV2Task(tasks) {
    if (tasks.length === 0)
        return selection("empty_graph");
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    const blockedByDependency = buildReverseDependencyMap(tasks);
    const failedDependencyTaskIds = new Set(collectReachableAffectedTasks(taskById, blockedByDependency, tasks.filter((task) => FAILED_DEPENDENCY_ROOT_STATUSES.has(task.status)).map((task) => task.taskId)));
    const blockedTaskIds = new Set(collectReachableAffectedTasks(taskById, blockedByDependency, tasks.filter((task) => task.status === "blocked").map((task) => task.taskId)));
    for (const task of tasks) {
        if (task.status === "succeeded")
            continue;
        if (isDependencyChainBlocked(task, taskById) && !failedDependencyTaskIds.has(task.taskId)) {
            blockedTaskIds.add(task.taskId);
        }
    }
    const failedDependencyTaskIdsList = inTaskOrder(tasks, failedDependencyTaskIds);
    const blockedTaskIdsList = inTaskOrder(tasks, blockedTaskIds).filter((taskId) => !failedDependencyTaskIds.has(taskId));
    const running = tasks.find((task) => task.status === "running");
    if (running) {
        return {
            task: running,
            reason: "running",
            blockedTaskIds: blockedTaskIdsList,
            failedDependencyTaskIds: failedDependencyTaskIdsList,
        };
    }
    for (const task of tasks) {
        if (!isSelectableTask(task))
            continue;
        if (!isDependencyChainBlocked(task, taskById)) {
            return {
                task,
                reason: "ready",
                blockedTaskIds: blockedTaskIdsList,
                failedDependencyTaskIds: failedDependencyTaskIdsList,
            };
        }
    }
    if (tasks.every((task) => task.status === "succeeded"))
        return selection("complete");
    if (failedDependencyTaskIds.size > 0) {
        return {
            reason: "failed_dependency",
            blockedTaskIds: blockedTaskIdsList,
            failedDependencyTaskIds: failedDependencyTaskIdsList,
        };
    }
    if (blockedTaskIds.size > 0) {
        return {
            reason: "blocked_by_dependencies",
            blockedTaskIds: blockedTaskIdsList,
            failedDependencyTaskIds: [],
        };
    }
    return selection("complete");
}
export function transitionAgentV2Task(input) {
    if (ERROR_REQUIRED_STATUSES.has(input.status) && !input.error) {
        throw new Error("Agent v2 blocked and failed task transitions require an error");
    }
    const isTerminal = TERMINAL_STATUSES.has(input.status);
    const output = input.output !== undefined ? input.output : isTerminal ? input.task.output : {};
    const startedAt = input.status === "running"
        ? input.task.status === "running"
            ? (input.task.startedAt ?? input.now)
            : input.now
        : isTerminal
            ? input.task.startedAt
            : undefined;
    return {
        ...input.task,
        status: input.status,
        output,
        error: ERROR_REQUIRED_STATUSES.has(input.status) ? input.error : undefined,
        startedAt,
        endedAt: isTerminal ? input.now : undefined,
        updatedAt: input.now,
    };
}
function selection(reason, task) {
    return {
        task,
        reason,
        blockedTaskIds: [],
        failedDependencyTaskIds: [],
    };
}
function buildReverseDependencyMap(tasks) {
    const blockedByDependency = new Map();
    for (const task of tasks) {
        for (const dependencyId of task.dependsOn) {
            const dependents = blockedByDependency.get(dependencyId);
            if (dependents) {
                dependents.push(task.taskId);
                continue;
            }
            blockedByDependency.set(dependencyId, [task.taskId]);
        }
    }
    return blockedByDependency;
}
function collectReachableAffectedTasks(taskById, blockedByDependency, rootTaskIds) {
    const queue = [...rootTaskIds];
    const visited = new Set();
    const affectedTaskIds = [];
    while (queue.length > 0) {
        const currentTaskId = queue.shift();
        if (!currentTaskId)
            continue;
        if (visited.has(currentTaskId)) {
            continue;
        }
        visited.add(currentTaskId);
        const task = taskById.get(currentTaskId);
        if (!task || task.status === "succeeded") {
            continue;
        }
        affectedTaskIds.push(currentTaskId);
        const dependents = blockedByDependency.get(currentTaskId);
        if (!dependents)
            continue;
        for (const dependentId of dependents) {
            const dependent = taskById.get(dependentId);
            if (!dependent || dependent.status === "succeeded" || visited.has(dependentId))
                continue;
            queue.push(dependentId);
        }
    }
    return affectedTaskIds;
}
function isDependencyChainBlocked(task, taskById) {
    return task.dependsOn.some((dependencyId) => {
        const dependency = taskById.get(dependencyId);
        return !dependency || dependency.status !== "succeeded";
    });
}
function inTaskOrder(tasks, taskIds) {
    const ordered = [];
    for (const task of tasks) {
        if (taskIds.has(task.taskId))
            ordered.push(task.taskId);
    }
    return ordered;
}
function isSelectableTask(task) {
    return task.status === "pending" || task.status === "ready";
}
//# sourceMappingURL=agent-v2-task-engine.js.map