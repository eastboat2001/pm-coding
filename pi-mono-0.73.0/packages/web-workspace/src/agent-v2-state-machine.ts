import {
	AGENT_V2_PHASES,
	AGENT_V2_RUN_STATUSES,
	type AgentV2Phase,
	type AgentV2RunSnapshot,
	type AgentV2RunSnapshotInput,
	type AgentV2RunStatus,
	type AgentV2TaskNode,
	type AgentV2TaskStatus,
} from "./agent-v2-types.js";

const RUN_TRANSITIONS: Record<AgentV2RunStatus, readonly AgentV2RunStatus[]> = {
	queued: ["running", "cancelled"],
	running: ["cancelling", "succeeded", "failed", "cancelled", "interrupted"],
	cancelling: ["cancelled", "interrupted"],
	succeeded: [],
	failed: [],
	cancelled: [],
	interrupted: [],
};

const TERMINAL_RUN_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const TERMINAL_AGENT_V2_PHASES = new Set<AgentV2Phase>(["delivery", "blocked", "failed", "cancelled"]);

export function assertAgentV2RunTransition(from: AgentV2RunStatus, to: AgentV2RunStatus): void {
	if (!RUN_TRANSITIONS[from].includes(to)) {
		throw new Error(`Invalid Agent v2 run transition: ${from} -> ${to}`);
	}
}

export function advanceAgentV2Phase(phase: AgentV2Phase): AgentV2Phase {
	const index = AGENT_V2_PHASES.indexOf(phase);
	if (index === -1 || TERMINAL_AGENT_V2_PHASES.has(phase)) {
		return phase;
	}
	return AGENT_V2_PHASES[index + 1] ?? phase;
}

export function phaseForAgentV2Task(task: AgentV2TaskNode, outcome: AgentV2TaskStatus): AgentV2Phase {
	if (outcome === "failed") return "failed";
	if (outcome === "blocked") return "blocked";
	if (outcome === "cancelled") return "cancelled";

	if (outcome === "succeeded") {
		switch (task.kind) {
			case "capability":
			case "spec":
				return "plan_draft";
			case "plan":
				return "task_generation";
			case "implementation":
			case "repair":
				return "validation";
			case "validation":
			case "artifact":
				return "preview";
			case "delivery":
				return "delivery";
		}
	}

	switch (task.kind) {
		case "capability":
			return "capability_routing";
		case "spec":
			return "spec_draft";
		case "plan":
			return "plan_draft";
		case "implementation":
			return "implementation";
		case "validation":
			return "validation";
		case "repair":
			return "repair";
		case "artifact":
			return "preview";
		case "delivery":
			return "delivery";
	}
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

export { AGENT_V2_PHASES, AGENT_V2_RUN_STATUSES };
