# 部署信息

## 项目状态
✅ 项目已成功部署并运行

## 访问地址
- **前端界面**: http://localhost:5173/preview/project-7468b404/
- **后端 API**: http://localhost:5000

## 功能验证步骤

### 1. 访问前端界面
打开浏览器访问: http://localhost:5173/preview/project-7468b404/

### 2. 验证核心功能

#### 2.1 新增收支记录
1. 点击"新增记录"按钮
2. 选择账目类型（收入/支出）
3. 输入金额（如：100.55）
4. 选择日期
5. 选择分类和支付方式
6. 点击提交
7. 验证记录出现在列表中

#### 2.2 筛选与统计
1. 在月份筛选器中选择特定月份
2. 在分类筛选器中选择特定分类
3. 验证列表按条件筛选
4. 验证顶部统计栏数据更新

#### 2.3 配置管理
1. 点击顶部导航的"设置"
2. 添加新的分类（如：宠物）
3. 添加新的支付方式
4. 尝试删除已被使用的分类，验证拦截提示

#### 2.4 编辑与删除
1. 在记录列表中点击"编辑"按钮
2. 修改记录信息并提交
3. 点击"删除"按钮
4. 确认删除操作

### 3. API 接口验证
使用 curl 或 Postman 测试 API：

```bash
# 获取分类
curl http://localhost:5000/api/categories

# 获取记录
curl http://localhost:5000/api/records

# 创建记录
curl -X POST http://localhost:5000/api/records \
  -H "Content-Type: application/json" \
  -d '{"type":"expense","amount":50.50,"date":"2024-01-15","category_id":5,"method_id":2,"note":"测试"}'

# 获取统计
curl http://localhost:5000/api/statistics
```

### 4. 运行测试脚本
```bash
python test_api.py
```

## 项目功能清单

### 已实现功能
✅ 收支记录 CRUD（增删改查）
✅ 按月份、分类、类型筛选
✅ 实时统计（总收入、总支出、结余）
✅ 分类管理（收入类/支出类）
✅ 支付方式管理
✅ 删除保护（已使用的分类/支付方式无法删除）
✅ 金额支持两位小数
✅ 日期倒序排列
✅ 响应式界面设计

### 默认数据
- **收入分类**: 工资、奖金、投资收益、其他收入
- **支出分类**: 餐饮、交通、购物、娱乐、居住、医疗、教育、其他支出
- **支付方式**: 现金、微信、支付宝、银行卡、信用卡

## 技术栈
- **前端**: Vue 3 + Vite + Tailwind CSS
- **后端**: Flask + SQLAlchemy + SQLite
- **数据库**: SQLite (ledger.db)

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
├── test_api.py            # API 测试脚本
├── run.sh                 # Linux/Mac 启动脚本
├── start.bat              # Windows 启动脚本
└── README.md              # 项目说明文档
```

## 已知假设与取舍

1. **单用户设计**: 系统仅支持单用户使用，无登录注册功能
2. **本地存储**: 数据完全存储在本地，不支持多端同步
3. **无分页**: 列表采用滚动加载，不提供分页功能
4. **简化统计**: 仅提供基础汇总统计，不包含复杂图表
5. **界面假设**: 配置管理入口位于页面顶部导航

## 故障排除

### 1. 后端服务无法启动
- 检查 Python 版本 (需要 3.9+)
- 检查依赖是否安装完整: `pip install -r requirements.txt`
- 检查端口 5000 是否被占用

### 2. 前端服务无法启动
- 检查 Node.js 版本 (需要 16+)
- 检查依赖是否安装完整: `npm install`
- 检查端口 3000 是否被占用

### 3. 数据库问题
- 数据库文件位于 `backend/instance/ledger.db`
- 可手动删除此文件重新初始化
- 项目启动时会自动创建表和默认数据

### 4. 跨域问题
- Flask 后端已配置 CORS
- Vite 开发服务器已配置代理

## 开发模式
1. 启动后端: `cd backend && python app.py`
2. 启动前端: `cd frontend && npm run dev`
3. 访问: http://localhost:3000

## 生产模式
1. 构建前端: `cd frontend && npm run build`
2. 启动后端: `cd backend && python app.py`
3. 访问: http://localhost:5000

## 备份建议
定期备份数据库文件: `backend/instance/ledger.db`