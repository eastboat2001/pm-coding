# Phase 10 Preflight 01: Secure Workspace and Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 file、preview、static validation 和 build 对不可信生成内容 fail closed，并能在本地通过隔离容器成功构建受支持的静态项目。

**Architecture:** 一个深 `WorkspacePathGuard` Module 统一 realpath、symlink、内部元数据和跨平台 containment；所有 IO caller 只使用其返回的授权路径。`BuildRunner` seam 只有 fake 与 ephemeral-container 两个 Adapter，production 不再存在宿主 shell fallback。

**Tech Stack:** Node.js fs/path、TypeScript compiler API、Vitest、Docker/Podman CLI、Vite static validation。

## Global Constraints

- 继承 master plan 全部约束。
- `WorkspacePathGuard` 是唯一项目内容授权 Interface；caller 不得在授权后再次 `resolve/join`。
- build container 不挂载仓库、服务数据、Docker socket 或宿主敏感路径。
- dependency restore 强制 `--ignore-scripts`，且只能通过受信任的 allowlist egress proxy 访问固定 registry；build 阶段 `--network none`。
- `docker/pi-coding-web` 保持零 diff。

**Mandatory commit gate:** 每个 Task 在 `git commit` 前都必须从仓库根目录运行 `npm run check` 与 `git diff --check`；任一失败即不得提交。

---

### Task 1: Restore the Mandatory Check Baseline and Add Targeted Source Mirror Sync

**Files:**
- Create: `packages/web-workspace/scripts/source-mirrors.mjs`
- Create: `packages/web-workspace/test/source-mirror-script.test.ts`
- Modify: `packages/web-workspace/package.json`
- Modify mechanically, as emitted by the fresh root Biome check: `apps/pi-coding-web/src/app/bootstrap.ts`, `apps/pi-coding-web/src/app/generated-apps-state.ts`, `apps/pi-coding-web/src/diagnostics/DiagnosticLogsTab.ts`, `apps/pi-coding-web/src/diagnostics/diagnostic-export-client.ts`, `apps/pi-coding-web/src/runtime/agent-v2-run-client.ts`, `apps/pi-coding-web/src/runtime/context-orchestrator.ts`, `apps/pi-coding-web/src/worker/main.ts`
- Modify mechanically: `packages/web-workspace/src/agent-v2-execution-core.ts`, `packages/web-workspace/src/agent-v2-maintenance.ts`, `packages/web-workspace/src/agent-v2-planning-bootstrap.ts`, `packages/web-workspace/src/agent-v2-run-api-service.ts`, `packages/web-workspace/src/agent-v2-run-event-bus.ts`, `packages/web-workspace/src/agent-v2-runtime-core.ts`, `packages/web-workspace/src/agent-v2-runtime.ts`, `packages/web-workspace/src/diagnostic-export-service.ts`, `packages/web-workspace/src/index.ts`, `packages/web-workspace/src/runtime-infra.ts`, `packages/web-workspace/src/vite-plugin.ts`, plus their exact JS/maps
- Modify mechanically: `packages/web-workspace/test/agent-v2-quality-regression.test.ts`, `packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts`, `packages/web-workspace/test/agent-v2-worker-stress.test.ts`, `packages/web-workspace/test/diagnostic-export-service.test.ts`, `packages/web-workspace/test/postgres-runtime-store.test.ts`, `packages/web-workspace/test/run-events-sse.test.ts`, `packages/web-workspace/test/run-queue-redis.integration.test.ts`, `packages/web-workspace/test/runtime-store-contract.test.ts`, `packages/web-workspace/test/vite-plugin-schema-init.test.ts`

Only two semantic deletions are authorized in this task: unused `LIVE_MESSAGE_UPDATE_MIN_INTERVAL_MS` in `vite-plugin.ts` and unused local `legacy` in `diagnostic-export-service.test.ts`. Every other change in the baseline list must be exactly Biome formatting or generated JS/map output; reviewer rejects any other behavior change.

**Interfaces:**
- Produces: `syncSourceMirrors({ rootDir, files })` and `auditSourceMirrors({ rootDir, files })`.
- CLI: `node scripts/source-mirrors.mjs sync <explicit.ts...>` and `audit <explicit.ts...>`.

