import { buildAgentV2ArtifactIndex, filterAgentV2Artifacts, } from "./agent-v2-artifact-index.js";
import { selectNextAgentV2Task } from "./agent-v2-task-engine.js";
export function buildAgentV2ContextPacket(input) {
    const taskSelection = selectNextAgentV2Task(input.tasks);
    const activeTask = taskSelection.task;
    const documents = selectAgentV2ContextDocuments(input.documents);
    const artifactIndex = buildAgentV2ArtifactIndex(input.artifacts);
    const activeTaskArtifacts = activeTask
        ? filterAgentV2Artifacts(artifactIndex, { sourceTaskId: activeTask.taskId })
        : [];
    const openProblems = collectOpenProblems(input.tasks, input.diagnostics);
    const requiredRereads = collectRequiredRereads(activeTask, documents, activeTaskArtifacts);
    const packetWithoutMarkdown = {
        run: input.run,
        taskSelection,
        activeTask,
        documents,
        artifactIndex,
        activeTaskArtifacts,
        openProblems,
        requiredRereads,
    };
    return {
        ...packetWithoutMarkdown,
        markdown: renderAgentV2ContextPacketMarkdown(packetWithoutMarkdown),
    };
}
export function renderAgentV2ContextPacketMarkdown(packet) {
    const lines = [
        "# Agent v2 Context Packet",
        "",
        "## Run",
        `- \`${packet.run.runId}\` ${packet.run.status} / ${packet.run.phase}`,
        "",
        "## Task Selection",
        ...renderTaskSelection(packet.taskSelection),
        "",
        "## Active Task",
        packet.activeTask
            ? `- \`${packet.activeTask.taskId}\` ${packet.activeTask.status}`
            : `- none (${packet.taskSelection.reason})`,
        "",
        "## Documents",
        ...renderDocuments(packet.documents),
        "",
        "## Artifact Index",
        ...renderArtifactIndex(packet.artifactIndex),
        "",
        "## Active Task Artifacts",
        ...renderArtifacts(packet.activeTaskArtifacts),
        "",
        "## Open Problems",
        ...renderProblems(packet.openProblems),
        "",
        "## Required Rereads",
        ...renderRereads(packet.requiredRereads),
    ];
    return `${lines.join("\n")}\n`;
}
function selectAgentV2ContextDocuments(documents) {
    const latestByKind = new Map();
    for (const document of [...documents].sort(compareDocuments)) {
        latestByKind.set(document.kind, document);
    }
    return {
        capabilityDecision: latestByKind.get("capability_decision"),
        spec: latestByKind.get("spec"),
        plan: latestByKind.get("plan"),
        tasks: latestByKind.get("tasks"),
    };
}
function collectOpenProblems(tasks, diagnostics) {
    const taskProblems = tasks.flatMap((task) => {
        if (task.status !== "failed" && task.status !== "blocked")
            return [];
        return [
            {
                source: "task",
                severity: task.status === "failed" ? "error" : "warn",
                code: task.error?.code ?? `TASK_${task.status.toUpperCase()}`,
                message: task.error?.message ?? `Task ${task.taskId} is ${task.status}`,
                taskId: task.taskId,
            },
        ];
    });
    const diagnosticProblems = diagnostics.flatMap((diagnostic) => {
        if (diagnostic.severity !== "warn" && diagnostic.severity !== "error")
            return [];
        return [
            {
                source: "diagnostic",
                severity: diagnostic.severity,
                code: diagnostic.code,
                message: diagnostic.message,
                taskId: diagnostic.taskId,
                artifactId: diagnostic.artifactId,
            },
        ];
    });
    return [...taskProblems, ...diagnosticProblems];
}
function collectRequiredRereads(activeTask, documents, activeTaskArtifacts) {
    if (!activeTask)
        return [];
    const rereads = [];
    const activeDocument = documentForTask(activeTask, documents);
    if (activeDocument) {
        rereads.push({
            kind: "document",
            id: activeDocument.documentId,
            reason: "active task context",
        });
    }
    for (const artifact of activeTaskArtifacts) {
        rereads.push({
            kind: "artifact",
            id: artifact.artifactId,
            path: artifact.path,
            reason: "active task artifact",
        });
    }
    return rereads;
}
function documentForTask(task, documents) {
    switch (task.taskId) {
        case "capability":
            return documents.capabilityDecision;
        case "spec":
            return documents.spec;
        case "plan":
            return documents.plan;
    }
    switch (task.kind) {
        case "capability":
            return documents.capabilityDecision;
        case "spec":
            return documents.spec;
        case "plan":
            return documents.plan;
        case "artifact":
        case "implementation":
        case "validation":
        case "repair":
        case "delivery":
            return documents.tasks ?? documents.plan ?? documents.spec;
    }
}
function renderTaskSelection(taskSelection) {
    const lines = [`- ${taskSelection.reason}`];
    if (taskSelection.task) {
        lines[0] = `- ${taskSelection.reason}: \`${taskSelection.task.taskId}\``;
    }
    if (taskSelection.blockedTaskIds.length > 0) {
        lines.push(`- blocked: ${taskSelection.blockedTaskIds.map((taskId) => `\`${taskId}\``).join(", ")}`);
    }
    if (taskSelection.failedDependencyTaskIds.length > 0) {
        lines.push(`- failed dependencies: ${taskSelection.failedDependencyTaskIds.map((taskId) => `\`${taskId}\``).join(", ")}`);
    }
    return lines;
}
function renderDocuments(documents) {
    const lines = [];
    if (documents.capabilityDecision) {
        lines.push(`- capability decision: \`${documents.capabilityDecision.documentId}\``);
    }
    if (documents.spec) {
        lines.push(`- spec: \`${documents.spec.documentId}\``);
    }
    if (documents.plan) {
        lines.push(`- plan: \`${documents.plan.documentId}\``);
    }
    if (documents.tasks) {
        lines.push(`- tasks: \`${documents.tasks.documentId}\``);
    }
    return lines.length > 0 ? lines : ["- none"];
}
function renderArtifactIndex(index) {
    return [
        `- artifacts: ${index.artifacts.length}`,
        `- pending validation: ${index.pendingValidation.length}`,
    ];
}
function renderArtifacts(artifacts) {
    if (artifacts.length === 0)
        return ["- none"];
    return artifacts.map((artifact) => `- \`${artifact.artifactId}\` (${artifact.path})`);
}
function renderProblems(problems) {
    if (problems.length === 0)
        return ["- none"];
    return problems.map((problem) => {
        const location = problem.taskId ? ` task \`${problem.taskId}\`` : "";
        const artifact = problem.artifactId ? ` artifact \`${problem.artifactId}\`` : "";
        return `- ${problem.severity} ${problem.source}${location}${artifact}: ${problem.code} ${problem.message}`;
    });
}
function renderRereads(rereads) {
    if (rereads.length === 0)
        return ["- none"];
    return rereads.map((item) => {
        const path = item.path ? ` (${item.path})` : "";
        return `- ${item.kind} \`${item.id}\`${path}: ${item.reason}`;
    });
}
function compareDocuments(left, right) {
    return (left.updatedAt.localeCompare(right.updatedAt) ||
        left.kind.localeCompare(right.kind) ||
        left.documentId.localeCompare(right.documentId));
}
//# sourceMappingURL=agent-v2-context-packet.js.map