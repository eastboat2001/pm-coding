# Application Generation Agent v2 Phase 10 Preflight 架构与代码审查

**日期：** 2026-07-10

**审查基线：** `vibecoding-platform` / `a029e9c5eb46f505b4c6cb8475e79866627fe0ab`

**审查方式：** 只读静态审查、CodeGraph 依赖分析、引用搜索、导出边界与现有测试证据核对

**结论：** 当前不具备进入真实模型 E2E 的条件。先完成安全与真实 v2 主链，再修复可靠性并删除遗留代码，最后才进入 E2E。

## 1. 范围与约束

本次审查覆盖：

- v2 模块边界、依赖方向和公共 Interface；
- schema/store/reset、run API、状态机、task graph、artifact index；
- validation、repair、revalidate 闭环；
- Redis claim token、uncertain commit、连接隔离、cancel、关闭期限；
- worker heartbeat、崩溃恢复、reclaim、stop 竞态；
- durable event、Redis live stream、SSE replay 与断线恢复；
- diagnostics taxonomy、脱敏、归档与 Langfuse；
- static build、preview readiness、路径安全；
- browser/server/worker 类型边界；
- 配置、废弃变量、启动失败策略；
- 死代码、无引用导出、重复 adapter、生成镜像约定和测试真实性。

审查严格遵守以下边界：

- Application Generation Agent v2 是唯一正式生成运行时；
- 不恢复或重新引入 v1 兼容路径、双版本 feature flag、旧 prompt/spec/plan/tasks、preview goal continuation、旧 repair 或旧内部 Interface；
- 不迁移旧 run/session/message/app preview goal/diagnostic 数据；允许破坏式 schema reset；
- 旧调用者必须迁移到 v2，不能通过恢复旧模块解决；
- 不修改 `docker/pi-coding-web` 远程部署配置；
- 不读取或输出 `.env` 中的密码、Token 或 API Key；
- 本阶段未运行测试、构建或真实 E2E，也未修改生产代码。

仓库未提供 `CONTEXT.md` 或 `docs/adr/`。本次领域语言与架构意图主要来自 Phase 3 至 Phase 9 的 specs/plans、代码 Interface 和测试命名。

## 2. 审查方法与 CodeGraph 状态

隔离 worktree 中 CodeGraph 已重建并处于最新状态：

- 934 files；
- 17,327 nodes；
- 48,778 edges；
- 状态：`Index is up to date`。

每个删除候选均同时检查：CodeGraph impact/callers、全文引用、package/export 边界、正向或负向测试，以及 TS/JS/source-map 镜像关系。仅有“看起来重复”不构成删除依据。

严重性定义：

- **Blocker：** 会使真实 E2E 名不副实、暴露高风险安全边界，或导致 run/event/claim 无法保持基本正确性；
- **Important：** 不一定立即阻断最小 happy path，但会破坏生产可靠性、可诊断性、跨平台行为或 v2-only 边界；
- **Minor：** 当前不造成主要故障，但保留了误导 Interface、无效抽象或可维护性债务。

## 3. Blocker Findings

### B1. 生产 startRun 没有持久化 planning bootstrap，worker 可在空 task graph 上结束

- 证据：`packages/web-workspace/src/agent-v2-run-api-service.ts:54-83` 的 `startRun()` 执行 create、enqueue 和 event append，但没有调用 planning bootstrap；`apps/pi-coding-web/src/worker/main.ts:52` 直接构造生产 execution；`packages/web-workspace/src/agent-v2-execution-core.ts:35` 在无可执行 task 时返回 `complete/no_task`。
- CodeGraph/引用：`persistAgentV2PlanningBootstrap` 只有测试或显式编排调用，没有进入生产 `startRun -> queue -> worker` 调用链。
- 测试缺口：production-chain 测试注入了测试专用 `SequencedExecution`，没有证明生产 startRun 会生成并持久化 task graph。
- 影响：API 可成功创建并入队一个没有 capability/spec/plan/tasks 的 run；worker 随后把“没有任务”当作完成。真实 E2E 即使表面成功，也不能证明 v2 主链正确。
- 要求：在 enqueue 前完成 v2 planning bootstrap，并定义失败时的事务/补偿与重试幂等语义；不能依赖旧 planner 或旧 goal continuation。

### B2. 生产 worker 没有真实模型生成，implementation task 只写固定 HTML

