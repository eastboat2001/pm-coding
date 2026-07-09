import { describe, expect, it } from "vitest";
import {
	agentV2RunEventStreamKey,
	InMemoryAgentV2RunEventBus,
	RedisAgentV2RunEventBus,
} from "../src/agent-v2-run-event-bus.js";
import type { AgentV2LiveRunEvent } from "../src/agent-v2-run-events.js";

const identity = {
	clientId: "client-a",
	runId: "run-a",
};

function event(seq: number, type = "agent_v2.phase_changed"): AgentV2LiveRunEvent {
	return {
		...identity,
		seq,
		type,
		payload: { seq, type },
		createdAt: `2026-07-08T00:00:0${seq}.000Z`,
	};
}

describe("agentV2RunEventStreamKey", () => {
	it("builds the v2 Redis stream key without legacy session identity", () => {
		expect(agentV2RunEventStreamKey(identity)).toBe("pi:agent-v2:runs:client-a:run-a:events");
	});
});

describe("InMemoryAgentV2RunEventBus", () => {
	it("only reads events with a sequence greater than afterSeq", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		await bus.publish(event(1));
		await bus.publish(event(2));
		await bus.publish(event(3));

		await expect(bus.read({ ...identity, afterSeq: 1 })).resolves.toEqual([event(2), event(3)]);
		await expect(bus.read({ ...identity, afterSeq: 3 })).resolves.toEqual([]);
	});

	it("refuses future reads and writes after close", async () => {
		const bus = new InMemoryAgentV2RunEventBus();

		await bus.publish(event(1));
		await bus.close();

		await expect(bus.publish(event(2))).rejects.toThrow("Agent v2 run event bus is closed");
		await expect(bus.read({ ...identity, afterSeq: 0 })).rejects.toThrow("Agent v2 run event bus is closed");
		await expect(bus.purge({ clientId: "client-a" })).rejects.toThrow("Agent v2 run event bus is closed");
	});

	it("purges streams by client id", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		await bus.publish(event(1));
		await bus.publish({ ...event(2), runId: "run-b" });
		await bus.publish({ ...event(3), clientId: "client-b", runId: "run-c" });

		await expect(bus.purge({ clientId: "client-a" })).resolves.toEqual({ streamsDeleted: 2 });
		await expect(bus.read({ ...identity, afterSeq: 0 })).resolves.toEqual([]);
		await expect(bus.read({ clientId: "client-a", runId: "run-b", afterSeq: 0 })).resolves.toEqual([]);
		await expect(bus.read({ clientId: "client-b", runId: "run-c", afterSeq: 0 })).resolves.toEqual([
			{ ...event(3), clientId: "client-b", runId: "run-c" },
		]);
	});
});

describe("RedisAgentV2RunEventBus", () => {
	it("publishes and reads via the v2 Redis stream key", async () => {
		const client = new FakeRedisClient();
		const bus = new RedisAgentV2RunEventBus({
			redisUrl: "redis://example",
			maxLen: 10,
			ttlSeconds: 60,
			createClient: () => client,
		});

		await bus.publish(event(4));
		client.xReadResults.push([
			{
				name: "pi:agent-v2:runs:client-a:run-a:events",
				messages: [{ id: "4-0", message: { event: JSON.stringify(event(4)) } }],
			},
		]);

		await expect(bus.read({ ...identity, afterSeq: 3 })).resolves.toEqual([event(4)]);
		expect(client.xAddCalls).toEqual([
			{
				key: "pi:agent-v2:runs:client-a:run-a:events",
				id: "4-0",
				message: { event: JSON.stringify(event(4)) },
				options: { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10 } },
			},
		]);
		expect(client.xReadCalls).toEqual([
			{
				streams: { key: "pi:agent-v2:runs:client-a:run-a:events", id: "3-0" },
				options: { BLOCK: 250, COUNT: 100 },
			},
		]);
	});

	it("refuses future reads and writes after close", async () => {
		const bus = new RedisAgentV2RunEventBus({
			redisUrl: "redis://example",
			createClient: () => new FakeRedisClient(),
		});

		await bus.close();

		await expect(bus.publish(event(1))).rejects.toThrow("Agent v2 run event bus is closed");
		await expect(bus.read({ ...identity, afterSeq: 0 })).rejects.toThrow("Agent v2 run event bus is closed");
		await expect(bus.purge({ clientId: "client-a" })).rejects.toThrow("Agent v2 run event bus is closed");
	});

	it("purges a specific Redis stream without scanning", async () => {
		const client = new FakeRedisClient();
		const bus = new RedisAgentV2RunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});

		await expect(bus.purge({ clientId: "client-a", runId: "run-a" })).resolves.toEqual({ streamsDeleted: 1 });
		expect(client.deletedKeys).toEqual(["pi:agent-v2:runs:client-a:run-a:events"]);
		expect(client.scanPatterns).toEqual([]);
		expect(client.usedKeysCommand).toBe(false);
	});

	it("purges Redis streams by scanning the requested client pattern", async () => {
		const client = new FakeRedisClient();
		client.scanResults.push("pi:agent-v2:runs:client-a:run-a:events", "pi:agent-v2:runs:client-a:run-b:events");
		const bus = new RedisAgentV2RunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});

		await expect(bus.purge({ clientId: "client-a" })).resolves.toEqual({ streamsDeleted: 2 });
		expect(client.scanPatterns).toContain("pi:agent-v2:runs:client-a:*:events");
		expect(client.deletedKeys).toEqual([
			"pi:agent-v2:runs:client-a:run-a:events",
			"pi:agent-v2:runs:client-a:run-b:events",
		]);
		expect(client.usedKeysCommand).toBe(false);
	});
});

