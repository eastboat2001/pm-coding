# 系统设计文档

> 本文档基于“个人项目管理看板”需求对话整理，旨在指导研发团队基于 Vite + React 技术栈完成纯前端 MVP 开发。

## 1. 范围与目标

### 1.1 项目背景
开发一个轻量级的个人项目管理工具，解决个人用户在多项目并行时任务进度不直观、延期提醒不及时的问题。

### 1.2 核心目标
- 实现基于 Web 的“零后端”任务管理。
- 提供拖拽式看板交互体验。
- 通过自动化逻辑（延期标记、状态联动）降低用户维护成本。

### 1.3 范围界定
- **包含**：Vite + React 前端开发、localStorage 持久化、拖拽交互、统计分析、演示数据初始化。
- **不包含**：后端 API、数据库服务器、用户注册登录、多端同步、文件附件存储。

## 2. 用户角色与参与方

| 角色 | 描述 | 主要诉求 |
| :--- | :--- | :--- |
| **个人用户** | 独立开发者或学生等需要管理个人事务的人群 | 简单、快速记录任务，直观看到哪些项目快到期了 |

## 3. 系统用例

## 3.1 用例：任务状态流转（拖拽）
- **参与者**：个人用户
- **触发条件**：用户在看板上点击并拖动任务卡片
- **前置条件**：看板已加载任务数据
- **主流程**：
    1. 用户选中“待办”列中的某个任务卡片。
    2. 用户将其拖拽至“进行中”或“已完成”列。
    3. 系统识别目标列状态，更新该任务的 `status` 属性。
    4. 系统重新计算右侧统计面板数据。
    5. 系统将更新后的全量数据写入 `localStorage`。
- **备选/异常流程**：若拖拽至非有效区域，卡片回弹，数据不更新。
- **后置条件**：界面显示任务已移至新列，统计数值实时更新。
- **验收检查点**：刷新页面后，任务位置保持在拖拽后的目标列。

### 3.2 用例：项目状态联动完成
- **参与者**：个人用户
- **触发条件**：用户将项目状态修改为“已完成”
- **前置条件**：该项目下存在多个处于“待办”或“进行中”的任务
- **主流程**：
    1. 用户在项目编辑弹窗或列表中点击“标记完成”。
    2. 系统更新项目实体状态为 `Completed`。
    3. 系统遍历所有 `projectId` 等于当前项目的任务。
    4. 系统将这些任务的 `status` 统一修改为 `Done`。
- **后置条件**：看板中该项目的所有任务卡片均移动至“已完成”列。
- **验收检查点**：全局视图下，该项目的任务状态也同步更新。

## 4. 功能需求

### 4.1 项目管理
- 支持项目的 CRUD（增删改查）。
- 优先级定义：低 (Low)、中 (Medium)、高 (High)。
- 级联删除：删除项目必须同步清理 `tasks` 数组中关联的所有任务。

### 4.2 任务管理
- 支持任务的 CRUD。
- 延期自动判定：`isOverdue = (currentDate > deadline) && (status != 'Done')`。
- 标签系统：支持为一个任务添加多个文本标签。

### 4.3 看板与视图
- **单项目视图**：仅展示当前选中项目的任务。
- **全局视图**：聚合展示所有项目的任务，卡片上需显示所属项目名称。
- **三栏布局**：待办 (Todo)、进行中 (In Progress)、已完成 (Done)。

### 4.4 统计分析
- 实时计算：项目总数、任务总数、完成率、延期任务数。

## 5. 非功能需求
- **性能**：在 500 条任务数据内，拖拽响应延迟 < 50ms。
- **持久化**：所有写操作必须同步触发 `localStorage` 更新。
- **易用性**：全中文界面，支持响应式布局（优先适配 PC 端）。
- **可靠性**：应用崩溃或刷新不应导致已保存的数据丢失。

 6. 高层架构设计

系统采用**单体前端架构**，不依赖任何后端服务。

- **UI 层**：React + Tailwind CSS。
- **状态管理层**：React Context API (用于全局数据共享) + 自定义 Hooks (用于逻辑复用)。
- **持久化层**：封装 `StorageService` 操作浏览器 `localStorage`。
- **交互层**：`dnd-kit` 处理拖拽逻辑。

## 7. 模块职责划分

| 模块名称 | 职责描述 |
| :--- | :--- |
| **StorageProvider** | 负责从 localStorage 读取/写入数据，提供全局状态。 |
| **ProjectSidebar** | 渲染项目列表，处理项目切换及增删改。 |
| **KanbanBoard** | 核心交互区域，管理三个状态列的渲染。 |
| **TaskCard** | 渲染单个任务，包含延期高亮逻辑。 |
| **StatsPanel** | 计算并展示汇总数据，提供全局筛选过滤功能。 |
| **MockDataService** | 当检测到初次访问时，注入演示数据。 |