- 证据：`packages/web-workspace/src/agent-v2-execution-core.ts:90` 的 implementation 路径写入 deterministic `index.html`；`apps/pi-coding-web/src/worker/main.ts:52` 的生产组装没有模型执行 Adapter。
- 引用边界：run request 接收 `model`、`attachments` 和 `projectFiles`，但 worker execution 没有消费这些输入来驱动生成。
- 测试缺口：当前测试证明 deterministic core 的状态变化，不证明 provider 调用、结构化输出、工具执行或真实 artifact 生成。
- 影响：“真实模型生成一个小型完整静态应用”没有可执行生产路径，现阶段运行只会验收样板实现。
- 要求：建立 v2 原生 ModelExecution Interface，并让 production worker 使用真实 Adapter、测试使用 fake；不得复用旧 Agent runtime、旧 prompt 或旧 continuation。

### B3. repair 只被规划，没有执行，revalidate 对未改变的 artifact 重跑

- 证据：`packages/web-workspace/src/agent-v2-execution-core.ts:192-221` 创建 diagnostic 与 `repairActions`，随后把 validation task 重新置为 ready，但没有执行 repair action 修改 artifact。
- 状态影响：validation history 被后续结果覆盖，artifact `validationStatus` 也没有形成明确的 `not_started → pending → passed/failed → accepted` 闭环。
- 测试缺口：测试验证“产生 repairActions”和“再次 validation”，没有断言 artifact 在两次 validation 之间发生预期变更。
- 影响：可修复错误无法闭环；E2E 中的 diagnostic → repair → revalidate 场景必然是假修复或循环。
- 要求：repair 必须是 v2 task graph 中的显式执行阶段，输出变更集、关联 diagnostic/artifact，并只在变更成功后 revalidate。

### B4. Preview 与文件 IO 只做词法 containment，可通过元数据或符号链接越界

- 证据：`packages/web-workspace/src/workspace-preview-service.ts:92` 信任 `.pi-project.json` 的 `serveRoot`；`:115` 请求时只做词法检查；`workspace-file-service.ts:90-105,121-155` 的读写同样只做词法 containment；`workspace-paths.ts:145` 的 `assertInside` 不解析符号链接。
- 触发：生成内容改写内部元数据，或构建/install script 在项目内创建指向外部的 symlink。
- 测试缺口：`workspace-project-hardening.test.ts:42` 只覆盖 URL 直接读取内部元数据；`preview-readiness-checker.test.ts:138` 只覆盖 readiness 拒绝外部 `serveRoot`，没有请求时 realpath、symlink 读写或元数据篡改用例。
- 影响：preview/file seam 可读取或写入进程账户可访问的项目外文件。
- 要求：禁止 agent/file Interface 访问内部元数据；请求时验证可信 serve root；已有目标使用 realpath containment，新建目标验证最近存在父目录的 realpath。

### B5. Static validation 使用固定反斜杠判断 containment，Linux/Docker 多文件应用会误判

- 证据：`packages/web-workspace/src/static-preview-quality-gate.ts:223` 与 `static-preview-smoke-gate.ts:619` 使用 Windows 分隔符假设；调用位于 `workspace-task-service.ts:94-99`。
- 触发：Linux 上 HTML 引用 `./app.js` 或其他相对静态资源。
- 测试缺口：`static-preview-quality-gate.test.ts:22` 与 `static-preview-smoke-gate.test.ts:22` 只使用宿主 OS 路径，没有 POSIX separator/跨平台 fixture。
- 影响：Compose/Linux 上常见 HTML/CSS/JS 多文件产物可能被判越界或无法读取，导致 delivery validation 失败。
- 要求：共用 `resolve + relative + sep` 的跨平台 containment Module，并与真实路径安全规则一致。

### B6. Durable append 与 Redis live publish 被当作一个同步提交，失败会制造不确定状态

- 证据：`packages/web-workspace/src/agent-v2-run-event-log.ts:20-23` 先 durable append 后同步 publish；`agent-v2-run-api-service.ts:54-83` 先 enqueue 再写创建事件；`agent-v2-worker-service.ts:134-155` 中 event publish 异常仍会进入 finally 完成 claim；Redis publish 位于 `agent-v2-run-event-bus.ts:128-145`。
- 触发：DB append 成功，但 Redis `XADD`/`EXPIRE` 失败或结果不确定。
- 测试缺口：event-log、run-api、SSE 测试只覆盖成功 publish 或 read 失败，没有 enqueue 成功后 publish 失败、worker phase publish 失败和 uncertain commit。
- 影响：HTTP 对已入队 run 返回失败、客户端重试创建重复 run；worker 已写 `running` 后失去 claim；事件因果顺序倒置；当前 SSE 连接出现永久 hole。
- 要求：以 durable store 为事实源，live publish 必须可恢复、可重放且不能决定 run/claim 成败；可采用 outbox 或显式 best-effort + gap healing，但必须有故障测试。

