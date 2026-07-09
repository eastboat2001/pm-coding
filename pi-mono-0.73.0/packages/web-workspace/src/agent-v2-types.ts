export const AGENT_V2_SCHEMA_VERSION = 1 as const;

export const APPLICATION_GENERATION_RUNTIME_V2 = Object.freeze({
	version: "v2",
	v1Disabled: true,
	reason: "Application Generation Agent v2 is the replacement default; v1 is not a compatibility target.",
} as const);
export type ApplicationGenerationRuntimeVersion = (typeof APPLICATION_GENERATION_RUNTIME_V2)["version"];
export type ApplicationGenerationRuntimeSelection = typeof APPLICATION_GENERATION_RUNTIME_V2;

export const AGENT_V2_RUN_STATUSES = [
	"queued",
	"running",
	"cancelling",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
] as const;
export type AgentV2RunStatus = (typeof AGENT_V2_RUN_STATUSES)[number];

export const AGENT_V2_PHASES = [
	"intake",
	"capability_routing",
	"spec_draft",
	"spec_review",
	"plan_draft",
	"task_generation",
	"implementation",
	"validation",
	"repair",
	"preview",
	"delivery",
	"blocked",
	"failed",
	"cancelled",
] as const;
export type AgentV2Phase = (typeof AGENT_V2_PHASES)[number];

export const AGENT_V2_RUN_EVENT_TYPES = [
	"agent_v2.run_created",
	"agent_v2.phase_changed",
	"agent_v2.task_updated",
	"agent_v2.artifact_indexed",
	"agent_v2.validation_recorded",
	"agent_v2.diagnostic_recorded",
] as const;
export type AgentV2RunEventType = (typeof AGENT_V2_RUN_EVENT_TYPES)[number];

export const AGENT_V2_TASK_STATUSES = [
	"pending",
	"ready",
	"running",
	"blocked",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type AgentV2TaskStatus = (typeof AGENT_V2_TASK_STATUSES)[number];

export type AgentV2DocumentKind = "capability_decision" | "spec" | "plan" | "tasks";
export type AgentV2CapabilityDeliveryMode =
	| "static_app"
	| "build_static_frontend"
	| "static_simulation"
	| "needs_clarification"
	| "unsupported";

export type AgentV2TaskKind =
	| "capability"
	| "spec"
	| "plan"
	| "implementation"
	| "validation"
	| "repair"
	| "artifact"
	| "delivery";
export type AgentV2PlanStepId = "capability" | "spec" | "plan" | "implement" | "validate" | "deliver";

export type AgentV2RunInput = Record<string, unknown>;
export type AgentV2DocumentMetadata = Record<string, unknown>;

export interface AgentV2Error {
	code: string;
	message: string;
	retryable: boolean;
	data?: Record<string, unknown>;
}

export interface AgentV2TaskNode {
	taskId: string;
	parentTaskId?: string;
	kind: AgentV2TaskKind;
	title: string;
	status: AgentV2TaskStatus;
	dependsOn: string[];
	acceptanceCriteria: string[];
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface AgentV2CapabilityDecision {
	kind: "capability_decision";
	selectedCapability: string;
	deliveryMode: AgentV2CapabilityDeliveryMode;
	summary: string;
	rationale: string;
	requiresSimulation: boolean;
	requiresClarification: boolean;
	unsupportedCapabilities: string[];
	userVisibleContract: string;
	evidence: Array<{
		capability: string;
		matchedText: string;
		reason: string;
	}>;
	constraints: string[];
	alternatives: Array<{
		capability: string;
		reason: string;
	}>;
	platformContract: AgentV2PlatformContract;
	metadata?: AgentV2DocumentMetadata;
}

export interface AgentV2PlatformContract {
	runtime: string;
	framework: string;
	deliveryMode: AgentV2CapabilityDeliveryMode;
	entrypoints: string[];
	deliverables: string[];
	constraints: string[];
	supportedDeliveryModes?: AgentV2CapabilityDeliveryMode[];
	unsupportedCapabilities?: string[];
	userVisibleContract?: string;
	metadata?: AgentV2DocumentMetadata;
}

export interface AgentV2SpecDocument {
	kind: "spec";
	title: string;
	objective: string;
	summary: string;
	scope: string[];
	goals: string[];
	nonGoals: string[];
	assumptions: string[];
	requirements: string[];
	capabilityBoundaries: string[];
	acceptanceCriteria: string[];
	platformContract: AgentV2PlatformContract;
	metadata?: AgentV2DocumentMetadata;
}

export interface AgentV2PlanDocument {
	kind: "plan";
	title: string;
	summary: string;
	technicalApproach: string[];
	fileStructure: string[];
	dataModel: string[];
	interactionFlow: string[];
	validationStrategy: string[];
	steps: Array<{
		stepId: AgentV2PlanStepId;
		title: string;
		description: string;
		dependsOn: string[];
		deliverables: string[];
	}>;
	risks: string[];
	metadata?: AgentV2DocumentMetadata;
}

export interface AgentV2TaskGraph {
	kind: "tasks";
	tasks: AgentV2TaskNode[];
	edges: Array<{
		fromTaskId: string;
		toTaskId: string;
	}>;
	metadata?: AgentV2DocumentMetadata;
}

export type AgentV2DocumentContent =
	| AgentV2CapabilityDecision
	| AgentV2SpecDocument
	| AgentV2PlanDocument
	| AgentV2TaskGraph;

export interface AgentV2RunSnapshot {
	clientId: string;
	runId: string;
	status: AgentV2RunStatus;
	phase: AgentV2Phase;
	attempt: number;
	input: AgentV2RunInput;
	model: unknown;
	workerId?: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}

export interface AgentV2RunSnapshotInput {
	clientId: string;
	runId: string;
	input: AgentV2RunInput;
	model: unknown;
	createdAt?: string;
	updatedAt?: string;
	workerId?: string;
	startedAt?: string;
	endedAt?: string;
	error?: AgentV2Error;
}
