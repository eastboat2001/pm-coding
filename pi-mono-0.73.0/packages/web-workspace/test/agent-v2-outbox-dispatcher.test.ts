import { describe, expect, it, vi } from "vitest";
import type { AgentV2OutboxKind, AgentV2OutboxRecord, AgentV2OutboxStore } from "../src/agent-v2-outbox.js";
import { type AgentV2OutboxDeliveryAdapter, AgentV2OutboxDispatcher } from "../src/agent-v2-outbox-dispatcher.js";

const NOW = "2026-07-15T00:00:00.000Z";

describe("AgentV2OutboxDispatcher", () => {
	it("leases only registered kinds and acknowledges each successful lease generation", async () => {
		const store = new FakeOutboxStore([intent("enqueue", "run_enqueue", 2), intent("live", "live_event", 3)]);
		const delivered: string[] = [];
		const adapters = [
			adapter("run_enqueue", async (record) => {
				delivered.push(record.intentId);
			}),
		];
		const dispatcher = new AgentV2OutboxDispatcher({ store, adapters, now: () => NOW });

		await expect(dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 })).resolves.toEqual({
			leased: 1,
			delivered: 1,
			retried: 0,
			deadLettered: 0,
			leaseLost: 0,
			aborted: false,
		});
		expect(store.leaseCalls[0]?.kinds).toEqual(["run_enqueue"]);
		expect(delivered).toEqual(["enqueue"]);
		expect(store.deliveredCalls).toEqual([
			{ intentId: "enqueue", ownerId: "owner-a", leaseAttempt: 2, deliveredAt: NOW },
		]);
	});

	it("isolates delivery failures, retries with sanitized errors, and dead-letters at max attempts", async () => {
		const store = new FakeOutboxStore([intent("bad", "run_enqueue", 4), intent("good", "live_event", 1)]);
		store.rescheduleResult = "dead_letter";
		const adapters = [
			adapter("run_enqueue", async () => {
				throw new Error("redis://user:secret@example.test payload=private");
			}),
			adapter("live_event", async () => undefined),
		];
		const dispatcher = new AgentV2OutboxDispatcher({ store, adapters, now: () => NOW });

		const result = await dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10, maxAttempts: 4 });

		expect(result).toMatchObject({ leased: 2, delivered: 1, deadLettered: 1, retried: 0 });
		expect(store.deliveredCalls.map((call) => call.intentId)).toEqual(["good"]);
		expect(store.rescheduleCalls[0]).toMatchObject({
			intentId: "bad",
			ownerId: "owner-a",
			leaseAttempt: 4,
			errorCode: "agent_v2.outbox_delivery_failed",
			errorMessage: "Agent v2 outbox delivery failed",
			maxAttempts: 4,
		});
		expect(JSON.stringify(store.rescheduleCalls)).not.toContain("secret");
		expect(JSON.stringify(store.rescheduleCalls)).not.toContain("private");
	});

	it("leaves an in-flight lease for expiry when aborted", async () => {
		const controller = new AbortController();
		const store = new FakeOutboxStore([intent("enqueue", "run_enqueue", 1)]);
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [
				adapter("run_enqueue", async (_record, signal) => {
					controller.abort();
					expect(signal.aborted).toBe(true);
					throw new DOMException("aborted", "AbortError");
				}),
			],
			now: () => NOW,
		});

		await expect(
			dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10, signal: controller.signal }),
		).resolves.toMatchObject({ leased: 1, delivered: 0, retried: 0, aborted: true });
		expect(store.deliveredCalls).toEqual([]);
		expect(store.rescheduleCalls).toEqual([]);
	});

	it("routes enqueue, cancel and live canonical references without embedding payload copies", async () => {
		const store = new FakeOutboxStore([]);
		const enqueue = vi.fn(async () => "enqueued" as const);
		const cancel = vi.fn(async () => "requested" as const);
		const project = vi.fn(async () => "projected" as const);
		store.events = [
			{ clientId: "client-a", runId: "run-a", seq: 7, type: "done", payload: { ok: true }, createdAt: NOW },
		];
		const dispatcher = AgentV2OutboxDispatcher.forQueueAndLive({
			store,
			queue: { enqueue, requestCancel: cancel },
			queueName: "agent-v2",
			bus: { project },
			now: () => NOW,
		});
		store.records = [
			intent("enqueue", "run_enqueue", 1),
			intent("cancel", "run_cancel", 1),
			intent("live", "live_event", 1),
		];

		await dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 });

		expect(enqueue).toHaveBeenCalledWith({ clientId: "client-a", runId: "run-a" });
		expect(cancel).toHaveBeenCalledWith({ clientId: "client-a", runId: "run-a" }, "cancel-a");
		expect(project).toHaveBeenCalledWith(store.events[0]);
		expect(store.listEventCalls).toEqual([{ clientId: "client-a", runId: "run-a", afterSeq: 6 }]);
	});

	it("keeps an attempt retry pending while the previous queue claim is still active", async () => {
		const store = new FakeOutboxStore([intent("retry-2", "run_enqueue", 1, 7, 2)]);
		const enqueue = vi.fn(async () => "already_active" as const);
		const dispatcher = AgentV2OutboxDispatcher.forQueueAndLive({
			store,
			queue: { enqueue, requestCancel: async () => "stale" as const },
			queueName: "agent-v2",
			bus: { project: async () => "projected" as const },
			now: () => NOW,
		});

		await expect(
			dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10, maxAttempts: 2 }),
		).resolves.toMatchObject({
			delivered: 0,
			retried: 1,
			deadLettered: 0,
		});
		expect(store.deliveredCalls).toEqual([]);
		expect(store.rescheduleCalls[0]).toMatchObject({
			intentId: "retry-2",
			maxAttempts: 1_000_000,
		});
	});

	it("delivers leased live events in durable sequence order for the same run", async () => {
		const store = new FakeOutboxStore([intent("live-2", "live_event", 1, 2), intent("live-1", "live_event", 1, 1)]);
		const delivered: number[] = [];
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [
				adapter("live_event", async (record) => {
					delivered.push(record.reference.eventSeq);
				}),
			],
			now: () => NOW,
		});

		await dispatcher.dispatchAvailable({ ownerId: "owner-a", limit: 10 });

		expect(delivered).toEqual([1, 2]);
	});

	it("keeps the start loop alive after a transient store scan failure with sanitized observation", async () => {
		const controller = new AbortController();
		const store = new FakeOutboxStore([intent("enqueue", "run_enqueue", 1)]);
		store.leaseErrorsRemaining = 1;
		const effects: string[] = [];
		const observed: unknown[] = [];
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: [
				adapter("run_enqueue", async (record) => {
					effects.push(record.intentId);
					controller.abort();
				}),
			],
			now: () => NOW,
			onError: (event) => {
				observed.push(event);
			},
		});

		await expect(
			dispatcher.start({ ownerId: "owner-a", intervalMs: 1, signal: controller.signal }),
		).resolves.toBeUndefined();
		expect(effects).toEqual(["enqueue"]);
		expect(observed).toEqual([{ code: "agent_v2.outbox_scan_failed", message: "Agent v2 outbox scan failed" }]);
		expect(JSON.stringify(observed)).not.toContain("redis://user:secret");
	});
});

