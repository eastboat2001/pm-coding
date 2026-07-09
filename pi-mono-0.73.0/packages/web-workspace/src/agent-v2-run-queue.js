export function createAgentV2RunQueue(queue) {
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
        close() {
            return queue.close();
        },
    };
}
function fromClaimedRun(run) {
    if (typeof run.clientId !== "string" || run.clientId.length === 0) {
        throw new Error("Agent v2 queue claim is missing clientId");
    }
    if (typeof run.runId !== "string" || run.runId.length === 0) {
        throw new Error("Agent v2 queue claim is missing runId");
    }
    return { clientId: run.clientId, runId: run.runId };
}
function fromActiveClaim(run) {
    return {
        ...fromClaimedRun(run),
        workerId: run.workerId,
        claimedAtMs: run.claimedAtMs,
        heartbeatAtMs: run.heartbeatAtMs,
        leaseExpiresAtMs: run.leaseExpiresAtMs,
    };
}
function toAgentV2Identity(run) {
    if (typeof run.clientId !== "string" || run.clientId.length === 0) {
        throw new Error("Agent v2 queue identity is missing clientId");
    }
    if (typeof run.runId !== "string" || run.runId.length === 0) {
        throw new Error("Agent v2 queue identity is missing runId");
    }
    return { clientId: run.clientId, runId: run.runId };
}
//# sourceMappingURL=agent-v2-run-queue.js.map