### B7. v2 diagnostics 可原样入库与归档，现有脱敏函数没有生产 caller

- 证据：`packages/web-workspace/src/agent-v2-diagnostics.ts:72-149` 中只有 `toWorkspaceDiagnosticEvent()` 调用 sanitizer；CodeGraph 显示该函数生产 callers 为 0。raw diagnostic 由 `runtime-db.ts:1441-1473`、`postgres-runtime-store.ts:1617-1650` 持久化，并由 `diagnostic-export-service.ts:163-170,809-830` 原样导出。
- 测试缺口：`agent-v2-diagnostics.test.ts:71-112` 仅手工调用转换函数后验证脱敏；归档测试没有 secret assertion。
- 影响：validation、repair、命令输出或未来 provider 错误中的 API key、authorization、cookie、token 可能进入数据库和 NDJSON 归档。
- 要求：在任何持久化、live event、日志和导出之前统一规范化与脱敏；同一已脱敏 taxonomy 再 fan-out 到 v2 store、Workspace diagnostics 和 Langfuse。

### B8. 默认 build_static 配置自相矛盾，且 install/build 执行缺少不可信代码隔离

- 证据：`packages/web-workspace/src/config.ts:75` 默认包含 `npm install` / `npm run build`；`workspace-task-service.ts:230` 明确拒绝 package-script 命令，因此默认 `npm run build` 与 guard 冲突；`workspace-command-service.ts:76` 使用 `shell: true` 并继承完整 `process.env`。即使 package-script guard 拒绝 build，`npm install` 仍会执行 dependency lifecycle scripts。
- 测试缺口：`workspace-project-hardening.test.ts:18` 只覆盖已知黑名单命令，没有 lifecycle、最小环境、网络/文件系统隔离和 symlink side effect。
- 影响：默认路径可能无法完成 build；若放宽 guard 则会把生成项目当作可信宿主命令执行；当前 install 仍可能执行不可信 lifecycle script 并读取服务环境。
- 要求：先明确不可信生成代码的威胁模型，再采用隔离 runner、最小环境、资源/时间限制与明确的 install-script 策略；不能只扩充字符串黑名单。

## 4. Important Findings

### I1. Browser 仍保留旧 planner/context/prompt/AgentEvent 语义

- `apps/pi-coding-web/src/app/bootstrap.ts:3,63,76,622-628,1435-1463` 仍组装 capability planner、旧 system prompt、remote resume 与旧消息上下文；
- `apps/pi-coding-web/src/runtime/remote-agent-controller.ts:55,80` 把 v2 event payload 强制转换为旧 `AgentEvent`；
- `apps/pi-coding-web/src/runtime/remote-resume.ts:29` 仍实现 toolResult continuation，并由 `bootstrap.ts:1060` 调用。
- 影响：浏览器展示与控制逻辑仍依赖旧 runtime event shape，掩盖 v2 Interface 缺失，并可能在切换中继续生成旧 continuation 行为。
- 处理：先建立 v2 browser projection/controller 边界与行为测试，再迁移调用者并删除旧模块；不可直接删仍在用的 `remote-resume.ts`。

### I2. run/task/artifact 状态约束不足

- task 更新没有集中 transition matrix；run phase 长期停留在 `intake`；artifact `validationStatus` 没有随 validation/repair 闭环更新；validation history 被覆盖而非追加。
- 影响：非法状态跃迁难以诊断，UI/SSE 无法准确展示真实阶段，崩溃恢复也缺少可判定状态。
- 处理：以 store CAS + 明确 transition table 保护状态；phase、task、artifact、validation record 在同一业务动作中保持一致。

### I3. heartbeat/cancel Promise rejection 未处理且 interval 可能重叠

- 证据：`packages/web-workspace/src/agent-v2-worker-service.ts:249-262`；worker fatal handler 位于 `apps/pi-coding-web/src/worker/main.ts:244-264`。
- 测试只覆盖 `renewLease()` 返回 false，没有 Redis reject 和重叠 tick。
- 影响：Redis 瞬时错误可升级为进程级 unhandled rejection，run 未经受控 interrupt，只能等待 reclaim。