function adapter<K extends AgentV2OutboxKind>(
	kind: K,
	deliver: AgentV2OutboxDeliveryAdapter<K>["deliver"],
): AgentV2OutboxDeliveryAdapter<K> {
	return { kind, deliver };
}

function intent(
	id: string,
	kind: "run_enqueue" | "run_cancel" | "live_event",
	attemptCount: number,
	eventSeq = 7,
	targetAttempt?: number,
): AgentV2OutboxRecord {
	const reference =
		kind === "run_enqueue"
			? ({
					kind,
					queueName: "agent-v2",
					...(targetAttempt === undefined ? {} : { attempt: targetAttempt }),
				} as const)
			: kind === "run_cancel"
				? ({ kind, queueName: "agent-v2", cancelToken: "cancel-a" } as const)
				: ({ kind, eventSeq } as const);
	return {
		intentId: id,
		dedupeKey: id,
		clientId: "client-a",
		runId: "run-a",
		reference,
		status: "leased",
		attemptCount,
		availableAt: NOW,
		leaseOwner: "owner-a",
		leaseExpiresAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

class FakeOutboxStore implements AgentV2OutboxStore {
	records: AgentV2OutboxRecord[];
	events: Array<{
		clientId: string;
		runId: string;
		seq: number;
		type: string;
		payload: Record<string, unknown>;
		createdAt: string;
	}> = [];
	readonly leaseCalls: Array<Record<string, unknown>> = [];
	readonly deliveredCalls: Array<Record<string, unknown>> = [];
	readonly rescheduleCalls: Array<Record<string, unknown>> = [];
	readonly listEventCalls: Array<Record<string, unknown>> = [];
	rescheduleResult: "pending" | "dead_letter" | "lease_lost" = "pending";
	leaseErrorsRemaining = 0;

	constructor(records: AgentV2OutboxRecord[]) {
		this.records = records;
	}

	leaseAgentV2Outbox(input: any): AgentV2OutboxRecord[] {
		this.leaseCalls.push(input);
		if (this.leaseErrorsRemaining > 0) {
			this.leaseErrorsRemaining -= 1;
			throw new Error("redis://user:secret@example.test raw payload");
		}
		return this.records.filter((record) => input.kinds.includes(record.reference.kind));
	}

	markAgentV2OutboxDelivered(input: any): "delivered" {
		this.deliveredCalls.push(input);
		return "delivered";
	}

	rescheduleAgentV2Outbox(input: any): "pending" | "dead_letter" | "lease_lost" {
		this.rescheduleCalls.push(input);
		return this.rescheduleResult;
	}

	listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number) {
		this.listEventCalls.push({ clientId, runId, afterSeq });
		return this.events.filter((event) => event.seq > afterSeq);
	}

	appendAgentV2RunEvent(): never {
		throw new Error("not used");
	}
}
