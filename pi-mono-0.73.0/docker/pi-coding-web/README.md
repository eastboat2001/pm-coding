# PI Coding Web Docker 部署说明

这个目录用于把 PI Coding Web 部署到服务器 Docker 环境。默认只部署 PI，不包含 PM。

## 目录内容

- `docker-compose.yaml`：服务器运行用 Compose 文件，只运行已有镜像。
- `docker-compose.build.yaml`：有完整源码时用于本地构建镜像。
- `.env.example`：统一配置模板，复制为 `.env` 后使用。
- `pi-coding-web-data`：Compose named volume，挂载到容器内 `/app/apps/pi-coding-web/data`，保存 PI 会话、项目和日志。
- `pi-redis-data`：Compose named volume，挂载到 Redis `/data`。
- `pi-coding-web-offline-0.73.0.tar`：可选的离线镜像包，包含 `pi-coding-web:0.73.0` 和 `redis:7-alpine`，由 `docker save` 生成，不应提交到 Git。

## 服务器前置条件

服务器需要安装 Docker Engine 和 Docker Compose Plugin，或者 Podman + podman-compose。

检查命令：

```bash
docker --version
docker compose version
```

Podman 环境检查命令：

```bash
podman --version
podman compose version
```

如果服务器不能访问 npm 或 Docker registry，建议在开发机或构建机先构建镜像并导出 tar，再复制到服务器。

## 配置文件

进入部署目录后，先复制示例文件：

```bash
cd /opt/pi-coding-web
cp .env.example .env
```

编辑 `.env`：

```env
PI_CODING_WEB_IMAGE=pi-coding-web:0.73.0
PI_CODING_WEB_PORT=5173
PI_CODING_WEB_PULL_POLICY=never

PI_PREVIEW_BASE_URL=
PI_LOG_ENABLED=true
PI_LANGFUSE_ENABLED=false
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

含义：

- `PI_CODING_WEB_IMAGE`：运行的镜像名和 tag。
- `PI_CODING_WEB_PORT`：服务器对外暴露端口。
- `PI_CODING_WEB_PULL_POLICY`：默认 `never`，表示只使用本地镜像，不从 registry 拉取。
- `PI_PREVIEW_BASE_URL`：留空时，PI 会按当前请求 Host 生成预览链接；若经过反向代理或域名访问，也可以显式写成 `https://pi.example.com`。
- `PI_LOG_ENABLED`：是否启用后台诊断日志。
- `PI_LANGFUSE_ENABLED`：是否启用 Langfuse 导出。
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`：Langfuse 密钥。`PI_LANGFUSE_ENABLED=false` 时可以留空。

Docker/Podman 部署统一使用一个 `.env`。这个文件同时给 Compose 提供镜像名、端口等部署变量，并通过 `env_file` 注入到容器进程环境。不要再把 `.env` bind mount 到 `/app/apps/pi-coding-web/.env`；rootless Podman 或受限文件系统下可能导致容器内读取 `.env` 报 `EACCES: permission denied`。`.env` 已被 Git 忽略，不要提交真实密钥。

建议：

- 不要使用 `0.0.0.0` 作为 `PI_PREVIEW_BASE_URL`；它只能作为监听地址，浏览器不能用它访问。

配置加载优先级：

```text
容器环境变量 > .env > 代码内默认值
```

## 在线构建部署

适用于服务器或构建机上有完整 `pi-mono-0.73.0` 源码的情况。

从仓库根目录进入 Docker 部署目录：

```bash
cd /path/to/pi-mono-0.73.0/docker/pi-coding-web
cp .env.example .env
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
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
docker save -o docker/pi-coding-web/pi-coding-web-offline-0.73.0.tar pi-coding-web:0.73.0 redis:7-alpine
```

如果构建机访问官方 npm registry 稳定，可以去掉 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`，Dockerfile 默认使用 `https://registry.npmjs.org/`。