### I4. reclaim 先删 claim 再 re-enqueue，跨系统失败会丢 queued work

- 证据：`agent-v2-run-queue.ts:152-172` 先删除 expired claim；`agent-v2-worker-service.ts:405-420` 后读 DB 并 re-enqueue；`:438-444` 吞掉恢复错误。
- 影响：中途崩溃或 enqueue 失败后，DB 仍为 queued，但 queue 与 active claim 都不存在，后续 maintenance 无对象可恢复。

### I5. 并发 claim 共用 Redis claim client

- 证据：`agent-v2-run-queue.ts:355-370,544-570,592-620`。
- 影响：某一 blocking claim 的 deadline/disconnect 可同时打断同连接的其他 pending claim；fake client 测试不能证明真实 node-redis socket 语义。

### I6. shutdown deadline 不完整，Langfuse drain 可挂起或漏批次

- event bus：`agent-v2-run-event-bus.ts:147-200,220-233,259-290`；
- queue：`agent-v2-run-queue.ts:491-519,616-630`；
- worker shutdown：`apps/pi-coding-web/src/worker/main.ts:166-197`；
- Langfuse：`langfuse-exporter.ts:138-176`。
- 影响：connect/read/fetch 卡住可阻止安全终止；已有 flush 时再次 `flush()` 直接返回可能漏掉 in-flight batch。

### I7. SSE 连接建立后不会主动修补 durable hole

- 证据：`packages/web-workspace/src/vite-plugin.ts:814-855` 只在连接开始读取一次 durable store，之后依赖 live stream。
- 影响：连接期间 DB 成功、Redis publish 丢失的 seq 只会在客户端断线重连后补回；当前连接可能长期漏掉终态或 diagnostic。
- Minor companion：server 只写 `data:`，不提供标准 `id:`/`Last-Event-ID`；自有 client 能用 `afterSeq` 恢复，但标准 EventSource 不能。

### I8. v2 diagnostic taxonomy 没有接入 Workspace diagnostic/Langfuse

- `agent-v2-worker-service.ts:164-190` 只写 v2 store/event；`diagnostic-log-service.ts:201-207` 的 Langfuse 队列只接 Workspace diagnostic。
- 影响：能看到 worker process lifecycle，却看不到 validation/repair/task_graph/worker 的 v2 run diagnostics。

### I9. 真实 Redis integration 覆盖不足

- `run-queue-redis.integration.test.ts:17-89` 由 `PI_TEST_REDIS_URL` 门控，只覆盖 basic FIFO、同 worker restart recovery 与 drain interruption；
- `RedisAgentV2RunEventBus` 没有真实 Redis integration；
- 缺失 claim token uncertain commit、并发 deadline/socket disconnect、cancel TTL/prune、lease expiry delete→enqueue、event publish/read/close 和 SSE hole repair。
- 处理：Phase 10 preflight 必须连接 Docker 中本地 Redis运行这些语义测试，不得继续跳过。

### I10. Web readiness 不探测 Redis

- `packages/web-workspace/src/vite-plugin.ts:73,139` 只构造 Adapter，首个请求才触发 schema 初始化；`:483` 的 `/status` 不探测 Redis；远程 Compose healthcheck 只请求该端点。
- 影响：服务可显示 healthy，但所有 run/event 请求到达时才失败。
- 处理：在源码 Web 启动或 dependency readiness 中显式探测 store、queue 与 event bus。本项不授权修改远程 Compose 配置。

### I11. 当前配置非法值会静默回退

- `packages/web-workspace/src/config.ts:64` 把任何非 `sqlite` 值当 PostgreSQL；`:197-220` 将非法数值/布尔静默替换默认值。
- 影响：拼写错误可能选择错误存储或意外并发/TTL；与 retired-variable fail-fast 策略不一致。
- 处理：只有未设置才采用默认值；显式设置但非法必须启动失败，并报告变量名但不输出 secret value。

### I12. Preview readiness origin 可受 Host 影响

- `workspace-preview-service.ts:328` 使用 Host/x-forwarded-proto 写 metadata；`preview-readiness-checker.ts:145` 只验证 pathname。
- 影响：未配置可信 preview base 时，可形成有限 SSRF 或错误探测。
- 处理：origin 必须来自可信配置或内部 server origin，并验证 protocol/host/port。

