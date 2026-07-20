import { describe, expect, it } from "vitest";
import {
	RedisAgentV2WorkerIdentityLease,
	type RedisAgentV2WorkerIdentityLeaseClient,
} from "../src/agent-v2-worker-identity-lease.js";

class MemoryLeaseClient implements RedisAgentV2WorkerIdentityLeaseClient {
	isOpen = false;
	constructor(private readonly values: Map<string, string>) {}
	async connect(): Promise<void> {
		this.isOpen = true;
	}
	async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
		const key = options.keys[0]!;
		const token = options.arguments[0]!;
		if (script.includes("identity-takeover")) {
			const replaced = this.values.has(key) && this.values.get(key) !== token;
			this.values.set(key, token);
			return replaced ? 1 : 0;
		}
		if (script.includes("identity-renew")) return this.values.get(key) === token ? 1 : 0;
		if (script.includes("identity-release")) {
			if (this.values.get(key) !== token) return 0;
			this.values.delete(key);
			return 1;
		}
		throw new Error("unexpected script");
	}
	async quit(): Promise<void> {
		this.isOpen = false;
	}
}

describe("RedisAgentV2WorkerIdentityLease", () => {
	it("lets the newer process replace the old owner without allowing the old owner to release the new lease", async () => {
		const values = new Map<string, string>();
		const first = new RedisAgentV2WorkerIdentityLease({
			redisUrl: "redis://test",
			queueName: "queue-a",
			workerId: "worker-a",
			token: "first",
			clientFactory: () => new MemoryLeaseClient(values),
		});
		const second = new RedisAgentV2WorkerIdentityLease({
			redisUrl: "redis://test",
			queueName: "queue-a",
			workerId: "worker-a",
			token: "second",
			clientFactory: () => new MemoryLeaseClient(values),
		});

		await expect(first.acquire()).resolves.toEqual({ replacedExistingOwner: false });
		await expect(first.renew()).resolves.toBe(true);
		await expect(second.acquire()).resolves.toEqual({ replacedExistingOwner: true });
		await expect(first.renew()).resolves.toBe(false);
		await expect(first.release()).resolves.toBe(false);
		await expect(second.renew()).resolves.toBe(true);
		await expect(second.release()).resolves.toBe(true);
	});

	it("scopes ownership by both queue name and worker id", async () => {
		const values = new Map<string, string>();
		const makeLease = (queueName: string, workerId: string, token: string) =>
			new RedisAgentV2WorkerIdentityLease({
				redisUrl: "redis://test",
				queueName,
				workerId,
				token,
				clientFactory: () => new MemoryLeaseClient(values),
			});

		await expect(makeLease("queue-a", "worker-a", "one").acquire()).resolves.toEqual({
			replacedExistingOwner: false,
		});
		await expect(makeLease("queue-b", "worker-a", "two").acquire()).resolves.toEqual({
			replacedExistingOwner: false,
		});
		await expect(makeLease("queue-a", "worker-b", "three").acquire()).resolves.toEqual({
			replacedExistingOwner: false,
		});
	});
});
