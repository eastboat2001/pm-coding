# Task 6 Report: v2 Execution Core Facade

## Summary

Implemented the Phase 4 deterministic execution facade as `executeAgentV2NextTask`, exported it from `packages/web-workspace/src/index.ts`, and added focused regression coverage in `packages/web-workspace/test/agent-v2-execution-core.test.ts`.

## Scope Delivered

- Added `packages/web-workspace/src/agent-v2-execution-core.ts`.
- Re-exported the facade API from `packages/web-workspace/src/index.ts`.
- Added focused tests for:
  - deterministic success of non-validation tasks selected from the v2 runtime snapshot
  - validation failure persistence across validation store, diagnostics, repair planning, and task transition

## Design Notes

- The facade loads task selection only through `loadAgentV2RuntimeSnapshot`, so task picking stays inside the existing context packet/task engine flow.
- All task status mutations go through `advanceAgentV2Task`; the facade does not write task status directly.
- Validation tasks run `runAgentV2StaticValidationGate`, persist the validation record, plan repair actions via `planAgentV2RepairActions`, append a validation diagnostic, and then fail the task through the state machine.
- Non-validation tasks use the brief-approved deterministic succeeded transition and do not invoke any legacy agent/prompt/spec/preview-goal/repair/createRunAgent path.
- No legacy runtime reads were introduced; the tests keep the `forbidLegacyRuntimeReads` proxy guard.

## TDD Evidence

### RED

Command:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-execution-core.test.ts
```

Observed failure:

- `Cannot find module '../src/agent-v2-execution-core.js'`

### GREEN

Command:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-execution-core.test.ts
```

Observed result:

- `1 passed`
- `2 passed`

## Verification

Focused test:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-execution-core.test.ts
```

Result: PASS

Typecheck:

```powershell
npm run check
```

Result: PASS

## Current Contract Adjustments

- The current repo contract from Task 5 uses repair action type `block_task`, not the older `block` label shown in the brief snippet. The test was aligned to current HEAD.
- I did not generate a source-adjacent `agent-v2-execution-core.js`. In this package, Vitest/tsx resolves `.js` import specifiers against the `.ts` source, and `npm run check` passed with the new TypeScript module plus `index.ts` export only.

## Files Changed

- `packages/web-workspace/src/agent-v2-execution-core.ts`
- `packages/web-workspace/src/index.ts`
- `packages/web-workspace/test/agent-v2-execution-core.test.ts`
