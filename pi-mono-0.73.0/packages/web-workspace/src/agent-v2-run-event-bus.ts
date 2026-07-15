import { createClient } from "redis";
import type {
	AgentV2LiveRunEvent,
	AgentV2RunEventIdentity,
	AgentV2RunEventReadRequest,
} from "./agent-v2-run-events.js";

const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const DEFAULT_EVENT_STREAM_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_READ_BLOCK_MS = 250;
const DEFAULT_READ_COUNT = 100;

const PROJECT_EVENT_SCRIPT = `
-- agent-v2-project-live-event
local existing = redis.call("XRANGE", KEYS[1], ARGV[1], ARGV[1], "COUNT", 1)
if #existing > 0 then
	local fields = existing[1][2]
	for index = 1, #fields, 2 do
		if fields[index] == "event" then
			if fields[index + 1] == ARGV[2] then return 0 end
			return -1
		end
	end
	return -1
end
local latest = redis.call("XREVRANGE", KEYS[1], "+", "-", "COUNT", 1)
if #latest > 0 then
	local separator = string.find(latest[1][1], "-")
	local latestSeq = separator and tonumber(string.sub(latest[1][1], 1, separator - 1)) or nil
	local requestedSeq = tonumber(ARGV[4])
	if latestSeq and requestedSeq and requestedSeq < latestSeq then return 0 end
end
redis.call("XADD", KEYS[1], "MAXLEN", "~", ARGV[3], ARGV[1], "event", ARGV[2])
return 1
`;

export class AgentV2RunEventProjectionConflictError extends Error {
	readonly code = "agent_v2.live_projection_conflict";

	constructor() {
		super("Agent v2 live event projection conflicts with the canonical sequence");
		this.name = "AgentV2RunEventProjectionConflictError";
	}
}

export interface AgentV2RunEventBus {
	project(event: AgentV2LiveRunEvent): Promise<"projected" | "already_projected">;
	read(request: AgentV2RunEventReadRequest): Promise<AgentV2LiveRunEvent[]>;
	purge(options?: AgentV2RunEventBusPurgeOptions): Promise<AgentV2RunEventBusPurgeResult>;
	close(): Promise<void>;
}

export interface AgentV2RunEventBusPurgeOptions {
	clientId?: string;
	runId?: string;
}

export interface AgentV2RunEventBusPurgeResult {
	streamsDeleted: number;
}

export function agentV2RunEventStreamKey(identity: AgentV2RunEventIdentity): string {
	return `pi:agent-v2:runs:${identity.clientId}:${identity.runId}:events`;
}

export class InMemoryAgentV2RunEventBus implements AgentV2RunEventBus {
	private closed = false;
	private readonly eventsByStream = new Map<string, AgentV2LiveRunEvent[]>();

	async project(event: AgentV2LiveRunEvent): Promise<"projected" | "already_projected"> {
		this.assertOpen();
		const key = agentV2RunEventStreamKey(event);
		const events = this.eventsByStream.get(key);
		if (events === undefined) {
			this.eventsByStream.set(key, [event]);
			return "projected";
		}
		const existing = events.find((candidate) => candidate.seq === event.seq);
		if (existing) {
			if (JSON.stringify(existing) === JSON.stringify(event)) return "already_projected";
			throw new AgentV2RunEventProjectionConflictError();
		}
		if (events.some((candidate) => candidate.seq > event.seq)) return "already_projected";
		events.push(event);
		events.sort((left, right) => left.seq - right.seq);
		return "projected";
	}

	async read(request: AgentV2RunEventReadRequest): Promise<AgentV2LiveRunEvent[]> {
		this.assertOpen();
		if (request.signal?.aborted) {
			return [];
		}
		const events = this.eventsByStream.get(agentV2RunEventStreamKey(request)) ?? [];
		return events.filter((event) => event.seq > request.afterSeq);
	}

	async purge(options: AgentV2RunEventBusPurgeOptions = {}): Promise<AgentV2RunEventBusPurgeResult> {
		this.assertOpen();
		if (options.clientId && options.runId) {
			const deleted = this.eventsByStream.delete(
				agentV2RunEventStreamKey({ clientId: options.clientId, runId: options.runId }),
			);
			return { streamsDeleted: deleted ? 1 : 0 };
		}
		const keys = [...this.eventsByStream.keys()].filter((key) => {
			if (!options.clientId) return true;
			return key.startsWith(`pi:agent-v2:runs:${options.clientId}:`) && key.endsWith(":events");
		});
		for (const key of keys) {
			this.eventsByStream.delete(key);
		}
		return { streamsDeleted: keys.length };
	}

	async close(): Promise<void> {
		this.closed = true;
		this.eventsByStream.clear();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Agent v2 run event bus is closed");
	}
}

export interface RedisAgentV2RunEventBusOptions {
	redisUrl: string;
	maxLen?: number;
	ttlSeconds?: number;
	createClient?: (options: { url: string }) => RedisAgentV2RunEventBusClient;
}

