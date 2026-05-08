# AI PM 项目说明

这是一个前后端分离的 AI 产品经理助手项目，主要用于需求访谈、结构化需求整理，以及生成 PRD / 设计文档。

- 后端：Flask
- 前端：Vue 3 + TypeScript + Vite
- 默认后端地址：`http://127.0.0.1:8000`
- 默认前端地址：`http://127.0.0.1:9530`

## 1. 项目结构

```text
pm-2/
|- app/               Flask 后端代码
|- data/              SQLite 数据库、模板、生成文档
|- frontend/          Vue 前端
|- recordings/        语音识别上传后的录音保存目录
|- run.py             后端启动入口
|- requirements.txt   后端依赖
|- .env.example       环境变量示例
```

## 2. 运行前准备

建议环境：

- Python `3.10` 到 `3.13`
- Node.js `20.19+` 或 `22.12+`
- npm（随 Node.js 安装）

说明：

- 前端依赖中的 Vite 版本对 Node.js 版本有要求，Node 太旧时前端可能无法启动。
- 后端默认使用 SQLite，本地运行不需要额外安装数据库。
- 项目核心能力依赖 LLM 接口；如果没有可用模型配置，页面能打开，但对话和文档生成无法正常工作。
- 当前依赖组合在 Python `3.14` 上可能出现 `requests -> charset_normalizer` 导入卡住的问题，不建议使用。

## 3. 配置环境变量

先复制示例配置：

```powershell
Copy-Item .env.example .env
```

最少需要关注这些字段：

```env
# 服务监听
HOST=0.0.0.0
PORT=8000

# 前端开发地址白名单
CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://localhost:9530

# LLM 配置
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=Qwen3.5-27B
LLM_TIMEOUT_SECONDS=500

# 可选：前端直连后端地址
VITE_API_BASE_URL=http://127.0.0.1:8000
```

### 3.1 使用 OpenAI 兼容接口

例如 MiniMax、硅基流动、OpenRouter 或其他兼容 `/chat/completions` 的服务：

```env
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_API_KEY=你的密钥
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_SECONDS=500
```

### 3.2 使用 Vertex AI Gemini

如果你使用 Google Cloud 服务账号：

```env
LLM_PROVIDER=vertex_gemini
LLM_MODEL=gemini-2.5-flash
LLM_GCP_PROJECT_ID=你的项目 ID
LLM_GCP_LOCATION=global
LLM_GCP_CREDENTIALS_PATH=C:\path\to\service-account.json
```

### 3.3 语音识别配置（可选）

如果你需要语音识别接口，再补充下面字段：

```env
ASR_APP_ID=
ASR_ACCESS_TOKEN=
ASR_SECRET_KEY=
ASR_BASE_URL=
```

不配置时，文本对话相关功能仍可使用，但录音转文字通常不可用。

### 3.4 代理配置（可选）

如果访问模型服务需要代理：

```env
LLM_PROXY_URL=http://127.0.0.1:7890
LLM_MAX_RETRIES=2
LLM_DEBUG_STREAM=true
LOG_LEVEL=INFO
```

## 4. 启动后端

### 4.1 创建并激活虚拟环境

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

### 4.2 安装依赖

```powershell
pip install -r requirements.txt
```

### 4.3 启动 Flask 服务

```powershell
.venv\Scripts\python.exe -u run.py
```

正常情况下会监听：

```text
http://127.0.0.1:8000
```

注意：

- 当前代码默认端口是 `8000`，不是 `5000`。
- 打开 `http://127.0.0.1:8000/` 时，看到的是一个简单的 Flask 占位页，不是完整前端界面。
- 真正的开发界面需要单独启动前端。

## 5. 启动前端

进入前端目录并安装依赖：

```powershell
Set-Location frontend
npm install
```

启动开发服务器：

```powershell
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:9530
```

说明：

- `frontend/vite.config.ts` 已配置 `/api` 代理，默认转发到 `http://127.0.0.1:8000`。
- 如果你改了后端端口，记得同步修改 `.env` 里的 `VITE_API_BASE_URL`。

## 6. 推荐启动顺序

完整使用项目时，建议按下面顺序启动：

1. 在项目根目录启动后端：`python run.py`
2. 在 `frontend/` 目录启动前端：`npm run dev`
3. 浏览器打开：`http://127.0.0.1:9530`

如果你只想调试接口，可以只启动后端。

## 7. 主要接口

### 7.1 会话相关

创建会话：

```http
POST /api/sessions
Content-Type: application/json

{
  "template_id": "optional-template-id"
}
```

查询会话列表：

```http
GET /api/sessions
```

获取单个会话：

```http
GET /api/sessions/{session_id}
```

删除会话：

```http
DELETE /api/sessions/{session_id}
```

### 7.2 对话相关

普通发送消息：

```http
POST /api/sessions/{session_id}/messages
Content-Type: application/json

{
  "message": "我们要做一个考勤系统",
  "language": "zh"
}
```

流式发送消息：

```http
POST /api/sessions/{session_id}/messages/stream
Content-Type: application/json

{
  "message": "第一阶段面向中小企业",
  "language": "zh"
}
```

### 7.3 结构化需求与文档

获取结构化需求：

```http
GET /api/sessions/{session_id}/structured-requirement?language=zh
```

获取需求摘要：

```http
GET /api/sessions/{session_id}/summary?language=zh
```

生成 PRD：

```http
POST /api/sessions/{session_id}/prd-doc?language=zh
```

流式生成 PRD：

```http
POST /api/sessions/{session_id}/prd-doc/stream?language=zh
```

生成系统设计文档：

```http
POST /api/sessions/{session_id}/design-doc?language=zh
```

流式生成系统设计文档：

```http
POST /api/sessions/{session_id}/design-doc/stream?language=zh
```

下载已生成的 PRD：

```http
GET /api/sessions/{session_id}/prd-doc/download
```

下载已生成的设计文档：

```http
GET /api/sessions/{session_id}/design-doc/download
```

### 7.4 模板与语音

获取业务模板列表：

```http
GET /api/templates
```

获取模板详情：

```http
GET /api/templates/{template_id}
```

语音识别：

```http
POST /api/asr/recognize
Content-Type: multipart/form-data

audio=<wav 文件>
```

## 8. 运行数据说明

- SQLite 数据库默认保存在 `data/rqmd.sqlite3`
- 生成的 PRD / 设计文档会保存在 `data/`
- 上传识别的录音文件会保存在 `recordings/`

这些目录属于运行时数据，通常不建议手工删除正在使用的文件。

## 9. 常见问题

### 9.1 页面能打开，但发送消息失败

优先检查：

- `.env` 中的 `LLM_BASE_URL`
- `.env` 中的 `LLM_API_KEY`
- `.env` 中的 `LLM_MODEL`
- 模型服务是否可访问

### 9.2 前端启动失败

优先检查：

- Node.js 版本是否满足 `20.19+` 或 `22.12+`
- 是否在 `frontend/` 目录执行了 `npm install`

### 9.3 前端请求不到后端

优先检查：

- 后端是否真的运行在 `8000` 端口
- `VITE_API_BASE_URL` 是否写对
- `CORS_ORIGINS` 是否包含前端地址

### 9.4 访问根地址只有一个简单页面

这是当前项目的正常表现。`http://127.0.0.1:8000/` 只是 Flask 模板占位页，实际交互界面应访问前端开发地址 `http://127.0.0.1:9530`。

## 10. 最简启动命令汇总

后端：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

前端：

```powershell
Set-Location frontend
npm install
npm run dev
```

启动完成后，在浏览器打开：

```text
http://127.0.0.1:9530
```