- [ ] **Step 1: Preserve the fresh root-check RED**

From the repository root run `npm run check`. Expected: Biome formats exactly the 27 listed TS/test files, then exits non-zero only for the two listed unused-variable warnings. Record `git diff --name-only`; any additional file aborts the task.

- [ ] **Step 2: Write the failing mirror test**

```ts
it("syncs only explicit TypeScript files and detects sourcesContent drift", async () => {
	const rootDir = fixtureProject();
	await syncSourceMirrors({ rootDir, files: ["alpha.ts"] });
	const output = readFileSync(join(rootDir, "src/alpha.js"), "utf8");
	expect(output).toContain("export const alpha");
	expect(output).not.toMatch(/exports\.|Object\.defineProperty\(exports/);
	expect(auditSourceMirrors({ rootDir, files: ["alpha.ts"] })).toEqual([]);
	writeFileSync(join(rootDir, "src/alpha.ts"), "export const alpha = 2;\n");
	expect(auditSourceMirrors({ rootDir, files: ["alpha.ts"] })).toContain("alpha.ts: sourcesContent drift");
	expect(existsSync(join(rootDir, "src/beta.js"))).toBe(false);
});
```

- [ ] **Step 3: Verify mirror-test RED**

Run from `packages/web-workspace`:

```powershell
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/source-mirror-script.test.ts
```

Expected: FAIL because `scripts/source-mirrors.mjs` does not exist.

- [ ] **Step 4: Implement the explicit mirror Module**

Use `typescript.transpileModule()` with `module: ESNext`, `target: ES2022`, `sourceMap: true`, `inlineSources: true`; this package is `type: module`, so generated mirrors must preserve ESM imports/exports and reject any CommonJS `exports`/`Object.defineProperty(exports,...)` wrapper. Reject paths outside `src`, non-`.ts` inputs, missing files and duplicate names. Normalize map `file`, `sources: ["<basename>.ts"]`, empty `sourceRoot`, and exact `sourcesContent`.

Add package scripts:

```json
"sync:source-mirrors": "node scripts/source-mirrors.mjs sync",
"check:source-mirrors": "node scripts/source-mirrors.mjs audit"
```

- [ ] **Step 5: Clear only the two warnings and synchronize formatted source mirrors**

Delete the two unused declarations. Run `sync:source-mirrors` with the 11 explicit formatted `packages/web-workspace/src/*.ts` names listed in this Task; do not scan or update any other mirror.

- [ ] **Step 6: Verify GREEN and commit**

```powershell
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/source-mirror-script.test.ts
npm run check:source-mirrors -- agent-v2-execution-core.ts agent-v2-maintenance.ts agent-v2-planning-bootstrap.ts agent-v2-run-api-service.ts agent-v2-run-event-bus.ts agent-v2-runtime-core.ts agent-v2-runtime.ts diagnostic-export-service.ts index.ts runtime-infra.ts vite-plugin.ts
Set-Location ../..
npm run check
git diff --check
git diff --name-only
# Stage only every exact path enumerated by this Task; no wildcard/pathspec directory.
git commit -m "build(web-workspace): restore checks and add targeted mirror sync"
```

Expected: focused test, mirror audit and root check PASS; second root check changes zero files; diff contains only the enumerated mechanical baseline, two unused deletions, mirror tool/test/package script and exact mirrors.

### Task 2: Implement WorkspacePathGuard

**Files:**
- Create: `packages/web-workspace/src/workspace-path-guard.ts`
- Generate: `packages/web-workspace/src/workspace-path-guard.js`
- Generate: `packages/web-workspace/src/workspace-path-guard.js.map`
- Create: `packages/web-workspace/test/workspace-path-guard.test.ts`

**Interfaces:**

