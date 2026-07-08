import { createClient, type RedisClientType } from "redis";

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
	return redis.call("HDEL", KEYS[1], ARGV[1])
end
return 0
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

export interface RunQueueIdentity {
	clientId: string;
	runId: string;
}

export type RunQueueItem = string | RunQueueIdentity;

export interface ClaimedRun {
	clientId?: string;
	runId: string;
}

export interface ActiveRunClaim extends ClaimedRun {
	workerId: string;
	claimedAtMs: number;
	heartbeatAtMs: number;
	leaseExpiresAtMs: number;
}

export interface RunQueue {
	enqueue(run: RunQueueItem): Promise<void>;
	claim(workerId: string, timeoutMs: number): Promise<ClaimedRun | undefined>;
	complete(run: RunQueueItem | ClaimedRun, workerId: string): Promise<void>;
	requeueActive(workerId: string): Promise<number>;
	renewLease(run: RunQueueItem | ClaimedRun, workerId: string): Promise<boolean>;
	releaseExpiredClaims(): Promise<ActiveRunClaim[]>;
	requestCancel(run: RunQueueItem | ClaimedRun): Promise<void>;
	isCancelRequested(run: RunQueueItem | ClaimedRun): Promise<boolean>;
	close(): Promise<void>;
}

export interface InMemoryRunQueueOptions {
	leaseTtlMs?: number;
	nowMs?: () => number;
}

export class InMemoryRunQueue implements RunQueue {
	private readonly active = new Map<string, ActiveRunClaim>();
	private readonly cancelRequests = new Set<string>();
	private closed = false;
	private readonly leaseTtlMs: number;
	private readonly nowMs: () => number;
	private readonly queued: ClaimedRun[] = [];

	constructor(options: InMemoryRunQueueOptions = {}) {
		this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
		this.nowMs = options.nowMs ?? (() => Date.now());
	}

	async enqueue(run: RunQueueItem): Promise<void> {
		this.assertOpen();
		this.queued.push(toClaimedRun(run));
	}

	async claim(workerId: string, _timeoutMs: number): Promise<ClaimedRun | undefined> {
		this.assertOpen();
		const run = this.queued.shift();
		if (run === undefined) {
			return undefined;
		}

		this.active.set(runKey(run), createActiveRunClaim(run, workerId, this.nowMs(), this.leaseTtlMs));
		return run;
	}

	async complete(run: RunQueueItem | ClaimedRun, workerId: string): Promise<void> {
		this.assertOpen();
		const key = runKey(run);
		if (this.active.get(key)?.workerId === workerId) {
			this.active.delete(key);
		}
	}

	async requeueActive(workerId: string): Promise<number> {
		this.assertOpen();
		const reclaimed: ClaimedRun[] = [];
		for (const [key, claim] of this.active) {
			if (claim.workerId !== workerId) continue;
			this.active.delete(key);
			reclaimed.push(runFromKey(key));
		}
		this.queued.push(...reclaimed);
		return reclaimed.length;
	}

	async renewLease(run: RunQueueItem | ClaimedRun, workerId: string): Promise<boolean> {
		this.assertOpen();
		const key = runKey(run);
		const claim = this.active.get(key);
		if (!claim || claim.workerId !== workerId) {
			return false;
		}
		const nowMs = this.nowMs();
		this.active.set(key, {
			...claim,
			heartbeatAtMs: nowMs,
			leaseExpiresAtMs: nowMs + this.leaseTtlMs,
		});
		return true;
	}

	async releaseExpiredClaims(): Promise<ActiveRunClaim[]> {
		this.assertOpen();
		const nowMs = this.nowMs();
		const expired: ActiveRunClaim[] = [];
		for (const [key, claim] of this.active) {
			if (claim.leaseExpiresAtMs > nowMs) continue;
			this.active.delete(key);
			expired.push({ ...claim, ...runFromKey(key) });
		}
		return expired;
	}

	async requestCancel(run: RunQueueItem | ClaimedRun): Promise<void> {
		this.assertOpen();
		const key = runKey(run);
		this.cancelRequests.add(key);
		for (let index = this.queued.length - 1; index >= 0; index -= 1) {
			if (runKey(this.queued[index]) === key) this.queued.splice(index, 1);
		}
	}

	async isCancelRequested(run: RunQueueItem | ClaimedRun): Promise<boolean> {
		this.assertOpen();
		return this.cancelRequests.has(runKey(run));
	}

	async close(): Promise<void> {
		this.closed = true;
		this.queued.length = 0;
		this.active.clear();
		this.cancelRequests.clear();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Run queue is closed");
	}
}

export interface RedisRunQueueOptions {
	redisUrl: string;
	queueName: string;
	cancelTtlSeconds?: number;
	claimLeaseTtlMs?: number;
}

export class RedisRunQueue implements RunQueue {
	private activeClaims = 0;
	private readonly activeKey: string;
	private blockingClient?: RedisClientType;
	private readonly cancelTtlSeconds: number;
	private client?: RedisClientType;
	private readonly claimWaiters: Array<() => void> = [];
	private closed = false;
	private readonly claimLeaseTtlMs: number;
	private readonly queueName: string;
	private readonly redisUrl: string;

