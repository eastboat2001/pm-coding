# 个人记账系统 (Personal Ledger)

一个轻量级、私有的本地记账工具，用于追踪日常的个人收入与支出情况。

## 功能特性

- **收支记录管理**：支持记录的增、删、改、查（CRUD）
- **配置管理**：自定义收支分类（一级平铺）和支付方式标签
- **筛选与统计**：支持按"月份"和"分类"筛选，实时计算总收入、总支出和结余
- **本地化运行**：数据存储在本地 SQLite 数据库，保证私密性

## 技术栈

- **前端**：Vue 3 + Vite + Tailwind CSS
- **后端**：Flask + SQLAlchemy + SQLite
- **数据库**：SQLite (ledger.db)

## 快速开始

### 1. 安装依赖

**后端依赖：**
```bash
cd backend
pip install -r requirements.txt
```

**前端依赖：**
```bash
cd frontend
npm install
```

### 2. 启动项目

**启动后端服务：**
```bash
cd backend
python app.py
```
后端服务默认运行在 `http://localhost:5000`

**启动前端服务：**
```bash
cd frontend
npm run dev
```
前端服务默认运行在 `http://localhost:3000`

### 3. 环境变量说明

- `FLASK_ENV`：Flask 运行环境，可选 `development`（开发）或 `production`（生产）
- `DATABASE_URL`：数据库连接 URL，默认为 `sqlite:///instance/ledger.db`

### 4. 数据库初始化

项目首次运行时会自动创建 SQLite 数据库文件 `instance/ledger.db`，并预置以下默认配置：

**默认分类：**
- 收入类：工资、奖金、投资收益、其他收入
- 支出类：餐饮、交通、购物、娱乐、居住、医疗、教育、其他支出

**默认支付方式：**
- 现金、微信、支付宝、银行卡、信用卡

### 5. 测试/验证步骤

1. 访问前端页面 `http://localhost:3000`
2. 测试新增记录：点击"新增"按钮，填写信息并提交
3. 测试筛选功能：选择月份或分类，验证列表和统计更新
4. 测试配置管理：进入设置页面，添加/删除分类或支付方式
5. 测试引用保护：尝试删除已被使用的分类，验证拦截提示

### 6. API 接口文档

**账目记录：**
- `GET /api/records` - 获取账目列表（支持 month, category_id 过滤）
- `POST /api/records` - 新增账目
- `PUT /api/records/<id>` - 修改账目
- `DELETE /api/records/<id>` - 删除账目

**分类管理：**
- `GET /api/categories` - 获取分类列表（支持 type 过滤）
- `POST /api/categories` - 新增分类
- `DELETE /api/categories/<id>` - 删除分类（含引用保护）

**支付方式管理：**
- `GET /api/payment-methods` - 获取支付方式列表
- `POST /api/payment-methods` - 新增支付方式
- `DELETE /api/payment-methods/<id>` - 删除支付方式（含引用保护）

**统计信息：**
- `GET /api/statistics` - 获取汇总统计（支持 month, category_id 过滤）

## 已知假设与取舍

1. **单用户设计**：系统仅支持单用户使用，无登录注册功能
2. **本地存储**：数据完全存储在本地，不支持多端同步
3. **无分页**：列表采用滚动加载，不提供分页功能（适合个人记账数据量）
4. **简化统计**：仅提供基础汇总统计，不包含复杂图表
5. **界面假设**：配置管理入口假设位于页面顶部导航

## 开发说明

### 数据备份
建议定期备份 `backend/instance/ledger.db` 文件。

### 浏览器兼容性
优先支持 Chrome、Edge 等现代浏览器。

### 开发模式
- 后端支持热重载
- 前端支持热重载
- 跨域请求已通过 Flask-CORS 处理

## 项目结构

```
personal-ledger/
├── backend/                # Flask 后端
│   ├── app.py            # 主应用入口
│   ├── models.py         # 数据模型
│   ├── routes/           # API 路由
│   │   ├── records.py    # 账目记录路由
│   │   ├── categories.py # 分类管理路由
│   │   ├── payment_methods.py # 支付方式路由
│   │   └── statistics.py # 统计信息路由
│   └── requirements.txt  # Python 依赖
├── frontend/               # Vue 前端
│   ├── src/
│   │   ├── components/   # Vue 组件
│   │   ├── views/        # 页面视图
│   │   ├── api/          # API 调用封装
│   │   └── App.vue       # 根组件
│   ├── package.json      # Node.js 依赖
│   └── vite.config.js    # Vite 配置
└── README.md             # 项目说明文档
```