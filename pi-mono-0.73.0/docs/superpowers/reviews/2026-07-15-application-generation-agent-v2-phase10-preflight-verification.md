# Application Generation Agent v2 Phase 10 Preflight 验收报告

**日期：** 2026-07-15

**基线：** `vibecoding-platform` / `a029e9c5eb46f505b4c6cb8475e79866627fe0ab`

**验证分支：** `codex/app-agent-v2-phase10-preflight`

**实现验证 HEAD：** `c996fda`

**结论：** Phase 10 preflight 清理、修复和自动化验证已完成。Application Generation Agent v2 保持唯一正式生成路径；当前可以进入用户控制的手动真实 E2E，但本报告阶段未启动真实模型生成、cutover 或付费调用。

## 1. 已关闭的高风险问题

- workspace 路径、静态校验、preview origin 和隔离 BuildRunner 已收紧，host build 与任意 shell 不再作为正式构建路径。
- PostgreSQL exact v2 schema、start/transition/cancel/execution/diagnostic 原子提交、revision CAS 和 durable outbox 已补齐。
- Redis claim token、uncertain commit、renew、reclaim、cancel 和 close deadline 已加固；所有 Redis 绝对租约/取消时间统一来自 Redis `TIME`，不再依赖 worker 主机时钟。
- worker claim/cancel monitor、shutdown deadline、crash/reclaim 和终态提交顺序已收紧。
- durable event、Redis live projection、SSE gap healing 和 replay cursor 已形成闭环。
- diagnostic taxonomy、canonicalization、Workspace/Langfuse projection 和 readiness 已补齐。
- diagnostic JSON/ZIP 默认不导出 settings；显式请求只返回无凭据统计摘要。导出 clientId 只接受规范化 header，浏览器使用带 header 的 GET/blob 下载。
- 浏览器旧 planner、prompt、continuation、remote AgentEvent/controller 路径和退役 runtime 包装层已删除；浏览器只发送和投影 v2 DTO。
- 退役模块、无引用导出和浅包装已删除；禁止 v1/旧配置/旧接口的边界测试已建立。

## 2. 自动化验证结果

### web-workspace

- Vitest：74 个文件、866 个用例通过。
- Node workspace scenarios：34/34 通过。
- 真实 PostgreSQL：15/15 通过，零跳过。
  - exact schema：5
  - durable store：9
  - readiness failure/recovery：1
- 真实 Redis：27/27 通过，零跳过。
  - queue/claim/cancel/reclaim：20
  - live event bus：3
  - outbox dispatcher：3
  - durable SSE healing：1
- 正负十年 worker wall-clock skew 用例通过，证明 Redis lease/cancel 语义使用 Redis 权威时间。
- source mirror 全跟踪审计：5/5 通过；TS/JS/source-map 无漂移或 orphan。

### 隔离构建与应用

- 真实 Docker BuildRunner integration：2/2 通过。
  - 允许白名单 registry；拒绝直连、非白名单域名和字面 IP。
  - 成功和失败路径均清理命名 container/network/volume。
- pi-coding-web：43 个文件、242 个用例通过，零跳过。
- root `npm run check`：通过。
  - Biome 2.3.5：836 个文件，无修复。
  - root/web-workspace/web-ui/pi-coding-web TypeScript checks：通过。
  - browser smoke：通过。
- web-workspace build、worker TypeScript build、前端 Vite production build：通过。
- clean worker build 后不再包含已删除的 legacy planner、prompt、remote controller 或 continuation 产物。

### 仓库与部署完整性

- `git diff --check`：通过。
- 普通 Compose config：通过。
- cutover profile Compose config：通过。
- `docker/pi-coding-web` 相对基线零 diff；本地验证未修改远程内网部署配置。
- 原 `vibecoding-platform` 工作树保持在 `a029e9c`；Phase 1–9 旧 worktree 目录和本地旧分支已清理，只保留原工作树和 Phase 10 worktree。
- `readme-update-zh.md` 已更新为当前 v2 开发、运行和验证说明；过时过程文档已收敛。

## 3. 独立复审

整分支首次复审发现 0 Blocker、2 Important：

1. diagnostic export 可能泄露 settings/provider credentials，且 query clientId 可选择租户；
2. Redis claim/reclaim/cancel 混用 worker wall clock 与 Redis time。

对应修复提交：

- `5bcf2cd fix(web-workspace): use redis time for lease ownership`
- `cacdfb3 fix(web): secure diagnostic export boundaries`
- `c996fda test(web-workspace): stabilize redis clock skew coverage`

同一独立 reviewer 复审结论：**APPROVED**。两个 Important 均关闭；指定高风险修复范围内 0 Blocker、0 Important、0 Minor。整分支首次复审未发现其他 Blocker/Important。

## 4. 非阻塞观察

- 前端 production build 仍报告 KaTeX 字体运行时解析、LM Studio browser externalize 和大 chunk 警告；不影响当前构建成功，后续可单独做性能与资源优化。
- pi-coding-web 的少数 Lit/DOM 动态导入用例在高并发机器上接近默认 10 秒预算；最终全量使用 30 秒 hook/test timeout 后 242/242 通过，断言与功能未失败。
- SSE 慢消费者的 `res.write()` backpressure 仍值得在手动断线/重连测试中观察；durable replay 与 gap healing 已覆盖正确性主路径。

## 5. 手动 E2E 准入与顺序

自动 preflight 已满足进入手动 E2E 的门槛。建议严格按以下顺序执行：

1. 确认本地 Docker PostgreSQL/Redis healthy，并记录初始状态。
2. 从源码启动 web 与 worker，验证 readiness 和启动失败策略。
3. 执行 local cutover rehearsal。
4. 使用真实模型生成一个小型完整静态应用。
5. 检查 task graph、artifact index、build、validation、preview 和 durable events。
6. 注入可修复错误，验证 diagnostic → repair → revalidate。
7. 验证 worker crash/restart/reclaim，确认无重复执行或遗留 claim。
8. 验证 cancel、SSE 断线重连和 durable replay。
9. 形成最终真实 E2E 验收报告。

在用户明确确认前，不推送、不合并回 `vibecoding-platform`，也不启动真实模型或 cutover E2E。