```ts
export type WorkspacePathPolicy = "project_content" | "trusted_lifecycle";
export type WorkspacePathExpectedType = "any" | "file" | "directory";
export type WorkspacePathAuthorizationCode =
	| "path_empty" | "path_absolute" | "path_component_invalid" | "path_device_reserved"
	| "path_internal" | "path_missing" | "path_type_invalid" | "path_symlink" | "path_escape";

export class WorkspacePathAuthorizationError extends Error {
	constructor(readonly code: WorkspacePathAuthorizationCode, message: string);
}

export interface AuthorizedWorkspacePath {
	relativePath: string;
	absolutePath: string;
	realRoot: string;
}

export class WorkspacePathGuard {
	static forProjectContent(root: string): WorkspacePathGuard;
	static forTrustedLifecycle(root: string): WorkspacePathGuard;
	normalizeRelativePath(input: string): string;
	authorizeExisting(input: string, expectedType?: WorkspacePathExpectedType): AuthorizedWorkspacePath;
	authorizeNew(input: string): AuthorizedWorkspacePath;
	authorizeAbsoluteExisting(target: string, expectedType?: WorkspacePathExpectedType): AuthorizedWorkspacePath;
}
```

- [ ] **Step 1: Write RED tests**

Cover empty/absolute/UNC/device paths, `.`, `..`, empty segments, `CON/NUL/COM1`, `.pi`, `.pi-project.json`, `.pi-project-files.json`, existing file/dir, external symlink/junction, symlinked parent for a new file, native separator containment and trusted lifecycle `.pi/build-staging`.

- [ ] **Step 2: Verify RED**

```powershell
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/workspace-path-guard.test.ts
```

Expected: FAIL because the Module does not exist.

- [ ] **Step 3: Implement minimal authorization**

Use `lstatSync` for every existing path segment, reject symbolic links/junctions, use `realpathSync.native` for root and existing parent, and determine containment with `relative(realRoot, realTarget)` where escape means `relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)`.

- [ ] **Step 4: Sync, verify and commit**

```powershell
npm run sync:source-mirrors -- workspace-path-guard.ts
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/workspace-path-guard.test.ts
npm run check:source-mirrors -- workspace-path-guard.ts
git add packages/web-workspace/src/workspace-path-guard.ts packages/web-workspace/src/workspace-path-guard.js packages/web-workspace/src/workspace-path-guard.js.map packages/web-workspace/test/workspace-path-guard.test.ts
git commit -m "feat(web-workspace): authorize workspace paths"
```

### Task 3: Migrate File and Preview IO

**Files:**
- Modify: `packages/web-workspace/src/workspace-file-service.ts`
- Modify: `packages/web-workspace/src/agent-v2-file-adapter.ts`
- Modify: `packages/web-workspace/src/workspace-preview-service.ts`
- Modify matching JS/maps
- Modify: `packages/web-workspace/test/workspace-project-hardening.test.ts`
- Modify: `packages/web-workspace/test/workspace-isolation.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-file-adapter.test.ts`

**Interfaces:** Existing public file/preview methods remain; implementation consumes `WorkspacePathGuard`. `agent-v2-file-adapter` catches `WorkspacePathAuthorizationError` by type and maps it to non-retryable `file.path_invalid`.

- [ ] **Step 1: Add failing request-time authorization tests**

```ts
it("rejects create rewrite delete and preview of trusted metadata");
it("rejects file reads and writes through an escaping junction");
it("does not trust metadata serveRoot outside the real project root");
it("does not convert a rejected preview path into SPA index fallback");
it("maps authorization errors to file.path_invalid without message matching");
```

- [ ] **Step 2: Verify RED**

```powershell
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/workspace-project-hardening.test.ts test/workspace-isolation.test.ts test/agent-v2-file-adapter.test.ts
```

Expected: at least the metadata/symlink cases FAIL on current lexical checks.

- [ ] **Step 3: Replace lexical caller logic**

For file create use `authorizeNew`; get/update/delete use `authorizeExisting(..., "file")`; rewrite chooses existing/new. Preview derives trusted project root from `dirname(metadataPath)`, authorizes metadata `serveRoot` as ordinary project content with `WorkspacePathGuard.forProjectContent(projectRoot).authorizeAbsoluteExisting(..., "directory")`, then creates a project-content guard rooted at that authorized serve root for every requested target. `trusted_lifecycle` remains reserved for `.pi/build-staging` and is never used to authorize preview content. Only `path_missing` may fall back to authorized `index.html`.

- [ ] **Step 4: Sync, verify and commit**

