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
	it("publishes explicit v2 worker package subpaths", () => {
		const packageJson = JSON.parse(readFileSync(join(repoRoot, "packages", "web-workspace", "package.json"), "utf8")) as {
			exports: Record<string, { types?: string; import?: string; default?: string }>;
		};

		expect(packageJson.exports["./agent-v2-runtime"]).toEqual({
			types: "./dist/agent-v2-runtime.d.ts",
			import: "./dist/agent-v2-runtime.js",
			default: "./dist/agent-v2-runtime.js",
		});
		expect(packageJson.exports["./runtime-infra"]).toEqual({
			types: "./dist/runtime-infra.d.ts",
			import: "./dist/runtime-infra.js",
			default: "./dist/runtime-infra.js",
		});
	});

	it("does not let the v2 worker import through the package root barrel", () => {
		const source = readFileSync(join(repoRoot, "apps", "pi-coding-web", "src", "worker", "main.ts"), "utf8");

		expect(source).not.toContain('from "@mariozechner/pi-web-workspace"');
		expect(source).toContain('from "@mariozechner/pi-web-workspace/agent-v2-runtime"');
		expect(source).toContain('from "@mariozechner/pi-web-workspace/runtime-infra"');
	});

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

	it("gates legacy plugin service construction behind v1 mode", () => {
		const source = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "vite-plugin.ts"), "utf8");
		const configuredStoragePluginSource = extractFunctionSource(source, "configuredStoragePlugin");
		const v1GateIndex = configuredStoragePluginSource.indexOf('config.appAgentVersion === "v1"');
		expect(v1GateIndex).toBeGreaterThanOrEqual(0);

		const legacyReferences = [
			"new AppPreviewGoalService",
			"new WorkspaceRunApiService",
			"new RedisRunEventBus",
			"queueName: config.runQueueName",
		];
		for (const legacyReference of legacyReferences) {
			const referenceIndex = configuredStoragePluginSource.indexOf(legacyReference);
			expect(referenceIndex, legacyReference).toBeGreaterThan(v1GateIndex);
			expect(configuredStoragePluginSource.slice(0, v1GateIndex), legacyReference).not.toContain(legacyReference);
		}
	});
});

function productionV2Files(): string[] {
	const webWorkspaceSrc = join(repoRoot, "packages", "web-workspace", "src");
	const agentV2Files = readdirSync(webWorkspaceSrc)
		.filter((name) => name.startsWith("agent-v2-") && name.endsWith(".ts"))
		.map((name) => join(webWorkspaceSrc, name));
	const v2OnlySubpathExports = ["agent-v2-runtime.ts", "runtime-infra.ts"]
		.map((name) => join(webWorkspaceSrc, name))
		.filter(existsSync);
	return [
		...agentV2Files,
		...v2OnlySubpathExports,
		join(repoRoot, "apps", "pi-coding-web", "src", "worker", "main.ts"),
	];
}

function toRepoPath(file: string): string {
	return relative(repoRoot, file).replace(/\\/g, "/");
}

function extractFunctionSource(source: string, functionName: string): string {
	const start = source.indexOf(`export function ${functionName}`);
	if (start < 0) throw new Error(`Could not find ${functionName}`);
	const bodyStart = source.indexOf("{", start);
	if (bodyStart < 0) throw new Error(`Could not find ${functionName} body`);
	let depth = 0;
	for (let index = bodyStart; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		if (char === "}") depth -= 1;
		if (depth === 0) return source.slice(start, index + 1);
	}
	throw new Error(`Could not find ${functionName} end`);
}