export interface RedisAgentV2RunEventBusClient {
	readonly isOpen: boolean;
	connect(): Promise<unknown>;
	disconnect(): Promise<unknown> | unknown;
	duplicate(): RedisAgentV2RunEventBusClient;
	del(keys: string | string[]): Promise<number>;
	expire(key: string, seconds: number): Promise<unknown>;
	quit(): Promise<unknown> | unknown;
	scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<unknown>;
	xAdd(key: string, id: string, message: Record<string, string>, options?: unknown): Promise<unknown>;
	xRead(streams: unknown, options?: unknown): Promise<unknown>;
	eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class RedisAgentV2RunEventBus implements AgentV2RunEventBus {
	private activeReads = 0;
	private readonly activeBlockingClients = new Set<RedisAgentV2RunEventBusClient>();
	private client?: RedisAgentV2RunEventBusClient;
	private closed = false;
	private readonly createRedisClient: (options: { url: string }) => RedisAgentV2RunEventBusClient;
	private readonly maxLen: number;
	private readonly readWaiters: Array<() => void> = [];
	private readonly redisUrl: string;
	private readonly ttlRefreshIntervalMs: number;
	private readonly ttlRefreshedAtByStream = new Map<string, number>();
	private readonly ttlSeconds: number;

	constructor(options: RedisAgentV2RunEventBusOptions) {
		this.redisUrl = options.redisUrl;
		this.maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
		this.ttlSeconds = options.ttlSeconds ?? DEFAULT_EVENT_STREAM_TTL_SECONDS;
		this.ttlRefreshIntervalMs = Math.max(1_000, Math.floor(this.ttlSeconds * 500));
		this.createRedisClient =
			options.createClient ??
			((clientOptions) => createClient({ url: clientOptions.url }) as RedisAgentV2RunEventBusClient);
	}

	async project(event: AgentV2LiveRunEvent): Promise<"projected" | "already_projected"> {
		this.assertOpen();
		const client = await this.connectedClient();
		const key = agentV2RunEventStreamKey(event);
		const projected = Number(
			await client.eval(PROJECT_EVENT_SCRIPT, {
				keys: [key],
				arguments: [`${event.seq}-0`, JSON.stringify(event), String(this.maxLen), String(event.seq)],
			}),
		);
		if (projected < 0) throw new AgentV2RunEventProjectionConflictError();
		await this.refreshTtlIfDue(client, key);
		return projected === 0 ? "already_projected" : "projected";
	}

	async read(request: AgentV2RunEventReadRequest): Promise<AgentV2LiveRunEvent[]> {
		this.assertOpen();
		if (request.signal?.aborted) {
			return [];
		}

		this.activeReads += 1;
		let blockingClient: RedisAgentV2RunEventBusClient | undefined;
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
				{ key: agentV2RunEventStreamKey(request), id: `${request.afterSeq}-0` },
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

	async purge(options: AgentV2RunEventBusPurgeOptions = {}): Promise<AgentV2RunEventBusPurgeResult> {
		this.assertOpen();
		if (options.clientId && options.runId) {
			return this.deleteStreams([agentV2RunEventStreamKey({ clientId: options.clientId, runId: options.runId })]);
		}

		const pattern = options.clientId ? `pi:agent-v2:runs:${options.clientId}:*:events` : "pi:agent-v2:runs:*:events";
		const client = await this.connectedClient();
		const keys: string[] = [];
		for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
			keys.push(String(key));
		}
		return this.deleteStreams(keys);
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
		if (this.closed) throw new Error("Agent v2 run event bus is closed");
	}

	private async connectedBlockingClient(
		sourceClient: RedisAgentV2RunEventBusClient,
	): Promise<RedisAgentV2RunEventBusClient> {
		const blockingClient = sourceClient.duplicate();
		if (!blockingClient.isOpen) {
			await blockingClient.connect();
		}
		return blockingClient;
	}

	private async deleteStreams(keys: readonly string[]): Promise<AgentV2RunEventBusPurgeResult> {
		if (keys.length === 0) {
			return { streamsDeleted: 0 };
		}
		const client = await this.connectedClient();
		const counts = await Promise.all(chunk(keys, 100).map((batch) => client.del(batch)));
		return { streamsDeleted: counts.reduce((total, count) => total + count, 0) };
	}

	private async connectedClient(): Promise<RedisAgentV2RunEventBusClient> {
		this.assertOpen();
		this.client ??= this.createRedisClient({ url: this.redisUrl });
		if (!this.client.isOpen) {
			await this.client.connect();
		}
		return this.client;
	}

	private async refreshTtlIfDue(client: RedisAgentV2RunEventBusClient, key: string): Promise<void> {
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

	private async closeClient(client: RedisAgentV2RunEventBusClient | undefined): Promise<void> {
		if (client === undefined || !client.isOpen) {
			return;
		}
		await Promise.resolve(client.quit()).catch(async () => {
			if (client.isOpen) await client.disconnect();
		});
	}
}

function parseReadResult(result: unknown, request: AgentV2RunEventReadRequest): AgentV2LiveRunEvent[] {
	if (!Array.isArray(result)) {
		return [];
	}

	const events: AgentV2LiveRunEvent[] = [];
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

function parseRunEvent(value: unknown): AgentV2LiveRunEvent | undefined {
	const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
	if (typeof text !== "string") {
		return undefined;
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isAgentV2LiveRunEvent(parsed)) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

function isAgentV2LiveRunEvent(value: unknown): value is AgentV2LiveRunEvent {
	return (
		isObject(value) &&
		typeof value.clientId === "string" &&
		typeof value.runId === "string" &&
		typeof value.seq === "number" &&
		typeof value.type === "string" &&
		isObject(value.payload) &&
		typeof value.createdAt === "string"
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}
