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
const legacyRootServiceExports = [
	"AppPreviewGoalService",
	"AppPreviewGoalSupervisor",
	"WorkspaceRunApiService",
	"WorkspaceRunWorkerService",
	"RunApiError",
	"budgetForSource",
	"WorkerAgent",
	"WorkerAgentEvent",
	"WorkspaceRunWorkerServiceOptions",
	"RunWorkerDiagnostics",
];
const legacyRootRuntimeExports = [
	"AppendAppPreviewGoalEventInput",
	"AppPreviewGoalEventRecord",
	"AppPreviewGoalEventType",
	"AppPreviewGoalRecord",
	"AppPreviewGoalSource",
	"AppPreviewGoalStartRequest",
	"AppPreviewGoalStatus",
	"ClaimedRun",
	"CreateRunInput",
	"CreateSessionInput",
	"DeleteSessionResult",
	"InMemoryRunEventBus",
	"InMemoryRunQueue",
	"LiveRunEvent",
	"RedisRunEventBus",
	"RedisRunQueue",
	"RunEventBus",
	"RunEventIdentity",
	"RunEventReadRequest",
	"RunEventSink",
	"RunEventSinkAgentEvent",
	"RunEventSinkOptions",
	"RunEventSinkStore",
	"RunQueue",
	"RunQueueClearResult",
	"RunQueueIdentity",
	"RunQueueItem",
	"RunRetryController",
	"RunRetryControllerDiagnostics",
	"RunRetryControllerOptions",
	"RunRetryExecutionInput",
	"RunStatus",
	"RunStatusPatch",
	"RuntimeActiveRunRestore",
	"RuntimeMessageRecord",
	"RuntimeRunEventListResult",
	"RuntimeRunEventRecord",
	"RuntimeRunListResult",
	"RuntimeRunRecord",
	"RuntimeSessionDetail",
	"RuntimeSessionListResult",
	"RuntimeSessionRecord",
	"RuntimeStore",
	"StartRunProjectFile",
	"StartRunRequest",
	"StartRunResult",
	"UpdateAppPreviewGoalInput",
	"UpsertAppPreviewGoalInput",
	"WorkerAgentInput",
];

const allowedLegacyFiles = new Set<string>();
const legacyV1RunEventBridge = "packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts";
const deletedLegacyEventCompatibilityFiles = [
	"packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts",
	"packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.js",
	"packages/web-workspace/src/run-event-sink.ts",
	"packages/web-workspace/src/run-event-sink.js",
	"packages/web-workspace/src/run-event-sink.js.map",
	"packages/web-workspace/src/run-event-bus.ts",
	"packages/web-workspace/src/run-event-bus.js",
	"packages/web-workspace/src/run-event-bus.js.map",
	"packages/web-workspace/test/run-event-sink.test.ts",
	"packages/web-workspace/test/run-event-bus.test.ts",
];
const deletedLegacyGenerationFiles = [
	"packages/web-workspace/src/app-preview-goal-service.ts",
	"packages/web-workspace/src/app-preview-goal-supervisor.ts",
	"packages/web-workspace/src/run-api-service.ts",
	"packages/web-workspace/src/run-worker-service.ts",
	"packages/web-workspace/test/app-preview-goal-service.test.ts",
	"packages/web-workspace/test/app-preview-goal-supervisor.test.ts",
	"packages/web-workspace/test/run-api-service.test.ts",
	"packages/web-workspace/test/run-worker-service.test.ts",
];
const allowedRuntimeStoreImportFiles = new Set([
	"packages/web-workspace/src/runtime-db.ts",
	"packages/web-workspace/src/postgres-runtime-store.ts",
	"packages/web-workspace/src/runtime-store-factory.ts",
]);
const explicitV2BoundaryFiles = [
	"packages/web-workspace/src/vite-plugin.ts",
	"apps/pi-coding-web/src/worker/main.ts",
];

