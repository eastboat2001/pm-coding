import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import {
	type AgentV2ArtifactIndex,
	buildAgentV2ArtifactIndex,
	filterAgentV2Artifacts,
} from "./agent-v2-artifact-index.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord } from "./agent-v2-store.js";
import { type AgentV2TaskSelection, selectNextAgentV2Task } from "./agent-v2-task-engine.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";

export interface AgentV2ContextPacketInput {
	run: AgentV2RunSnapshot;
	documents: AgentV2DocumentRecord[];
	tasks: AgentV2TaskNode[];
	artifacts: AgentV2ArtifactRecord[];
	diagnostics: AgentV2DiagnosticEvent[];
}

export interface AgentV2ContextDocuments {
	capabilityDecision?: AgentV2DocumentRecord;
	spec?: AgentV2DocumentRecord;
	plan?: AgentV2DocumentRecord;
	tasks?: AgentV2DocumentRecord;
}

export interface AgentV2ContextProblem {
	source: "task" | "diagnostic";
	severity: "warn" | "error";
	code: string;
	message: string;
	taskId?: string;
	artifactId?: string;
}

export interface AgentV2ContextReread {
	kind: "document" | "artifact";
	id: string;
	path?: string;
	reason: string;
}

export interface AgentV2ContextPacket {
	run: AgentV2RunSnapshot;
	taskSelection: AgentV2TaskSelection;
	activeTask?: AgentV2TaskNode;
	documents: AgentV2ContextDocuments;
	artifactIndex: AgentV2ArtifactIndex;
	activeTaskArtifacts: AgentV2ArtifactRecord[];
	openProblems: AgentV2ContextProblem[];
	requiredRereads: AgentV2ContextReread[];
	markdown: string;
}

export function buildAgentV2ContextPacket(input: AgentV2ContextPacketInput): AgentV2ContextPacket {
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

export function renderAgentV2ContextPacketMarkdown(packet: Omit<AgentV2ContextPacket, "markdown">): string {
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
		packet.activeTask ? `- \`${packet.activeTask.taskId}\` ${packet.activeTask.status}` : "- none",
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

function selectAgentV2ContextDocuments(documents: AgentV2DocumentRecord[]): AgentV2ContextDocuments {
	const latestByKind = new Map<AgentV2DocumentRecord["kind"], AgentV2DocumentRecord>();
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

function collectOpenProblems(tasks: AgentV2TaskNode[], diagnostics: AgentV2DiagnosticEvent[]): AgentV2ContextProblem[] {
	const taskProblems = tasks.flatMap((task): AgentV2ContextProblem[] => {
		if (task.status !== "failed" && task.status !== "blocked") return [];
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
	const diagnosticProblems = diagnostics.flatMap((diagnostic): AgentV2ContextProblem[] => {
		if (diagnostic.severity !== "warn" && diagnostic.severity !== "error") return [];
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

function collectRequiredRereads(
	activeTask: AgentV2TaskNode | undefined,
	documents: AgentV2ContextDocuments,
	activeTaskArtifacts: AgentV2ArtifactRecord[],
): AgentV2ContextReread[] {
	if (!activeTask) return [];

	const rereads: AgentV2ContextReread[] = [];
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

function documentForTask(task: AgentV2TaskNode, documents: AgentV2ContextDocuments): AgentV2DocumentRecord | undefined {
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
		case "implementation":
		case "validation":
		case "repair":
		case "delivery":
			return documents.tasks;
	}
}

function renderTaskSelection(taskSelection: AgentV2TaskSelection): string[] {
	const lines = [`- ${taskSelection.reason}`];
	if (taskSelection.task) {
		lines[0] = `- ${taskSelection.reason}: \`${taskSelection.task.taskId}\``;
	}
	if (taskSelection.blockedTaskIds.length > 0) {
		lines.push(`- blocked: ${taskSelection.blockedTaskIds.map((taskId) => `\`${taskId}\``).join(", ")}`);
	}
	if (taskSelection.failedDependencyTaskIds.length > 0) {
		lines.push(
			`- failed dependencies: ${taskSelection.failedDependencyTaskIds.map((taskId) => `\`${taskId}\``).join(", ")}`,
		);
	}
	return lines;
}

function renderDocuments(documents: AgentV2ContextDocuments): string[] {
	const lines: string[] = [];
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

function renderArtifactIndex(index: AgentV2ArtifactIndex): string[] {
	return [
		`- artifacts: ${index.artifacts.length}`,
		`- pending validation: ${index.pendingValidation.length}`,
	];
}

function renderArtifacts(artifacts: AgentV2ArtifactRecord[]): string[] {
	if (artifacts.length === 0) return ["- none"];
	return artifacts.map((artifact) => `- \`${artifact.artifactId}\` (${artifact.path})`);
}

function renderProblems(problems: AgentV2ContextProblem[]): string[] {
	if (problems.length === 0) return ["- none"];
	return problems.map((problem) => {
		const location = problem.taskId ? ` task \`${problem.taskId}\`` : "";
		const artifact = problem.artifactId ? ` artifact \`${problem.artifactId}\`` : "";
		return `- ${problem.severity} ${problem.source}${location}${artifact}: ${problem.code} ${problem.message}`;
	});
}

function renderRereads(rereads: AgentV2ContextReread[]): string[] {
	if (rereads.length === 0) return ["- none"];
	return rereads.map((item) => {
		const path = item.path ? ` (${item.path})` : "";
		return `- ${item.kind} \`${item.id}\`${path}: ${item.reason}`;
	});
}

function compareDocuments(left: AgentV2DocumentRecord, right: AgentV2DocumentRecord): number {
	return (
		left.updatedAt.localeCompare(right.updatedAt) ||
		left.kind.localeCompare(right.kind) ||
		left.documentId.localeCompare(right.documentId)
	);
}
