export const AGENT_V2_SCHEMA_VERSION = 1;
export const AGENT_V2_RUN_STATUSES = [
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
];
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
];
export const AGENT_V2_RUN_EVENT_TYPES = [
    "agent_v2.run_created",
    "agent_v2.phase_changed",
    "agent_v2.task_updated",
    "agent_v2.artifact_indexed",
    "agent_v2.validation_recorded",
    "agent_v2.diagnostic_recorded",
];
export const AGENT_V2_TASK_STATUSES = [
    "pending",
    "ready",
    "running",
    "blocked",
    "succeeded",
    "failed",
    "cancelled",
];
//# sourceMappingURL=agent-v2-types.js.map