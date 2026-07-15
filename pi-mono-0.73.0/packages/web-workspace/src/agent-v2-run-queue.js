import { randomUUID } from "node:crypto";
import { createClient } from "redis";
const DEFAULT_CANCEL_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_CLAIM_LEASE_TTL_MS = 30_000;
const DEFAULT_CLAIM_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 1_000;
const CLAIM_POLL_MIN_INTERVAL_MS = 25;
const CLAIM_POLL_MAX_INTERVAL_MS = 250;
const ENQUEUE_SCRIPT = `
-- agent-v2-enqueue
local runKey = ARGV[1]
if redis.call("HEXISTS", KEYS[3], runKey) == 1 then
	return "already_active"
end
if redis.call("SADD", KEYS[2], runKey) == 0 then
	return "already_ready"
end
redis.call("LPUSH", KEYS[1], runKey)
return "enqueued"
`;
const CLAIM_SCRIPT = `
-- agent-v2-claim
local maxScans = tonumber(ARGV[1])
for index = 1, maxScans do
	local runKey = redis.call("RPOP", KEYS[1])
	if not runKey then return false end
	redis.call("SREM", KEYS[2], runKey)
	local ok, identity = pcall(cjson.decode, runKey)
	if ok and type(identity) == "table" and type(identity[1]) == "string" and type(identity[2]) == "string" then
		if redis.call("HEXISTS", KEYS[3], runKey) == 0 then
			local now = tonumber(ARGV[3])
			local claim = {
				clientId = identity[1], runId = identity[2], workerId = ARGV[2],
				claimToken = ARGV[5], claimedAtMs = now, heartbeatAtMs = now,
				leaseExpiresAtMs = now + tonumber(ARGV[4])
			}
			redis.call("HSET", KEYS[3], runKey, cjson.encode(claim))
			return cjson.encode(claim)
		end
	end
end
return false
`;
const RECOVER_CLAIM_BY_TOKEN_SCRIPT = `
-- agent-v2-recover-claim-token
local entries = redis.call("HVALS", KEYS[1])
for _, raw in ipairs(entries) do
	local ok, claim = pcall(cjson.decode, raw)
	if ok and type(claim) == "table" and claim["claimToken"] == ARGV[1] and claim["workerId"] == ARGV[2] then
		return raw
	end
end
return false
`;
const COMPLETE_IF_OWNER_SCRIPT = `
-- agent-v2-complete
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, claim = pcall(cjson.decode, raw)
if not ok or claim["workerId"] ~= ARGV[2] or claim["claimToken"] ~= ARGV[3] then return 0 end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1
`;
const CONFIRM_OWNERSHIP_SCRIPT = `
-- agent-v2-confirm-ownership
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, claim = pcall(cjson.decode, raw)
if not ok or claim["workerId"] ~= ARGV[2] or claim["claimToken"] ~= ARGV[3] then return 0 end
return 1
`;
const RENEW_LEASE_SCRIPT = `
-- agent-v2-renew-lease
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, claim = pcall(cjson.decode, raw)
if not ok or claim["workerId"] ~= ARGV[2] or claim["claimToken"] ~= ARGV[3] then return 0 end
claim["heartbeatAtMs"] = tonumber(ARGV[4])
claim["leaseExpiresAtMs"] = tonumber(ARGV[5])
redis.call("HSET", KEYS[1], ARGV[1], cjson.encode(claim))
return ARGV[5]
`;
const REQUEUE_ACTIVE_BY_OWNER_SCRIPT = `
-- agent-v2-requeue-owner
local entries = redis.call("HGETALL", KEYS[1])
local reclaimed = 0
for index = 1, #entries, 2 do
	local runKey = entries[index]
	local ok, claim = pcall(cjson.decode, entries[index + 1])
	if ok and type(claim) == "table" and claim["workerId"] == ARGV[1] then
		redis.call("HDEL", KEYS[1], runKey)
		if redis.call("SADD", KEYS[3], runKey) == 1 then redis.call("LPUSH", KEYS[2], runKey) end
		reclaimed = reclaimed + 1
	end
end
return reclaimed
`;
const REQUEUE_EXPIRED_CLAIMS_SCRIPT = `
-- agent-v2-requeue-expired
local now = tonumber(ARGV[1])
local entries = redis.call("HGETALL", KEYS[1])
local reclaimed = {}
for index = 1, #entries, 2 do
	local runKey = entries[index]
	local raw = entries[index + 1]
	local ok, claim = pcall(cjson.decode, raw)
	local expiry = nil
	if ok and type(claim) == "table" and type(claim["leaseExpiresAtMs"]) == "number" then
		expiry = claim["leaseExpiresAtMs"]
	end
	local validExpiry = expiry ~= nil and expiry == expiry and expiry ~= math.huge and expiry ~= -math.huge
	if not validExpiry then
		redis.call("HDEL", KEYS[1], runKey)
		redis.call("HSET", KEYS[4], runKey, "invalid_lease_expiry")
	elseif expiry <= now then
		redis.call("HDEL", KEYS[1], runKey)
		if redis.call("SADD", KEYS[3], runKey) == 1 then redis.call("LPUSH", KEYS[2], runKey) end
		table.insert(reclaimed, raw)
	end
end
return reclaimed
`;
const REQUEST_CANCEL_SCRIPT = `
-- agent-v2-request-cancel
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[4])
redis.call("ZADD", KEYS[3], ARGV[2], ARGV[1])
redis.call("EXPIRE", KEYS[3], ARGV[3])
redis.call("SREM", KEYS[2], ARGV[1])
return redis.call("LREM", KEYS[1], 0, ARGV[1])
`;
const CHECK_CANCEL_SCRIPT = `
-- agent-v2-check-cancel
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[2])
local expiresAtMs = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not expiresAtMs then return 0 end
return tonumber(expiresAtMs) > tonumber(ARGV[2]) and 1 or 0
`;
const CLEAR_SCRIPT = `
-- agent-v2-clear
local queueItemsDeleted = redis.call("SCARD", KEYS[2])
local activeClaimsDeleted = redis.call("HLEN", KEYS[3])
redis.call("ZREMRANGEBYSCORE", KEYS[4], "-inf", ARGV[1])
local cancelKeysDeleted = redis.call("ZCARD", KEYS[4])
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return { queueItemsDeleted, activeClaimsDeleted, cancelKeysDeleted }
`;
export class InMemoryAgentV2RunQueue {
    active = new Map();
    cancelRequests = new Map();
    closed = false;
    cancelTtlSeconds;
    claimLeaseTtlMs;
    now;
    queued = [];
    ready = new Set();
    constructor(options = {}) {
        this.claimLeaseTtlMs = options.claimLeaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
        this.cancelTtlSeconds = options.cancelTtlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS;
        this.now = options.now ?? (() => Date.now());
    }
    async enqueue(run) {
        this.assertOpen();
        const identity = copyIdentity(run);
        const key = runKey(identity);
        if (this.active.has(key))
            return "already_active";
        if (this.ready.has(key))
            return "already_ready";
        this.ready.add(key);
        this.queued.push(identity);
        return "enqueued";
    }
    async claim(workerId, _timeoutMs) {
        this.assertOpen();
        for (;;) {
            const run = this.queued.shift();
            if (!run)
                return undefined;
            const key = runKey(run);
            this.ready.delete(key);
            if (this.active.has(key))
                continue;
            const now = this.now();
            const claim = createActiveRunClaim(run, workerId, randomUUID(), now, this.claimLeaseTtlMs);
            this.active.set(key, claim);
            return publicClaim(claim);
        }
    }
    async complete(claim) {
        this.assertOpen();
        const key = runKey(claim);
        if (!sameOwner(this.active.get(key), claim))
            return false;
        this.active.delete(key);
        this.cancelRequests.delete(key);
        return true;
    }
    async confirmOwnership(claim, _timeoutMs) {
        this.assertOpen();
        return sameOwner(this.active.get(runKey(claim)), claim) ? "owned" : "lost";
    }
    async requeueActive(workerId) {
        this.assertOpen();
        let count = 0;
        for (const [key, claim] of [...this.active]) {
            if (claim.workerId !== workerId)
                continue;
            this.active.delete(key);
            if (!this.ready.has(key)) {
                this.ready.add(key);
                this.queued.push(copyIdentity(claim));
            }
            count += 1;
        }
        return count;
    }
    async renewLease(claim) {
        this.assertOpen();
        const key = runKey(claim);
        const current = this.active.get(key);
        if (!sameOwner(current, claim))
            return { status: "lost" };
        const now = this.now();
        const leaseExpiresAtMs = now + this.claimLeaseTtlMs;
        this.active.set(key, { ...current, heartbeatAtMs: now, leaseExpiresAtMs });
        return { status: "renewed", leaseExpiresAtMs };
    }
    async requeueExpiredClaims(nowMs = this.now()) {
        this.assertOpen();
        const reclaimed = [];
        for (const [key, claim] of [...this.active]) {
            if (claim.leaseExpiresAtMs > nowMs)
                continue;
            this.active.delete(key);
            if (!this.ready.has(key)) {
                this.ready.add(key);
                this.queued.push(copyIdentity(claim));
            }
            reclaimed.push(publicClaim(claim));
        }
        return reclaimed;
    }
    async requestCancel(run) {
        this.assertOpen();
        const key = runKey(run);
        this.cancelRequests.set(key, this.now() + this.cancelTtlSeconds * 1_000);
        this.ready.delete(key);
        for (let index = this.queued.length - 1; index >= 0; index -= 1) {
            if (runKey(this.queued[index]) === key)
                this.queued.splice(index, 1);
        }
    }
    async isCancelRequested(run) {
        this.assertOpen();
        const key = runKey(run);
        const expiresAt = this.cancelRequests.get(key);
        if (expiresAt === undefined)
            return false;
        if (expiresAt > this.now())
            return true;
        this.cancelRequests.delete(key);
        return false;
    }
    async clear() {
        this.assertOpen();
        this.purgeExpiredCancelRequests();
        const result = {
            queueItemsDeleted: this.ready.size,
            activeClaimsDeleted: this.active.size,
            cancelKeysDeleted: this.cancelRequests.size,
        };
        this.queued.length = 0;
        this.ready.clear();
        this.active.clear();
        this.cancelRequests.clear();
        return result;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.queued.length = 0;
        this.ready.clear();
        this.active.clear();
        this.cancelRequests.clear();
    }
    assertOpen() {
        if (this.closed)
            throw new Error("Run queue is closed");
    }
    purgeExpiredCancelRequests() {
        const now = this.now();
        for (const [key, expiresAt] of this.cancelRequests) {
            if (expiresAt <= now)
                this.cancelRequests.delete(key);
        }
    }
}
export class RedisAgentV2RunQueue {
    activeKey;
    cancelIndexKey;
    cancelTtlSeconds;
    client;
    clientConnectPromise;
    claimClients = new Set();
    claimCommandTimeoutMs;
    claimLeaseTtlMs;
    closed = false;
    closePromise;
    gracefulCloseTimeoutMs;
    idleWaiters = new Set();
    invalidActiveKey;
    queueName;
    readyKey;
    redisUrl;
    constructor(options) {
        this.redisUrl = options.redisUrl;
        this.queueName = options.queueName;
        this.readyKey = `${options.queueName}:ready`;
        this.activeKey = `${options.queueName}:active`;
        this.cancelIndexKey = `${options.queueName}:cancel`;
        this.invalidActiveKey = `${options.queueName}:invalid-active`;
        this.cancelTtlSeconds = options.cancelTtlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS;
        this.claimLeaseTtlMs = options.claimLeaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
        this.claimCommandTimeoutMs = options.claimCommandTimeoutMs ?? DEFAULT_CLAIM_COMMAND_TIMEOUT_MS;
        this.gracefulCloseTimeoutMs = Math.max(1, options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS);
    }
    async enqueue(run) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(ENQUEUE_SCRIPT, {
            keys: [this.queueName, this.readyKey, this.activeKey],
            arguments: [runKey(run)],
        });
        this.wakeIdleWaiter();
        return parseEnqueueResult(result);
    }
    async claim(workerId, timeoutMs) {
        this.assertOpen();
        const client = createQueueClient(this.redisUrl);
        this.claimClients.add(client);
        const claimToken = randomUUID();
        try {
            // Establishing the dedicated socket is infrastructure setup, not time spent waiting for work.
            await client.connect();
            if (this.closed)
                return undefined;
            const boundedTimeoutMs = Math.max(0, timeoutMs);
            const deadline = Date.now() + boundedTimeoutMs;
            let pollIntervalMs = CLAIM_POLL_MIN_INTERVAL_MS;
            for (;;) {
                const result = await runBounded(client.eval(CLAIM_SCRIPT, {
                    keys: [this.queueName, this.readyKey, this.activeKey],
                    arguments: ["100", workerId, String(Date.now()), String(this.claimLeaseTtlMs), claimToken],
                }), this.claimCommandTimeoutMs);
                if (result.kind === "value") {
                    const claim = parseClaim(result.value);
                    if (claim)
                        return claim;
                }
                else {
                    await this.disconnectClaimClient(client);
                    const recovered = await this.recoverClaim(workerId, claimToken);
                    if (recovered)
                        return recovered;
                    if (result.kind === "error")
                        throw sanitizeRedisError(result.error, "agent_v2.redis_claim_failed");
                    return undefined;
                }
                if (timeoutMs <= 0 || this.closed || Date.now() >= deadline)
                    return undefined;
                await this.waitForWork(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
                pollIntervalMs = Math.min(pollIntervalMs * 2, CLAIM_POLL_MAX_INTERVAL_MS);
            }
        }
        catch (error) {
            if (this.closed)
                return undefined;
            throw sanitizeRedisError(error, "agent_v2.redis_claim_failed");
        }
        finally {
            await this.disconnectClaimClient(client);
        }
    }
    async complete(claim) {
        this.assertOpen();
        try {
            const result = await (await this.connectedClient()).eval(COMPLETE_IF_OWNER_SCRIPT, {
                keys: [this.activeKey, this.cancelIndexKey],
                arguments: [runKey(claim), claim.workerId, claim.claimToken],
            });
            return toCount(result) === 1;
        }
        catch (error) {
            throw sanitizeRedisError(error, "agent_v2.redis_complete_uncertain");
        }
    }
    async confirmOwnership(claim, timeoutMs) {
        this.assertOpen();
        try {
            const result = await runBounded(this.connectedClient().then(async (client) => await client.eval(CONFIRM_OWNERSHIP_SCRIPT, {
                keys: [this.activeKey],
                arguments: [runKey(claim), claim.workerId, claim.claimToken],
            })), Math.max(1, timeoutMs));
            return result.kind === "value" ? (toCount(result.value) === 1 ? "owned" : "lost") : "uncertain";
        }
        catch {
            return "uncertain";
        }
    }
    async requeueActive(workerId) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(REQUEUE_ACTIVE_BY_OWNER_SCRIPT, {
            keys: [this.activeKey, this.queueName, this.readyKey],
            arguments: [workerId],
        });
        return toCount(result);
    }
    async renewLease(claim) {
        this.assertOpen();
        const now = Date.now();
        const leaseExpiresAtMs = now + this.claimLeaseTtlMs;
        try {
            const result = await (await this.connectedClient()).eval(RENEW_LEASE_SCRIPT, {
                keys: [this.activeKey],
                arguments: [runKey(claim), claim.workerId, claim.claimToken, String(now), String(leaseExpiresAtMs)],
            });
            return toCount(result) > 0 ? { status: "renewed", leaseExpiresAtMs } : { status: "lost" };
        }
        catch {
            return { status: "uncertain", errorCode: "agent_v2.redis_lease_uncertain" };
        }
    }
    async requeueExpiredClaims(nowMs = Date.now()) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(REQUEUE_EXPIRED_CLAIMS_SCRIPT, {
            keys: [this.activeKey, this.queueName, this.readyKey, this.invalidActiveKey],
            arguments: [String(nowMs)],
        });
        return Array.isArray(result) ? result.map(parseClaim).filter(isClaim) : [];
    }
    async requestCancel(run) {
        this.assertOpen();
        const now = Date.now();
        await (await this.connectedClient()).eval(REQUEST_CANCEL_SCRIPT, {
            keys: [this.queueName, this.readyKey, this.cancelIndexKey],
            arguments: [
                runKey(run),
                String(now + this.cancelTtlSeconds * 1_000),
                String(this.cancelTtlSeconds),
                String(now),
            ],
        });
    }
    async isCancelRequested(run) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(CHECK_CANCEL_SCRIPT, {
            keys: [this.cancelIndexKey],
            arguments: [runKey(run), String(Date.now())],
        });
        return toCount(result) === 1;
    }
    async clear() {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(CLEAR_SCRIPT, {
            keys: [this.queueName, this.readyKey, this.activeKey, this.cancelIndexKey, this.invalidActiveKey],
            arguments: [String(Date.now())],
        });
        return parseClearResult(result);
    }
    close() {
        if (!this.closePromise)
            this.closePromise = this.closeInternal();
        return this.closePromise;
    }
    async closeInternal() {
        if (this.closed)
            return;
        this.closed = true;
        this.wakeAllIdleWaiters();
        await Promise.all([...this.claimClients].map(async (client) => await this.disconnectClaimClient(client)));
        const client = this.client;
        this.client = undefined;
        this.clientConnectPromise = undefined;
        if (!client?.isOpen)
            return;
        const graceful = await runBounded(client.quit(), this.gracefulCloseTimeoutMs);
        if (graceful.kind !== "value" && client.isOpen)
            await client.disconnect().catch(() => undefined);
    }
    assertOpen() {
        if (this.closed)
            throw new Error("Run queue is closed");
    }
    async connectedClient() {
        this.assertOpen();
        this.client ??= createQueueClient(this.redisUrl);
        if (!this.client.isOpen) {
            const client = this.client;
            this.clientConnectPromise ??= client
                .connect()
                .then(() => undefined)
                .finally(() => {
                this.clientConnectPromise = undefined;
            });
            await this.clientConnectPromise;
        }
        return this.client;
    }
    async recoverClaim(workerId, claimToken) {
        if (this.closed)
            return undefined;
        const client = createQueueClient(this.redisUrl);
        this.claimClients.add(client);
        try {
            const result = await runBounded(client.connect().then(async () => await client.eval(RECOVER_CLAIM_BY_TOKEN_SCRIPT, {
                keys: [this.activeKey],
                arguments: [claimToken, workerId],
            })), Math.min(this.claimCommandTimeoutMs, 100));
            return result.kind === "value" ? parseClaim(result.value) : undefined;
        }
        finally {
            await this.disconnectClaimClient(client);
        }
    }
    async disconnectClaimClient(client) {
        this.claimClients.delete(client);
        if (client.isOpen)
            await client.disconnect().catch(() => undefined);
    }
    waitForWork(timeoutMs) {
        if (this.closed)
            return Promise.resolve();
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                this.idleWaiters.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, timeoutMs);
            this.idleWaiters.add(wake);
        });
    }
    wakeIdleWaiter() {
        this.idleWaiters.values().next().value?.();
    }
    wakeAllIdleWaiters() {
        for (const wake of [...this.idleWaiters])
            wake();
    }
}
export function createAgentV2RunQueue(options = {}) {
    return new InMemoryAgentV2RunQueue(options);
}
export function createRedisAgentV2RunQueue(options) {
    return new RedisAgentV2RunQueue(options);
}
function copyIdentity(run) {
    if (typeof run.clientId !== "string" || run.clientId.length === 0)
        throw new Error("Agent v2 queue identity is missing clientId");
    if (typeof run.runId !== "string" || run.runId.length === 0)
        throw new Error("Agent v2 queue identity is missing runId");
    return { clientId: run.clientId, runId: run.runId };
}
function createActiveRunClaim(run, workerId, claimToken, now, claimLeaseTtlMs) {
    return {
        ...copyIdentity(run),
        workerId,
        claimToken,
        claimedAtMs: now,
        heartbeatAtMs: now,
        leaseExpiresAtMs: now + claimLeaseTtlMs,
    };
}
function publicClaim(claim) {
    return {
        clientId: claim.clientId,
        runId: claim.runId,
        workerId: claim.workerId,
        claimToken: claim.claimToken,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
    };
}
function sameOwner(active, claim) {
    return active?.workerId === claim.workerId && active.claimToken === claim.claimToken;
}
function parseClaim(value) {
    const raw = toUtf8String(value);
    if (!raw)
        return undefined;
    try {
        const claim = JSON.parse(raw);
        if (typeof claim.clientId === "string" &&
            typeof claim.runId === "string" &&
            typeof claim.workerId === "string" &&
            typeof claim.claimToken === "string" &&
            typeof claim.leaseExpiresAtMs === "number")
            return {
                clientId: claim.clientId,
                runId: claim.runId,
                workerId: claim.workerId,
                claimToken: claim.claimToken,
                leaseExpiresAtMs: claim.leaseExpiresAtMs,
            };
    }
    catch { }
    return undefined;
}
function isClaim(value) {
    return value !== undefined;
}
function runKey(run) {
    const identity = copyIdentity(run);
    return JSON.stringify([identity.clientId, identity.runId]);
}
function parseEnqueueResult(value) {
    const result = toUtf8String(value);
    if (result === "enqueued" || result === "already_ready" || result === "already_active")
        return result;
    throw new Error("Redis returned an invalid Agent v2 enqueue result");
}
function toUtf8String(value) {
    if (typeof value === "string")
        return value;
    return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}
function toCount(value) {
    return typeof value === "number" ? value : Number(value) || 0;
}
function parseClearResult(value) {
    if (!Array.isArray(value))
        return { queueItemsDeleted: 0, activeClaimsDeleted: 0, cancelKeysDeleted: 0 };
    return {
        queueItemsDeleted: toCount(value[0]),
        activeClaimsDeleted: toCount(value[1]),
        cancelKeysDeleted: toCount(value[2]),
    };
}
async function runBounded(operation, timeoutMs) {
    let timeoutId;
    const settled = operation.then((value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }));
    const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: "timeout" }), Math.max(1, timeoutMs));
    });
    try {
        return await Promise.race([settled, timeout]);
    }
    finally {
        if (timeoutId !== undefined)
            clearTimeout(timeoutId);
    }
}
function sanitizeRedisError(_error, code) {
    return new Error(code);
}
function createQueueClient(redisUrl) {
    const client = createClient({ url: redisUrl });
    // Command promises carry the actionable failure. The required listener prevents node-redis's
    // duplicate socket error notification from becoming an uncaught process exception.
    client.on("error", () => undefined);
    return client;
}
//# sourceMappingURL=agent-v2-run-queue.js.map