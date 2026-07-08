# Task 1 Report — Pure v2 Task Engine

## Scope
- Implemented `selectNextAgentV2Task` and `transitionAgentV2Task` as a pure v2-only task engine.
- Added full unit tests and exported the new API from `packages/web-workspace/src/index.ts`.
- No old v1 agent internals (`capability-planner`, `spec-artifact`, `context-orchestrator`, `preview-goal`, `createRunAgent`, `selectApplicationGenerationRuntime`) were imported/used.

## Files Changed
- `packages/web-workspace/src/agent-v2-task-engine.ts` (new)
- `packages/web-workspace/test/agent-v2-task-engine.test.ts` (new)
- `packages/web-workspace/src/index.ts` (added exports)

## TDD Steps
1. Wrote `agent-v2-task-engine.test.ts` first with all specified scenarios.
2. Ran focused test:
   - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts`
   - Initially failed due to missing engine module (expected pre-implementation failure).
3. Implemented engine in `agent-v2-task-engine.ts` per brief.
4. Re-ran focused test and `npm run check` in `packages/web-workspace`:
   - Focused test: PASS (8/8)
   - Typecheck: PASS

## Results
- `selectNextAgentV2Task` supports:
  - `running` task prioritization
  - selectable ready/pending dependency handling
  - `empty_graph`, `blocked_by_dependencies`, `failed_dependency`, and `complete` states
- `transitionAgentV2Task` stamps immutable status transitions and enforces error requirement for failed transitions.
- No state reads/writes depend on legacy session/message/run records.

## Phase 3 Task 1 Review Findings Fixes
- Fixed `selectNextAgentV2Task` dependency handling so only `failed` and `cancelled` are treated as hard failure causes:
  - `blocked` contributes to `blocked_by_dependencies` when it is the only terminal blocker.
  - Terminal `blocked` tasks are included in `blockedTaskIds` and their transitive downstream pending/blocked descendants.
  - Terminal `failed`/`cancelled` tasks now produce `failed_dependency` when work is blocked, with `failedDependencyTaskIds` including terminal failed/cancelled ids and directly failure-affected pending/ready tasks.
- Fixed `transitionAgentV2Task` restart semantics:
  - clears `endedAt` on non-terminal transitions (`running`/`ready` and other non-terminals),
  - resets `output` to `{}` when transitioning to `running` without explicit output,
  - clears stale `error` when status is not `failed`,
  - keeps transitions immutable.
- Extended tests in `packages/web-workspace/test/agent-v2-task-engine.test.ts`:
  - blocked vs failed/cancelled distinction,
  - transition restart path resets `endedAt`, `output`, and `error`.
- Validation executed:
  - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts` (PASS, 11/11)
  - `npm run check` (PASS)

## Phase 3 Task 1 Review Findings (round 2)
- Fixed `transitionAgentV2Task` output/error semantics for non-terminal transitions:
  - `input.output` takes precedence when explicitly provided.
  - If target is terminal (`blocked|succeeded|failed|cancelled`) and output is absent, old `output` is preserved.
  - If target is non-terminal and output is absent, `output` is reset to `{}`.
  - `endedAt` is cleared on non-terminal transitions; `error` is kept only for `failed`.
  - Added test for `failed -> ready` reset to assert `output === {}`.
- Refactored `selectNextAgentV2Task` to compute diagnostics on full graph before selection:
  - `failedDependencyTaskIds` now includes terminal failed/cancelled roots and their non-succeeded descendants.
  - `blockedTaskIds` now includes terminal blocked roots and their non-succeeded descendants excluding failed dependencies.
  - Pending/ready tasks with unknown or unfinished dependencies are included in `blockedTaskIds` unless already failed dependency descendants.
  - Running tasks still win selection, but return diagnostic lists from full-graph analysis.
  - Ready tasks return even when unrelated blocked/failed graphs exist, while diagnostics remain comprehensive.
  - If no active task: `failed_dependency` if failure diagnostics exist, otherwise `blocked_by_dependencies`.
- Added regression tests:
  - ready + blocked-graph returns ready with blocked diagnostics preserved;
  - ready + failed-graph returns ready with failed dependency diagnostics preserved;
  - running + blocked graph returns running with non-empty blocked diagnostics.
- Validation executed:
  - `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts` (PASS, 14/14)
  - `npm run check` (PASS)
