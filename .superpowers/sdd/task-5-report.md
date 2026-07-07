# Phase 1 Task 5 Report

## Status

`DONE`

## Commit

`e0754e4`

## Scope

Implemented the Application Generation Agent v2 runtime entry in `apps/pi-coding-web`, added selector coverage, and isolated the worker entry so any explicit `PI_APP_AGENT_VERSION=v1` request now fails fast instead of acting as a supported runtime path.

## RED

Command:

```powershell
Set-Location C:\VibeCoding\pm-coding-agent-v2-phase1\pi-mono-0.73.0\apps\pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run --config vitest.config.ts test/agent-v2-runtime-entry.test.ts
```

Key output:

- `FAIL test/agent-v2-runtime-entry.test.ts`
- `Cannot find module '../src/agent-v2/runtime-entry.js'`

This proved the runtime entry did not exist before implementation.

## GREEN

Command:

```powershell
Set-Location C:\VibeCoding\pm-coding-agent-v2-phase1\pi-mono-0.73.0\apps\pi-coding-web
npx tsx ../../node_modules/vitest/dist/cli.js --run --config vitest.config.ts test/agent-v2-runtime-entry.test.ts
```

Key output:

- `Test Files  1 passed (1)`
- `Tests  3 passed (3)`

## Typecheck

Command:

```powershell
Set-Location C:\VibeCoding\pm-coding-agent-v2-phase1\pi-mono-0.73.0\apps\pi-coding-web
npm run check
```

Key output:

- `> pi-coding-web@0.73.0 check`
- `> tsgo --noEmit`

The command exited `0`.

## Changed Files

- `apps/pi-coding-web/src/agent-v2/runtime-entry.ts`
- `apps/pi-coding-web/src/agent-v2/types.ts`
- `apps/pi-coding-web/src/worker/main.ts`
- `apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts`
- `.superpowers/sdd/task-5-report.md`

## Scoped Deviation

- `apps/pi-coding-web/src/config.ts` does not exist in this worktree, so no config file was created or modified.
- No `.js/.map` source sidecar convention exists for the new `apps/pi-coding-web/src/agent-v2/*` files in this app source tree, so none were added.

## Self-Review

- `selectApplicationGenerationRuntime({})` returns the v2-only app-facing selection shape.
- `requestedVersion: "v1"` throws with `v1 is retired` in the message, preventing v1 from remaining a product runtime.
- `requestedVersion: "v2"` still resolves to `{ version: "v2", v1Disabled: true }`.
- `worker/main.ts` only adds a minimal runtime-entry gate and does not introduce a new compatibility branch for v1.

## Concerns

- The worker reads `process.env.PI_APP_AGENT_VERSION` directly because there is no existing app-local `src/config.ts` to thread this through. That keeps the change scoped, but the temporary flag remains env-based rather than typed config state.
## Task 5 Fix Follow-up

- status: DONE
- commit hash: 0085bc8
- changed files:
  - `pi-mono-0.73.0/apps/pi-coding-web/src/agent-v2/runtime-entry.ts`
  - `pi-mono-0.73.0/apps/pi-coding-web/src/agent-v2/types.ts`
  - `pi-mono-0.73.0/apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts`
  - `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-types.ts`
  - `pi-mono-0.73.0/packages/web-workspace/src/index.ts`
- reviewer important fix 1:
  - moved the runtime-selection contract source of truth into `packages/web-workspace/src/agent-v2-types.ts`
  - `apps/pi-coding-web/src/agent-v2/types.ts` is now re-export/projection only and no longer declares app-local interfaces
  - `runtime-entry.ts` consumes the projected upstream type and keeps only the local value construction
- reviewer important fix 2:
  - added a focused integration test proving `createRunAgent(...)` throws `v1 is retired` when `process.env.PI_APP_AGENT_VERSION='v1'`
  - the test uses minimal in-memory input and asserts the guard fires before agent construction or external service usage
- RED/GREEN evidence:
  - RED: `npx tsx ../../node_modules/vitest/dist/cli.js --run --config vitest.config.ts test/agent-v2-runtime-entry.test.ts`
    - integration test was already green because the guard had already been wired in prior commit `e0754e4`, so strict RED for that finding was not possible
    - the same focused run failed on the added fresh-selection assertion, exposing the shared-object issue
  - GREEN: `npx tsx ../../node_modules/vitest/dist/cli.js --run --config vitest.config.ts test/agent-v2-runtime-entry.test.ts`
    - 5 tests passed
  - GREEN: `npm run check`
    - `tsgo --noEmit` passed
- self-review:
  - `selectApplicationGenerationRuntime()` still defaults to v2
  - explicit `v1` still throws with `v1 is retired`
  - explicit `v2` still returns `{ version: "v2", v1Disabled: true }`
  - no v1 product path or compatibility path was added
  - successful selections now return a fresh object to avoid shared mutable state
