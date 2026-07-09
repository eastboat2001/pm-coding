import { RedisRunQueue, type ActiveRunClaim, type ClaimedRun, type RunQueue } from "./run-queue.js";

export interface AgentV2RunQueueIdentity {
	clientId: string;
	runId: string;
}

export type AgentV2ClaimedRun = AgentV2RunQueueIdentity;

export interface AgentV2ActiveRunClaim extends AgentV2RunQueueIdentity {
	workerId: string;
	claimedAtMs: number;
	heartbeatAtMs: number;
	leaseExpiresAtMs: number;
}

export interface AgentV2RunQueueClearResult {
	queueItemsDeleted: number;
	activeClaimsDeleted: number;
	cancelKeysDeleted: number;
}

export interface RedisAgentV2RunQueueOptions {
	redisUrl: string;
	queueName: string;
	claimLeaseTtlMs?: number;
	cancelTtlSeconds?: number;
}

export interface AgentV2RunQueue {
	enqueue(run: AgentV2RunQueueIdentity): Promise<void>;
	claim(workerId: string, timeoutMs: number): Promise<AgentV2ClaimedRun | undefined>;
	complete(run: AgentV2RunQueueIdentity, workerId: string): Promise<void>;
	requeueActive(workerId: string): Promise<number>;
	renewLease(run: AgentV2RunQueueIdentity, workerId: string): Promise<boolean>;
	releaseExpiredClaims(): Promise<AgentV2ActiveRunClaim[]>;
	requestCancel(run: AgentV2RunQueueIdentity): Promise<void>;
	isCancelRequested(run: AgentV2RunQueueIdentity): Promise<boolean>;
	clear(): Promise<AgentV2RunQueueClearResult>;
	close(): Promise<void>;
}

export function createRedisAgentV2RunQueue(options: RedisAgentV2RunQueueOptions): AgentV2RunQueue {
	return createAgentV2RunQueue(new RedisRunQueue(options));
}

export function createAgentV2RunQueue(queue: RunQueue): AgentV2RunQueue {
	return {
		enqueue(run) {
			return queue.enqueue(toAgentV2Identity(run));
		},
		async claim(workerId, timeoutMs) {
			const run = await queue.claim(workerId, timeoutMs);
			return run === undefined ? undefined : fromClaimedRun(run);
		},
		complete(run, workerId) {
			return queue.complete(toAgentV2Identity(run), workerId);
		},
		requeueActive(workerId) {
			return queue.requeueActive(workerId);
		},
		renewLease(run, workerId) {
			return queue.renewLease(toAgentV2Identity(run), workerId);
		},
		async releaseExpiredClaims() {
			return (await queue.releaseExpiredClaims()).map(fromActiveClaim);
		},
		requestCancel(run) {
			return queue.requestCancel(toAgentV2Identity(run));
		},
		isCancelRequested(run) {
			return queue.isCancelRequested(toAgentV2Identity(run));
		},
		clear() {
			return queue.clear();
		},
		close() {
			return queue.close();
		},
	};
}

function fromClaimedRun(run: ClaimedRun): AgentV2ClaimedRun {
	if (typeof run.clientId !== "string" || run.clientId.length === 0) {
		throw new Error("Agent v2 queue claim is missing clientId");
	}
	if (typeof run.runId !== "string" || run.runId.length === 0) {
		throw new Error("Agent v2 queue claim is missing runId");
	}
	return { clientId: run.clientId, runId: run.runId };
}

function fromActiveClaim(run: ActiveRunClaim): AgentV2ActiveRunClaim {
	return {
		...fromClaimedRun(run),
		workerId: run.workerId,
		claimedAtMs: run.claimedAtMs,
		heartbeatAtMs: run.heartbeatAtMs,
		leaseExpiresAtMs: run.leaseExpiresAtMs,
	};
}

function toAgentV2Identity(run: AgentV2RunQueueIdentity): AgentV2RunQueueIdentity {
	if (typeof run.clientId !== "string" || run.clientId.length === 0) {
		throw new Error("Agent v2 queue identity is missing clientId");
	}
	if (typeof run.runId !== "string" || run.runId.length === 0) {
		throw new Error("Agent v2 queue identity is missing runId");
	}
	return { clientId: run.clientId, runId: run.runId };
}
