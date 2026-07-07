import { createClient } from "redis";
import type { RuntimeRunEventRecord } from "./types.js";

const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const DEFAULT_EVENT_STREAM_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_READ_BLOCK_MS = 250;
const DEFAULT_READ_COUNT = 100;

export interface RunEventIdentity {
	clientId: string;
	sessionId: string;
	runId: string;
}

export type LiveRunEvent = RuntimeRunEventRecord;

export interface RunEventReadRequest extends RunEventIdentity {
	afterSeq: number;
	blockMs?: number;
	signal?: AbortSignal;
}

export interface RunEventBus {
	publish(event: LiveRunEvent): Promise<void>;
	read(request: RunEventReadRequest): Promise<RuntimeRunEventRecord[]>;
	deleteSessionEvents?(clientId: string, sessionId: string, runIds: readonly string[]): Promise<number>;
	close(): Promise<void>;
}

export function runEventStreamKey(identity: RunEventIdentity): string {
	return `pi:runs:${identity.clientId}:${identity.sessionId}:${identity.runId}:events`;
}

export class InMemoryRunEventBus implements RunEventBus {
	private closed = false;
	private readonly eventsByStream = new Map<string, RuntimeRunEventRecord[]>();

	async publish(event: LiveRunEvent): Promise<void> {
		this.assertOpen();
		const key = runEventStreamKey(event);
		const events = this.eventsByStream.get(key);
		if (events === undefined) {
			this.eventsByStream.set(key, [event]);
			return;
		}
		events.push(event);
	}

	async read(request: RunEventReadRequest): Promise<RuntimeRunEventRecord[]> {
		this.assertOpen();
		if (request.signal?.aborted) {
			return [];
		}

		const events = this.eventsByStream.get(runEventStreamKey(request)) ?? [];
		return events.filter((event) => event.seq > request.afterSeq);
	}

	async deleteSessionEvents(clientId: string, sessionId: string, runIds: readonly string[]): Promise<number> {
		this.assertOpen();
		let deleted = 0;
		for (const runId of runIds) {
			const key = runEventStreamKey({ clientId, sessionId, runId });
			if (this.eventsByStream.delete(key)) deleted += 1;
		}
		return deleted;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.eventsByStream.clear();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Run event bus is closed");
	}
}

export interface RedisRunEventBusOptions {
	redisUrl: string;
	maxLen?: number;
	ttlSeconds?: number;
	createClient?: (options: { url: string }) => RedisRunEventBusClient;
}

export interface RedisRunEventBusClient {
	readonly isOpen: boolean;
	connect(): Promise<unknown>;
	disconnect(): Promise<unknown> | unknown;
	duplicate(): RedisRunEventBusClient;
	del(key: string): Promise<number> | number;
	expire(key: string, seconds: number): Promise<unknown>;
	quit(): Promise<unknown> | unknown;
	xAdd(key: string, id: string, message: Record<string, string>, options?: unknown): Promise<unknown>;
	xRead(streams: unknown, options?: unknown): Promise<unknown>;
}

export class RedisRunEventBus implements RunEventBus {
	private activeReads = 0;
	private readonly activeBlockingClients = new Set<RedisRunEventBusClient>();
	private client?: RedisRunEventBusClient;
	private closed = false;
	private readonly createRedisClient: (options: { url: string }) => RedisRunEventBusClient;
	private readonly maxLen: number;
	private readonly readWaiters: Array<() => void> = [];
	private readonly redisUrl: string;
	private readonly ttlRefreshIntervalMs: number;
	private readonly ttlRefreshedAtByStream = new Map<string, number>();
	private readonly ttlSeconds: number;

	constructor(options: RedisRunEventBusOptions) {
		this.redisUrl = options.redisUrl;
		this.maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
		this.ttlSeconds = options.ttlSeconds ?? DEFAULT_EVENT_STREAM_TTL_SECONDS;
		this.ttlRefreshIntervalMs = Math.max(1_000, Math.floor(this.ttlSeconds * 500));
		this.createRedisClient =
			options.createClient ??
			((clientOptions) => createClient({ url: clientOptions.url }) as RedisRunEventBusClient);
	}

	async publish(event: LiveRunEvent): Promise<void> {
		this.assertOpen();
		const client = await this.connectedClient();
		const key = runEventStreamKey(event);
		await client.xAdd(
			key,
			`${event.seq}-0`,
			{ event: JSON.stringify(event) },
			{
				TRIM: {
					strategy: "MAXLEN",
					strategyModifier: "~",
					threshold: this.maxLen,
				},
			},
		);
		await this.refreshTtlIfDue(client, key);
	}

