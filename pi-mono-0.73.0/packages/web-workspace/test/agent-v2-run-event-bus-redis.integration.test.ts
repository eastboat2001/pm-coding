import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { agentV2RunEventStreamKey, RedisAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("RedisAgentV2RunEventBus projection integration", () => {
	it("projects an explicit durable sequence idempotently and rejects conflicting payload", async () => {
		const identity = { clientId: `client-${randomUUID()}`, runId: `run-${randomUUID()}` };
		const bus = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, maxLen: 100, ttlSeconds: 60 });
		const event = {
			...identity,
			seq: 4,
			type: "agent_v2.phase_changed",
			payload: { phase: "implementation" },
			createdAt: "2026-07-15T00:00:00.000Z",
		};
		try {
			await expect(bus.project(event)).resolves.toBe("projected");
			await expect(bus.project(event)).resolves.toBe("already_projected");
			await expect(bus.project({ ...event, payload: { phase: "validation" } })).rejects.toMatchObject({
				name: "AgentV2RunEventProjectionConflictError",
				code: "agent_v2.live_projection_conflict",
			});
			await expect(bus.read({ ...identity, afterSeq: 3, blockMs: 1 })).resolves.toEqual([event]);
			expect(agentV2RunEventStreamKey(identity)).toContain(":events");
		} finally {
			await bus.purge(identity);
			await bus.close();
		}
	});

	it("treats a lower sequence retry as safely superseded after a later event projected", async () => {
		const identity = { clientId: `client-${randomUUID()}`, runId: `run-${randomUUID()}` };
		const unavailable = new RedisAgentV2RunEventBus({
			redisUrl: "redis://127.0.0.1:1",
			createClient: () =>
				createClient({ url: "redis://127.0.0.1:1", socket: { reconnectStrategy: false } }) as never,
		});
		const healthy = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, ttlSeconds: 60 });
		const first = { ...identity, seq: 1, type: "first", payload: { seq: 1 }, createdAt: "2026-07-15T00:00:00.000Z" };
		const second = {
			...identity,
			seq: 2,
			type: "second",
			payload: { seq: 2 },
			createdAt: "2026-07-15T00:00:01.000Z",
		};
		try {
			await expect(unavailable.project(first)).rejects.toBeDefined();
			await expect(healthy.project(second)).resolves.toBe("projected");
			await expect(healthy.project(first)).resolves.toBe("already_projected");
			await expect(healthy.read({ ...identity, afterSeq: 0, blockMs: 1 })).resolves.toEqual([second]);
		} finally {
			await unavailable.close();
			await healthy.purge(identity);
			await healthy.close();
		}
	});

	it("treats a retained-stream low sequence replay as safely superseded after trimming", async () => {
		const identity = { clientId: `client-${randomUUID()}`, runId: `run-${randomUUID()}` };
		const bus = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, ttlSeconds: 60 });
		const inspection = createClient({ url: redisUrl! });
		const first = { ...identity, seq: 1, type: "first", payload: { seq: 1 }, createdAt: "2026-07-15T00:00:00.000Z" };
		const second = {
			...identity,
			seq: 2,
			type: "second",
			payload: { seq: 2 },
			createdAt: "2026-07-15T00:00:01.000Z",
		};
		await inspection.connect();
		try {
			await bus.project(first);
			await bus.project(second);
			await inspection.sendCommand(["XTRIM", agentV2RunEventStreamKey(identity), "MINID", "2-0"]);
			await expect(bus.project(first)).resolves.toBe("already_projected");
			await expect(bus.project({ ...second, payload: { conflicting: true } })).rejects.toMatchObject({
				code: "agent_v2.live_projection_conflict",
			});
		} finally {
			await inspection.quit();
			await bus.purge(identity);
			await bus.close();
		}
	});
});
