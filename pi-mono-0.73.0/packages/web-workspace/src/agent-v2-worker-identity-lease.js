import { randomUUID } from "node:crypto";
import { createClient } from "redis";
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const TAKEOVER_SCRIPT = `
-- agent-v2-worker-identity-takeover
local previous = redis.call("GET", KEYS[1])
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
if previous and previous ~= ARGV[1] then return 1 end
return 0
`;
const RENEW_SCRIPT = `
-- agent-v2-worker-identity-renew
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1
`;
const RELEASE_SCRIPT = `
-- agent-v2-worker-identity-release
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return 1
`;
export class RedisAgentV2WorkerIdentityLease {
    token;
    key;
    leaseTtlMs;
    commandTimeoutMs;
    client;
    constructor(options) {
        if (!options.redisUrl.trim())
            throw new Error("Agent v2 worker identity lease requires redisUrl");
        if (!options.queueName.trim())
            throw new Error("Agent v2 worker identity lease requires queueName");
        if (!options.workerId.trim())
            throw new Error("Agent v2 worker identity lease requires workerId");
        this.leaseTtlMs = positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
        this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
        this.token = options.token?.trim() || randomUUID();
        this.key = workerIdentityLeaseKey(options.queueName, options.workerId);
        this.client = options.clientFactory?.() ?? createLeaseClient(options.redisUrl);
    }
    async acquire() {
        await this.ensureConnected();
        const result = await this.command(this.client.eval(TAKEOVER_SCRIPT, {
            keys: [this.key],
            arguments: [this.token, String(this.leaseTtlMs)],
        }), "agent_v2.worker_identity_takeover_failed");
        return { replacedExistingOwner: Number(result) === 1 };
    }
    async renew() {
        await this.ensureConnected();
        const result = await this.command(this.client.eval(RENEW_SCRIPT, {
            keys: [this.key],
            arguments: [this.token, String(this.leaseTtlMs)],
        }), "agent_v2.worker_identity_renew_failed");
        return Number(result) === 1;
    }
    async release() {
        if (this.client.isOpen === false)
            return false;
        const result = await this.command(this.client.eval(RELEASE_SCRIPT, { keys: [this.key], arguments: [this.token] }), "agent_v2.worker_identity_release_failed");
        return Number(result) === 1;
    }
    async close() {
        if (this.client.isOpen === false)
            return;
        try {
            await this.command(this.client.quit(), "agent_v2.worker_identity_close_failed");
        }
        catch (error) {
            this.client.disconnect?.();
            throw error;
        }
    }
    async ensureConnected() {
        if (this.client.isOpen === true)
            return;
        await this.command(this.client.connect(), "agent_v2.worker_identity_connect_failed");
    }
    async command(operation, errorCode) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(errorCode)), this.commandTimeoutMs);
            timer.unref?.();
        });
        try {
            return await Promise.race([operation, timeout]);
        }
        catch {
            throw new Error(errorCode);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
}
export function workerIdentityLeaseKey(queueName, workerId) {
    const identity = Buffer.from(JSON.stringify([queueName, workerId]), "utf8").toString("base64url");
    return `pi:agent-v2:worker-identity:${identity}`;
}
function createLeaseClient(redisUrl) {
    const client = createClient({ url: redisUrl });
    client.on("error", () => undefined);
    return client;
}
function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
//# sourceMappingURL=agent-v2-worker-identity-lease.js.map