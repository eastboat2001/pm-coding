const PENDING_VALIDATION_STATUSES = new Set(["pending", "not_started"]);
export function buildAgentV2ArtifactIndex(artifacts) {
    const ordered = [...artifacts].sort(compareArtifacts);
    const latestByPath = new Map();
    for (const artifact of ordered)
        latestByPath.set(artifact.path, artifact);
    return {
        artifacts: ordered,
        latestByPath,
        pendingValidation: ordered
            .filter((artifact) => PENDING_VALIDATION_STATUSES.has(artifact.validationStatus))
            .sort(comparePendingValidation),
    };
}
export function filterAgentV2Artifacts(index, filter) {
    return index.artifacts.filter((artifact) => {
        if (filter.kind !== undefined && artifact.kind !== filter.kind)
            return false;
        if (filter.sourceTaskId !== undefined && artifact.sourceTaskId !== filter.sourceTaskId)
            return false;
        if (filter.validationStatus !== undefined && artifact.validationStatus !== filter.validationStatus)
            return false;
        if (filter.pathPrefix !== undefined && !artifact.path.startsWith(filter.pathPrefix))
            return false;
        return true;
    });
}
export function findLatestAgentV2ArtifactByPath(index, path) {
    return index.latestByPath.get(path);
}
function compareArtifacts(left, right) {
    return (compareStrings(left.updatedAt, right.updatedAt) ||
        compareStrings(left.path, right.path) ||
        compareStrings(left.artifactId, right.artifactId));
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function comparePendingValidation(left, right) {
    return (pendingValidationStatusOrder(left.validationStatus) - pendingValidationStatusOrder(right.validationStatus) ||
        compareArtifacts(left, right));
}
function pendingValidationStatusOrder(status) {
    return status === "pending" ? 0 : 1;
}
//# sourceMappingURL=agent-v2-artifact-index.js.map