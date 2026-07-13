# Phase 10 Preflight 01 / Task 4 Implementer Report

## Result

- Base: `681552d42bc23fea8e9f74af6aa3c347e98b2486`
- Worktree: `C:\VibeCoding\pm-coding-agent-v2-phase10-preflight\pi-mono-0.73.0`
- Commit message: `fix(web-workspace): secure static validation and preview origin`

## CodeGraph review

- `buildPreviewUrl` has three direct callers in `WorkspacePreviewService`: project listing, rename, and build/record.
- `assessStaticPreviewQuality` is called by `WorkspaceTaskService` validation.
- `runStaticPreviewSmokeGate` also reaches agent-v2 validation and server-direct tools through the workspace task flow.
- The implementation therefore preserves the existing gate interfaces while authorizing their inputs and returns authorized absolute serve roots directly.

## TDD evidence

- RED focused run: 6 failing suites plus the intentionally missing new module; 12 failing assertions and 53 passing tests. Failures covered internal-origin probing, Host poisoning, invalid internal origins, nested query/hash resources, escaped indexes, and a symlinked dist root.
- GREEN focused run: 6 files and 67 tests passed.

## Implementation

- Added a trusted preview-origin helper. Public URLs prefer validated `previewBaseUrl` and otherwise use `previewInternalOrigin`; request Host/forwarded headers are ignored.
- Added fail-closed `PI_PREVIEW_INTERNAL_ORIGIN` parsing with the default `http://127.0.0.1:5173`. Errors name the variable without including its value.
- Readiness probes always target the configured internal origin while preserving the public metadata URL in results.
- Replaced both local `pathIsInside` implementations with `WorkspacePathGuard` authorization for indexes, scripts, styles, and static assets. Scheme/external/data references are excluded before local-path handling; query/hash fragments are stripped before authorization.
- Static serve-root candidates and build source entries are authorized through `WorkspacePathGuard`, rejecting symlink/junction escapes.
- Updated only the direct `StorageConfig` fixtures listed in the brief and synchronized the eight requested TypeScript mirrors.

## Verification

- Six focused Vitest files: 67/67 passed.
- `node test/workspace.test.mjs`: 34/34 scenarios passed.
- Eight-file source mirror audit: passed.
- Fresh root `npm run check`: passed; Biome reported `No fixes applied` for 800 root files and 87 web-ui files.
- `git diff --check`: passed.
- No v1/legacy compatibility, remote Docker, E2E, or secret output was introduced.
