import {
	AGENT_V2_PHASES,
	AGENT_V2_RUN_STATUSES,
	type AgentV2Phase,
	type AgentV2RunSnapshot,
	type AgentV2RunSnapshotInput,
	type AgentV2RunStatus,
	type AgentV2TaskNode,
} from "./agent-v2-types.js";

const RUN_TRANSITIONS: Record<AgentV2RunStatus, readonly AgentV2RunStatus[]> = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

const TERMINAL_RUN_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled"]);

export function assertAgentV2RunTransition(from: AgentV2RunStatus, to: AgentV2RunStatus): void {
	if (!RUN_TRANSITIONS[from].includes(to)) {
		throw new Error(`Invalid Agent v2 run transition: ${from} -> ${to}`);
	}
}

export function advanceAgentV2Phase(phase: AgentV2Phase): AgentV2Phase {
	const index = AGENT_V2_PHASES.indexOf(phase);
	return index === -1 || index === AGENT_V2_PHASES.length - 1 ? phase : AGENT_V2_PHASES[index + 1]!;
}

export function createAgentV2RunSnapshot(input: AgentV2RunSnapshotInput): AgentV2RunSnapshot {
	const timestamp = input.createdAt ?? input.updatedAt ?? new Date().toISOString();

	const snapshot: AgentV2RunSnapshot = {
		clientId: input.clientId,
		runId: input.runId,
		status: "queued",
		phase: "intake",
		attempt: 1,
		input: input.input,
		model: input.model,
		createdAt: timestamp,
		updatedAt: input.updatedAt ?? timestamp,
	};

	if (input.workerId !== undefined) snapshot.workerId = input.workerId;
	if (input.startedAt !== undefined) snapshot.startedAt = input.startedAt;
	if (input.endedAt !== undefined) snapshot.endedAt = input.endedAt;
	if (input.error !== undefined) snapshot.error = input.error;

	return snapshot;
}

export function transitionAgentV2RunSnapshot(
	snapshot: AgentV2RunSnapshot,
	to: AgentV2RunStatus,
	patch: Partial<Omit<AgentV2RunSnapshot, "clientId" | "runId" | "input" | "model" | "status" | "createdAt">> = {},
): AgentV2RunSnapshot {
	assertAgentV2RunTransition(snapshot.status, to);

	const updatedAt = patch.updatedAt ?? new Date().toISOString();
	const startedAt = to === "running" ? (patch.startedAt ?? snapshot.startedAt ?? updatedAt) : snapshot.startedAt;
	const endedAt = TERMINAL_RUN_STATUSES.has(to) ? (patch.endedAt ?? updatedAt) : snapshot.endedAt;
	const error = TERMINAL_RUN_STATUSES.has(to) ? (patch.error ?? snapshot.error) : snapshot.error;

	const next: AgentV2RunSnapshot = {
		...snapshot,
		status: to,
		phase: patch.phase ?? snapshot.phase,
		attempt: patch.attempt ?? snapshot.attempt,
		updatedAt,
	};

	if (to === "running") {
		if (patch.workerId !== undefined || snapshot.workerId !== undefined) {
			next.workerId = patch.workerId ?? snapshot.workerId;
		}
		if (startedAt !== undefined) {
			next.startedAt = startedAt;
		}
	} else if (snapshot.workerId !== undefined) {
		next.workerId = snapshot.workerId;
	}

	if (endedAt !== undefined) {
		next.endedAt = endedAt;
	}
	if (error !== undefined) {
		next.error = error;
	}

	return next;
}

export function getReadyAgentV2TaskIds(tasks: AgentV2TaskNode[]): string[] {
	const succeeded = new Set(tasks.filter((task) => task.status === "succeeded").map((task) => task.taskId));
	return tasks
		.filter((task) => task.status === "pending")
		.filter((task) => task.dependsOn.every((taskId) => succeeded.has(taskId)))
		.map((task) => task.taskId);
}

export { AGENT_V2_PHASES, AGENT_V2_RUN_STATUSES };
