status: DONE
commit hash: 8569931

changed files:
- `packages/web-workspace/src/agent-v2-run-events.ts`
- `packages/web-workspace/src/agent-v2-run-events.js`
- `packages/web-workspace/src/agent-v2-run-events.js.map`
- `packages/web-workspace/src/agent-v2-types.ts`
- `packages/web-workspace/src/agent-v2-types.js`
- `packages/web-workspace/src/run-event-sink.ts`
- `packages/web-workspace/src/run-event-sink.js`
- `packages/web-workspace/src/index.ts`
- `packages/web-workspace/src/index.js`
- `packages/web-workspace/test/agent-v2-store.test.ts`
- `packages/web-workspace/test/run-event-sink.test.ts`

RED/GREEN test evidence:
- RED
  - command: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-store.test.ts test/run-event-sink.test.ts`
  - result: failed with `Cannot find module '../src/agent-v2-run-events.js'` in both focused suites
- GREEN
  - command: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-store.test.ts test/run-event-sink.test.ts`
  - result: `2 passed`, `14 passed`
- build
  - command: `npm run build`
  - result: passed
- typecheck
  - command: `npm run check`
  - result: passed
- final focused regression
  - command: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-store.test.ts test/run-event-sink.test.ts`
  - result: `2 passed`, `14 passed`

transport projection boundary:
- Added `appendAgentV2RunEvent(...)` as the only adapter entrypoint for v2 transport projection into legacy `runs/run_events`.
- Adapter only forwards `agent_v2.*` event payloads through `RunEventSink`; it does not add any v1 semantic translation layer.
- `RunEventSink` now durably persists `agent_v2.*` event types so replay can read them from legacy `run_events`, with tests proving durable writes rather than live publish only.
- `getAgentV2Run(...)` coverage still proves v2 reads stay on `agent_v2_runs` and ignore legacy `runs/run_events`, even when a legacy projection with the same run id exists.
- No preview goal continuation or `AppPreviewGoalSupervisor` repair path was reintroduced; the new store test verifies the projection path leaves `app_preview_goal_events` untouched.

self-review:
- Adapter surface is intentionally narrow and transport-only.
- Durable persistence change is scoped to `agent_v2.*` prefix and does not alter existing v1 event payload handling.
- Tests cover replay persistence, event type prefixing, legacy-read isolation, and absence of preview-goal repair side effects.
