import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const denyStrings = [
	"PI_APP_AGENT_VERSION",
	"run-api-service",
	"run-worker-service",
	"app-preview-goal-service",
	"AppPreviewGoalSupervisor",
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"buildSpecArtifact",
	"SPEC_ARTIFACT_PROJECT_FILES",
	"createRunAgent",
	"RunEventSink",
	"WorkspaceRunApiService",
	"WorkspaceRunWorkerService",
	"legacy-v1-main",
	"legacy-v1-agent-v2-run-event-bridge",
];

const allowedLegacyFiles = new Set<string>();
const legacyV1RunEventBridge = "packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts";

describe("agent v2 production import boundary", () => {
	it("publishes explicit v2 worker package subpaths", () => {
		const packageJson = JSON.parse(
			readFileSync(join(repoRoot, "packages", "web-workspace", "package.json"), "utf8"),
		) as {
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

	it("does not retain v1 gating or legacy plugin service construction in configured storage plugin", () => {
		const source = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "vite-plugin.ts"), "utf8");
		const configuredStoragePluginSource = extractFunctionSource(source, "configuredStoragePlugin");
		expect(configuredStoragePluginSource).not.toContain('config.appAgentVersion === "v1"');

		const legacyReferences = [
			"new AppPreviewGoalService",
			"new WorkspaceRunApiService",
			"new RedisRunEventBus",
			"queueName: config.runQueueName",
		];
		for (const legacyReference of legacyReferences) {
			expect(configuredStoragePluginSource, legacyReference).not.toContain(legacyReference);
		}
	});

	it("deletes the legacy v1 worker entry", () => {
		expect(existsSync(join(repoRoot, "apps", "pi-coding-web", "src", "worker", "legacy-v1-main.ts"))).toBe(false);
	});

	it("keeps browser-side v2 entrypoints free of legacy spec artifact and worker/api orchestration symbols", () => {
		const browserFiles = [
			join(repoRoot, "apps", "pi-coding-web", "src", "app", "bootstrap.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "runtime", "agent-v2-run-client.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "runtime", "run-client.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "runtime", "remote-agent-controller.ts"),
		];
		const forbidden = [
			"PI_APP_AGENT_VERSION",
			"legacy-v1-main",
			"buildSpecArtifact",
			"SPEC_ARTIFACT_PROJECT_FILES",
			"AppPreviewGoalSupervisor",
			"app-preview-goal",
			"getAppPreviewGoal",
			"enableAppPreviewGoal",
			"disableAppPreviewGoal",
			"app_preview_continuation",
			"createRunAgent",
			"WorkspaceRunWorkerService",
			"WorkspaceRunApiService",
			"spec-artifact",
		];

		for (const file of browserFiles) {
			const source = readFileSync(file, "utf8");
			for (const denyString of forbidden) {
				expect(source, `${toRepoPath(file)} must not reference ${denyString}`).not.toContain(denyString);
			}
		}
	});
});

function productionV2Files(): string[] {
	const webWorkspaceSrc = join(repoRoot, "packages", "web-workspace", "src");
	const agentV2Files = collectTsFiles(webWorkspaceSrc).filter((file) => basename(file).startsWith("agent-v2-"));
	const v2OnlySubpathExports = ["agent-v2-runtime.ts", "runtime-infra.ts"]
		.map((name) => join(webWorkspaceSrc, name))
		.filter(existsSync);
	const workerSrc = join(repoRoot, "apps", "pi-coding-web", "src", "worker");
	const workerFiles = collectTsFiles(workerSrc);
	return [
		...agentV2Files,
		...v2OnlySubpathExports,
		...workerFiles,
	];
}

function toRepoPath(file: string): string {
	return relative(repoRoot, file).replace(/\\/g, "/");
}

function collectTsFiles(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const filePath = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectTsFiles(filePath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			out.push(filePath);
		}
	}
	return out;
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
