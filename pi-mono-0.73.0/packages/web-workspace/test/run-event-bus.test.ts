import { describe, expect, it } from "vitest";
import {
	InMemoryRunEventBus,
	RedisRunEventBus,
	runEventStreamKey,
	type LiveRunEvent,
} from "../src/run-event-bus.js";

const identity = {
	clientId: "client-a",
	sessionId: "session-a",
	runId: "run-a",
};

function event(seq: number, type = "message"): LiveRunEvent {
	return {
		eventId: seq,
		...identity,
		seq,
		type,
		payload: { text: `event ${seq}` },
		createdAt: `2026-06-29T00:00:0${seq}.000Z`,
	};
}

describe("runEventStreamKey", () => {
	it("builds the Redis stream key from the full run identity", () => {
		expect(runEventStreamKey(identity)).toBe("pi:runs:client-a:session-a:run-a:events");
	});
});

describe("InMemoryRunEventBus", () => {
	it("only reads events with a sequence greater than afterSeq", async () => {
		const bus = new InMemoryRunEventBus();
		await bus.publish(event(1));
		await bus.publish(event(2));
		await bus.publish(event(3));

		await expect(bus.read({ ...identity, afterSeq: 1 })).resolves.toEqual([event(2), event(3)]);
		await expect(bus.read({ ...identity, afterSeq: 3 })).resolves.toEqual([]);
	});
});

describe("RedisRunEventBus", () => {
	it("publishes events to Redis Streams with event JSON, approximate trim, and TTL", async () => {
		const client = new FakeRedisClient();
		const bus = new RedisRunEventBus({
			redisUrl: "redis://example",
			maxLen: 10,
			ttlSeconds: 60,
			createClient: () => client,
		});

		await bus.publish(event(4));

		expect(client.xAddCalls).toEqual([
			{
				key: "pi:runs:client-a:session-a:run-a:events",
				id: "4-0",
				message: { event: JSON.stringify(event(4)) },
				options: { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10 } },
			},
		]);
		expect(client.expireCalls).toEqual([{ key: "pi:runs:client-a:session-a:run-a:events", seconds: 60 }]);
	});

	it("reads Redis stream events after afterSeq and skips malformed event entries", async () => {
		const client = new FakeRedisClient();
		client.xReadResults.push([
			{
				name: "pi:runs:client-a:session-a:run-a:events",
				messages: [
					{ id: "1-0", message: { event: JSON.stringify(event(1)) } },
					{ id: "2-0", message: { event: "{bad json" } },
					{ id: "3-0", message: { event: JSON.stringify(event(3)) } },
				],
			},
		]);
		const bus = new RedisRunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});

		await expect(bus.read({ ...identity, afterSeq: 1 })).resolves.toEqual([event(3)]);
		expect(client.xReadCalls).toEqual([
			{
				streams: { key: "pi:runs:client-a:session-a:run-a:events", id: "1-0" },
				options: { BLOCK: 250, COUNT: 100 },
			},
		]);
	});

	it("uses the requested Redis blocking read duration", async () => {
		const client = new FakeRedisClient();
		const bus = new RedisRunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});

		await expect(bus.read({ ...identity, afterSeq: 2, blockMs: 15_000 })).resolves.toEqual([]);

		expect(client.xReadCalls).toEqual([
			{
				streams: { key: "pi:runs:client-a:session-a:run-a:events", id: "2-0" },
				options: { BLOCK: 15_000, COUNT: 100 },
			},
		]);
	});

	it("returns immediately when read is already aborted", async () => {
		const client = new FakeRedisClient();
		const bus = new RedisRunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});
		const controller = new AbortController();
		controller.abort();

		await expect(bus.read({ ...identity, afterSeq: 0, signal: controller.signal })).resolves.toEqual([]);
		expect(client.xReadCalls).toEqual([]);
	});

	it("isolates concurrent blocking reads so aborting one read does not disconnect another", async () => {
		const client = new FakeRedisClient();
		const firstRead = deferred<unknown>();
		const secondRead = deferred<unknown>();
		client.xReadResults.push(firstRead.promise, secondRead.promise);
		const bus = new RedisRunEventBus({
			redisUrl: "redis://example",
			createClient: () => client,
		});
		const firstController = new AbortController();

		const first = bus.read({ ...identity, afterSeq: 0, signal: firstController.signal });
		const second = bus.read({ ...identity, afterSeq: 1 });
		first.catch(() => undefined);
		second.catch(() => undefined);
		await waitUntil(() => client.xReadCalls.length === 2);

		firstController.abort();
		await waitUntil(() => client.duplicates.some((duplicate) => !duplicate.isOpen));

		expect(client.duplicates).toHaveLength(2);
		expect(client.duplicates.filter((duplicate) => duplicate.isOpen)).toHaveLength(1);

		const redisEventResult = [
			{
				name: "pi:runs:client-a:session-a:run-a:events",
				messages: [{ id: "2-0", message: { event: JSON.stringify(event(2)) } }],
			},
		];
		firstRead.resolve(redisEventResult);
		secondRead.resolve(redisEventResult);

		await expect(first).resolves.toEqual([]);
		await expect(second).resolves.toEqual([event(2)]);
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

	private disconnectPromise(): Promise<never> {
		if (!this.isOpen) return Promise.reject(new Error("Redis client disconnected"));
		return new Promise((_, reject) => {
			this.disconnectWaiters.push(() => reject(new Error("Redis client disconnected")));
		});
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out waiting for predicate. Last check: ${predicate()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
