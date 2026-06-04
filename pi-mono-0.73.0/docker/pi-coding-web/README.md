# PI Coding Web Docker 部署说明

这个目录用于把 PI Coding Web 部署到服务器 Docker 环境。默认只部署 PI，不包含 PM。

## 目录内容

- `docker-compose.yaml`：服务器运行用 Compose 文件，只运行已有镜像。
- `docker-compose.build.yaml`：有完整源码时用于本地构建镜像。
- `.env.example`：Compose 变量示例，复制为 `.env` 后使用。
- `pi-storage.config.json`：PI 服务端运行配置模板。
- `secrets/pi-storage.secrets.env.example`：密钥文件示例，复制为 `secrets/pi-storage.secrets.env` 后使用。
- `data/`：服务器运行数据目录，挂载到容器内 `/app/apps/pi-coding-web/data`。
- `pi-coding-web-0.73.0.tar`：可选的离线镜像包，由 `docker save` 生成，不应提交到 Git。

## 服务器前置条件

服务器需要安装 Docker Engine 和 Docker Compose Plugin。

检查命令：

```bash
docker --version
docker compose version
```

如果服务器不能访问 npm 或 Docker registry，建议在开发机或构建机先构建镜像并导出 tar，再复制到服务器。

## 配置文件

进入部署目录后，先复制示例文件：

```bash
cd /opt/pi-coding-web
cp .env.example .env
cp secrets/pi-storage.secrets.env.example secrets/pi-storage.secrets.env
```

编辑 `.env`：

```env
PI_CODING_WEB_IMAGE=pi-coding-web:0.73.0
PI_CODING_WEB_PORT=5173
PI_CODING_WEB_PULL_POLICY=never
```

含义：

- `PI_CODING_WEB_IMAGE`：运行的镜像名和 tag。
- `PI_CODING_WEB_PORT`：服务器对外暴露端口。
- `PI_CODING_WEB_PULL_POLICY`：默认 `never`，表示只使用本地镜像，不从 registry 拉取。

编辑 `pi-storage.config.json`：

```json
"previewBaseUrl": "",
"serverSessionSyncEnabled": true,
"secretsEnvFile": "./secrets/pi-storage.secrets.env",
"logsDbFile": "./data/logs/pi-diagnostics.sqlite"
```

建议：

- `serverSessionSyncEnabled` 保持 `true`，会话和设置会保存到挂载的 `data/` 目录。
- `previewBaseUrl` 留空时，PI 会按当前请求 Host 生成预览链接。若经过反向代理或域名访问，也可以显式写成 `https://pi.example.com`。
- 不要使用 `0.0.0.0` 作为 `previewBaseUrl`；它只能作为监听地址，浏览器不能用它访问。

编辑 `secrets/pi-storage.secrets.env`：

```env
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

如果 `langfuseEnabled` 为 `false`，可以留空。若启用 Langfuse，把 key 写在这里，不要写进 `pi-storage.config.json`。

密钥加载优先级：

```text
容器环境变量 > secrets/pi-storage.secrets.env > pi-storage.config.json
```

## 在线构建部署

适用于服务器或构建机上有完整 `pi-mono-0.73.0` 源码的情况。

从仓库根目录进入 Docker 部署目录：

```bash
cd /path/to/pi-mono-0.73.0/docker/pi-coding-web
cp .env.example .env
cp secrets/pi-storage.secrets.env.example secrets/pi-storage.secrets.env
```

构建镜像：

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml build
```

构建 `pi-coding-web` 前端时 Vite 会处理 Monaco、PDF worker 等较大的浏览器依赖，构建阶段需要较高 Node heap。当前 `apps/pi-coding-web/Dockerfile` 已对应用构建步骤设置 `NODE_OPTIONS=--max-old-space-size=4096`。如果构建机仍出现 OOM，应把 Docker 可用内存调到 6GB 或更高，或者改用已构建好的离线镜像包部署。

启动：

```bash
docker compose up -d
```

## 离线镜像包部署

适用于服务器不能联网，或不希望在服务器上构建源码的情况。

先在有完整源码和网络的机器上构建并导出镜像：

```bash
cd /path/to/pi-mono-0.73.0
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
docker save -o docker/pi-coding-web/pi-coding-web-0.73.0.tar pi-coding-web:0.73.0
```

把 `docker/pi-coding-web` 目录复制到服务器，例如：

```text
/opt/pi-coding-web/
  docker-compose.yaml
  .env
  pi-storage.config.json
  pi-coding-web-0.73.0.tar
  data/
  secrets/
```

在服务器加载镜像：

```bash
cd /opt/pi-coding-web
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d --no-build
```

