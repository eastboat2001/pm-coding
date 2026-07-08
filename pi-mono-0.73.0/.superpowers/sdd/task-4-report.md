# Task 4 Report: v2 Validation Gate

## Scope

Implemented Phase 4 Task 4 in:

- `packages/web-workspace/src/agent-v2-validation-gate.ts`
- `packages/web-workspace/src/index.ts`
- `packages/web-workspace/test/agent-v2-validation-gate.test.ts`

No other production modules were changed.

## Codegraph First

I started with `codegraph`, but the index was stale relative to the worktree: `agent-v2-file-adapter.ts`, `agent-v2-tool-governance.ts`, and `agent-v2-store.ts` existed on disk but were not queryable from the MCP index.

Repair steps:

1. Confirmed the local `.codegraph/` database existed.
2. Verified the `codegraph` CLI was installed.
3. Ran `codegraph sync .` in the task worktree.
4. Re-ran `codegraph` symbol queries successfully against the v2 files.

Relevant symbols reviewed with `codegraph` after repair:

- `WorkspaceTaskService.run`
- `UpsertAgentV2ValidationInput`
- `AgentV2ToolFailure`
- `createAgentV2ToolFailure`
- `createAgentV2FileAdapter`

## TDD Evidence

### RED

Added `packages/web-workspace/test/agent-v2-validation-gate.test.ts` first, then ran:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-gate.test.ts
```

Observed expected failure:

- `Cannot find module '../src/agent-v2-validation-gate.js'`

That confirmed the test was failing for the intended reason: the module did not exist yet.

### GREEN

Implemented `runAgentV2StaticValidationGate` and re-ran:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-gate.test.ts
```

Observed:

- `1 passed`
- `3 passed`

## What Changed

### 1. Added a v2 static validation gate

`runAgentV2StaticValidationGate` now:

- calls `WorkspaceTaskService.run({ task: "validate" })`
- classifies static validation errors into structured `AgentV2ValidationFailure` records
- emits `UpsertAgentV2ValidationInput`
- returns a v2-friendly `AgentV2ValidationGateResult`

### 2. Preserved v2 taxonomy instead of leaking legacy tool wording

The gate explicitly normalizes legacy preview/build strings from `WorkspaceTaskService` into v2-oriented failures such as:

- `static.loading_visible`
- `static.metric_placeholder`
- `static.selector_missing`
- `static.local_script_missing`
- `static.script_error`
- `static.preview_missing_entry`
- `static.preview_build_required`

Important implementation detail:

- the returned `rawResult.errors` are sanitized to normalized v2 messages rather than exposing legacy `project_task` wording

This was necessary to satisfy the task constraint that v2 gate contracts must not surface old preview/tool semantics.

### 3. Re-exported the new API

`packages/web-workspace/src/index.ts` now re-exports:

- `AgentV2ValidationFailure`
- `AgentV2ValidationGateContext`
- `AgentV2ValidationGateResult`
- `RunAgentV2StaticValidationGateInput`
- `runAgentV2StaticValidationGate`

## Test Coverage Added

The new focused test covers:

1. visible loading placeholder -> structured failure mapping
2. happy path static app -> passed validation result
3. legacy build-required preview message -> normalized v2 preview failure without `project_task` leakage

## Verification

Executed successfully in `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-gate.test.ts
npm run check
```

Results:

- focused Vitest suite passed
- `tsgo --noEmit` passed

## Notes

- I did **not** add source-adjacent JS for the new module. This package's current test/runtime setup resolves the `../src/*.js` specifier to the new `.ts` source correctly once the file exists, and both focused tests and `npm run check` passed without extra JS sync.
- I did **not** import or depend on old application generation internals, v1 prompt/spec modules, preview-goal helpers, or `createRunAgent`.
- I reused `WorkspaceTaskService` only as the static validation executor, and placed all v2 contract shaping in the new adapter module.
