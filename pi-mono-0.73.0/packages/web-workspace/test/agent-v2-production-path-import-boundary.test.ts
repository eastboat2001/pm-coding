import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const denyStrings = [
	"run-api-service",
	"run-worker-service",
	"app-preview-goal-service",
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"createRunAgent",
	"RunEventSink",
	"WorkspaceRunApiService",
	"WorkspaceRunWorkerService",
];

const allowedLegacyFiles = new Set([
	"apps/pi-coding-web/src/worker/legacy-v1-main.ts",
	"packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts",
]);

describe("agent v2 production import boundary", () => {
	it("keeps production v2 files independent from legacy v1 generation internals", () => {
		const violations = productionV2Files()
			.filter((file) => !allowedLegacyFiles.has(toRepoPath(file)))
			.flatMap((file) => {
				const source = readFileSync(file, "utf8");
				return denyStrings
					.filter((denyString) => source.includes(denyString))
					.map((denyString) => `${toRepoPath(file)} imports or references ${denyString}`);
			});

		expect(violations).toEqual([]);
	});
});

function productionV2Files(): string[] {
	const webWorkspaceSrc = join(repoRoot, "packages", "web-workspace", "src");
	const agentV2Files = readdirSync(webWorkspaceSrc)
		.filter((name) => name.startsWith("agent-v2-") && name.endsWith(".ts"))
		.map((name) => join(webWorkspaceSrc, name));
	return [...agentV2Files, join(repoRoot, "apps", "pi-coding-web", "src", "worker", "main.ts")];
}

function toRepoPath(file: string): string {
	return relative(repoRoot, file).replace(/\\/g, "/");
}
