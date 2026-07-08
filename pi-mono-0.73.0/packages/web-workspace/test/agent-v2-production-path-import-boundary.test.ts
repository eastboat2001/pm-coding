import { existsSync, readdirSync, readFileSync } from "node:fs";
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
	"legacy-v1-agent-v2-run-event-bridge",
];

const allowedLegacyFiles = new Set([
	"apps/pi-coding-web/src/worker/legacy-v1-main.ts",
]);
const legacyV1RunEventBridge = "packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts";

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

	it("does not expose the legacy v1 run-event bridge through v2 production files", () => {
		expect([...allowedLegacyFiles]).not.toContain(legacyV1RunEventBridge);
		expect(productionV2Files().map(toRepoPath)).not.toContain(legacyV1RunEventBridge);

		if (existsSync(join(repoRoot, legacyV1RunEventBridge))) {
			const publicV2Surface = productionV2Files()
				.map((file) => readFileSync(file, "utf8"))
				.join("\n");
			expect(publicV2Surface).not.toContain("legacy-v1-agent-v2-run-event-bridge");
		}
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
