import type { AgentV2ArtifactRecord } from "./agent-v2-store.js";

export interface AgentV2ArtifactIndexFilter {
	kind?: string;
	sourceTaskId?: string;
	validationStatus?: string;
	pathPrefix?: string;
}

export interface AgentV2ArtifactIndex {
	artifacts: AgentV2ArtifactRecord[];
	latestByPath: Map<string, AgentV2ArtifactRecord>;
	pendingValidation: AgentV2ArtifactRecord[];
}

const PENDING_VALIDATION_STATUSES = new Set(["pending", "not_started"]);

export function buildAgentV2ArtifactIndex(artifacts: AgentV2ArtifactRecord[]): AgentV2ArtifactIndex {
	const ordered = [...artifacts].sort(compareArtifacts);
	const latestByPath = new Map<string, AgentV2ArtifactRecord>();
	for (const artifact of ordered) latestByPath.set(artifact.path, artifact);

	return {
		artifacts: ordered,
		latestByPath,
		pendingValidation: ordered
			.filter((artifact) => PENDING_VALIDATION_STATUSES.has(artifact.validationStatus))
			.sort(comparePendingValidation),
	};
}

export function filterAgentV2Artifacts(index: AgentV2ArtifactIndex, filter: AgentV2ArtifactIndexFilter): AgentV2ArtifactRecord[] {
	return index.artifacts.filter((artifact) => {
		if (filter.kind !== undefined && artifact.kind !== filter.kind) return false;
		if (filter.sourceTaskId !== undefined && artifact.sourceTaskId !== filter.sourceTaskId) return false;
		if (filter.validationStatus !== undefined && artifact.validationStatus !== filter.validationStatus) return false;
		if (filter.pathPrefix !== undefined && !artifact.path.startsWith(filter.pathPrefix)) return false;
		return true;
	});
}

export function findLatestAgentV2ArtifactByPath(
	index: AgentV2ArtifactIndex,
	path: string,
): AgentV2ArtifactRecord | undefined {
	return index.latestByPath.get(path);
}

function compareArtifacts(left: AgentV2ArtifactRecord, right: AgentV2ArtifactRecord): number {
	return (
		left.updatedAt.localeCompare(right.updatedAt) ||
		left.path.localeCompare(right.path) ||
		left.artifactId.localeCompare(right.artifactId)
	);
}

function comparePendingValidation(left: AgentV2ArtifactRecord, right: AgentV2ArtifactRecord): number {
	return (
		pendingValidationStatusOrder(left.validationStatus) - pendingValidationStatusOrder(right.validationStatus) ||
		compareArtifacts(left, right)
	);
}

function pendingValidationStatusOrder(status: string): number {
	return status === "pending" ? 0 : 1;
}
