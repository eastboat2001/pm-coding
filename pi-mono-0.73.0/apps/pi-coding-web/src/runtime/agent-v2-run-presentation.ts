import type {
	AgentV2ArtifactIndexedTransportEvent,
	AgentV2DeliveryReportedTransportEvent,
	AgentV2DiagnosticRecordedTransportEvent,
	AgentV2Error,
	AgentV2OutputRecordedTransportEvent,
	AgentV2Phase,
	AgentV2RunStatus,
	AgentV2SkillAppliedTransportEvent,
	AgentV2SkillResourceLoadedTransportEvent,
	AgentV2TaskUpdatedTransportEvent,
	AgentV2ValidationRecordedTransportEvent,
} from "@mariozechner/pi-web-workspace";

export type AgentV2UserStage = "understanding" | "planning" | "implementation" | "validation" | "delivery";

export interface AgentV2RunPresentation {
	runId: string;
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	stage: AgentV2UserStage;
	active: boolean;
	repairing: boolean;
	repairReason?: string;
	repairAttempt?: number;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	tasks: ReadonlyMap<string, AgentV2TaskUpdatedTransportEvent>;
	artifacts: ReadonlyMap<string, AgentV2ArtifactIndexedTransportEvent>;
	validations: ReadonlyMap<string, ReadonlyMap<number, AgentV2ValidationRecordedTransportEvent>>;
	diagnostics: ReadonlyMap<string, AgentV2DiagnosticRecordedTransportEvent>;
	outputs: ReadonlyMap<string, AgentV2OutputRecordedTransportEvent>;
	skills: ReadonlyMap<string, AgentV2SkillAppliedTransportEvent>;
	resources: ReadonlyMap<string, AgentV2SkillResourceLoadedTransportEvent>;
	deliveryReport?: AgentV2DeliveryReportedTransportEvent;
	error?: AgentV2Error;
}

export interface AgentV2RunPresentationStore {
	runs: ReadonlyMap<string, AgentV2RunPresentation>;
}

export type AgentV2RunPresentationAction =
	| { type: "begin"; runId: string; phase: AgentV2Phase; status: AgentV2RunStatus; at: string }
	| { type: "phase"; runId: string; phase: AgentV2Phase; status: AgentV2RunStatus; at: string }
	| { type: "task"; runId: string; event: AgentV2TaskUpdatedTransportEvent }
	| { type: "artifact"; runId: string; event: AgentV2ArtifactIndexedTransportEvent }
	| { type: "validation"; runId: string; event: AgentV2ValidationRecordedTransportEvent }
	| { type: "diagnostic"; runId: string; event: AgentV2DiagnosticRecordedTransportEvent }
	| { type: "output"; runId: string; event: AgentV2OutputRecordedTransportEvent }
	| { type: "skill"; runId: string; event: AgentV2SkillAppliedTransportEvent }
	| { type: "resource"; runId: string; event: AgentV2SkillResourceLoadedTransportEvent }
	| { type: "delivery"; runId: string; event: AgentV2DeliveryReportedTransportEvent }
	| { type: "settle"; runId: string; status: TerminalAgentV2RunStatus; at: string; error?: AgentV2Error };

export type TerminalAgentV2RunStatus = Extract<AgentV2RunStatus, "succeeded" | "failed" | "cancelled" | "interrupted">;

export interface SerializedAgentV2Validation {
	validationId: string;
	attempts: AgentV2ValidationRecordedTransportEvent[];
}

export interface SerializedAgentV2TerminalRunPresentation {
	runId: string;
	status: TerminalAgentV2RunStatus;
	phase: AgentV2Phase;
	stage: AgentV2UserStage;
	active: false;
	repairing: false;
	startedAt: string;
	updatedAt: string;
	endedAt: string;
	tasks: AgentV2TaskUpdatedTransportEvent[];
	artifacts: AgentV2ArtifactIndexedTransportEvent[];
	validations: SerializedAgentV2Validation[];
	diagnostics: AgentV2DiagnosticRecordedTransportEvent[];
	outputs: AgentV2OutputRecordedTransportEvent[];
	skills: AgentV2SkillAppliedTransportEvent[];
	resources: AgentV2SkillResourceLoadedTransportEvent[];
	deliveryReport?: AgentV2DeliveryReportedTransportEvent;
	error?: AgentV2Error;
}

const STAGE_BY_PHASE: Record<AgentV2Phase, AgentV2UserStage> = {
	intake: "understanding",
	capability_routing: "understanding",
	spec_draft: "planning",
	spec_review: "planning",
	plan_draft: "planning",
	task_generation: "planning",
	implementation: "implementation",
	repair: "validation",
	validation: "validation",
	preview: "validation",
	delivery: "delivery",
	blocked: "delivery",
	failed: "delivery",
	cancelled: "delivery",
};

const TERMINAL_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);

export function agentV2StageForPhase(phase: AgentV2Phase): AgentV2UserStage {
	return STAGE_BY_PHASE[phase];
}

export function createAgentV2RunPresentationStore(): AgentV2RunPresentationStore {
	return { runs: new Map() };
}