```powershell
npm run sync:source-mirrors -- workspace-file-service.ts agent-v2-file-adapter.ts workspace-preview-service.ts
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/workspace-project-hardening.test.ts test/workspace-isolation.test.ts test/agent-v2-file-adapter.test.ts
npm run check:source-mirrors -- workspace-file-service.ts agent-v2-file-adapter.ts workspace-preview-service.ts
git add packages/web-workspace/src/workspace-file-service.ts packages/web-workspace/src/workspace-file-service.js packages/web-workspace/src/workspace-file-service.js.map packages/web-workspace/src/agent-v2-file-adapter.ts packages/web-workspace/src/agent-v2-file-adapter.js packages/web-workspace/src/agent-v2-file-adapter.js.map packages/web-workspace/src/workspace-preview-service.ts packages/web-workspace/src/workspace-preview-service.js packages/web-workspace/src/workspace-preview-service.js.map packages/web-workspace/test/workspace-project-hardening.test.ts packages/web-workspace/test/workspace-isolation.test.ts packages/web-workspace/test/agent-v2-file-adapter.test.ts
git commit -m "fix(web-workspace): protect project file and preview IO"
```

### Task 4: Unify Static Gates and Trusted Preview Origin

**Files:**
- Create: `packages/web-workspace/src/preview-origin.ts` plus mirrors
- Modify: `packages/web-workspace/src/static-preview.ts`
- Modify: `packages/web-workspace/src/static-preview-quality-gate.ts`
- Modify: `packages/web-workspace/src/static-preview-smoke-gate.ts`
- Modify: `packages/web-workspace/src/preview-readiness-checker.ts`
- Modify: `packages/web-workspace/src/workspace-preview-service.ts`
- Modify: `packages/web-workspace/src/config.ts`, `types.ts` and matching mirrors
- Create/Modify tests: `preview-origin.test.ts`, `preview-readiness-checker.test.ts`, `static-preview-quality-gate.test.ts`, `static-preview-smoke-gate.test.ts`, `config-diagnostics.test.ts`
- Modify direct `StorageConfig` fixtures: `agent-v2-execution-core.test.ts`, `agent-v2-file-adapter.test.ts`, `agent-v2-validation-gate.test.ts`, `agent-v2-vite-plugin-routes.test.ts`, `run-events-sse.test.ts`, `runtime-store-factory.test.ts`, `server-agent-tools.test.ts`, `vite-plugin-schema-init.test.ts`, `workspace.test.mjs`, `workspace-isolation.test.ts`, `workspace-project-hardening.test.ts`, `workspace-skill-service.test.ts`, `workspace-task-abort.test.ts`

**Interfaces:**

```ts
export interface PreviewOriginConfig { previewBaseUrl: string; previewInternalOrigin: string; }
export function buildTrustedPreviewUrl(config: PreviewOriginConfig, projectId: string): string;
```

`StorageConfig.previewInternalOrigin` defaults to `http://127.0.0.1:5173`; explicit `PI_PREVIEW_INTERNAL_ORIGIN` must be HTTP(S) origin without credentials/query/hash.

- [ ] **Step 1: Write RED tests** for Linux/native nested assets, symlinked dist, out-of-root index, Host header poisoning, external readiness origin and invalid internal origin.
- [ ] **Step 2: Run `preview-origin`, `preview-readiness-checker`, both static gate tests, `config-diagnostics`, and `workspace-project-hardening`; confirm expected failures.**
- [ ] **Step 3: Remove both local `pathIsInside` implementations; authorize index/scripts/assets and serve-root candidates through `WorkspacePathGuard`. Build/probe URLs only from configured origin.**
- [ ] **Step 4: Sync all modified mirrors, run the six focused tests, `node test/workspace.test.mjs`, and `npm run check:source-mirrors -- <files>`, then commit `fix(web-workspace): secure static validation and preview origin`.**

### Task 5: Define BuildRunner and Manifest Policy

**Files:**
- Create: `packages/web-workspace/src/build-runner.ts` plus mirrors
- Create: `packages/web-workspace/src/build-manifest-policy.ts` plus mirrors
- Create: `packages/web-workspace/test/build-manifest-policy.test.ts`

**Interfaces:**

