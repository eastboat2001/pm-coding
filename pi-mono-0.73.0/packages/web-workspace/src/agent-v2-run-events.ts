import type { AgentV2RunEventRecord } from "./agent-v2-store.js";
import type {
	AgentV2ArtifactIndexedPayload,
	AgentV2DeliveryReportPayload,
	AgentV2DiagnosticRecordedPayload,
	AgentV2OutputRecordedPayload,
	AgentV2Phase,
	AgentV2PlanningReadyTransportEvent,
	AgentV2RunEventType,
	AgentV2RunStatus,
	AgentV2SkillAppliedPayload,
	AgentV2SkillResourceLoadedPayload,
	AgentV2TaskUpdatedPayload,
	AgentV2ValidationRecordedPayload,
} from "./agent-v2-types.js";

export type { AgentV2PlanningReadyTransportEvent } from "./agent-v2-types.js";

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
	status: AgentV2RunStatus;
	attempt?: number;
	reason?: string;
	cancelFingerprint?: string;
};

export type AgentV2TaskUpdatedTransportEvent = AgentV2TaskUpdatedPayload;
export type AgentV2ArtifactIndexedTransportEvent = AgentV2ArtifactIndexedPayload;
export type AgentV2ValidationRecordedTransportEvent = AgentV2ValidationRecordedPayload;
export type AgentV2DiagnosticRecordedTransportEvent = AgentV2DiagnosticRecordedPayload;
export type AgentV2OutputRecordedTransportEvent = AgentV2OutputRecordedPayload;
export type AgentV2SkillAppliedTransportEvent = AgentV2SkillAppliedPayload;
export type AgentV2SkillResourceLoadedTransportEvent = AgentV2SkillResourceLoadedPayload;
export type AgentV2DeliveryReportedTransportEvent = AgentV2DeliveryReportPayload;

export type AgentV2RunTransportEvent =
	| AgentV2RunCreatedTransportEvent
	| AgentV2PlanningReadyTransportEvent
	| AgentV2PhaseChangedTransportEvent
	| AgentV2TaskUpdatedTransportEvent
	| AgentV2ArtifactIndexedTransportEvent
	| AgentV2ValidationRecordedTransportEvent
	| AgentV2DiagnosticRecordedTransportEvent
	| AgentV2OutputRecordedTransportEvent
	| AgentV2SkillAppliedTransportEvent
	| AgentV2SkillResourceLoadedTransportEvent
	| AgentV2DeliveryReportedTransportEvent;
