import {
	AGENT_V2_RUN_EVENT_TYPES,
	type AgentV2Phase,
	type AgentV2RunEventType,
	type AgentV2RunStatus,
} from "./agent-v2-types.js";
import type { AgentV2RunEventRecord } from "./agent-v2-store.js";
import type { RunEventSink } from "./run-event-sink.js";
import type { RuntimeRunRecord } from "./types.js";

type AgentV2TransportEventBase = {
	type: AgentV2RunEventType;
	at: string;
};

export interface AgentV2RunEventIdentity {
	clientId: string;
	runId: string;
}

export type AgentV2LiveRunEvent = AgentV2RunEventRecord;

export interface AgentV2RunEventReadRequest extends AgentV2RunEventIdentity {
	afterSeq: number;
	blockMs?: number;
	signal?: AbortSignal;
}

export type AgentV2RunCreatedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.run_created";
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	attempt: number;
};

export type AgentV2PhaseChangedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.phase_changed";
	phase: AgentV2Phase;
	attempt?: number;
};

export type AgentV2TaskUpdatedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.task_updated";
	taskId: string;
	status: string;
};

export type AgentV2ArtifactIndexedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.artifact_indexed";
	artifactId: string;
	kind?: string;
	path?: string;
};

export type AgentV2ValidationRecordedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.validation_recorded";
	validationId: string;
	status: string;
	summary: string;
};

export type AgentV2DiagnosticRecordedTransportEvent = AgentV2TransportEventBase & {
	type: "agent_v2.diagnostic_recorded";
	diagnosticId: string;
	severity: string;
	code: string;
	message: string;
};

export type AgentV2RunTransportEvent =
	| AgentV2RunCreatedTransportEvent
	| AgentV2PhaseChangedTransportEvent
	| AgentV2TaskUpdatedTransportEvent
	| AgentV2ArtifactIndexedTransportEvent
	| AgentV2ValidationRecordedTransportEvent
	| AgentV2DiagnosticRecordedTransportEvent;

const AGENT_V2_RUN_EVENT_TYPE_SET = new Set<string>(AGENT_V2_RUN_EVENT_TYPES);

export async function appendAgentV2RunEvent(
	sink: Pick<RunEventSink, "persistAgentEvent">,
	run: RuntimeRunRecord,
	event: AgentV2RunTransportEvent,
): Promise<void> {
	if (!AGENT_V2_RUN_EVENT_TYPE_SET.has(event.type)) {
		throw new Error(`Unsupported Agent v2 transport event type: ${event.type}`);
	}

	await sink.persistAgentEvent(run, event);
}