### I13. TS/JS/source-map mirror 没有单一生成与审计入口

- `packages/web-workspace/src` 有 56 个 TS、55 个 JS、55 个 map；55 组 map 均可解析、sourcesContent 与 TS 一致；唯一缺口是 `node-service-runtime.ts`。
- `packages/web-workspace/package.json:32` 的 build 输出到 `dist`，`tsconfig.build.json:4` 不会同步 `src` mirrors。
- 影响：长期存在 TS 与运行时 JS split-brain 风险。
- 处理：建立唯一 mirror generation/audit 命令，或正式停止提交 src mirrors 并统一从 TS/dist 解析；在决定前不得把 JS/map 当重复代码删除。

## 5. Minor Findings

- `packages/web-workspace/src/vite-plugin.ts:869,902` 的 v2 SSE 私有调用链仍接受 `RuntimeRunEventRecord | AgentV2RunEventRecord`，应在迁移测试后删除 v1 union/import；
- maintenance `.catch(() => undefined)` 吞掉 reclaim 故障，应产生 v2 taxonomy diagnostic；
- v2 task/artifact/validation event 类型存在但没有生产 producers，需决定补齐真实事件还是删除无效承诺；
- 多处 header、containment、状态投影逻辑重复，适合在真实调用链稳定后收敛为深模块，不应提前抽象出更多 pass-through Adapter。

## 6. 可删除代码清单

### 6.1 高置信度，可由边界测试保护后删除

| 候选 | CodeGraph impact / 引用 | 导出边界 | 测试证据 | 建议 |
|---|---|---|---|---|
| `packages/web-workspace/src/node-service-runtime.ts` | 仅本文件 6 个符号；`NodeServiceRuntime` 无 caller；全文无外部引用 | 不在 root barrel、v2 runtime 或 package exports | 无测试引用；且唯一没有 JS/map mirror 的 TS | 删除整个模块。未来若需要后端 runtime，重新设计隔离 seam，不保留未接线 shell runner |
| `packages/web-workspace/src/json.ts:60` 的 `cloneJsonObject` | callers 为 0；仅 TS/生成 JS 自身定义 | 未从 root barrel 或 subpath 导出 | 无测试引用 | 删除函数并通过正式 mirror 流程更新 JS/map |
| `apps/pi-coding-web/src/runtime/run-client.ts` 与专用测试 | `buildRunRequestHeaders` 无生产 caller；仅 `run-client.test.ts` 使用 | app private package，无 exports | 真实 v2 client 在 `agent-v2-run-client.ts:231` 有重复实现及独立测试 | 删除死模块和只为它存在的测试；若复用 header，命名为 v2 seam 并让真实 client 使用 |
| `packages/web-workspace/src/types.ts:76-86,117-131` 的旧 start/continuation DTO | 无生产 caller；类型只互相引用 | 未导出到任何 package entry | 只有 deny tests，无正向行为测试 | 按符号删除，不恢复旧 runtime-entry/types |
| `packages/web-workspace/src/types.ts:152-175` 中无连接的响应/worker DTO | 每个符号只影响自身 | 未从 package entry 导出 | 无正向测试，仅边界否定断言 | 逐个删除；不要连带删除仍被 store Interface 使用的类型 |

### 6.2 先迁移调用者或公共边界，再删除

| 候选 | 当前约束 | 删除门槛 |
|---|---|---|
| `apps/pi-coding-web/src/runtime/remote-resume.ts` | 生产 `bootstrap.ts:1060` 仍调用 | v2 browser controller 不再解析旧 toolResult continuation；边界测试禁止重新导入 |
| browser capability planner/context orchestrator/coding prompt 旧链 | 生产 bootstrap 仍组装并写 diagnostic | v2 原生 request/context/event projection 覆盖所有 UI 行为后迁移删除 |
| `getReadyAgentV2TaskIds` | 公开导出/测试契约仍存在 | 迁移消费者到唯一 task selection Interface，先加导出边界测试 |
| `AgentV2RunEventLog.readLive()` | CodeGraph 生产 caller 为 0，但类从 root 导出且有直接测试 | 确认无包外消费者，迁移/删除测试和公开方法 |
| `AgentV2RunStore` alias | 仍是导出类型并用于 API service 签名，虽然只表达浅别名 | 先迁移公开签名和消费者到唯一真实 store Interface，再用 public-surface test 保护删除 |
| `vite-plugin.ts` 中 v1 SSE union | 私有调用链仍声明旧 record 合法 | v2 SSE 类型测试固定后删 union/import，不删除仍被其他 legacy store 使用的全局类型 |
| provider-key legacy fallback | 有明确部署配置切换语义和测试 | 新部署配置切换并验证完成、且有 fail-fast 测试后再删；不得直接破坏部署输入，这不涉及旧业务数据迁移 |