export function reduceAgentV2RunPresentation(
	store: AgentV2RunPresentationStore,
	action: AgentV2RunPresentationAction,
): AgentV2RunPresentationStore {
	if (action.type === "begin") {
		return setRun(store, action.runId, {
			runId: action.runId,
			status: action.status,
			phase: action.phase,
			stage: agentV2StageForPhase(action.phase),
			active: !TERMINAL_STATUSES.has(action.status),
			repairing: action.phase === "repair",
			startedAt: action.at,
			updatedAt: action.at,
			tasks: new Map(),
			artifacts: new Map(),
			validations: new Map(),
			diagnostics: new Map(),
			outputs: new Map(),
			skills: new Map(),
			resources: new Map(),
		});
	}

	const run = requireRun(store, action.runId);
	switch (action.type) {
		case "phase": {
			const repair = action.phase === "repair" ? latestFailedValidation(run) : undefined;
			return setRun(store, action.runId, {
				...run,
				phase: action.phase,
				stage: agentV2StageForPhase(action.phase),
				status: action.status,
				active: !TERMINAL_STATUSES.has(action.status),
				repairing: action.phase === "repair",
				...(repair ? { repairReason: repair.summary, repairAttempt: repair.attempt } : {}),
				updatedAt: action.at,
			});
		}
		case "task":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				tasks: setMapValue(run.tasks, action.event.taskId, action.event),
			});
		case "artifact":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				artifacts: setMapValue(run.artifacts, action.event.artifactId, action.event),
			});
		case "validation": {
			const attempts = setMapValue(
				run.validations.get(action.event.validationId) ?? new Map(),
				action.event.attempt,
				action.event,
			);
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				validations: setMapValue(run.validations, action.event.validationId, attempts),
			});
		}
		case "diagnostic":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				diagnostics: setMapValue(run.diagnostics, action.event.diagnosticId, action.event),
			});
		case "output":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				outputs: setMapValue(run.outputs, outputKey(action.event), action.event),
			});
		case "skill":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				skills: setMapValue(run.skills, `${action.event.name}\u0000${action.event.location}`, action.event),
			});
		case "resource":
			return setRun(store, action.runId, {
				...run,
				updatedAt: action.event.at,
				resources: setMapValue(
					run.resources,
					`${action.event.name}\u0000${action.event.path}\u0000${action.event.checksum}`,
					action.event,
				),
			});
		case "delivery":
			return setRun(store, action.runId, { ...run, updatedAt: action.event.at, deliveryReport: action.event });
		case "settle":
			return setRun(store, action.runId, {
				...run,
				status: action.status,
				active: false,
				repairing: false,
				updatedAt: action.at,
				endedAt: action.at,
				...(action.error ? { error: action.error } : {}),
			});
	}
}

export function serializeAgentV2TerminalRunPresentation(
	store: AgentV2RunPresentationStore,
	runId: string,
): SerializedAgentV2TerminalRunPresentation {
	const run = requireRun(store, runId);
	if (run.active || !isTerminalStatus(run.status)) {
		throw new Error(`Agent v2 run ${runId} is not terminal.`);
	}
	if (!run.endedAt) throw new Error(`Agent v2 run ${runId} has no terminal timestamp.`);
	return {
		runId: run.runId,
		status: run.status,
		phase: run.phase,
		stage: run.stage,
		active: false,
		repairing: false,
		startedAt: run.startedAt,
		updatedAt: run.updatedAt,
		endedAt: run.endedAt,
		tasks: Array.from(run.tasks.values()),
		artifacts: Array.from(run.artifacts.values()),
		validations: Array.from(run.validations, ([validationId, attempts]) => ({
			validationId,
			attempts: Array.from(attempts.values()).sort((left, right) => left.attempt - right.attempt),
		})),
		diagnostics: Array.from(run.diagnostics.values()),
		outputs: Array.from(run.outputs.values()),
		skills: Array.from(run.skills.values()),
		resources: Array.from(run.resources.values()),
		...(run.deliveryReport ? { deliveryReport: run.deliveryReport } : {}),
		...(run.error ? { error: run.error } : {}),
	};
}

function latestFailedValidation(run: AgentV2RunPresentation): AgentV2ValidationRecordedTransportEvent | undefined {
	return Array.from(run.validations.values())
		.flatMap((attempts) => Array.from(attempts.values()))
		.filter((validation) => validation.status === "failed" || validation.status === "blocked")
		.sort((left, right) => left.attempt - right.attempt || left.at.localeCompare(right.at))
		.at(-1);
}

function outputKey(event: AgentV2OutputRecordedTransportEvent): string {
	return `${event.taskId}\u0000${event.provider}\u0000${event.model}\u0000${event.summary}`;
}

function setMapValue<Key, Value>(source: ReadonlyMap<Key, Value>, key: Key, value: Value): ReadonlyMap<Key, Value> {
	const next = new Map(source);
	next.set(key, value);
	return next;
}

function setRun(
	store: AgentV2RunPresentationStore,
	runId: string,
	run: AgentV2RunPresentation,
): AgentV2RunPresentationStore {
	return { runs: setMapValue(store.runs, runId, run) };
}

function requireRun(store: AgentV2RunPresentationStore, runId: string): AgentV2RunPresentation {
	const run = store.runs.get(runId);
	if (!run) throw new Error(`Agent v2 run ${runId} has not begun.`);
	return run;
}

function isTerminalStatus(status: AgentV2RunStatus): status is TerminalAgentV2RunStatus {
	return TERMINAL_STATUSES.has(status);
}