	async read(request: RunEventReadRequest): Promise<RuntimeRunEventRecord[]> {
		this.assertOpen();
		if (request.signal?.aborted) {
			return [];
		}

		this.activeReads += 1;
		let blockingClient: RedisRunEventBusClient | undefined;
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

			const result = await blockingClient.xRead(
				{ key: runEventStreamKey(request), id: `${request.afterSeq}-0` },
				{ BLOCK: request.blockMs ?? DEFAULT_READ_BLOCK_MS, COUNT: DEFAULT_READ_COUNT },
			);
			if (this.closed || request.signal?.aborted) {
				return [];
			}

			return parseReadResult(result, request);
		} catch (error) {
			if (this.closed || request.signal?.aborted) {
				return [];
			}
			throw error;
		} finally {
			request.signal?.removeEventListener("abort", disconnectBlockingRead);
			if (blockingClient !== undefined) {
				this.activeBlockingClients.delete(blockingClient);
				await this.closeClient(blockingClient);
			}
			this.activeReads -= 1;
			if (this.activeReads === 0) {
				for (const resolve of this.readWaiters.splice(0)) resolve();
			}
		}
	}

	async deleteSessionEvents(clientId: string, sessionId: string, runIds: readonly string[]): Promise<number> {
		this.assertOpen();
		if (runIds.length === 0) return 0;
		const client = await this.connectedClient();
		let deleted = 0;
		for (const runId of runIds) {
			deleted += await Promise.resolve(client.del(runEventStreamKey({ clientId, sessionId, runId })));
		}
		return deleted;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all(
			[...this.activeBlockingClients].map(async (client) => {
				if (client.isOpen) await Promise.resolve(client.disconnect()).catch(() => undefined);
			}),
		);
		await this.waitForActiveReads();
		const clients = [...new Set([this.client, ...this.activeBlockingClients])];
		this.activeBlockingClients.clear();
		this.ttlRefreshedAtByStream.clear();
		this.client = undefined;

		await Promise.all(clients.map((client) => this.closeClient(client)));
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Run event bus is closed");
	}

	private async connectedBlockingClient(sourceClient: RedisRunEventBusClient): Promise<RedisRunEventBusClient> {
		const blockingClient = sourceClient.duplicate();
		if (!blockingClient.isOpen) {
			await blockingClient.connect();
		}

		return blockingClient;
	}

	private async connectedClient(): Promise<RedisRunEventBusClient> {
		this.assertOpen();
		this.client ??= this.createRedisClient({ url: this.redisUrl });
		if (!this.client.isOpen) {
			await this.client.connect();
		}

		return this.client;
	}

	private async refreshTtlIfDue(client: RedisRunEventBusClient, key: string): Promise<void> {
		const now = Date.now();
		const refreshedAt = this.ttlRefreshedAtByStream.get(key);
		if (refreshedAt !== undefined && now - refreshedAt < this.ttlRefreshIntervalMs) {
			return;
		}
		await client.expire(key, this.ttlSeconds);
		this.ttlRefreshedAtByStream.set(key, now);
	}

	private waitForActiveReads(): Promise<void> {
		if (this.activeReads === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.readWaiters.push(resolve);
		});
	}

	private async closeClient(client: RedisRunEventBusClient | undefined): Promise<void> {
		if (client === undefined || !client.isOpen) {
			return;
		}

		await Promise.resolve(client.quit()).catch(async () => {
			if (client.isOpen) await client.disconnect();
		});
	}
}

function parseReadResult(result: unknown, request: RunEventReadRequest): RuntimeRunEventRecord[] {
	if (!Array.isArray(result)) {
		return [];
	}

	const events: RuntimeRunEventRecord[] = [];
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

function parseRunEvent(value: unknown): RuntimeRunEventRecord | undefined {
	const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
	if (typeof text !== "string") {
		return undefined;
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRuntimeRunEventRecord(parsed)) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

function isRuntimeRunEventRecord(value: unknown): value is RuntimeRunEventRecord {
	return (
		isObject(value) &&
		typeof value.eventId === "number" &&
		typeof value.runId === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.clientId === "string" &&
		typeof value.seq === "number" &&
		typeof value.type === "string" &&
		isObject(value.payload) &&
		typeof value.createdAt === "string"
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