### 6.3 明确不得删除或恢复

- `packages/web-workspace/src/agent-v2-types.ts` 是当前 v2 核心类型，不是已删除的旧 `apps/.../agent-v2/types.ts`；
- `toWorkspaceDiagnosticEvent()` 当前是缺失生产接线的安全能力，应该接入而不是删除；
- 已删除的 run-queue、run-event-bus、run-event-sink、run-retry-controller、retry-policy、legacy bridge、旧 runtime-entry/types 和 runtime-message-conversion 不得恢复；
- 所有 `src/*.js` 与 `src/*.js.map` 必须按 mirror 策略处理，不能因与 TS 同名就单独删除。

## 7. 已删除旧模块复核

以下禁止项均不存在，未发现生产导入：

- 旧 `run-queue`、`run-event-bus`、`run-event-sink`；
- `run-retry-controller`、`retry-policy`；
- `legacy-v1-agent-v2-run-event-bridge`；
- `apps/pi-coding-web/src/agent-v2/runtime-entry.ts`；
- `apps/pi-coding-web/src/agent-v2/types.ts`；
- `apps/pi-coding-web/src/runtime/runtime-message-conversion.ts`。

文本命中只来自 deny tests、retired-variable 拒绝常量和历史文档，不构成恢复理由。

## 8. 测试真实性审查

当前测试数量基线很强，但以下关键生产语义主要由 fake/mock 证明：

- production startRun 的 planning bootstrap；
- 真实 model provider 输入、生成与 artifact 落地；
- repair 实际修改 artifact 后 revalidate；
- node-redis 并发 blocking claim、disconnect 与 uncertain commit；
- event bus 真实 Redis publish/read/close；
- DB durable + Redis live 的故障组合与 SSE gap healing；
- symlink/realpath/metadata 越界；
- Linux 多文件静态应用验证；
- build lifecycle、环境隔离和 timeout；
- diagnostic 在 DB、SSE、archive、Langfuse 全路径脱敏；
- Web 启动/readiness 对 Redis 的真实依赖探测。

因此 Phase 10 preflight 不能以“现有全量测试继续通过”作为充分条件。必须先增加真实 Adapter 与故障注入测试，再执行删除和重构。

## 9. E2E 准入判定

当前判定：**NO-GO**。

只有同时满足以下条件，才可进入真实 E2E：

1. startRun 在 enqueue 前完成 v2 planning bootstrap，并有幂等/失败恢复测试；
2. production worker 真实消费 model/objective/attachments/projectFiles，并由 v2 ModelExecution Adapter 生成 artifacts；
3. diagnostic → repair → artifact change → revalidate 闭环可观测且可恢复；
4. preview/file/build 的越界与不可信执行风险有明确安全边界；
5. durable event、live publish、claim/reclaim、heartbeat、cancel 和 shutdown 的故障语义通过真实 Redis 测试；
6. diagnostics 在持久化、事件、归档和 Langfuse 前统一脱敏；
7. browser 不再把 v2 event 当旧 `AgentEvent`，不再执行旧 continuation；
8. 计划内删除完成且 CodeGraph、引用、exports、测试和 mirror 审计全部通过；
9. 全量验证门槛通过，独立 reviewer 无 Blocker/Important。

## 10. 建议实施顺序

1. **安全与真实 v2 主链：** 路径/preview/build 安全；startRun bootstrap；真实 model execution；状态与 repair 闭环；browser v2 projection。
2. **可靠性与可诊断性：** durable/live 解耦、SSE gap healing、claim/reclaim/heartbeat/cancel/shutdown、diagnostic redaction/Langfuse、readiness/config。
3. **删除与架构收敛：** 先补边界测试，再删除高置信度死代码；迁移 browser/公开导出后删除旧 seam；建立 mirror 单一来源。
4. **验证后才 E2E：** 全量测试、类型检查、build、真实 Redis、CodeGraph、diff check、独立 review 全部通过后，才执行 Phase 10 分层真实 E2E。