describe("agent v2 production import boundary", () => {
	it("deletes the legacy queue and retry modules", () => {
		for (const file of [
			"packages/web-workspace/src/run-queue.ts",
			"packages/web-workspace/src/run-retry-controller.ts",
			"packages/web-workspace/test/run-queue.test.ts",
			"packages/web-workspace/test/retry-policy.test.ts",
		]) {
			expect(existsSync(join(repoRoot, file)), `${file} must be deleted`).toBe(false);
		}

		const queueSource = readFileSync(join(repoRoot, "packages/web-workspace/src/agent-v2-run-queue.ts"), "utf8");
		expect(queueSource).not.toContain("./run-queue.js");
		for (const legacyType of ["RunQueue", "ClaimedRun", "ActiveRunClaim"]) {
			expect(queueSource).not.toMatch(new RegExp(`\\b${legacyType}\\b`));
		}
	});

	it("deletes the retired application generation runtime selector", () => {
		const deleted = [
			"apps/pi-coding-web/src/agent-v2/runtime-entry.ts",
			"apps/pi-coding-web/src/agent-v2/types.ts",
			"apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts",
		];
		for (const file of deleted) expect(existsSync(join(repoRoot, file)), file).toBe(false);

		const types = readFileSync(join(repoRoot, "packages/web-workspace/src/agent-v2-types.ts"), "utf8");
		const barrel = readFileSync(join(repoRoot, "packages/web-workspace/src/index.ts"), "utf8");
		for (const retired of [
			"APPLICATION_GENERATION_RUNTIME_V2",
			"ApplicationGenerationRuntimeVersion",
			"ApplicationGenerationRuntimeSelection",
			"v1Disabled",
			"allowDebugV1",
		]) {
			expect(types, retired).not.toContain(retired);
			expect(barrel, retired).not.toContain(retired);
		}
	});

	it("does not expose legacy v1 product services through the root package barrel", () => {
		const rootExports = readRootBarrelExportNames();
		for (const legacyExport of [...legacyRootServiceExports, ...legacyRootRuntimeExports]) {
			expect(rootExports, `root barrel must not export ${legacyExport}`).not.toContain(legacyExport);
		}
	});

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
		const agentV2RuntimeImport = source.match(
			/import\s*\{[\s\S]*?\}\s*from "@mariozechner\/pi-web-workspace\/agent-v2-runtime";/,
		)?.[0];
		const runtimeInfraImport = source.match(
			/import\s*\{[\s\S]*?\}\s*from "@mariozechner\/pi-web-workspace\/runtime-infra";/,
		)?.[0];

		expect(source).not.toContain('from "@mariozechner/pi-web-workspace"');
		expect(source).not.toContain("RedisRunQueue");
		expect(source).not.toMatch(/\bRuntimeStore\b/);
		expect(source).toContain('from "@mariozechner/pi-web-workspace/agent-v2-runtime"');
		expect(source).toContain('from "@mariozechner/pi-web-workspace/runtime-infra"');
		expect(source).toContain("createRedisAgentV2RunQueue");
		expect(source).toContain("AgentV2SchemaStore");
		expect(source).toContain("AgentV2ProductionStore");
		expect(source).not.toContain("AgentV2WorkerStore");
		expect(agentV2RuntimeImport).toContain("type AgentV2RunQueue");
		expect(runtimeInfraImport).toContain("createRedisAgentV2RunQueue");
		expect(runtimeInfraImport).toContain("createAgentV2RuntimeStore");
		expect(runtimeInfraImport).toContain("type AgentV2ProductionStore");
		expect(runtimeInfraImport).toContain("type AgentV2SchemaStore");
	});

	it("keeps the runtime-infra subpath limited to v2 queue exports", () => {
		const source = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "runtime-infra.ts"), "utf8");

		expect(source).not.toMatch(/\bRuntimeStore\b/);
		expect(source).not.toContain("./runtime-store.js");
		expect(source).toContain("createRedisAgentV2RunQueue");
	});

	it("uses the composite agent v2 store factory across production entrypoints and barrels", () => {
		const files = [
			"packages/web-workspace/src/vite-plugin.ts",
			"apps/pi-coding-web/src/worker/main.ts",
			"packages/web-workspace/src/runtime-infra.ts",
			"packages/web-workspace/src/index.ts",
		];

		for (const file of files) {
			const source = readFileSync(join(repoRoot, file), "utf8");
			expect(source, file).toContain("createAgentV2RuntimeStore");
			expect(source, file).not.toContain("createRuntimeStore");
			expect(source, file).not.toMatch(/\bRuntimeStore\b/);
			expect(source, file).not.toMatch(/createAgentV2RuntimeStore\([^)]*\)\s+as\b/);
		}

		const factory = readFileSync(
			join(repoRoot, "packages/web-workspace/src/runtime-store-factory.ts"),
			"utf8",
		);
		expect(factory).toContain("export type AgentV2ProductionStore");
		expect(factory).toContain("createAgentV2RuntimeStore");
		expect(factory).not.toContain("./runtime-store.js");
		expect(factory).not.toContain("createRuntimeStore");
	});

	it("keeps committed source JavaScript mirrors aligned with the v2 public surface", () => {
		const rootMirror = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "index.js"), "utf8");
		const runtimeInfraMirror = readFileSync(
			join(repoRoot, "packages", "web-workspace", "src", "runtime-infra.js"),
			"utf8",
		);
		const agentRuntimeMirror = readFileSync(
			join(repoRoot, "packages", "web-workspace", "src", "agent-v2-runtime.js"),
			"utf8",
		);

		for (const legacyModule of [
			'"./run-event-bus.js"',
			'"./run-event-sink.js"',
			'"./run-queue.js"',
			'"./run-retry-controller.js"',
			'"./runtime-store.js"',
		]) {
			expect(rootMirror, `index.js must not export ${legacyModule}`).not.toContain(legacyModule);
			expect(runtimeInfraMirror, `runtime-infra.js must not export ${legacyModule}`).not.toContain(legacyModule);
		}
		expect(runtimeInfraMirror).not.toContain("RedisRunQueue");
		expect(runtimeInfraMirror).toContain("createRedisAgentV2RunQueue");
		expect(agentRuntimeMirror).toContain("createRedisAgentV2RunQueue");
	});

	it("keeps v2 production contracts independent from the legacy RuntimeStore interface", () => {
		const violations = [...productionV2Files(), ...explicitV2BoundaryFiles.map((file) => join(repoRoot, file))]
			.map(toRepoPath)
			.filter((file) => !allowedRuntimeStoreImportFiles.has(file))
			.filter((file) => {
				const source = readFileSync(join(repoRoot, file), "utf8");
				return source.includes("./runtime-store.js") || /\bRuntimeStore\b/.test(source);
			});

		expect(violations).toEqual([]);
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

	it("deletes legacy event compatibility modules and dedicated tests", () => {
		for (const file of deletedLegacyEventCompatibilityFiles) {
			expect(existsSync(join(repoRoot, file)), `${file} must be deleted`).toBe(false);
		}
		expect([...allowedLegacyFiles]).not.toContain(legacyV1RunEventBridge);
		expect(productionV2Files().map(toRepoPath)).not.toContain(legacyV1RunEventBridge);
	});

	it("keeps retired route handling as a pathname-only classifier", () => {
		const source = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "vite-plugin.ts"), "utf8");
		const classifierSource = extractFunctionSource(source, "retiredApplicationGenerationRoute");

		expect(classifierSource).toContain(
			"function retiredApplicationGenerationRoute(pathname: string): RetiredApplicationGenerationRoute | undefined",
		);
		expect(classifierSource).not.toMatch(/retiredApplicationGenerationRoute\([^)]*(?:store|queue|session|eventLog)/);
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

	it("keeps the cutover rehearsal on v2 routes without reset or legacy configuration", () => {
		const source = readFileSync(
			join(repoRoot, "apps", "pi-coding-web", "src", "worker", "cutover-rehearsal.ts"),
			"utf8",
		);

		expect(source).toContain("/api/agent-v2/runs");
		expect(source).toContain("/api/pi-storage/status");
		expect(source).not.toContain("/api/pi-storage/reset");
		expect(source).not.toContain("PI_APP_AGENT_VERSION");
		expect(source).not.toMatch(/PI_RUN_/);
	});

	it("removes legacy v1 generation services and their dedicated tests", () => {
		for (const file of deletedLegacyGenerationFiles) {
			expect(existsSync(join(repoRoot, file)), `${file} must be deleted`).toBe(false);
		}
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

	it("keeps browser application generation state on agent v2 contracts", () => {
		const browserFiles = [
			"apps/pi-coding-web/src/app/bootstrap.ts",
			"apps/pi-coding-web/src/app/generated-apps-state.ts",
			"apps/pi-coding-web/src/diagnostics/DiagnosticLogsTab.ts",
			"apps/pi-coding-web/src/diagnostics/diagnostic-export-client.ts",
			"apps/pi-coding-web/src/runtime/agent-v2-run-client.ts",
			"apps/pi-coding-web/src/runtime/browser-records.ts",
			"apps/pi-coding-web/src/runtime/remote-agent-controller.ts",
			"apps/pi-coding-web/src/runtime/remote-resume.ts",
			"apps/pi-coding-web/src/runtime/run-health.ts",
			"apps/pi-coding-web/src/runtime/run-retry-status.ts",
			"apps/pi-coding-web/src/storage/merged-session-index.ts",
		].map((file) => join(repoRoot, file));
		const retiredBrowserRuntimeTypes = [
			"RunStatus",
			"RuntimeRunRecord",
			"RuntimeRunEventRecord",
			"RuntimeActiveRunRestore",
			"RuntimeSessionDetail",
			"StartRunProjectFile",
			"RuntimeSessionRecord",
			"RuntimeMessageRecord",
			"DeleteSessionResult",
		] as const;

		for (const file of browserFiles) {
			const source = readFileSync(file, "utf8");
			for (const retiredType of retiredBrowserRuntimeTypes) {
				expect(source, `${toRepoPath(file)} must not reference ${retiredType}`).not.toMatch(
					new RegExp(`\\b${retiredType}\\b`),
				);
			}
			expect(source, `${toRepoPath(file)} must not use the retired completed status`).not.toContain('"completed"');
		}

		const bootstrapSource = readFileSync(
			join(repoRoot, "apps/pi-coding-web/src/app/bootstrap.ts"),
			"utf8",
		);
		const eventHandlerStart = bootstrapSource.indexOf("const applyConnectedRunEvent");
		const eventHandlerEnd = bootstrapSource.indexOf("const connectToRemoteRun", eventHandlerStart);
		const eventHandlerSource = bootstrapSource.slice(eventHandlerStart, eventHandlerEnd);
		expect(eventHandlerSource).not.toContain('finishRemoteRun("succeeded")');
		expect(eventHandlerSource).not.toMatch(/markRemoteRunSettled\([^)]*"succeeded"/s);
	});

	it("keeps product browser/runtime paths from calling the legacy pi-sessions API", () => {
		const browserFiles = [
			join(repoRoot, "apps", "pi-coding-web", "src", "app", "bootstrap.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "runtime", "run-client.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "diagnostics", "DiagnosticLogsTab.ts"),
			join(repoRoot, "apps", "pi-coding-web", "src", "diagnostics", "diagnostic-export-client.ts"),
		];

		for (const file of browserFiles) {
			const source = readFileSync(file, "utf8");
			expect(source, `${toRepoPath(file)} must not reference /api/pi-sessions`).not.toContain("/api/pi-sessions");
			expect(source, `${toRepoPath(file)} must not import legacy deleteSession`).not.toContain("deleteRuntimeSession");
			expect(source, `${toRepoPath(file)} must not import legacy renameSession`).not.toContain("renameRuntimeSession");
		}
	});
});

function productionV2Files(): string[] {
	const webWorkspaceSrc = join(repoRoot, "packages", "web-workspace", "src");
	const agentV2Files = collectTsFiles(webWorkspaceSrc).filter((file) => basename(file).startsWith("agent-v2-"));
	const v2OnlySubpathExports = ["agent-v2-runtime.ts", "runtime-infra.ts", "diagnostic-export-service.ts"]
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

function readRootBarrelExportNames(): string[] {
	const source = readFileSync(join(repoRoot, "packages", "web-workspace", "src", "index.ts"), "utf8");
	const names = new Set<string>();
	for (const match of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["'];/g)) {
		for (const rawPart of match[1].split(",")) {
			const withoutComment = rawPart.replace(/\/\/.*$/gm, "").trim();
			if (!withoutComment) continue;
			const cleaned = withoutComment.replace(/^type\s+/, "").trim();
			if (!cleaned) continue;
			const aliasParts = cleaned.split(/\s+as\s+/);
			names.add((aliasParts.at(-1) || cleaned).trim());
		}
	}
	return [...names].sort();
}

function extractFunctionSource(source: string, functionName: string): string {
	const exportedStart = source.indexOf(`export function ${functionName}`);
	const start = exportedStart >= 0 ? exportedStart : source.indexOf(`function ${functionName}`);
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
