import type { AgentV2OutboxKind, AgentV2OutboxRecord, AgentV2OutboxStore } from "./agent-v2-outbox.js";
import type { AgentV2RunEventBus } from "./agent-v2-run-event-bus.js";
import type { AgentV2RunQueue, AgentV2RunQueueIdentity } from "./agent-v2-run-queue.js";
import type { AgentV2RunEventLogStore } from "./agent-v2-runtime-store.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface AgentV2OutboxDeliveryAdapter<K extends AgentV2OutboxKind = AgentV2OutboxKind> {
	readonly kind: K;
	deliver(intent: AgentV2OutboxRecord & { reference: { kind: K } }, signal: AbortSignal): Promise<void>;
}

export interface AgentV2OutboxDispatchInput {
	ownerId: string;
	limit: number;
	leaseTtlMs?: number;
	maxAttempts?: number;
	signal?: AbortSignal;
}

export interface AgentV2OutboxDispatchResult {
	leased: number;
	delivered: number;
	retried: number;
	deadLettered: number;
	leaseLost: number;
	aborted: boolean;
}

export interface AgentV2OutboxDispatcherOptions {
	store: AgentV2OutboxStore;
	adapters: readonly AgentV2OutboxDeliveryAdapter[];
	now?: () => string;
	retryDelayMs?: number;
	onError?: (event: AgentV2OutboxDispatcherErrorEvent) => void | Promise<void>;
}

export interface AgentV2OutboxDispatcherErrorEvent {
	code: "agent_v2.outbox_scan_failed";
	message: "Agent v2 outbox scan failed";
}

export class AgentV2OutboxDispatcher {
	private readonly adapters = new Map<AgentV2OutboxKind, AgentV2OutboxDeliveryAdapter>();
	private readonly now: () => string;
	private readonly onError?: (event: AgentV2OutboxDispatcherErrorEvent) => void | Promise<void>;
	private readonly retryDelayMs: number;
	private readonly store: AgentV2OutboxStore;
	private wakeResolver?: () => void;

	constructor(options: AgentV2OutboxDispatcherOptions) {
		this.store = options.store;
		this.now = options.now ?? (() => new Date().toISOString());
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.onError = options.onError;
		for (const adapter of options.adapters) {
			if (this.adapters.has(adapter.kind)) throw new Error(`Duplicate Agent v2 outbox adapter: ${adapter.kind}`);
			this.adapters.set(adapter.kind, adapter);
		}
		if (this.adapters.size === 0) throw new Error("Agent v2 outbox dispatcher requires an adapter");
	}

	static forQueueAndLive(options: {
		store: AgentV2OutboxStore & AgentV2RunEventLogStore;
		queue: Pick<AgentV2RunQueue, "enqueue" | "requestCancel">;
		queueName: string;
		bus: Pick<AgentV2RunEventBus, "project">;
		now?: () => string;
		onError?: (event: AgentV2OutboxDispatcherErrorEvent) => void | Promise<void>;
	}): AgentV2OutboxDispatcher {
		return new AgentV2OutboxDispatcher({
			store: options.store,
			now: options.now,
			onError: options.onError,
			adapters: [
				queueEnqueueAdapter(options.queue, options.queueName),
				queueCancelAdapter(options.queue, options.queueName),
				liveEventAdapter(options.store, options.bus),
			],
		});
	}

	wake(): void {
		this.wakeResolver?.();
	}

	async dispatchAvailable(input: AgentV2OutboxDispatchInput): Promise<AgentV2OutboxDispatchResult> {
		const result: AgentV2OutboxDispatchResult = {
			leased: 0,
			delivered: 0,
			retried: 0,
			deadLettered: 0,
			leaseLost: 0,
			aborted: input.signal?.aborted ?? false,
		};
		if (result.aborted) return result;
		const now = this.now();
		const records = await this.store.leaseAgentV2Outbox({
			ownerId: input.ownerId,
			kinds: [...this.adapters.keys()],
			limit: input.limit,
			now,
			leaseTtlMs: input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
		});
		result.leased = records.length;
		for (const record of orderLiveEvents(records)) {
			if (input.signal?.aborted) {
				result.aborted = true;
				break;
			}
			const adapter = this.adapters.get(record.reference.kind);
			if (!adapter) continue;
			const signal = input.signal ?? new AbortController().signal;
			try {
				await adapter.deliver(record as never, signal);
				if (signal.aborted) {
					result.aborted = true;
					break;
				}
				const ack = await this.store.markAgentV2OutboxDelivered({
					intentId: record.intentId,
					ownerId: input.ownerId,
					leaseAttempt: record.attemptCount,
					deliveredAt: this.now(),
				});
				if (ack === "delivered") result.delivered += 1;
				else result.leaseLost += 1;
			} catch {
				if (signal.aborted) {
					result.aborted = true;
					break;
				}
				const updatedAt = this.now();
				const availableAt = new Date(Date.parse(updatedAt) + this.retryDelayMs).toISOString();
				const rescheduled = await this.store.rescheduleAgentV2Outbox({
					intentId: record.intentId,
					ownerId: input.ownerId,
					leaseAttempt: record.attemptCount,
					availableAt,
					errorCode: "agent_v2.outbox_delivery_failed",
					errorMessage: "Agent v2 outbox delivery failed",
					maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
					updatedAt,
				});
				if (rescheduled === "pending") result.retried += 1;
				else if (rescheduled === "dead_letter") result.deadLettered += 1;
				else result.leaseLost += 1;
			}
		}
		return result;
	}

