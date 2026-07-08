import { randomUUID } from "node:crypto";
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord, UpsertAgentV2TaskInput } from "./agent-v2-store.js";
import { type AgentV2ContextPacket, buildAgentV2ContextPacket } from "./agent-v2-context-packet.js";
import { type AgentV2TaskTransitionInput, transitionAgentV2Task } from "./agent-v2-task-engine.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";
import type { RuntimeStore } from "./runtime-store.js";

export type AgentV2RuntimeStore = Pick<
	RuntimeStore,
	| "getAgentV2Run"
	| "listAgentV2Tasks"
	| "listAgentV2Artifacts"
	| "listAgentV2Documents"
	| "listAgentV2Diagnostics"
	| "upsertAgentV2Task"
	| "appendAgentV2Diagnostic"
>;

export interface AgentV2RuntimeSnapshot {
	run: AgentV2RunSnapshot;
	tasks: AgentV2TaskNode[];
	artifacts: AgentV2ArtifactRecord[];
	documents: AgentV2DocumentRecord[];
	diagnostics: AgentV2DiagnosticEvent[];
	contextPacket: AgentV2ContextPacket;
}

export interface LoadAgentV2RuntimeSnapshotInput {
	store: AgentV2RuntimeStore;
	clientId: string;
	runId: string;
}

export interface AdvanceAgentV2TaskInput extends Omit<AgentV2TaskTransitionInput, "task"> {
	store: AgentV2RuntimeStore;
	clientId: string;
	runId: string;
	taskId: string;
}

export async function loadAgentV2RuntimeSnapshot(
	input: LoadAgentV2RuntimeSnapshotInput,
): Promise<AgentV2RuntimeSnapshot> {
	const run = await input.store.getAgentV2Run(input.clientId, input.runId);
	if (!run) {
		throw new Error(`Agent v2 run not found: ${input.clientId}/${input.runId}`);
	}

	const [tasks, artifacts, documents, diagnostics] = await Promise.all([
		input.store.listAgentV2Tasks(input.clientId, input.runId),
		input.store.listAgentV2Artifacts(input.clientId, input.runId),
		input.store.listAgentV2Documents(input.clientId, input.runId),
		input.store.listAgentV2Diagnostics(input.clientId, input.runId),
	]);

	const contextPacket = buildAgentV2ContextPacket({
		run,
		tasks,
		artifacts,
		documents,
		diagnostics,
	});

	return { run, tasks, artifacts, documents, diagnostics, contextPacket };
}

export async function advanceAgentV2Task(input: AdvanceAgentV2TaskInput): Promise<AgentV2TaskNode> {
	const run = await input.store.getAgentV2Run(input.clientId, input.runId);
	if (!run) {
		throw new Error(`Agent v2 run not found: ${input.clientId}/${input.runId}`);
	}

	const tasks = await input.store.listAgentV2Tasks(input.clientId, input.runId);
	const task = tasks.find((candidate) => candidate.taskId === input.taskId);
	if (!task) {
		await appendRuntimeDiagnosticBestEffort(input.store, input.clientId, input.runId, {
			code: "agent_v2.task_not_found",
			severity: "error",
			message: `Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`,
			taskId: input.taskId,
			createdAt: input.now,
		});
		throw new Error(`Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`);
	}

	const transitioned = transitionAgentV2Task({
		task,
		status: input.status,
		now: input.now,
		output: input.output,
		error: input.error,
	});

	const persisted = await input.store.upsertAgentV2Task(toUpsertTaskInput(input.clientId, input.runId, transitioned));
	await appendRuntimeDiagnosticBestEffort(input.store, input.clientId, input.runId, {
		code: "agent_v2.task_transitioned",
		severity: "info",
		message: `Agent v2 task ${input.taskId} transitioned to ${input.status}`,
		taskId: input.taskId,
		createdAt: input.now,
	});
	return persisted;
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

async function appendRuntimeDiagnostic(
	store: AgentV2RuntimeStore,
	clientId: string,
	runId: string,
	input: {
		code: string;
		severity: "info" | "error";
		message: string;
		taskId?: string;
		createdAt: string;
	},
): Promise<void> {
	await store.appendAgentV2Diagnostic(
		createAgentV2DiagnosticEvent({
			diagnosticId: `${input.code}:${input.taskId ?? "run"}:${input.createdAt}:${randomUUID()}`,
			clientId,
			runId,
			severity: input.severity,
			category: "task_graph",
			code: input.code,
			taskId: input.taskId,
			message: input.message,
			data: {},
			createdAt: input.createdAt,
		}),
	);
}

async function appendRuntimeDiagnosticBestEffort(
	store: AgentV2RuntimeStore,
	clientId: string,
	runId: string,
	input: {
		code: string;
		severity: "info" | "error";
		message: string;
		taskId?: string;
		createdAt: string;
	},
): Promise<void> {
	try {
		await appendRuntimeDiagnostic(store, clientId, runId, input);
	} catch {
		// Diagnostics are advisory; task state mutation is the source of truth.
	}
}
