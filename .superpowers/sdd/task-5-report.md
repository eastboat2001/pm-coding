# Task 5 Report

## RED

命令：

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts
```

结果：

- `FAIL test/agent-v2-worker-service.test.ts`
- `Error: Cannot find module '../src/agent-v2-worker-service.js'`
- 结论：按 TDD 预期，先因缺失 `agent-v2-worker-service` 失败。

## GREEN

命令 1：

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts
```

结果：

- `1 passed`
- `6 passed`

命令 2：

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-task-engine.test.ts
```

结果：

- `3 passed`
- `30 passed`

命令 3：

```bash
cd packages/web-workspace
npm run check
```

结果：

- `@mariozechner/pi-web-workspace@0.73.0 check`
- `tsgo --noEmit`
- exit code `0`

补充验证：

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-state-machine.test.ts
```

结果：

- `1 passed`
- `12 passed`

## 修改文件

- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-worker-service.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/agent-v2-worker-service.test.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-types.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-types.js`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-state-machine.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-state-machine.js`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-run-api-service.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/agent-v2-state-machine.test.ts`

## Commit SHA

- `121b76c0103d6e7f2eee11efed4d578f2668fd5f`

## 自检

- worker 未导入或复用 `WorkspaceRunWorkerService`、`WorkerAgent`、`createRunAgent`、`RunRetryController`、`AppPreviewGoalSupervisor`、legacy session/message helpers。
- worker 只围绕 v2 store、`AgentV2RunQueue`、最小执行接口、`AgentV2RunEventLog` 工作。
- 取消语义保持 Task 4 风格：queued cancel 保持 `cancelled`，running cancel 先到 `cancelling`，worker 观察后落 `cancelled`。
- stop / recovery 统一把 owned `running` / `cancelling` run 标成 `interrupted`。
- 为了让运行时真正使用新状态，补了仓库内已提交的 `.js` 镜像文件；否则测试会继续吃旧状态机。

## 顾虑

- 当前 worker 通过最小执行接口驱动任务，不直接耦合 `executeAgentV2NextTask` 的完整上下文装配；这满足 brief 的“最小可注入执行接口”要求，但真正接入生产启动路径时还需要外层适配器提供 execution input。

---

## Task 5 Reviewer Fix（2026-07-08）

### 修改文件

- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-worker-service.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-state-machine.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/agent-v2-state-machine.js`
- `pi-mono-0.73.0/packages/web-workspace/src/runtime-store.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/runtime-db.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/runtime-db.js`
- `pi-mono-0.73.0/packages/web-workspace/src/postgres-runtime-store.ts`
- `pi-mono-0.73.0/packages/web-workspace/src/postgres-runtime-store.js`
- `pi-mono-0.73.0/packages/web-workspace/test/agent-v2-worker-service.test.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/agent-v2-state-machine.test.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/runtime-store-contract.test.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/runtime-db.test.ts`
- `pi-mono-0.73.0/packages/web-workspace/test/postgres-runtime-store.test.ts`

### 修复说明

- 收紧 v2 run 状态机，禁止 `cancelling -> succeeded/failed`，只允许 `cancelling -> cancelled/interrupted`。
- worker 在每轮执行前后都会重新读取最新 run；只要 run 已经是 `cancelling`，或者 queue 已存在 cancel request，就优先收敛到 `cancelled`，不再允许后续 step 结果把 run finalize 成 `succeeded` / `failed`。
- 把 worker stop / recovery 依赖的 owned active run listing 提升为正式 `RuntimeStore` contract：新增 `listAgentV2RunsByWorker(workerId)`，并在 SQLite / PostgreSQL store 中落地。

### 测试命令与结果

1. `cd packages/web-workspace && npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-task-engine.test.ts`
   - 结果：`3 passed`, `31 passed`
2. `cd packages/web-workspace && npx tsx ../../node_modules/vitest/dist/cli.js --run test/runtime-store-contract.test.ts test/agent-v2-state-machine.test.ts test/runtime-db.test.ts test/postgres-runtime-store.test.ts`
   - 结果：`4 passed`, `40 passed`
3. `cd packages/web-workspace && npm run check`
   - 结果：`tsgo --noEmit`，exit code `0`

### Commit SHA

- `fa0da06d2629850e1db6c5cfc565dd48e128332b`

### 是否仍有顾虑

- 无新增顾虑；本次只按 reviewer 指定范围修复 race 和 store contract。
