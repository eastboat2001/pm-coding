import { createHash } from "node:crypto";
import type { AgentV2StoreResult } from "./agent-v2-runtime-store.js";

export type AgentV2OutboxKind =
	| "run_enqueue"
	| "run_cancel"
	| "live_event"
	| "workspace_diagnostic"
	| "langfuse_diagnostic";
export type AgentV2OutboxStatus = "pending" | "leased" | "delivered" | "dead_letter";

export type AgentV2OutboxReference =
	| { kind: "run_enqueue"; queueName: string; attempt?: number }
	| { kind: "run_cancel"; queueName: string; cancelToken: string }
	| { kind: "live_event"; eventSeq: number }
	| { kind: "workspace_diagnostic"; diagnosticId: string }
	| { kind: "langfuse_diagnostic"; diagnosticId: string };

export interface AgentV2OutboxRecord {
	intentId: string;
	dedupeKey: string;
	clientId: string;
	runId: string;
	reference: AgentV2OutboxReference;
	status: AgentV2OutboxStatus;
	attemptCount: number;
	availableAt: string;
	leaseOwner?: string;
	leaseExpiresAt?: string;
	lastErrorCode?: string;
	lastErrorMessage?: string;
	createdAt: string;
	updatedAt: string;
	deliveredAt?: string;
}

export interface AgentV2OutboxLeaseInput {
	ownerId: string;
	kinds?: readonly AgentV2OutboxKind[];
	limit: number;
	now: string;
	leaseTtlMs: number;
}
export interface AgentV2OutboxDeliveryInput {
	intentId: string;
	ownerId: string;
	leaseAttempt: number;
	deliveredAt: string;
}
export interface AgentV2OutboxRescheduleInput {
	intentId: string;
	ownerId: string;
	leaseAttempt: number;
	availableAt: string;
	errorCode: string;
	errorMessage: string;
	maxAttempts: number;
	updatedAt: string;
}
export interface AgentV2OutboxStore {
	leaseAgentV2Outbox(input: AgentV2OutboxLeaseInput): AgentV2StoreResult<AgentV2OutboxRecord[]>;
	markAgentV2OutboxDelivered(input: AgentV2OutboxDeliveryInput): AgentV2StoreResult<"delivered" | "lease_lost">;
	rescheduleAgentV2Outbox(
		input: AgentV2OutboxRescheduleInput,
	): AgentV2StoreResult<"pending" | "dead_letter" | "lease_lost">;
}

export function agentV2OutboxIntentId(dedupeKey: string): string {
	return `outbox:${createHash("sha256").update(dedupeKey).digest("hex")}`;
}

export function validateAgentV2OutboxLeaseInput(input: AgentV2OutboxLeaseInput): void {
	if (!input.ownerId.trim()) throw new Error("Agent v2 outbox ownerId is required");
	if (!Number.isSafeInteger(input.limit) || input.limit <= 0)
		throw new Error("Agent v2 outbox limit must be positive");
	if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
		throw new Error("Agent v2 outbox leaseTtlMs must be positive");
	}
	assertTimestamp(input.now, "now");
	const allowed = new Set<AgentV2OutboxKind>([
		"run_enqueue",
		"run_cancel",
		"live_event",
		"workspace_diagnostic",
		"langfuse_diagnostic",
	]);
	if (input.kinds?.some((kind) => !allowed.has(kind))) throw new Error("Agent v2 outbox kind is invalid");
}

export function validateAgentV2OutboxDeliveryInput(input: AgentV2OutboxDeliveryInput): void {
	if (!input.ownerId.trim()) throw new Error("Agent v2 outbox ownerId is required");
	if (!input.intentId.trim()) throw new Error("Agent v2 outbox intentId is required");
	assertLeaseAttempt(input.leaseAttempt);
	assertTimestamp(input.deliveredAt, "deliveredAt");
}

export function validateAgentV2OutboxRescheduleInput(input: AgentV2OutboxRescheduleInput): void {
	if (!input.ownerId.trim()) throw new Error("Agent v2 outbox ownerId is required");
	if (!input.intentId.trim()) throw new Error("Agent v2 outbox intentId is required");
	assertLeaseAttempt(input.leaseAttempt);
	if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
		throw new Error("Agent v2 outbox maxAttempts must be positive");
	}
	assertTimestamp(input.availableAt, "availableAt");
	assertTimestamp(input.updatedAt, "updatedAt");
}

function assertLeaseAttempt(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Agent v2 outbox leaseAttempt must be positive");
	}
}

export function assertAgentV2Timestamp(value: string, label: string): void {
	assertTimestamp(value, label);
}

function assertTimestamp(value: string, label: string): void {
	if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`Agent v2 outbox ${label} must be a timestamp`);
}
