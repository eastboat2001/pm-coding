import { describe, expect, it } from "vitest";
import {
	buildAgentV2ArtifactIndex,
	filterAgentV2Artifacts,
	findLatestAgentV2ArtifactByPath,
} from "../src/agent-v2-artifact-index.js";
import type { AgentV2ArtifactRecord } from "../src/agent-v2-store.js";

describe("agent v2 artifact index", () => {
	it("orders artifacts deterministically by updatedAt, path, and artifactId", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "b", path: "agent-v2/spec.md", updatedAt: "2026-07-08T00:03:00.000Z" }),
			artifact({ artifactId: "a", path: "agent-v2/spec.md", updatedAt: "2026-07-08T00:03:00.000Z" }),
			artifact({ artifactId: "c", path: "agent-v2/plan.md", updatedAt: "2026-07-08T00:02:00.000Z" }),
		]);

		expect(index.artifacts.map((item) => item.artifactId)).toEqual(["c", "a", "b"]);
	});

	it("keeps the latest artifact by path", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "spec-v1", path: "agent-v2/spec.md", version: "1", updatedAt: "2026-07-08T00:01:00.000Z" }),
			artifact({ artifactId: "spec-v2", path: "agent-v2/spec.md", version: "2", updatedAt: "2026-07-08T00:05:00.000Z" }),
		]);

		expect(findLatestAgentV2ArtifactByPath(index, "agent-v2/spec.md")).toMatchObject({
			artifactId: "spec-v2",
			version: "2",
		});
	});

	it("filters by kind, source task, validation status, and path prefix", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({
				artifactId: "spec",
				kind: "document",
				path: "agent-v2/spec.md",
				sourceTaskId: "spec",
				validationStatus: "accepted",
			}),
			artifact({
				artifactId: "app",
				kind: "source",
				path: "src/App.tsx",
				sourceTaskId: "implement",
				validationStatus: "pending",
			}),
			artifact({
				artifactId: "test",
				kind: "source",
				path: "src/App.test.tsx",
				sourceTaskId: "validate",
				validationStatus: "pending",
			}),
		]);

		expect(
			filterAgentV2Artifacts(index, {
				kind: "source",
				sourceTaskId: "implement",
				validationStatus: "pending",
				pathPrefix: "src/",
			}).map((item) => item.artifactId),
		).toEqual(["app"]);
	});

	it("exposes artifacts pending validation", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "accepted", validationStatus: "accepted" }),
			artifact({ artifactId: "passed", validationStatus: "passed" }),
			artifact({ artifactId: "pending", validationStatus: "pending" }),
			artifact({ artifactId: "not-started", validationStatus: "not_started" }),
		]);

		expect(index.pendingValidation.map((item) => item.artifactId)).toEqual(["pending", "not-started"]);
	});

	it("orders with non-ASCII artifact IDs by code-unit comparison independent of locale", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "å", path: "src/index.md", updatedAt: "2026-07-08T00:01:00.000Z" }),
			artifact({ artifactId: "z", path: "src/index.md", updatedAt: "2026-07-08T00:01:00.000Z" }),
		]);

		expect(index.artifacts.map((item) => item.artifactId)).toEqual(["z", "å"]);
		expect(["z", "å"].sort((left, right) => left.localeCompare(right, "en"))).toEqual(["å", "z"]);
	});
});

function artifact(input: Partial<AgentV2ArtifactRecord> & { artifactId: string }): AgentV2ArtifactRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-a",
		artifactId: input.artifactId,
		kind: input.kind ?? "document",
		path: input.path ?? `agent-v2/${input.artifactId}.md`,
		mediaType: input.mediaType ?? "text/markdown",
		checksum: input.checksum ?? `sha256:${input.artifactId}`,
		version: input.version ?? "1",
		sourceTaskId: input.sourceTaskId,
		validationStatus: input.validationStatus ?? "accepted",
		metadataJson: input.metadataJson ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}
