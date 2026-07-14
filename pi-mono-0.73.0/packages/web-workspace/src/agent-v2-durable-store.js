import { createHash } from "node:crypto";
import { buildAgentV2Run } from "./agent-v2-store.js";
export function agentV2StartReplayEvidence(input) {
    const run = buildAgentV2Run(input.run);
    return {
        protocolVersion: 1,
        run: {
            clientId: run.clientId,
            runId: run.runId,
            input: run.input,
            model: run.model,
            createdAt: run.createdAt,
        },
        bootstrapVersion: input.bootstrapVersion,
        bootstrapChecksum: input.bootstrapChecksum,
        inputBlobs: input.inputBlobs.map(({ bytes, ...blob }) => ({ ...blob, bytes: Array.from(bytes) })),
        inputReferences: input.inputReferences,
        readyPhase: input.readyPhase,
        documents: input.documents,
        tasks: input.tasks,
        artifacts: input.artifacts,
        diagnostics: input.diagnostics,
        queueName: input.queueName,
        createdAt: input.createdAt,
    };
}
export function agentV2CancelReplayEvidence(input) {
    return {
        protocolVersion: 1,
        clientId: input.clientId,
        runId: input.runId,
        expectedStatuses: input.expectedStatuses,
        expectedRun: input.expectedRun,
        queueName: input.queueName,
        cancelToken: input.cancelToken,
        cancelledAt: input.cancelledAt,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
}
export function agentV2StartReplayFingerprint(input) {
    return protocolFingerprint(agentV2StartReplayEvidence(input));
}
export function agentV2CancelReplayFingerprint(input) {
    return protocolFingerprint(agentV2CancelReplayEvidence(input));
}
export function isAgentV2DeterministicExecutionTaskId(taskId) {
    return (/^repair:[A-Za-z0-9][A-Za-z0-9._:~-]*:[1-9][0-9]*$/u.test(taskId) ||
        /^revalidate:[A-Za-z0-9][A-Za-z0-9._:~-]*:[2-9][0-9]*$/u.test(taskId));
}
export function matchesAgentV2ExpectedRun(run, expected) {
    return (run.status === expected.status &&
        run.phase === expected.phase &&
        run.attempt === expected.attempt &&
        (run.workerId ?? null) === expected.workerId &&
        run.updatedAt === expected.updatedAt);
}
export function equalAgentV2ProtocolValues(left, right) {
    return JSON.stringify(canonicalProtocolValue(left)) === JSON.stringify(canonicalProtocolValue(right));
}
export function isCanonicalAgentV2Revision(value) {
    if (typeof value !== "string")
        return false;
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}
export function isStrictlyNewerAgentV2Revision(next, current) {
    return (isCanonicalAgentV2Revision(next) && isCanonicalAgentV2Revision(current) && Date.parse(next) > Date.parse(current));
}
function canonicalProtocolValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalProtocolValue);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalProtocolValue(child)]));
}
function protocolFingerprint(value) {
    return createHash("sha256")
        .update(JSON.stringify(canonicalProtocolValue(value)))
        .digest("hex");
}
//# sourceMappingURL=agent-v2-durable-store.js.map