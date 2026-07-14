export const AGENT_V2_SCHEMA_VERSION = 2 as const;

export const AGENT_V2_SCHEMA_RESET_REQUIRED = "Agent v2 schema reset required";

export const AGENT_V2_SCHEMA_TABLE_COLUMNS = {
	agent_v2_schema_metadata: ["singleton_id", "schema_version", "applied_at"],
	agent_v2_runs: [
		"client_id",
		"run_id",
		"status",
		"phase",
		"attempt",
		"input_json",
		"model_json",
		"worker_id",
		"created_at",
		"updated_at",
		"started_at",
		"ended_at",
		"error_json",
	],
	agent_v2_run_events: ["client_id", "run_id", "seq", "event_type", "payload_json", "created_at"],
	agent_v2_tasks: [
		"client_id",
		"run_id",
		"task_id",
		"kind",
		"title",
		"status",
		"parent_task_id",
		"depends_on_json",
		"acceptance_criteria_json",
		"input_json",
		"output_json",
		"created_at",
		"updated_at",
		"started_at",
		"ended_at",
		"error_json",
	],
	agent_v2_artifacts: [
		"client_id",
		"run_id",
		"artifact_id",
		"kind",
		"path",
		"media_type",
		"checksum",
		"version",
		"validation_status",
		"source_task_id",
		"metadata_json",
		"created_at",
		"updated_at",
	],
	agent_v2_documents: [
		"client_id",
		"run_id",
		"document_id",
		"kind",
		"version",
		"content_markdown",
		"content_json",
		"source_task_id",
		"created_at",
		"updated_at",
	],
	agent_v2_diagnostics: [
		"client_id",
		"run_id",
		"diagnostic_id",
		"severity",
		"category",
		"code",
		"message",
		"phase",
		"task_id",
		"artifact_id",
		"trace_id",
		"data_json",
		"created_at",
	],
	agent_v2_validation_attempts: [
		"client_id",
		"run_id",
		"validation_id",
		"attempt",
		"task_id",
		"artifact_id",
		"status",
		"summary",
		"details_json",
		"created_at",
		"updated_at",
	],
	agent_v2_input_blobs: [
		"client_id",
		"run_id",
		"input_id",
		"logical_path",
		"media_type",
		"encoding",
		"bytes",
		"byte_length",
		"checksum",
		"created_at",
	],
	agent_v2_input_references: [
		"client_id",
		"run_id",
		"input_id",
		"logical_path",
		"media_type",
		"checksum",
		"kind",
		"ordinal",
		"display_name",
		"byte_length",
	],
	agent_v2_bootstraps: ["client_id", "run_id", "bootstrap_version", "bootstrap_checksum", "created_at"],
	agent_v2_outbox: [
		"intent_id",
		"dedupe_key",
		"client_id",
		"run_id",
		"kind",
		"status",
		"available_at",
		"created_at",
		"updated_at",
		"reference_json",
		"attempt_count",
		"lease_owner",
		"lease_expires_at",
		"last_error_code",
		"last_error_message",
		"delivered_at",
	],
} as const;

export const AGENT_V2_SCHEMA_TABLES = Object.keys(AGENT_V2_SCHEMA_TABLE_COLUMNS).sort();
export const AGENT_V2_SCHEMA_INDEXES = [
	"idx_agent_v2_artifacts_run_updated",
	"idx_agent_v2_diagnostics_run_created",
	"idx_agent_v2_documents_run_updated",
	"idx_agent_v2_outbox_dispatch",
	"idx_agent_v2_outbox_lease",
	"idx_agent_v2_outbox_run",
	"idx_agent_v2_runs_status",
	"idx_agent_v2_runs_worker_active",
	"idx_agent_v2_tasks_run_updated",
	"idx_agent_v2_validation_attempts_run_created",
	"uq_agent_v2_input_blobs_logical_path",
	"uq_agent_v2_outbox_dedupe",
] as const;

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
	"agent_v2.planning_ready",
	"agent_v2.phase_changed",
	"agent_v2.task_updated",
	"agent_v2.artifact_indexed",
	"agent_v2.validation_recorded",
	"agent_v2.diagnostic_recorded",
	"agent_v2.output_recorded",
] as const;
export type AgentV2RunEventType = (typeof AGENT_V2_RUN_EVENT_TYPES)[number];

export interface AgentV2PlanningReadyTransportEvent {
	type: "agent_v2.planning_ready";
	phase: AgentV2Phase;
	at: string;
}

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

export const AGENT_V2_VALIDATION_STATUSES = ["passed", "failed", "blocked", "warning"] as const;
export type AgentV2ValidationStatus = (typeof AGENT_V2_VALIDATION_STATUSES)[number];
export type AgentV2ArtifactValidationStatus = "not_started" | "pending" | "passed" | "failed" | "accepted";

export interface AgentV2ModelUsageSummary {
	input: number;
	output: number;
	totalTokens: number;
	costTotal: number;
}

export interface AgentV2TaskUpdatedPayload {
	type: "agent_v2.task_updated";
	taskId: string;
	kind: AgentV2TaskKind;
	status: AgentV2TaskStatus;
	phase: AgentV2Phase;
	at: string;
}

export interface AgentV2ArtifactIndexedPayload {
	type: "agent_v2.artifact_indexed";
	artifactId: string;
	path: string;
	validationStatus: AgentV2ArtifactValidationStatus;
	revision: string;
	at: string;
}

export interface AgentV2ValidationRecordedPayload {
	type: "agent_v2.validation_recorded";
	validationId: string;
	taskId: string;
	attempt: number;
	status: AgentV2ValidationStatus;
	summary: string;
	at: string;
}

export interface AgentV2OutputRecordedPayload {
	type: "agent_v2.output_recorded";
	taskId: string;
	summary: string;
	provider: string;
	model: string;
	usage?: AgentV2ModelUsageSummary;
	at: string;
}

export interface AgentV2DiagnosticRecordedPayload {
	type: "agent_v2.diagnostic_recorded";
	diagnosticId: string;
	severity: "debug" | "info" | "warn" | "error";
	code: string;
	message: string;
	at: string;
}

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
