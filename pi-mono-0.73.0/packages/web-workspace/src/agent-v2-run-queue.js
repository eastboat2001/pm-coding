import { createClient } from "redis";
const DEFAULT_CANCEL_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_CLAIM_LEASE_TTL_MS = 30_000;
const COMPLETE_IF_OWNER_SCRIPT = `
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if not raw then
	return 0
end
local owner = raw
if string.sub(raw, 1, 1) == "{" then
	local ok, decoded = pcall(cjson.decode, raw)
	if ok and type(decoded) == "table" and type(decoded["workerId"]) == "string" then
		owner = decoded["workerId"]
	end
end
if owner == ARGV[2] then
	redis.call("ZREM", KEYS[2], ARGV[1])
	return redis.call("HDEL", KEYS[1], ARGV[1])
end
return 0
`;
const CLAIM_SCRIPT = `
-- agent-v2-claim
local maxScans = tonumber(ARGV[1])
for index = 1, maxScans do
	local raw = redis.call("RPOP", KEYS[1])
	if not raw then
		return false
	end
	local ok, decoded = pcall(cjson.decode, raw)
	if ok and type(decoded) == "table" then
		local clientId = decoded[1] or decoded["clientId"]
		local runId = decoded[2] or decoded["runId"]
		if type(clientId) == "string" and type(runId) == "string" then
			local runKey = cjson.encode({ clientId, runId })
			if redis.call("HEXISTS", KEYS[2], runKey) == 0 then
				local now = tonumber(ARGV[3])
				local claim = cjson.encode({
					workerId = ARGV[2],
					claimedAtMs = now,
					heartbeatAtMs = now,
					leaseExpiresAtMs = now + tonumber(ARGV[4])
				})
				redis.call("HSET", KEYS[2], runKey, claim)
				return runKey
			end
		end
	end
end
return false
`;
const REQUEST_CANCEL_SCRIPT = `
-- agent-v2-request-cancel
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[4])
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[1])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return redis.call("LREM", KEYS[1], 0, ARGV[1])
`;
const CHECK_CANCEL_SCRIPT = `
-- agent-v2-check-cancel
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[2])
local expiresAtMs = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not expiresAtMs then
	return 0
end
if tonumber(expiresAtMs) <= tonumber(ARGV[2]) then
	redis.call("ZREM", KEYS[1], ARGV[1])
	return 0
end
return 1
`;
const CLEAR_SCRIPT = `
-- agent-v2-clear
local queueItemsDeleted = redis.call("LLEN", KEYS[1])
local activeClaimsDeleted = redis.call("HLEN", KEYS[2])
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[1])
local cancelKeysDeleted = redis.call("ZCARD", KEYS[3])
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
return { queueItemsDeleted, activeClaimsDeleted, cancelKeysDeleted }
`;
const REQUEUE_ACTIVE_BY_OWNER_SCRIPT = `
local entries = redis.call("HGETALL", KEYS[1])
local reclaimed = 0
for i = 1, #entries, 2 do
	local runKey = entries[i]
	local raw = entries[i + 1]
	local owner = raw
	if string.sub(raw, 1, 1) == "{" then
		local ok, decoded = pcall(cjson.decode, raw)
		if ok and type(decoded) == "table" and type(decoded["workerId"]) == "string" then
			owner = decoded["workerId"]
		end
	end
	if owner == ARGV[1] then
		redis.call("HDEL", KEYS[1], runKey)
		redis.call("LPUSH", KEYS[2], runKey)
		reclaimed = reclaimed + 1
	end
end
return reclaimed
`;
const RENEW_LEASE_IF_OWNER_SCRIPT = `
local raw = redis.call("HGET", KEYS[1], ARGV[1])
if not raw then
	return 0
end
local owner = raw
if string.sub(raw, 1, 1) == "{" then
	local ok, decoded = pcall(cjson.decode, raw)
	if ok and type(decoded) == "table" and type(decoded["workerId"]) == "string" then
		owner = decoded["workerId"]
	end
end
if owner ~= ARGV[2] then
	return 0
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1
`;
const RELEASE_EXPIRED_CLAIMS_SCRIPT = `
local now = tonumber(ARGV[1])
local entries = redis.call("HGETALL", KEYS[1])
local reclaimed = {}
for i = 1, #entries, 2 do
	local runKey = entries[i]
	local raw = entries[i + 1]
	local leaseExpiresAtMs = nil
	if string.sub(raw, 1, 1) == "{" then
		local ok, decoded = pcall(cjson.decode, raw)
		if ok and type(decoded) == "table" and type(decoded["leaseExpiresAtMs"]) == "number" then
			leaseExpiresAtMs = decoded["leaseExpiresAtMs"]
		end
	end
	if leaseExpiresAtMs == nil or leaseExpiresAtMs <= now then
		redis.call("HDEL", KEYS[1], runKey)
		table.insert(reclaimed, runKey)
		table.insert(reclaimed, raw)
	end
end
return reclaimed
`;
export class InMemoryAgentV2RunQueue {
    active = new Map();
    cancelRequests = new Map();
    closed = false;
    cancelTtlSeconds;
    claimLeaseTtlMs;
    now;
    queued = [];
    constructor(options = {}) {
        this.claimLeaseTtlMs = options.claimLeaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
        this.cancelTtlSeconds = options.cancelTtlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS;
        this.now = options.now ?? (() => Date.now());
    }
    async enqueue(run) {
        this.assertOpen();
        this.queued.push(copyIdentity(run));
    }
    async claim(workerId, _timeoutMs) {
        this.assertOpen();
        const maxScans = this.queued.length;
        for (let index = 0; index < maxScans; index += 1) {
            const run = this.queued.shift();
            if (!run)
                return undefined;
            const key = runKey(run);
            if (this.active.has(key))
                continue;
            const now = this.now();
            this.active.set(key, createActiveRunClaim(run, workerId, now, this.claimLeaseTtlMs));
            return copyIdentity(run);
        }
        return undefined;
    }
    async complete(run, workerId) {
        this.assertOpen();
        const key = runKey(run);
        if (this.active.get(key)?.workerId === workerId) {
            this.active.delete(key);
            this.cancelRequests.delete(key);
        }
    }
    async requeueActive(workerId) {
        this.assertOpen();
        const reclaimed = [];
        for (const [key, claim] of this.active) {
            if (claim.workerId !== workerId)
                continue;
            this.active.delete(key);
            reclaimed.push({ clientId: claim.clientId, runId: claim.runId });
        }
        this.queued.push(...reclaimed);
        return reclaimed.length;
    }
    async renewLease(run, workerId) {
        this.assertOpen();
        const key = runKey(run);
        const claim = this.active.get(key);
        if (!claim || claim.workerId !== workerId)
            return false;
        const now = this.now();
        this.active.set(key, { ...claim, heartbeatAtMs: now, leaseExpiresAtMs: now + this.claimLeaseTtlMs });
        return true;
    }
    async releaseExpiredClaims() {
        this.assertOpen();
        const now = this.now();
        const expired = [];
        for (const [key, claim] of this.active) {
            if (claim.leaseExpiresAtMs > now)
                continue;
            this.active.delete(key);
            expired.push({ ...claim });
        }
        return expired;
    }
    async requestCancel(run) {
        this.assertOpen();
        const key = runKey(run);
        this.cancelRequests.set(key, this.now() + this.cancelTtlSeconds * 1_000);
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
            queueItemsDeleted: this.queued.length,
            activeClaimsDeleted: this.active.size,
            cancelKeysDeleted: this.cancelRequests.size,
        };
        this.queued.length = 0;
        this.active.clear();
        this.cancelRequests.clear();
        return result;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.queued.length = 0;
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
    activeClaims = 0;
    activeKey;
    cancelIndexKey;
    cancelTtlSeconds;
    client;
    claimLeaseTtlMs;
    claimWaiters = [];
    closed = false;
    closePromise;
    idleWaiters = new Set();
    queueName;
    redisUrl;
    constructor(options) {
        this.redisUrl = options.redisUrl;
        this.queueName = options.queueName;
        this.activeKey = `${options.queueName}:active`;
        this.cancelIndexKey = `${options.queueName}:cancel`;
        this.cancelTtlSeconds = options.cancelTtlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS;
        this.claimLeaseTtlMs = options.claimLeaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
    }
    async enqueue(run) {
        this.assertOpen();
        const client = await this.connectedClient();
        await client.lPush(this.queueName, runKey(run));
        this.wakeIdleWaiter();
    }
    async claim(workerId, timeoutMs) {
        this.assertOpen();
        this.activeClaims += 1;
        try {
            const deadline = Date.now() + Math.max(0, timeoutMs);
            for (;;) {
                const run = await this.claimOne(workerId);
                if (run || timeoutMs <= 0 || this.closed || Date.now() >= deadline)
                    return run;
                await this.waitForWork(Math.min(10, Math.max(1, deadline - Date.now())));
                if (this.closed)
                    return undefined;
            }
        }
        catch (error) {
            if (this.closed)
                return undefined;
            throw error;
        }
        finally {
            this.activeClaims -= 1;
            if (this.activeClaims === 0) {
                for (const resolve of this.claimWaiters.splice(0))
                    resolve();
            }
        }
    }
    async complete(run, workerId) {
        this.assertOpen();
        await this.completeClaimedRun(await this.connectedClient(), run, workerId);
    }
    async requeueActive(workerId) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(REQUEUE_ACTIVE_BY_OWNER_SCRIPT, {
            keys: [this.activeKey, this.queueName],
            arguments: [workerId],
        });
        return toCount(result);
    }
    async renewLease(run, workerId) {
        this.assertOpen();
        const claim = createActiveRunClaim(run, workerId, Date.now(), this.claimLeaseTtlMs);
        const result = await (await this.connectedClient()).eval(RENEW_LEASE_IF_OWNER_SCRIPT, {
            keys: [this.activeKey],
            arguments: [runKey(run), workerId, serializeActiveRunClaim(claim)],
        });
        return toCount(result) > 0;
    }
    async releaseExpiredClaims() {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(RELEASE_EXPIRED_CLAIMS_SCRIPT, {
            keys: [this.activeKey],
            arguments: [String(Date.now())],
        });
        return parseReleasedActiveClaims(result);
    }
    async requestCancel(run) {
        this.assertOpen();
        const key = runKey(run);
        await (await this.connectedClient()).eval(REQUEST_CANCEL_SCRIPT, {
            keys: [this.queueName, this.cancelIndexKey],
            arguments: [
                key,
                String(Date.now() + this.cancelTtlSeconds * 1_000),
                String(this.cancelTtlSeconds),
                String(Date.now()),
            ],
        });
    }
    async isCancelRequested(run) {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(CHECK_CANCEL_SCRIPT, {
            keys: [this.cancelIndexKey],
            arguments: [runKey(run), String(Date.now())],
        });
        return toCount(result) > 0;
    }
    async clear() {
        this.assertOpen();
        const result = await (await this.connectedClient()).eval(CLEAR_SCRIPT, {
            keys: [this.queueName, this.activeKey, this.cancelIndexKey],
            arguments: [String(Date.now())],
        });
        return parseClearResult(result);
    }
    close() {
        return (this.closePromise ??= this.closeInternal());
    }
    async closeInternal() {
        if (this.closed)
            return;
        this.closed = true;
        this.wakeAllIdleWaiters();
        await this.waitForActiveClaims();
        const clients = [this.client];
        this.client = undefined;
        await Promise.all(clients.map(async (client) => {
            if (!client?.isOpen)
                return;
            await client.quit().catch(async () => {
                if (client.isOpen)
                    await client.disconnect();
            });
        }));
    }
    assertOpen() {
        if (this.closed)
            throw new Error("Run queue is closed");
    }
    async completeClaimedRun(client, run, workerId) {
        await client.eval(COMPLETE_IF_OWNER_SCRIPT, {
            keys: [this.activeKey, this.cancelIndexKey],
            arguments: [runKey(run), workerId],
        });
    }
    async connectedClient() {
        this.assertOpen();
        this.client ??= createClient({ url: this.redisUrl });
        if (!this.client.isOpen)
            await this.client.connect();
        return this.client;
    }
    async claimOne(workerId) {
        const result = await (await this.connectedClient()).eval(CLAIM_SCRIPT, {
            keys: [this.queueName, this.activeKey],
            arguments: ["100", workerId, String(Date.now()), String(this.claimLeaseTtlMs)],
        });
        return parseIdentity(toUtf8String(result));
    }
    waitForActiveClaims() {
        if (this.activeClaims === 0)
            return Promise.resolve();
        return new Promise((resolve) => this.claimWaiters.push(resolve));
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
function createActiveRunClaim(run, workerId, now, claimLeaseTtlMs) {
    return { ...copyIdentity(run), workerId, claimedAtMs: now, heartbeatAtMs: now, leaseExpiresAtMs: now + claimLeaseTtlMs };
}
function serializeActiveRunClaim(claim) {
    return JSON.stringify({
        workerId: claim.workerId,
        claimedAtMs: claim.claimedAtMs,
        heartbeatAtMs: claim.heartbeatAtMs,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
    });
}
function serializeIdentity(run) {
    return JSON.stringify(copyIdentity(run));
}
function parseIdentity(value) {
    if (value === null || value === undefined)
        return undefined;
    const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
            return { clientId: parsed[0], runId: parsed[1] };
        }
        if (parsed &&
            typeof parsed === "object" &&
            "clientId" in parsed &&
            "runId" in parsed &&
            typeof parsed.clientId === "string" &&
            typeof parsed.runId === "string") {
            return { clientId: parsed.clientId, runId: parsed.runId };
        }
    }
    catch { }
    return undefined;
}
function runKey(run) {
    const identity = copyIdentity(run);
    return JSON.stringify([identity.clientId, identity.runId]);
}
function parseReleasedActiveClaims(result) {
    if (!Array.isArray(result))
        return [];
    const claims = [];
    for (let index = 0; index < result.length; index += 2) {
        const run = parseIdentity(toUtf8String(result[index]));
        const claim = parseActiveRunClaim(toUtf8String(result[index + 1]));
        if (run && claim)
            claims.push({ ...run, ...claim });
    }
    return claims;
}
function parseActiveRunClaim(value) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (parsed &&
            typeof parsed === "object" &&
            "workerId" in parsed &&
            typeof parsed.workerId === "string" &&
            "claimedAtMs" in parsed &&
            typeof parsed.claimedAtMs === "number" &&
            "heartbeatAtMs" in parsed &&
            typeof parsed.heartbeatAtMs === "number" &&
            "leaseExpiresAtMs" in parsed &&
            typeof parsed.leaseExpiresAtMs === "number") {
            return {
                workerId: parsed.workerId,
                claimedAtMs: parsed.claimedAtMs,
                heartbeatAtMs: parsed.heartbeatAtMs,
                leaseExpiresAtMs: parsed.leaseExpiresAtMs,
            };
        }
    }
    catch { }
    return { workerId: value, claimedAtMs: 0, heartbeatAtMs: 0, leaseExpiresAtMs: 0 };
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
//# sourceMappingURL=agent-v2-run-queue.js.map