把 `docker/pi-coding-web` 目录复制到服务器，例如：

```text
/opt/pi-coding-web/
  docker-compose.yaml
  .env
  pi-coding-web-offline-0.73.0.tar
```

在服务器加载镜像：

```bash
cd /opt/pi-coding-web
docker load -i pi-coding-web-offline-0.73.0.tar
docker compose up -d --no-build
```

`--no-build` 可以避免离线服务器误尝试构建源码。

## 数据卷与 Podman 权限

默认 `docker-compose.yaml` 使用 Compose named volumes，而不是把宿主机 `./data` 目录直接 bind mount 到容器内：

```yaml
volumes:
  pi-coding-web-data:
  pi-redis-data:
```

这样可以避免 rootless Podman、SELinux、NFS 或受限企业文件系统下的常见权限错误：

```text
EACCES: permission denied, mkdir '/app/apps/pi-coding-web/data/clients'
EACCES: permission denied, open '/app/apps/pi-coding-web/.env'
chown: .: Operation not permitted
```

如果你使用 Podman，Compose 项目名会参与 volume 名称。可以用下面命令确认真实 volume 名：

```bash
podman volume ls | grep pi-coding-web
podman volume ls | grep pi-redis
```

需要备份数据时，先查看 volume 挂载点：

```bash
podman volume inspect <volume-name>
```

如果必须改回宿主机目录 bind mount，请先确认该目录在容器内可写，并且 `.env` 不要 bind mount 到容器内。Podman 环境通常还需要处理 SELinux label、用户命名空间或 `:U` 映射；没有明确需求时不建议使用 bind mount。

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
curl http://127.0.0.1:${PI_CODING_WEB_PORT:-5173}/api/pi-storage/status
curl http://127.0.0.1:${PI_CODING_WEB_PORT:-5173}/api/pi-logs/status
```

如果 shell 不支持上面的参数展开，手动把端口替换为 `.env` 里的 `PI_CODING_WEB_PORT`。例如 `PI_CODING_WEB_PORT=9529` 时访问 `http://127.0.0.1:9529/...`；容器内部端口始终是 `5173`。

重点看：

- `configured` 是否为 `true`。
- `runtimeDbFile` 是否指向 `/app/apps/pi-coding-web/data/runtime/pi-runtime.sqlite`。
- `loggingEnabled` 是否为 `true`。
- `databaseFile` 是否指向 `/app/apps/pi-coding-web/data/logs/pi-diagnostics.sqlite`。
- `langfuseConfigured` 是否符合预期。

## 日志与数据持久化

容器内数据目录：

```text
/app/apps/pi-coding-web/data
```

服务器持久化位置：

```text
Compose named volume: pi-coding-web-data
```

其中包含：

- `data/clients/`：按 client/session 隔离的项目工作区。
- `data/settings.json`：服务端设置、模型选择、provider key 镜像等。
- `data/runtime/pi-runtime.sqlite`：会话、消息、run 和 run events。
- `data/logs/pi-diagnostics.sqlite`：PI 诊断日志 SQLite 数据库。
- `data/skills/`：服务器全局 skills。

默认日志保留策略：

```json
"logRetentionDays": 30,
"logMaxEvents": 50000,
"logVacuumIntervalMs": 86400000
```

长期部署时必须保留 `pi-coding-web-data` named volume，否则容器重建后会话、日志和生成项目都会丢失。

## Langfuse

默认 `PI_LANGFUSE_ENABLED=false`。启用时修改 `.env`：

```env
PI_LANGFUSE_ENABLED=true
PI_LANGFUSE_HOST=https://cloud.langfuse.com
PI_LANGFUSE_OTEL_ENDPOINT=
PI_OTEL_SERVICE_NAME=pi-coding-web
PI_OTEL_DEPLOYMENT_ENVIRONMENT=production
```

再把 key 写入 `.env`：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