## 8. API 设计（前端 Service 草案）

由于无后端，此处定义内部 `DataService` 方法：

- `getProjects(): Project[]`
- `saveProject(project: Project): void`
- `deleteProject(projectId: string): void`
- `getTasks(projectId?: string): Task[]` (支持可选过滤)
- `updateTaskStatus(taskId: string, newStatus: string): void`

## 9. 数据模型与数据库设计

虽然使用 `localStorage`，但数据结构需遵循关系型逻辑。

### 9.1 实体定义

#### 表：Projects (项目)
| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | PK, Unique | 建议使用 UUID 或 Date.now() |
| name | string | Not Null | 项目名称 |
| description| string | - | 项目描述 |
| priority | string | Enum | Low, Medium, High |
| deadline | string | ISO Date | 截止日期 |
| status | string | Enum | Active, Completed |

#### 表：Tasks (任务)
| 字段 | 类型 | 约束 | 说明 |
| :--- | :--- | :--- | :--- |
| id | string | PK, Unique | 任务唯一标识 |
| projectId | string | FK (Projects.id) | 所属项目 ID |
| title | string | Not Null | 任务标题 |
| content | string | - | 任务详细说明 |
| assignee | string | - | 负责人 |
| priority | string | Enum | Low, Medium, High |
| deadline | string | ISO Date | 截止日期 |
| status | string | Enum | Todo, InProgress, Done |
| tags | string[] | - | 标签数组 |

### 9.2 数据约束与一致性
- **级联删除**：在 `deleteProject` 方法中，必须显式执行 `tasks = tasks.filter(t => t.projectId !== deletedId)`。
- **状态同步**：在 `updateProjectStatus` 为 `Completed` 时，必须循环更新关联任务。

## 10. 关键流程 / 时序说明

### 10.1 初始化流程
1. 应用加载 -> 检查 `localStorage.getItem('kanban_data')`。
2. 若为 `null` -> 调用 `MockDataService` 生成演示 JSON -> 写入存储 -> 渲染。
3. 若存在数据 -> 解析 JSON -> 存入 React Context -> 渲染。

### 10.2 拖拽更新流程
1. `onDragEnd` 触发 -> 获取 `active.id` (任务ID) 和 `over.id` (目标列ID)。
2. 调用 `updateTaskStatus` -> 更新内存中的 `tasks` 数组。
3. 触发 `useEffect` 监听数据变化 -> 自动执行 `localStorage.setItem`。

## 11. 安全、隐私与合规
- **数据隐私**：所有数据仅存储在用户本地浏览器，不上传至任何服务器。
- **安全建议**：在界面显著位置提示用户“清理浏览器缓存将导致数据丢失”。

## 12. 可观测性与运维
- **日志**：在开发环境下记录每一次 `localStorage` 的写操作。
- **错误处理**：使用 React Error Boundary 捕获渲染错误，防止因数据格式异常导致白屏。

## 13. 部署与环境规划
- **开发环境**：Vite Dev Server (Localhost)。
- **生产环境**：静态资源托管（如 GitHub Pages, Vercel 或 Netlify）。
- **构建命令**：`npm run build` 生成 `dist` 目录。

## 14. 测试与验收方案
- **单元测试**：针对 `calculateStats` 和 `checkOverdue` 等纯函数进行逻辑测试。
- **集成测试**：手动验证拖拽后刷新页面，数据是否保持一致。
- **验收标准**：
    - [ ] 成功加载演示数据。
    - [ ] 能够创建新项目并立即在左侧列表看到。
    - [ ] 拖拽任务卡片到“已完成”列，右侧“完成率”上升。
    - [ ] 超过截止日期的任务显示红色“已延期”标签。

## 15. 风险、权衡与假设
- **风险**：`localStorage` 有 5MB 容量限制。
- **权衡**：为了保持 Demo 的轻量性，放弃了复杂的状态管理库（如 Redux），改用 Context API。
- **假设**：假设用户使用的浏览器支持现代 ES6+ 语法及 `localStorage` API。

## 16. 里程碑与交付计划
1. **Phase 1**：项目脚手架搭建与数据模型定义。
2. **Phase 2**：左侧项目列表与右侧统计面板开发。
3. **Phase 3**：中间看板及拖拽功能集成。
4. **Phase 4**：自动化逻辑（延期、联动）与样式优化。

## 17. 待确认问题 / 缺失输入
- **TBD**: 是否需要提供“导出/导入数据”功能（JSON文件），以防用户更换浏览器？
- **TBD**: 任务卡片是否需要支持点击展开查看详情弹窗？（当前默认为简单编辑模式）
- **TBD**: 截止日期是否需要精确到小时分钟，还是仅日期？（建议仅日期）