	async start(input: { ownerId: string; intervalMs: number; signal: AbortSignal }): Promise<void> {
		if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
			throw new Error("Agent v2 outbox intervalMs must be positive");
		}
		while (!input.signal.aborted) {
			try {
				await this.dispatchAvailable({ ownerId: input.ownerId, limit: 100, signal: input.signal });
			} catch {
				if (input.signal.aborted) break;
				await Promise.resolve(
					this.onError?.({
						code: "agent_v2.outbox_scan_failed",
						message: "Agent v2 outbox scan failed",
					}),
				).catch(() => undefined);
			}
			if (input.signal.aborted) break;
			await this.wait(input.intervalMs, input.signal);
		}
	}

	private wait(intervalMs: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				if (this.wakeResolver === finish) this.wakeResolver = undefined;
				resolve();
			};
			const timer = setTimeout(finish, intervalMs);
			this.wakeResolver = finish;
			signal.addEventListener("abort", finish, { once: true });
		});
	}
}

function queueEnqueueAdapter(
	queue: Pick<AgentV2RunQueue, "enqueue">,
	queueName: string,
): AgentV2OutboxDeliveryAdapter<"run_enqueue"> {
	return {
		kind: "run_enqueue",
		async deliver(intent): Promise<void> {
			assertQueueName(intent.reference.queueName, queueName);
			await queue.enqueue(identity(intent));
		},
	};
}

function queueCancelAdapter(
	queue: Pick<AgentV2RunQueue, "requestCancel">,
	queueName: string,
): AgentV2OutboxDeliveryAdapter<"run_cancel"> {
	return {
		kind: "run_cancel",
		async deliver(intent): Promise<void> {
			assertQueueName(intent.reference.queueName, queueName);
			await queue.requestCancel(identity(intent), intent.reference.cancelToken);
		},
	};
}

function liveEventAdapter(
	store: AgentV2RunEventLogStore,
	bus: Pick<AgentV2RunEventBus, "project">,
): AgentV2OutboxDeliveryAdapter<"live_event"> {
	return {
		kind: "live_event",
		async deliver(intent): Promise<void> {
			const events = await store.listAgentV2RunEvents(intent.clientId, intent.runId, intent.reference.eventSeq - 1);
			const event = events.find((candidate) => candidate.seq === intent.reference.eventSeq);
			if (!event) throw new Error("Agent v2 canonical live event is missing");
			await bus.project(event);
		},
	};
}

function identity(intent: AgentV2OutboxRecord): AgentV2RunQueueIdentity {
	return { clientId: intent.clientId, runId: intent.runId };
}

function assertQueueName(referenceQueueName: string, configuredQueueName: string): void {
	if (referenceQueueName !== configuredQueueName) {
		throw new Error("Agent v2 outbox queue reference does not match this dispatcher");
	}
}

function orderLiveEvents(records: readonly AgentV2OutboxRecord[]): AgentV2OutboxRecord[] {
	const ordered = [...records];
	const byRun = new Map<string, AgentV2OutboxRecord[]>();
	for (const record of ordered) {
		if (record.reference.kind !== "live_event") continue;
		const key = JSON.stringify([record.clientId, record.runId]);
		const events = byRun.get(key) ?? [];
		events.push(record);
		byRun.set(key, events);
	}
	for (const events of byRun.values()) events.sort((left, right) => liveSeq(left) - liveSeq(right));
	const offsets = new Map<string, number>();
	return ordered.map((record) => {
		if (record.reference.kind !== "live_event") return record;
		const key = JSON.stringify([record.clientId, record.runId]);
		const offset = offsets.get(key) ?? 0;
		offsets.set(key, offset + 1);
		return byRun.get(key)![offset]!;
	});
}

function liveSeq(record: AgentV2OutboxRecord): number {
	return record.reference.kind === "live_event" ? record.reference.eventSeq : 0;
}
