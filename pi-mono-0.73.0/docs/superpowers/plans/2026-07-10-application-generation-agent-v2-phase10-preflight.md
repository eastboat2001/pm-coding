# Application Generation Agent v2 Phase 10 Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真实 E2E 前完成安全、真实、可恢复、可诊断的唯一 v2 生产生成链，并删除已证明无价值的遗留 Module。

**Architecture:** 工作按四份串行计划执行：先安全 workspace/build，再真实 v2 主链，再 Redis/worker/event/diagnostic 可靠性，最后迁移 browser、清理 exports/dead code 并做全量验证。PostgreSQL/SQLite durable store 是 run/task/event 与 immutable input blob 的事实源，Redis queue/live stream 是可重建投影；生产模型 Adapter 只存在于 worker composition，web-workspace 提供 v2 Interface 和确定性 fake seam。

**Tech Stack:** TypeScript、Node.js、Vitest、SQLite、PostgreSQL、Redis 7、Vite、Docker/Podman CLI、PI AI stream Interface。

## Global Constraints

- Application Generation Agent v2 是唯一正式生成运行时。
- 不恢复 v1、旧 prompt/spec/plan/tasks、preview goal continuation、旧 repair、旧内部 Interface 或双版本 feature flag。
- 不迁移旧 run/session/message/app preview goal/diagnostic 数据；schema 变更允许显式 destructive reset。
- 已删除的 queue/event/sink/retry/bridge/runtime wrapper/message conversion Module 不得恢复。
- `docker/pi-coding-web` 不因本地 preflight 修改。
- 不读取、记录或输出 `.env` 中的密码、Token、API Key。
- 所有生产行为修改遵循 RED → GREEN → REFACTOR；每个重要任务独立本地提交并完成双阶段 review。
- 不运行 `npm run dev`、根目录 `npm test` 或根目录 `npm run build`；focused test 从 package root 运行。
- 每个代码提交前必须从仓库根目录运行 `npm run check` 与 `git diff --check`，并修复全部 error/warning/info；focused package test 不能替代此提交门槛。
- 当前保留 `packages/web-workspace/src` TS/JS/source-map mirrors；任何 TS 修改必须通过唯一同步命令生成并审计同名 JS/map。
- 不推送、不合并回 `vibecoding-platform`，不运行真实 E2E，直到四份计划和最终 reviewer gate 全部通过。

## Fresh Baseline

- `pi-coding-web`: 44 files / 225 tests passed。
- `web-workspace`: 51 files / 378 non-Redis tests passed；`workspace.test.mjs` 34 scenarios passed。
- 真实 Redis integration：3/3 失败，均为 enqueue 后 `claim(workerId, 1)` 返回 `undefined`。这是 preflight 前已存在的 RED，记录于 reliability 计划，不得通过 skip 或只修改断言消除。
- 根 `npm run check`：Biome 会机械格式化 27 个已跟踪 TS/test 文件，随后因 `vite-plugin.ts` 与 `diagnostic-export-service.test.ts` 各一处 unused warning 失败。命令产生的修改已全部精确撤销；01/Task 1 将以独立机械提交恢复这一强制门槛并同步所有受影响 mirrors。
- CodeGraph：934 files / 17,327 nodes / 48,778 edges，索引最新。

## Plan Order

1. [安全 Workspace 与隔离 Build](2026-07-10-application-generation-agent-v2-phase10-preflight-01-security.md)
2. [真实 v2 主链](2026-07-10-application-generation-agent-v2-phase10-preflight-02-real-v2-chain.md)
3. [可靠性、事件与诊断](2026-07-10-application-generation-agent-v2-phase10-preflight-03-reliability.md)
4. [Browser 迁移、删除与验证](2026-07-10-application-generation-agent-v2-phase10-preflight-04-browser-cleanup-verification.md)

## Dependency Ledger

```text
01/T0 mirror command
  ├─ 01/T1-T6 workspace/build safety
  └─ 02/T1 durable store + outbox
        ├─ 02/T2 atomic start
        ├─ 02/T3-T8 trusted model + input materialization + repair
        └─ 03/T2 dispatcher <─ 03/T1 Redis queue
              ├─ 03/T3 worker durable transitions
              ├─ 03/T4 SSE healing
              └─ 03/T5 diagnostics ─> 03/T6 control loop ─> 03/T7 shutdown
                    └─ 04/T1-T2 browser v2 projection/removal
                          └─ 04/T3-T5 config/deletion/final verification
```

## Subagent Rules

- 一个 implementer 一次只执行一个 Task，不读取整份 master plan；主代理提供当前 Task brief、前置 commit SHA 和相关全局约束。
- implementer 先报告 RED 命令与预期失败，再写生产代码；完成后自审、focused test、`npm run check`、mirror audit、精确 `git add` 与本地提交。
- 每个 Task 后生成 review package，独立 reviewer 必须同时给出 spec compliance 与 code quality verdict。
- Critical/Important 必须由同一 implementer 修复，再由同一 reviewer 复审；未清零前不进入下一个 Task。
- 不并行派发两个 implementer。只读研究可以并行，写任务串行，避免共享 worktree 冲突。

## Final Gate

四份计划全部完成后，必须重新运行第四份计划中的完整 verification block，并由独立 reviewer 对 Phase 10 preflight merge base 到 HEAD 做全分支复审。只有 reviewer 无 Blocker/Important 且工作树干净，才向用户报告“可决定是否进入真实 E2E”。