`--no-build` 可以避免离线服务器误尝试构建源码。

## 启动与停止

启动：

```bash
docker compose up -d
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f pi-coding-web
```

停止：

```bash
docker compose down
```

## 健康检查

本机检查：

```bash
curl http://127.0.0.1:5173/api/pi-storage/status
curl http://127.0.0.1:5173/api/pi-logs/status
```

如果 `.env` 中改了端口，把 `5173` 替换为 `PI_CODING_WEB_PORT`。

重点看：

- `configured` 是否为 `true`。
- `serverSessionSyncEnabled` 是否为 `true`。
- `loggingEnabled` 是否为 `true`。
- `databaseFile` 是否指向 `/app/apps/pi-coding-web/data/logs/pi-diagnostics.sqlite`。
- `langfuseConfigured` 是否符合预期。

## 日志与数据持久化

容器内数据目录：

```text
/app/apps/pi-coding-web/data
```

服务器挂载目录：

```text
./data
```

其中包含：

- `data/sessions/`：服务端会话。
- `data/settings.json`：服务端设置、模型选择、provider key 镜像等。
- `data/projects/`：生成项目和预览产物。
- `data/logs/pi-diagnostics.sqlite`：PI 诊断日志 SQLite 数据库。
- `data/skills/`：服务器全局 skills。

默认日志保留策略：

```json
"logRetentionDays": 30,
"logMaxEvents": 50000,
"logVacuumIntervalMs": 86400000
```

长期部署时必须保留 `data/` 目录，否则容器重建后会话、日志和生成项目都会丢失。

## Langfuse

默认 `langfuseEnabled` 为 `false`。启用时修改 `pi-storage.config.json`：

```json
"langfuseEnabled": true,
"langfuseHost": "https://cloud.langfuse.com",
"langfuseOtelEndpoint": "",
"otelServiceName": "pi-coding-web",
"otelDeploymentEnvironment": "production"
```

再把 key 写入 `secrets/pi-storage.secrets.env`：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

如果使用自建 Langfuse，把 `langfuseHost` 改为自建地址。`langfuseOtelEndpoint` 留空时会自动使用：

```text
<langfuseHost>/api/public/otel/v1/traces
```

如果后续接 OpenTelemetry Collector，可以显式设置：

```json
"langfuseOtelEndpoint": "http://otel-collector:4318/v1/traces"
```

## 深度调试开关

生产环境默认关闭深度内容日志：

```json
"rawProviderLoggingEnabled": false,
"promptSnapshotLoggingEnabled": false,
"modelOutputSnapshotLoggingEnabled": false,
"langfuseExportPromptSnapshots": false,
"langfuseExportModelOutputSnapshots": false,
"langfuseExportRawChunks": false
```

排查模型问题时可以临时开启：

```json
"promptSnapshotLoggingEnabled": true,
"modelOutputSnapshotLoggingEnabled": true,
"langfuseExportPromptSnapshots": true,
"langfuseExportModelOutputSnapshots": true
```

如果要看 provider raw chunk 和 PI raw stream event，再开启：

```json
"rawProviderLoggingEnabled": true,
"langfuseExportRawChunks": true
```

这些开关可能记录 prompt、模型输出、工具参数和 raw chunk，排查结束后建议关闭。

## 反向代理

如果通过 Nginx、Traefik 或网关访问 PI，需要把外部地址写入 `previewBaseUrl`，例如：

```json
"previewBaseUrl": "https://pi.example.com"
```

反向代理需要转发：

- Web 页面请求。
- `/api/pi-storage/*`
- `/api/pi-logs/*`
- `/api/pi-projects/*`
- 预览项目相关路径。

同时建议转发 `X-Forwarded-Proto` 和 `Host`，这样 `previewBaseUrl` 留空时也能生成正确链接。

## 升级

保留 `data/`、`.env`、`pi-storage.config.json` 和 `secrets/`。

在线构建升级：

```bash
cd /path/to/pi-mono-0.73.0/docker/pi-coding-web
docker compose down
docker compose -f docker-compose.yaml -f docker-compose.build.yaml build
docker compose up -d
```

离线镜像包升级：

```bash
cd /opt/pi-coding-web
docker compose down
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d --no-build
```

升级后检查：

```bash
docker compose ps
curl http://127.0.0.1:5173/api/pi-storage/status
curl http://127.0.0.1:5173/api/pi-logs/status
```

## PM 对接

PM 需要指向 PI 的外部访问地址，例如：

```env
VITE_GO_CODING_URL=https://pi.example.com
```

PM 后端 CORS 也需要允许该 PI origin：

```env
CORS_ORIGINS=https://pi.example.com
```
