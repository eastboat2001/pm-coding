import type { ClaimedRun, RunQueue } from "./run-queue.js";

export interface AgentV2RunQueueIdentity {
	clientId: string;
	runId: string;
}

export type AgentV2ClaimedRun = AgentV2RunQueueIdentity;

export interface AgentV2RunQueue {
	enqueue(run: AgentV2RunQueueIdentity): Promise<void>;
	claim(workerId: string, timeoutMs: number): Promise<AgentV2ClaimedRun | undefined>;
	complete(run: AgentV2RunQueueIdentity, workerId: string): Promise<void>;
	requeueActive(workerId: string): Promise<number>;
	requestCancel(run: AgentV2RunQueueIdentity): Promise<void>;
	isCancelRequested(run: AgentV2RunQueueIdentity): Promise<boolean>;
	close(): Promise<void>;
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
		requestCancel(run) {
			return queue.requestCancel(toAgentV2Identity(run));
		},
		isCancelRequested(run) {
			return queue.isCancelRequested(toAgentV2Identity(run));
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

function toAgentV2Identity(run: AgentV2RunQueueIdentity): AgentV2RunQueueIdentity {
	if (typeof run.clientId !== "string" || run.clientId.length === 0) {
		throw new Error("Agent v2 queue identity is missing clientId");
	}
	if (typeof run.runId !== "string" || run.runId.length === 0) {
		throw new Error("Agent v2 queue identity is missing runId");
	}
	return { clientId: run.clientId, runId: run.runId };
}