如果使用自建 Langfuse，把 `PI_LANGFUSE_HOST` 改为自建地址。`PI_LANGFUSE_OTEL_ENDPOINT` 留空时会自动使用：

```text
<langfuseHost>/api/public/otel/v1/traces
```

如果后续接 OpenTelemetry Collector，可以显式设置：

```env
PI_LANGFUSE_OTEL_ENDPOINT=http://otel-collector:4318/v1/traces
```

## 深度调试开关

生产环境默认关闭深度内容日志：

```env
PI_LOG_RAW_PROVIDER_ENABLED=false
PI_LOG_PROMPT_SNAPSHOT_ENABLED=false
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=false
PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=false
PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=false
PI_LANGFUSE_EXPORT_RAW_CHUNKS=false
```

排查模型问题时可以临时开启：

```env
PI_LOG_PROMPT_SNAPSHOT_ENABLED=true
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true
PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=true
PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=true
```

如果要看 provider raw chunk 和 PI raw stream event，再开启：

```env
PI_LOG_RAW_PROVIDER_ENABLED=true
PI_LANGFUSE_EXPORT_RAW_CHUNKS=true
```

这些开关可能记录 prompt、模型输出、工具参数和 raw chunk，排查结束后建议关闭。

## 反向代理

如果通过 Nginx、Traefik 或网关访问 PI，需要把外部地址写入 `PI_PREVIEW_BASE_URL`，例如：

```env
PI_PREVIEW_BASE_URL=https://pi.example.com
```

反向代理需要转发：

- Web 页面请求。
- `/api/pi-storage/*`
- `/api/pi-logs/*`
- `/api/pi-projects/*`
- 预览项目相关路径。

同时建议转发 `X-Forwarded-Proto` 和 `Host`，这样 `PI_PREVIEW_BASE_URL` 留空时也能生成正确链接。

## 升级

保留 `.env`、`pi-coding-web-data` 和 `pi-redis-data` volumes。

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
docker load -i pi-coding-web-offline-0.73.0.tar
docker compose up -d --no-build
```

升级后检查：

```bash
docker compose ps
curl http://127.0.0.1:${PI_CODING_WEB_PORT:-5173}/api/pi-storage/status
curl http://127.0.0.1:${PI_CODING_WEB_PORT:-5173}/api/pi-logs/status
```

如果 `.env` 中配置了 `PI_CODING_WEB_PORT`，这里也要改成对应宿主机端口。

## 常见启动故障

Web 或 worker 退出后先看日志：

```bash
docker compose logs --tail=200 pi-coding-web
docker compose logs --tail=200 pi-worker
docker compose logs --tail=200 redis
```

Podman 环境也可以直接查容器日志：

```bash
podman logs --tail=200 pi-coding-web
podman logs --tail=200 pi-worker
podman logs --tail=200 pi-coding-redis
```

如果看到：

```text
EACCES: permission denied, open '/app/apps/pi-coding-web/.env'
```

说明 `.env` 被 bind mount 到容器内且容器不可读。删除 `./.env:/app/apps/pi-coding-web/.env:ro` 这类挂载，只保留 `env_file: ./.env`。

如果看到：

```text
EACCES: permission denied, mkdir '/app/apps/pi-coding-web/data/clients'
```

说明容器不能写 `/app/apps/pi-coding-web/data`。使用默认 named volume，或者修复宿主机 bind mount 目录权限。

如果 Redis 日志反复出现：

```text
chown: .: Operation not permitted
```

说明 Redis 正在写一个不允许容器 chown 的宿主机目录。使用默认 `pi-redis-data` named volume，或者删除 Redis 的 bind mount。

## PM 对接

PM 需要指向 PI 的外部访问地址，例如：

```env
VITE_GO_CODING_URL=https://pi.example.com
```

PM 后端 CORS 也需要允许该 PI origin：

```env
CORS_ORIGINS=https://pi.example.com
```