	constructor(options: RedisRunQueueOptions) {
		this.redisUrl = options.redisUrl;
		this.queueName = options.queueName;
		this.activeKey = `${options.queueName}:active`;
		this.cancelTtlSeconds = options.cancelTtlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS;
		this.claimLeaseTtlMs = options.claimLeaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
	}

	async enqueue(run: RunQueueItem): Promise<void> {
		this.assertOpen();
		const client = await this.connectedClient();
		await client.lPush(this.queueName, serializeQueueItem(run));
	}

	async claim(workerId: string, timeoutMs: number): Promise<ClaimedRun | undefined> {
		this.assertOpen();
		this.activeClaims += 1;
		try {
			const client = await this.connectedClient();
			const run = await this.popRun(timeoutMs, client);
			if (run === undefined) {
				return undefined;
			}
			if (this.closed) {
				await client.rPush(this.queueName, serializeClaimedRun(run));
				return undefined;
			}

			await client.hSet(
				this.activeKey,
				runKey(run),
				serializeActiveRunClaim(createActiveRunClaim(run, workerId, Date.now(), this.claimLeaseTtlMs)),
			);
			if (this.closed) {
				await this.completeClaimedRun(client, run, workerId);
				await client.rPush(this.queueName, serializeClaimedRun(run));
				return undefined;
			}
			return run;
		} catch (error) {
			if (this.closed) return undefined;
			throw error;
		} finally {
			this.activeClaims -= 1;
			if (this.activeClaims === 0) {
				for (const resolve of this.claimWaiters.splice(0)) resolve();
			}
		}
	}

	async complete(run: RunQueueItem | ClaimedRun, workerId: string): Promise<void> {
		this.assertOpen();
		const client = await this.connectedClient();
		await this.completeClaimedRun(client, run, workerId);
	}

	async requeueActive(workerId: string): Promise<number> {
		this.assertOpen();
		const client = await this.connectedClient();
		const result = await client.eval(REQUEUE_ACTIVE_BY_OWNER_SCRIPT, {
			keys: [this.activeKey, this.queueName],
			arguments: [workerId],
		});
		return typeof result === "number" ? result : Number(result) || 0;
	}

	async renewLease(run: RunQueueItem | ClaimedRun, workerId: string): Promise<boolean> {
		this.assertOpen();
		const client = await this.connectedClient();
		const claim = createActiveRunClaim(toClaimedRun(run), workerId, Date.now(), this.claimLeaseTtlMs);
		const result = await client.eval(RENEW_LEASE_IF_OWNER_SCRIPT, {
			keys: [this.activeKey],
			arguments: [runKey(run), workerId, serializeActiveRunClaim(claim)],
		});
		return (typeof result === "number" ? result : Number(result) || 0) > 0;
	}

	async releaseExpiredClaims(): Promise<ActiveRunClaim[]> {
		this.assertOpen();
		const client = await this.connectedClient();
		const result = await client.eval(RELEASE_EXPIRED_CLAIMS_SCRIPT, {
			keys: [this.activeKey],
			arguments: [String(Date.now())],
		});
		return parseReleasedActiveClaims(result);
	}

	async requestCancel(run: RunQueueItem | ClaimedRun): Promise<void> {
		this.assertOpen();
		const client = await this.connectedClient();
		await Promise.all([
			client.set(this.cancelKey(run), "1", { EX: this.cancelTtlSeconds }),
			client.lRem(this.queueName, 0, serializeRunQueueEntry(run)),
		]);
	}

	async isCancelRequested(run: RunQueueItem | ClaimedRun): Promise<boolean> {
		this.assertOpen();
		const client = await this.connectedClient();
		return (await client.exists(this.cancelKey(run))) > 0;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.blockingClient?.isOpen) {
			await this.blockingClient.disconnect();
		}
		await this.waitForActiveClaims();
		const clients = [this.client, this.blockingClient];
		this.blockingClient = undefined;
		this.client = undefined;