```ts
export type BuildOutputDirectory = "dist" | "build" | "public";
export type BuildRunnerFailureCode =
	| "build.config_missing" | "build.engine_unavailable" | "build.policy_rejected"
	| "build.dependency_restore_failed" | "build.execution_failed" | "build.output_missing"
	| "build.output_escape" | "build.timeout" | "build.cancelled" | "build.cleanup_failed";
export interface BuildRunnerInput { projectId: string; projectRoot: string; artifactRoot: string; allowedOutputs: readonly BuildOutputDirectory[]; signal?: AbortSignal; }
export interface BuildRunnerResult { serveRoot: string; outputDirectory: BuildOutputDirectory; files: string[]; logs: string[]; durationMs: number; }
export interface BuildRunner { build(input: BuildRunnerInput): Promise<BuildRunnerResult>; }
export class BuildRunnerError extends Error { constructor(readonly code: BuildRunnerFailureCode, message: string, readonly logs?: readonly string[]); }
export interface BuildManifestPlan { restoreCommand?: readonly string[]; buildCommand: readonly string[]; outputDirectories: readonly BuildOutputDirectory[]; }
export function inspectBuildManifest(input: { projectRoot: string; registryOrigins: readonly string[] }): BuildManifestPlan;
```

- [ ] **Step 1: RED tests** require lockfile for dependencies, allow only npm, reject project `.npmrc`, lifecycle requirements, `git:`/`file:`/plain-HTTP dependencies and off-allowlist lockfile URLs; force argv arrays with `--ignore-scripts`, fixed trusted `--userconfig`, and never return shell strings.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement fixed restore `npm ci --ignore-scripts --no-audit --no-fund` and fixed build `npm --ignore-scripts run build`; output allowlist is `dist/build/public`.**
- [ ] **Step 4: Sync, focused test, mirror audit and commit `feat(web-workspace): define isolated static build policy`.**

### Task 6: Implement EphemeralContainerBuildRunner

**Files:**
- Create: `packages/web-workspace/src/ephemeral-container-build-runner.ts` plus mirrors
- Create: `packages/web-workspace/test/ephemeral-container-build-runner.test.ts`
- Create: `packages/web-workspace/test/ephemeral-container-build-runner.integration.test.ts`

**Interfaces:**

```ts
export interface ContainerCommand { args: readonly string[]; stdin?: Uint8Array; timeoutMs: number; signal?: AbortSignal; }
export interface ContainerCommandResult { exitCode: number; stdout: string; stderr: string; }
export interface ContainerCommandExecutor { execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult>; }
export interface ContainerBuildRunnerConfig {
	engine: "docker" | "podman"; image: string; proxyImage: string; timeoutMs: number; cpus: number;
	memoryMb: number; pidsLimit: number; maxLogChars: number; registryOrigins: string[];
}
export interface EphemeralContainerBuildRunnerOptions {
	config: ContainerBuildRunnerConfig; executor?: ContainerCommandExecutor;
	now?: () => number; id?: () => string;
}
export class EphemeralContainerBuildRunner implements BuildRunner { constructor(options: EphemeralContainerBuildRunnerOptions); build(input: BuildRunnerInput): Promise<BuildRunnerResult>; }
```

The proxy image is a digest-pinned Squid-compatible image. The runner writes a generated configuration into a named configuration volume (never a host bind): allow only CONNECT/HTTP destinations whose normalized hostname and port exactly match `registryOrigins`, reject numeric IPv4/IPv6 destinations and unknown ports, disable caching and access-log request paths, and expose the proxy only on the internal build network. The proxy alone also joins a transient bridge with egress; the restore container has no interface on that bridge. Project files, lockfiles and credentials are never mounted into the proxy.

