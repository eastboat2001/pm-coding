# QDM Finished Lot 良率看板

## 项目概述

基于 PRD（需求文档-20260610-040506-405369.md）和系统设计文档（设计文档-20260610-040526-819718.md）实现的 **D.CHQ.QDM Finished Lot 良率看板** 静态前端应用。

为工厂管理层和工程师提供不同产品关键良率指标的高层视图，包含绩效趋势总览与缺陷损失占比分析两大核心页面。

---

## 如何运行

本项目为纯静态前端应用，无需安装依赖或启动服务器。

### 方法一：直接预览
打开 `index.html` 即可在浏览器中查看总览页面。

### 方法二：通过平台预览
通过 PI 平台 Preview URL 访问，无需任何本地操作。

---

## 功能清单

### 页面 1：绩效趋势总览 (index.html)
- **CH-01 成品良率总趋势**：折线+柱状图，展示 12 周 Yield 和 Output 趋势
- **KPI 卡片**：Yield/Target、Output(NSQM)、Finished Count、NSQM Loss
- **周次下钻**：点击趋势图柱体，联动更新右侧详情和 KPI
- **周详情面板**：展示选中周的 Yield、Output、Defects、Loss

### 页面 2：缺陷损失占比分析 (defect.html)
- **CH-02 缺陷损失排名 (Pareto)**：横向柱状图 + 累计百分比线，Top 10 缺陷代码
- **CH-03 责任部门分布**：环形图展示各责任部门的缺陷占比
- **CH-04 缺陷趋势对比**：折线图展示 Top 3 缺陷代码的 12 周趋势
- **缺陷下钻**：点击 Pareto 柱体，联动更新趋势图和部门分布图
- **缺陷统计摘要**：Total Defects、Core Loss Ratio (Top 5)、Top Department

### 统一筛选条件
- Customer（多选）
- Plant（多选）
- Date Type（Weekly / Monthly / Quarterly）
- Lot Type（All / HVM / EVT / DVT / PVT）
- Unit Type（All / NSQM / NSOM）
- Project Type（Overall / Product A-D）
- 筛选条件变更后图表异步刷新，不整页重载

### 导出功能
- CSV 导出
- Excel 导出
- 导出包含当前筛选上下文

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 结构 | HTML5 |
| 样式 | 自定义 CSS（遵循 AITC 企业标准配色） |
| 交互 | 原生 JavaScript (ES6+) |
| 图表 | Chart.js 4.4.0 |
| UI 框架 | Bootstrap 5.3.0 |
| 图标 | Bootstrap Icons 1.11.0 |
| 字体 | Inter (Google Fonts) |

---

## 数据模型

### FinishedLotSummary (DS-01 → MockData.yieldTrend)
| 字段 | 类型 | 说明 |
|------|------|------|
| week | String | 周标签 (W01-W12) |
| date | Date | 业务周期日期 |
| yield | Number | 成品综合良率 (%) |
| targetYield | Number | 目标良率 (96.5%) |
| inputQty | Number | 投入数量 |
| outputNSQM | Number | 产出值 (NSQM) |
| finishedCount | Number | 完成数量 |
| lossNSQM | Number | 损失值 |
| lotType | String | 批次类型 |
| unitType | String | 单位类型 |
| projectType | String | 项目类型 |
| defects | Array | 该周缺陷明细 |

### DefectSummary (DS-02 → MockData.defectAnalysis)
| 字段 | 类型 | 说明 |
|------|------|------|
| code | String | 缺陷代码 |
| name | String | 缺陷名称 |
| qty | Number | 缺陷数量 |
| department | String | 责任部门 |
| lossRatio | Number | 损失占比 (%) |
| coreLossRatio | Number | 核心损失占比 (%) |

---

## 良率计算逻辑

遵循 PRD 定义的连乘逻辑：
- 单工序良率：Process Yield = Output / Input
- 成品良率：Product Yield = ∏(Process Yield_i)
- 周汇总：基于周度总出货量与总投入量的比例

---

## 项目结构

```
├── index.html          # 绩效趋势总览页面
├── defect.html         # 缺陷损失占比分析页面
├── css/
│   └── style.css       # 主样式（AITC 企业标准）
├── js/
│   ├── data.js         # 模拟数据与 Mock API 服务层
│   ├── charts.js       # Chart.js 图表配置
│   └── app.js          # 主应用逻辑（筛选、联动、下钻）
├── docs/
│   ├── 需求文档-*.md    # PRD 文档
│   └── 设计文档-*.md    # 系统设计文档
└── README.md           # 本文件
```

---

## 已知假设与取舍

1. **数据源**：由于 PI 平台只交付静态前端，使用 JavaScript 内生成的模拟数据替代 SQLite 数据库查询。模拟数据覆盖 12 周、10 种缺陷代码、5 个责任部门。
2. **后端 API**：设计文档中的 C# ASP.NET Core API 以 `MockData` 模拟服务层替代，包含人工延迟模拟网络请求。
3. **认证授权**：模拟数据中未实现 RBAC 角色权限控制，导出功能对所有用户开放。
4. **多选筛选**：Customer 和 Plant 的多选筛选器在当前模拟数据下不做过滤（所有数据都属于 "All"），因源数据未按 Customer/Plant 分维度生成。
5. **数据刷新**：设计文档中的"每日自动刷新"在静态前端中以页面加载时生成新随机数据实现，每次刷新数据会变化。
6. **导出格式**：当前导出为 JSON 格式模拟，实际生产环境应为 CSV/Excel。
7. **Target Yield**：假设为 96.5%（基于 PRD 中的描述）。
8. **默认单位**：使用 NSQM（基于 PRD Q-02 假设）。

---

## 验证清单

- [x] 总览页面趋势图正常渲染
- [x] KPI 卡片数据正确显示
- [x] 点击趋势图柱体，详情面板联动更新
- [x] 缺陷分析页面 Pareto 图正常渲染
- [x] 环形图展示部门分布
- [x] 缺陷趋势对比图正常渲染
- [x] 点击 Pareto 柱体，趋势图和部门图联动更新
- [x] 筛选条件变更后图表刷新
- [x] 页面间导航正常
- [x] Loading 状态展示
- [x] 响应式布局（桌面端 + 平板端）
- [x] 导出功能可用
- [x] 数据更新时间显示