		await Promise.all(
			clients.map(async (client) => {
				if (client === undefined || !client.isOpen) {
					return;
				}

				await client.quit().catch(async () => {
					if (client.isOpen) await client.disconnect();
				});
			}),
		);
	}

	private cancelKey(run: RunQueueItem | ClaimedRun): string {
		return `${this.queueName}:cancel:${encodeURIComponent(runKey(run))}`;
	}

	private async completeClaimedRun(
		client: RedisClientType,
		run: RunQueueItem | ClaimedRun,
		workerId: string,
	): Promise<void> {
		await client.eval(COMPLETE_IF_OWNER_SCRIPT, {
			keys: [this.activeKey],
			arguments: [runKey(run), workerId],
		});
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Run queue is closed");
	}

	private async connectedBlockingClient(sourceClient: RedisClientType): Promise<RedisClientType> {
		this.blockingClient ??= sourceClient.duplicate();
		if (!this.blockingClient.isOpen) {
			await this.blockingClient.connect();
		}

		return this.blockingClient;
	}

	private async connectedClient(): Promise<RedisClientType> {
		this.assertOpen();
		this.client ??= createClient({ url: this.redisUrl });
		if (!this.client.isOpen) {
			await this.client.connect();
		}

		return this.client;
	}

	private async popRun(timeoutMs: number, client: RedisClientType): Promise<ClaimedRun | undefined> {
		if (timeoutMs <= 0) {
			return this.toClaimedRun(await client.rPop(this.queueName));
		}

		const blockingClient = await this.connectedBlockingClient(client);
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		const result = await blockingClient.brPop(this.queueName, timeoutSeconds);
		return this.toClaimedRun(result?.element);
	}

	private waitForActiveClaims(): Promise<void> {
		if (this.activeClaims === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.claimWaiters.push(resolve);
		});
	}

	private toClaimedRun(value: Buffer | string | null | undefined): ClaimedRun | undefined {
		if (value === null || value === undefined) {
			return undefined;
		}

		return parseQueueItem(Buffer.isBuffer(value) ? value.toString("utf8") : value);
	}
}

function toClaimedRun(run: RunQueueItem | ClaimedRun): ClaimedRun {
	if (typeof run === "string") return { runId: run };
	return { clientId: run.clientId, runId: run.runId };
}

function createActiveRunClaim(
	run: ClaimedRun,
	workerId: string,
	nowMs: number,
	leaseTtlMs: number,
): ActiveRunClaim {
	return {
		...run,
		workerId,
		claimedAtMs: nowMs,
		heartbeatAtMs: nowMs,
		leaseExpiresAtMs: nowMs + leaseTtlMs,
	};
}

function serializeActiveRunClaim(claim: ActiveRunClaim): string {
	return JSON.stringify({
		workerId: claim.workerId,
		claimedAtMs: claim.claimedAtMs,
		heartbeatAtMs: claim.heartbeatAtMs,
		leaseExpiresAtMs: claim.leaseExpiresAtMs,
	});
}

function serializeQueueItem(run: RunQueueItem): string {
	if (typeof run === "string") return run;
	return JSON.stringify(run);
}

function serializeClaimedRun(run: ClaimedRun): string {
	if (!run.clientId) return run.runId;
	return JSON.stringify({ clientId: run.clientId, runId: run.runId });
}

function serializeRunQueueEntry(run: RunQueueItem | ClaimedRun): string {
	if (typeof run === "string") return run;
	if (!run.clientId) return run.runId;
	return JSON.stringify({ clientId: run.clientId, runId: run.runId });
}

function parseQueueItem(value: string): ClaimedRun {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
			return { clientId: parsed[0], runId: parsed[1] };
		}
		if (
			parsed &&
			typeof parsed === "object" &&
			"clientId" in parsed &&
			"runId" in parsed &&
			typeof parsed.clientId === "string" &&
			typeof parsed.runId === "string"
		) {
			return { clientId: parsed.clientId, runId: parsed.runId };
		}
	} catch {
		// Existing queues may contain raw run ids.
	}
	return { runId: value };
}

function runFromKey(key: string): ClaimedRun {
	return parseQueueItem(key);
}

function runKey(run: RunQueueItem | ClaimedRun): string {
	if (typeof run === "string") return run;
	return run.clientId ? JSON.stringify([run.clientId, run.runId]) : run.runId;
}

function parseReleasedActiveClaims(result: unknown): ActiveRunClaim[] {
	if (!Array.isArray(result)) {
		return [];
	}
	const claims: ActiveRunClaim[] = [];
	for (let index = 0; index < result.length; index += 2) {
		const key = toUtf8String(result[index]);
		const rawClaim = toUtf8String(result[index + 1]);
		if (key === undefined || rawClaim === undefined) {
			continue;
		}
		const parsed = parseActiveRunClaim(rawClaim);
		if (!parsed) {
			continue;
		}
		claims.push({ ...runFromKey(key), ...parsed });
	}
	return claims;
}

function parseActiveRunClaim(value: string): Omit<ActiveRunClaim, "clientId" | "runId"> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"workerId" in parsed &&
			typeof parsed.workerId === "string" &&
			"claimedAtMs" in parsed &&
			typeof parsed.claimedAtMs === "number" &&
			"heartbeatAtMs" in parsed &&
			typeof parsed.heartbeatAtMs === "number" &&
			"leaseExpiresAtMs" in parsed &&
			typeof parsed.leaseExpiresAtMs === "number"
		) {
			return {
				workerId: parsed.workerId,
				claimedAtMs: parsed.claimedAtMs,
				heartbeatAtMs: parsed.heartbeatAtMs,
				leaseExpiresAtMs: parsed.leaseExpiresAtMs,
			};
		}
	} catch {
		// Existing queue claims may only store the owner worker id.
	}
	if (!value) {
		return undefined;
	}
	return {
		workerId: value,
		claimedAtMs: 0,
		heartbeatAtMs: 0,
		leaseExpiresAtMs: 0,
	};
}

function toUtf8String(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}