- [ ] **Step 1: RED fake-executor tests** assert named volume only, no host bind/socket, non-root/read-only/cap-drop/no-new-privileges/resource limits, build `--network none`, cleanup on cancel/timeout, output authorization and log redaction/truncation. Restore container只能加入专用 internal network；受信任 proxy container 同时加入 internal 与临时 egress network，`HTTPS_PROXY` 指向 proxy、`NO_PROXY` 为空，proxy allowlist 只允许 `registryOrigins` 的 host/port，且两个 image 都必须是 digest-pinned。
- [ ] **Step 2: 先创建真实 integration test 并执行 RED。** `ephemeral-container-build-runner.integration.test.ts` 使用 required `PI_TEST_BUILD_CONTAINER_ENGINE`、`PI_TEST_BUILD_CONTAINER_IMAGE=<image@sha256>` 与 `PI_TEST_BUILD_PROXY_IMAGE=<proxy@sha256>`。它先证明 direct DNS hostname、off-allowlist hostname 和 literal IP 请求均被拒绝，再证明允许 registry 的依赖 restore 成功；不得 skip。
- [ ] **Step 3: Verify unit and real-integration RED before production implementation.**
- [ ] **Step 4: Implement create volume → seed copy → internal network + dual-network trusted proxy → restore container → networkless build container → staging export → authorized atomic publish → cleanup. Empty/unpinned build/proxy image fails `build.config_missing`/`build.policy_rejected`; never fall back to host.**
- [ ] **Step 5: Sync, focused unit/integration tests, mirror audit and commit `feat(web-workspace): build static projects in ephemeral containers`.**

### Task 7: Cut WorkspaceTaskService to BuildRunner and Prove Real Engine

**Files:**
- Create: `packages/web-workspace/src/workspace-task-factory.ts` plus mirrors
- Modify: `packages/web-workspace/src/workspace-task-service.ts`, `workspace-command-service.ts`, `agent-v2-validation-gate.ts`, `config.ts`, `types.ts`, `vite-plugin.ts`, `server-agent-tools.ts` plus mirrors
- Modify tests: `workspace-task-abort.test.ts`, `workspace-project-hardening.test.ts`, `agent-v2-validation-gate.test.ts`, `config-diagnostics.test.ts`, `workspace.test.mjs`
- Modify: `packages/web-workspace/test/ephemeral-container-build-runner.integration.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:** `WorkspaceTaskService` constructor receives `BuildRunner`; remove `ProjectCommandRunner`. `createWorkspaceTaskService()` is the single production composition factory used by Vite and server agent tools. Add `StorageConfig.containerBuild` with engine/build-image/proxy-image/time/resource/registry fields. Retire `PI_PROJECT_INSTALL_COMMAND`, `PI_PROJECT_BUILD_COMMAND`, and their timeout variables with fail-fast errors.

- [ ] **Step 1: RED tests** prove host runner is not called, AbortSignal reaches BuildRunner, structured failure codes reach v2 validation, old env vars fail startup and successful fake build is validated.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Route `build_static` exclusively through `BuildRunner.build()`, move every constructor call to `createWorkspaceTaskService()`, and remove host install/build config and shell execution path.**
- [ ] **Step 4: Sync mirrors, run focused tests, run `npm run check`, and commit `refactor(web-workspace): route static builds through BuildRunner`.**
- [ ] **Step 5: Re-run the already-RED real container integration through the production `createWorkspaceTaskService()` composition.** Dependency fixture builds `dist/index.html` and `dist/app.js`, leaves source unchanged, denies direct/off-allowlist/IP egress, and leaves no proxy/container/network/volume residue.
- [ ] **Step 6: Run integration with required env (no skip), `workspace.test.mjs`, boundary test, mandatory root commit gate, and confirm `git status --short -- ../../docker/pi-coding-web` is empty; commit `test(web-workspace): verify isolated static build chain`.**

## Plan 01 Verification

```powershell
Set-Location packages/web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/source-mirror-script.test.ts test/workspace-path-guard.test.ts test/workspace-project-hardening.test.ts test/workspace-isolation.test.ts test/agent-v2-file-adapter.test.ts test/preview-origin.test.ts test/preview-readiness-checker.test.ts test/static-preview-quality-gate.test.ts test/static-preview-smoke-gate.test.ts test/build-manifest-policy.test.ts test/ephemeral-container-build-runner.test.ts test/workspace-task-abort.test.ts test/agent-v2-validation-gate.test.ts test/ephemeral-container-build-runner.integration.test.ts
npm run check
git diff --check
```

Expected: all focused tests PASS, real container integration executes rather than skips, check/diff pass, and remote deployment directory has no changes.
