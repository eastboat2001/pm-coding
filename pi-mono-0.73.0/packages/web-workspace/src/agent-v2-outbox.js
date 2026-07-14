import { createHash } from "node:crypto";
export function agentV2OutboxIntentId(dedupeKey) {
    return `outbox:${createHash("sha256").update(dedupeKey).digest("hex")}`;
}
export function validateAgentV2OutboxLeaseInput(input) {
    if (!input.ownerId.trim())
        throw new Error("Agent v2 outbox ownerId is required");
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0)
        throw new Error("Agent v2 outbox limit must be positive");
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
        throw new Error("Agent v2 outbox leaseTtlMs must be positive");
    }
    assertTimestamp(input.now, "now");
    const allowed = new Set([
        "run_enqueue",
        "run_cancel",
        "live_event",
        "workspace_diagnostic",
        "langfuse_diagnostic",
    ]);
    if (input.kinds?.some((kind) => !allowed.has(kind)))
        throw new Error("Agent v2 outbox kind is invalid");
}
export function validateAgentV2OutboxDeliveryInput(input) {
    if (!input.ownerId.trim())
        throw new Error("Agent v2 outbox ownerId is required");
    if (!input.intentId.trim())
        throw new Error("Agent v2 outbox intentId is required");
    assertLeaseAttempt(input.leaseAttempt);
    assertTimestamp(input.deliveredAt, "deliveredAt");
}
export function validateAgentV2OutboxRescheduleInput(input) {
    if (!input.ownerId.trim())
        throw new Error("Agent v2 outbox ownerId is required");
    if (!input.intentId.trim())
        throw new Error("Agent v2 outbox intentId is required");
    assertLeaseAttempt(input.leaseAttempt);
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
        throw new Error("Agent v2 outbox maxAttempts must be positive");
    }
    assertTimestamp(input.availableAt, "availableAt");
    assertTimestamp(input.updatedAt, "updatedAt");
}
function assertLeaseAttempt(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("Agent v2 outbox leaseAttempt must be positive");
    }
}
export function assertAgentV2Timestamp(value, label) {
    assertTimestamp(value, label);
}
function assertTimestamp(value, label) {
    if (!value || !Number.isFinite(Date.parse(value)))
        throw new Error(`Agent v2 outbox ${label} must be a timestamp`);
}
//# sourceMappingURL=agent-v2-outbox.js.map