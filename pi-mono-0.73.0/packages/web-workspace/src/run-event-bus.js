import { createClient } from "redis";
const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const DEFAULT_EVENT_STREAM_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_READ_BLOCK_MS = 250;
const DEFAULT_READ_COUNT = 100;
export function runEventStreamKey(identity) {
    return `pi:runs:${identity.clientId}:${identity.sessionId}:${identity.runId}:events`;
}
export class InMemoryRunEventBus {
    closed = false;
    eventsByStream = new Map();
    async publish(event) {
        this.assertOpen();
        const key = runEventStreamKey(event);
        const events = this.eventsByStream.get(key);
        if (events === undefined) {
            this.eventsByStream.set(key, [event]);
            return;
        }
        events.push(event);
    }
    async read(request) {
        this.assertOpen();
        if (request.signal?.aborted) {
            return [];
        }
        const events = this.eventsByStream.get(runEventStreamKey(request)) ?? [];
        return events.filter((event) => event.seq > request.afterSeq);
    }
    async close() {
        this.closed = true;
        this.eventsByStream.clear();
    }
    assertOpen() {
        if (this.closed)
            throw new Error("Run event bus is closed");
    }
}
export class RedisRunEventBus {
    activeReads = 0;
    activeBlockingClients = new Set();
    client;
    closed = false;
    createRedisClient;
    maxLen;
    readWaiters = [];
    redisUrl;
    ttlSeconds;
    constructor(options) {
        this.redisUrl = options.redisUrl;
        this.maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
        this.ttlSeconds = options.ttlSeconds ?? DEFAULT_EVENT_STREAM_TTL_SECONDS;
        this.createRedisClient =
            options.createClient ??
                ((clientOptions) => createClient({ url: clientOptions.url }));
    }
    async publish(event) {
        this.assertOpen();
        const client = await this.connectedClient();
        const key = runEventStreamKey(event);
        await client.xAdd(key, `${event.seq}-0`, { event: JSON.stringify(event) }, {
            TRIM: {
                strategy: "MAXLEN",
                strategyModifier: "~",
                threshold: this.maxLen,
            },
        });
        await client.expire(key, this.ttlSeconds);
    }
    async read(request) {
        this.assertOpen();
        if (request.signal?.aborted) {
            return [];
        }
        this.activeReads += 1;
        let blockingClient;
        const disconnectBlockingRead = () => {
            if (blockingClient?.isOpen) {
                void Promise.resolve(blockingClient.disconnect()).catch(() => undefined);
            }
        };
        request.signal?.addEventListener("abort", disconnectBlockingRead, { once: true });
        try {
            const client = await this.connectedClient();
            if (this.closed || request.signal?.aborted) {
                disconnectBlockingRead();
                return [];
            }
            blockingClient = await this.connectedBlockingClient(client);
            this.activeBlockingClients.add(blockingClient);
            if (this.closed || request.signal?.aborted) {
                disconnectBlockingRead();
                return [];
            }
            const result = await blockingClient.xRead({ key: runEventStreamKey(request), id: `${request.afterSeq}-0` }, { BLOCK: request.blockMs ?? DEFAULT_READ_BLOCK_MS, COUNT: DEFAULT_READ_COUNT });
            if (this.closed || request.signal?.aborted) {
                return [];
            }
            return parseReadResult(result, request);
        }
        catch (error) {
            if (this.closed || request.signal?.aborted) {
                return [];
            }
            throw error;
        }
        finally {
            request.signal?.removeEventListener("abort", disconnectBlockingRead);
            if (blockingClient !== undefined) {
                this.activeBlockingClients.delete(blockingClient);
                await this.closeClient(blockingClient);
            }
            this.activeReads -= 1;
            if (this.activeReads === 0) {
                for (const resolve of this.readWaiters.splice(0))
                    resolve();
            }
        }
    }
    async close() {
        this.closed = true;
        await Promise.all([...this.activeBlockingClients].map(async (client) => {
            if (client.isOpen)
                await Promise.resolve(client.disconnect()).catch(() => undefined);
        }));
        await this.waitForActiveReads();
        const clients = [...new Set([this.client, ...this.activeBlockingClients])];
        this.activeBlockingClients.clear();
        this.client = undefined;
        await Promise.all(clients.map((client) => this.closeClient(client)));
    }
    assertOpen() {
        if (this.closed)
            throw new Error("Run event bus is closed");
    }
    async connectedBlockingClient(sourceClient) {
        const blockingClient = sourceClient.duplicate();
        if (!blockingClient.isOpen) {
            await blockingClient.connect();
        }
        return blockingClient;
    }
    async connectedClient() {
        this.assertOpen();
        this.client ??= this.createRedisClient({ url: this.redisUrl });
        if (!this.client.isOpen) {
            await this.client.connect();
        }
        return this.client;
    }
    waitForActiveReads() {
        if (this.activeReads === 0)
            return Promise.resolve();
        return new Promise((resolve) => {
            this.readWaiters.push(resolve);
        });
    }
    async closeClient(client) {
        if (client === undefined || !client.isOpen) {
            return;
        }
        await Promise.resolve(client.quit()).catch(async () => {
            if (client.isOpen)
                await client.disconnect();
        });
    }
}
function parseReadResult(result, request) {
    if (!Array.isArray(result)) {
        return [];
    }
    const events = [];
    for (const stream of result) {
        if (!isObject(stream) || !Array.isArray(stream.messages)) {
            continue;
        }
        for (const message of stream.messages) {
            if (!isObject(message) || !isObject(message.message)) {
                continue;
            }
            const event = parseRunEvent(message.message.event);
            if (event === undefined || event.seq <= request.afterSeq) {
                continue;
            }
            events.push(event);
        }
    }
    return events;
}
function parseRunEvent(value) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (typeof text !== "string") {
        return undefined;
    }
    try {
        const parsed = JSON.parse(text);
        if (!isRuntimeRunEventRecord(parsed)) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
function isRuntimeRunEventRecord(value) {
    return (isObject(value) &&
        typeof value.eventId === "number" &&
        typeof value.runId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.clientId === "string" &&
        typeof value.seq === "number" &&
        typeof value.type === "string" &&
        isObject(value.payload) &&
        typeof value.createdAt === "string");
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=run-event-bus.js.map