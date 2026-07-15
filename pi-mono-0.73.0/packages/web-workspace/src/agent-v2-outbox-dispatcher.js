const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_DELAY_MS = 1_000;
export class AgentV2OutboxDispatcher {
    adapters = new Map();
    now;
    onError;
    retryDelayMs;
    store;
    wakeResolver;
    constructor(options) {
        this.store = options.store;
        this.now = options.now ?? (() => new Date().toISOString());
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.onError = options.onError;
        for (const adapter of options.adapters) {
            if (this.adapters.has(adapter.kind))
                throw new Error(`Duplicate Agent v2 outbox adapter: ${adapter.kind}`);
            this.adapters.set(adapter.kind, adapter);
        }
        if (this.adapters.size === 0)
            throw new Error("Agent v2 outbox dispatcher requires an adapter");
    }
    static forQueueAndLive(options) {
        return new AgentV2OutboxDispatcher({
            store: options.store,
            now: options.now,
            onError: options.onError,
            adapters: [
                queueEnqueueAdapter(options.queue, options.queueName),
                queueCancelAdapter(options.queue, options.queueName),
                liveEventAdapter(options.store, options.bus),
                ...(options.additionalAdapters ?? []),
            ],
        });
    }
    wake() {
        this.wakeResolver?.();
    }
    async dispatchAvailable(input) {
        const result = {
            leased: 0,
            delivered: 0,
            retried: 0,
            deadLettered: 0,
            leaseLost: 0,
            aborted: input.signal?.aborted ?? false,
        };
        if (result.aborted)
            return result;
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
            if (!adapter)
                continue;
            const signal = input.signal ?? new AbortController().signal;
            try {
                await adapter.deliver(record, signal);
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
                if (ack === "delivered")
                    result.delivered += 1;
                else
                    result.leaseLost += 1;
            }
            catch {
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
                if (rescheduled === "pending")
                    result.retried += 1;
                else if (rescheduled === "dead_letter")
                    result.deadLettered += 1;
                else
                    result.leaseLost += 1;
            }
        }
        return result;
    }
    async start(input) {
        if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
            throw new Error("Agent v2 outbox intervalMs must be positive");
        }
        while (!input.signal.aborted) {
            try {
                await this.dispatchAvailable({ ownerId: input.ownerId, limit: 100, signal: input.signal });
            }
            catch {
                if (input.signal.aborted)
                    break;
                await Promise.resolve(this.onError?.({
                    code: "agent_v2.outbox_scan_failed",
                    message: "Agent v2 outbox scan failed",
                })).catch(() => undefined);
            }
            if (input.signal.aborted)
                break;
            await this.wait(input.intervalMs, input.signal);
        }
    }
    wait(intervalMs, signal) {
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                if (this.wakeResolver === finish)
                    this.wakeResolver = undefined;
                resolve();
            };
            const timer = setTimeout(finish, intervalMs);
            this.wakeResolver = finish;
            signal.addEventListener("abort", finish, { once: true });
        });
    }
}
function queueEnqueueAdapter(queue, queueName) {
    return {
        kind: "run_enqueue",
        async deliver(intent) {
            assertQueueName(intent.reference.queueName, queueName);
            await queue.enqueue(identity(intent));
        },
    };
}
function queueCancelAdapter(queue, queueName) {
    return {
        kind: "run_cancel",
        async deliver(intent) {
            assertQueueName(intent.reference.queueName, queueName);
            await queue.requestCancel(identity(intent), intent.reference.cancelToken);
        },
    };
}
function liveEventAdapter(store, bus) {
    return {
        kind: "live_event",
        async deliver(intent) {
            const events = await store.listAgentV2RunEvents(intent.clientId, intent.runId, intent.reference.eventSeq - 1);
            const event = events.find((candidate) => candidate.seq === intent.reference.eventSeq);
            if (!event)
                throw new Error("Agent v2 canonical live event is missing");
            await bus.project(event);
        },
    };
}
function identity(intent) {
    return { clientId: intent.clientId, runId: intent.runId };
}
function assertQueueName(referenceQueueName, configuredQueueName) {
    if (referenceQueueName !== configuredQueueName) {
        throw new Error("Agent v2 outbox queue reference does not match this dispatcher");
    }
}
function orderLiveEvents(records) {
    const ordered = [...records];
    const byRun = new Map();
    for (const record of ordered) {
        if (record.reference.kind !== "live_event")
            continue;
        const key = JSON.stringify([record.clientId, record.runId]);
        const events = byRun.get(key) ?? [];
        events.push(record);
        byRun.set(key, events);
    }
    for (const events of byRun.values())
        events.sort((left, right) => liveSeq(left) - liveSeq(right));
    const offsets = new Map();
    return ordered.map((record) => {
        if (record.reference.kind !== "live_event")
            return record;
        const key = JSON.stringify([record.clientId, record.runId]);
        const offset = offsets.get(key) ?? 0;
        offsets.set(key, offset + 1);
        return byRun.get(key)[offset];
    });
}
function liveSeq(record) {
    return record.reference.kind === "live_event" ? record.reference.eventSeq : 0;
}
//# sourceMappingURL=agent-v2-outbox-dispatcher.js.map