interface FakeRedisState {
	readonly expireCalls: Array<{ key: string; seconds: number }>;
	readonly xAddCalls: Array<{
		key: string;
		id: string;
		message: Record<string, string>;
		options: unknown;
	}>;
	readonly xReadCalls: Array<{ streams: unknown; options: unknown }>;
	readonly xReadResults: unknown[];
	readonly deletedKeys: string[];
	readonly scanPatterns: string[];
	readonly scanResults: string[];
	usedKeysCommand: boolean;
}

class FakeRedisClient {
	isOpen = false;
	readonly duplicates: FakeRedisClient[] = [];
	private readonly disconnectWaiters: Array<() => void> = [];

	constructor(
		private readonly state: FakeRedisState = {
			expireCalls: [],
			xAddCalls: [],
			xReadCalls: [],
			xReadResults: [],
			deletedKeys: [],
			scanPatterns: [],
			scanResults: [],
			usedKeysCommand: false,
		},
	) {}

	get expireCalls(): Array<{ key: string; seconds: number }> {
		return this.state.expireCalls;
	}

	get xAddCalls(): Array<{
		key: string;
		id: string;
		message: Record<string, string>;
		options: unknown;
	}> {
		return this.state.xAddCalls;
	}

	get xReadCalls(): Array<{ streams: unknown; options: unknown }> {
		return this.state.xReadCalls;
	}

	get xReadResults(): unknown[] {
		return this.state.xReadResults;
	}

	get deletedKeys(): string[] {
		return this.state.deletedKeys;
	}

	get scanPatterns(): string[] {
		return this.state.scanPatterns;
	}

	get scanResults(): string[] {
		return this.state.scanResults;
	}

	get usedKeysCommand(): boolean {
		return this.state.usedKeysCommand;
	}

	async connect(): Promise<void> {
		this.isOpen = true;
	}

	duplicate(): FakeRedisClient {
		const duplicate = new FakeRedisClient(this.state);
		this.duplicates.push(duplicate);
		return duplicate;
	}

	async disconnect(): Promise<void> {
		this.isOpen = false;
		for (const resolve of this.disconnectWaiters.splice(0)) resolve();
	}

	async quit(): Promise<void> {
		this.isOpen = false;
		for (const resolve of this.disconnectWaiters.splice(0)) resolve();
	}

	async expire(key: string, seconds: number): Promise<void> {
		this.expireCalls.push({ key, seconds });
	}

	async xAdd(key: string, id: string, message: Record<string, string>, options: unknown): Promise<string> {
		this.xAddCalls.push({ key, id, message, options });
		return id;
	}

	async xRead(streams: unknown, options: unknown): Promise<unknown> {
		this.xReadCalls.push({ streams, options });
		const result = this.xReadResults.shift() ?? null;
		return Promise.race([Promise.resolve(result), this.disconnectPromise()]);
	}

	async del(...keysOrBatches: Array<string | string[]>): Promise<number> {
		const keys = keysOrBatches.flat();
		this.deletedKeys.push(...keys);
		return keys.length;
	}

	async *scanIterator(options: { MATCH?: string; COUNT?: number }): AsyncIterable<string> {
		this.scanPatterns.push(options.MATCH ?? "");
		for (const key of this.scanResults) {
			yield key;
		}
	}

	async keys(_pattern: string): Promise<string[]> {
		this.state.usedKeysCommand = true;
		return [];
	}

	private disconnectPromise(): Promise<never> {
		if (!this.isOpen) return Promise.reject(new Error("Redis client disconnected"));
		return new Promise((_, reject) => {
			this.disconnectWaiters.push(() => reject(new Error("Redis client disconnected")));
		});
	}
}
