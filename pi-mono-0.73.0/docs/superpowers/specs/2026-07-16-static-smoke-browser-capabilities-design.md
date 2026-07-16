# Static Smoke Browser Capabilities Design

## 背景

Agent v2 的静态预览校验通过 Node `vm` 和轻量 DOM 模型执行应用启动脚本。该模型当前把所有元素都表示为 `SmokeElement`，没有 Canvas API。标准的 `canvas.getContext("2d")` 因此被错误识别为应用脚本异常，触发三轮无效修复，最终只向用户显示 `Agent v2 task graph is blocked.`。

同一执行模型还有两个高影响风险：递归 `requestAnimationFrame` 会耗尽固定的 50 次回调上限并被误判为失败；DOM 事件和定时器回调从宿主直接调用，没有应用 `vm` 超时，错误代码可能长期占用 Worker。

## 目标

- 让使用标准 Canvas 2D API 的静态应用通过启动校验。
- 保持语法错误、空引用、API 拼写错误和真实运行时异常严格失败。
- 有界执行持续动画，不把正常动画循环误判为无限任务。
- 对所有应用回调应用执行超时，避免 Worker 被无限循环阻塞。
- 让终态错误包含首要校验原因，而不是只显示任务图阻塞摘要。

## 非目标

- 不实现像素级 Canvas 渲染或视觉正确性比较。
- 不用通用 Proxy 吞掉任意未知属性或方法。
- 不在本次改造中引入 Playwright、浏览器进程或新的运行时依赖。
- 不弱化静态资源授权、路径安全和现有质量规则。

## 方案

### 1. 明确的 Canvas 适配器

`SmokeDocument.createElement()` 根据标签创建专用元素。Canvas 元素提供 `getContext("2d")`，返回轻量、无像素输出的 2D 上下文；上下文显式实现生成应用常用的状态属性、路径、矩形、文本、变换和保存恢复方法。`getContext()` 对未知上下文类型返回 `null`，与浏览器契约保持一致。

元素模型解析并暴露 `width`、`height` 等 Canvas 数值属性。动态创建的 Canvas 使用浏览器默认尺寸 300×150。实现不提供任意方法兜底，因此 `getContex()` 等拼写错误仍产生真实脚本异常。

### 2. 有界启动调度器

定时任务区分一次性任务和持续任务：

- `setTimeout` 属于一次性任务，允许在启动阶段继续产生有限的后续一次性任务。
- `setInterval` 和 `requestAnimationFrame` 属于持续任务，每个注册项在启动校验中最多执行一次。
- 持续任务产生的新一帧或下一周期不会被当作错误；校验器记录已观察到持续运行，然后停止启动期采样。
- 一次性任务超过现有安全上限仍然失败，以保留对失控启动逻辑的保护。

### 3. 回调执行隔离与超时

DOM 事件、Window 事件和定时器回调不再由宿主直接调用。回调注册到 VM 上下文内的受控槽位，由 `Script.runInContext()` 在现有 `scriptTimeoutMs` 下执行。超时被记录为真实 `static.script_error`，并携带回调阶段信息。

这保证初始脚本、事件处理器和定时任务具有一致的资源边界。

### 4. 能力缺口分类

仅对平台明确登记、但暂未完整模拟的标准浏览器能力使用专用 `UnsupportedSmokeCapabilityError`。Smoke Gate 将该错误转换为 warning，不进入模型修复循环。普通 `TypeError`、`ReferenceError`、未知方法和业务异常继续进入 errors。

本次只登记有明确调用入口且能安全识别的能力，不基于错误字符串猜测，不使用通用 Proxy。

### 5. 终态错误传播

当校验在最大尝试次数后失败，Worker 从失败任务或最近一次 validation diagnostic 提取首要原因，生成包含根因的终态消息。任务图状态码保持不变，便于现有调用方兼容；用户可见文本不再只有 `Agent v2 task graph is blocked.`。

## 数据流

1. Static Gate 读取并授权 `index.html` 与本地资源。
2. Smoke Runtime 构造显式浏览器能力适配器和受控调度器。
3. 初始脚本、事件和定时器都在同一 VM 超时边界内执行。
4. 真实错误进入 validation failures；已登记能力缺口进入 warnings；持续任务在有限采样后停止。
5. Validation Gate 保存结构化失败原因。
6. Repair Engine 只对真实、可修复的应用错误安排修复。
7. 达到终态时，Worker 将首要失败原因附加到用户可见错误。

## 测试设计

在 `packages/web-workspace/test/static-preview-smoke-gate.test.ts` 中按 TDD 增加：

- 当前贪吃蛇同构的 Canvas 启动脚本可以取得 2D context 并调用常用绘图 API。
- Canvas 的 HTML 尺寸属性和默认尺寸可用。
- 拼写错误的 Canvas 方法仍然失败。
- 自递归 `requestAnimationFrame` 只采样有限帧且不产生队列耗尽错误。
- 失控的一次性定时任务仍然失败。
- DOMContentLoaded 和定时器中的无限循环在超时后失败，不阻塞测试进程。
- 明确登记的能力缺口产生 warning；普通业务异常仍产生 error。

在 Worker/validation 测试中增加：

- 最终阻塞错误包含 `canvas.getContext` 或其他首要 validation failure。
- 状态码和任务终态保持原有契约。

## 验证范围

- 运行修改过的专项测试文件。
- 运行 `packages/web-workspace` 类型检查。
- 按仓库要求运行根目录 `npm run check`，读取完整输出。
- 使用失败会话中的最终 `index.html` 作为本地 Smoke Gate 回归样本。

## 风险控制

- Canvas 上下文仅做行为兼容，不声称验证视觉结果。
- 新增 API 必须显式实现和测试，避免隐藏拼写或业务错误。
- 回调超时沿用现有配置，不引入第二套超时来源。
- 不修改用户生成项目文件，不停止用户当前服务。
