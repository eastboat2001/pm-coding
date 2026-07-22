# PI Coding Web 内网 Podman 部署

本目录是 Linux 内网服务器的生产部署模板。运行时由 PostgreSQL、Redis、Web、Worker 四个长期服务组成；生成项目的依赖安装和前端构建由宿主机上的 **rootless Podman API 服务**按任务创建临时容器完成。

服务器能够访问互联网时，推荐从内部镜像仓库拉取 PI 镜像，并在首次启动前预拉取固定摘要的构建镜像。部署过程不依赖 Docker daemon。

## 已确定的运行方案

| 能力 | 方案 |
| --- | --- |
| 浏览器访问 PI 与预览 | `PI_PREVIEW_BASE_URL=http://pi.intranet.example:5173` |
| Worker 内部预览校验 | `PI_PREVIEW_INTERNAL_ORIGIN=http://pi-coding-web:5173` |
| 生成项目构建 | Worker 内的 Podman 远程客户端连接宿主机 rootless Podman Unix Socket |
| 构建隔离 | 每次构建独立网络、卷和容器；依赖恢复只允许访问配置的 npm registry；build 阶段断网 |
| 持久化 | 会话和 Run 使用 PostgreSQL；队列和实时事件使用 Redis；项目、技能与诊断日志使用 `./data/app` |

`PI_PREVIEW_BASE_URL` 是发给浏览器的地址，不能使用 `0.0.0.0`。`PI_PREVIEW_INTERNAL_ORIGIN` 是 Worker 在 Compose 网络内做 readiness 校验的地址，必须使用服务名，不能使用 `localhost` 或服务器公网地址。

## 安全边界

Podman API Socket 对所属 Linux 用户具有完整的容器控制能力，因此部署必须遵守以下边界：

- 不限制固定用户名或 UID；由实际部署用户运行自己的 rootless Podman、Compose 和构建容器。
- Socket 只挂载到 `pi-worker`；`pi-coding-web` 不持有 Socket。
- 不把 Podman API 暴露为无双向 TLS 的 TCP 服务。
- 不使用 rootful `/run/podman/podman.sock`。
- PI 服务账号不运行其他业务容器，避免 Worker 获得无关工作负载的控制权。

Compose 已为 Worker 配置 `security_opt: label=disable`。这是容器内访问 Podman Socket 所需的 SELinux 设置，不应把该设置扩展到其他服务。

## 服务器前置条件

建议资源：4 vCPU、6–8 GiB 内存和足够的镜像/项目存储。默认允许 2 个并发 Worker 任务，每个临时构建容器最多使用 1 vCPU、1 GiB 内存；小规格服务器应先把 `PI_WORKER_CONCURRENCY` 调为 `1`。

服务器需要：

- Linux、cgroup v2、rootless Podman；推荐 Podman 5.x。
- systemd user service。
- `podman-compose` 或其他可被 `podman compose` 调用的 Compose provider。
- 到模型服务、npm registry 和所需镜像仓库的网络访问。

先验证工具：

```bash
podman --version
podman info
podman compose version
```

`podman compose` 是 Compose provider 的包装器。若最后一条命令失败，先安装并配置 `podman-compose`，不要改用 Docker daemon。

## 启动当前用户的 rootless Podman 服务

任何普通 Linux 用户均可部署，无需使用固定账号或配置数字 UID。登录准备运行 PI 的用户后执行：

```bash
systemctl --user enable --now podman.socket
systemctl --user status podman.socket --no-pager
test -S "$XDG_RUNTIME_DIR/podman/podman.sock"
```

Compose 会自动使用当前用户的 `$XDG_RUNTIME_DIR/podman/podman.sock`，不需要在 `.env` 中填写用户名、UID 或 Socket 路径。后续镜像拉取、Compose 启停和 PI 服务也应由该用户执行；rootless Podman 的镜像存储按用户隔离，切换用户后看不到原用户拉取的镜像。

若服务需要在该用户注销后和服务器重启后继续运行，由管理员执行一次 `loginctl enable-linger <实际部署用户名>`。

## 准备 PI 镜像

推荐在 CI/构建机从当前源码构建 PI 镜像并推送到内网仓库：

```bash
PI_RELEASE_TAG=0.73.0-intranet-20260721-r1

podman build \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  --build-arg NPM_REPLACE_REGISTRY_HOST=npmjs \
  -t registry.intranet.example/pi/pi-coding-web:${PI_RELEASE_TAG} \
  -f apps/pi-coding-web/Dockerfile .

podman push registry.intranet.example/pi/pi-coding-web:${PI_RELEASE_TAG}
```

当前 Dockerfile 会把 Podman 远程客户端安装到 PI 镜像中。不得继续部署旧的、不含 `podman` 命令的 PI 镜像。

若没有内部镜像仓库，在仓库根目录执行以下命令生成新的离线包及校验文件。

PowerShell（Windows + Docker Desktop 构建机；生成的 Docker archive 可在内网服务器用 `podman load` 加载）：

```powershell
$piReleaseTag = "0.73.0-intranet-20260721-r1"
$piImage = "pi-coding-web:$piReleaseTag"
$piArchiveName = "pi-coding-web-offline-$piReleaseTag.tar"
$piArchive = Join-Path "docker/pi-coding-web" $piArchiveName
$piChecksum = "$piArchive.sha256"

docker build `
  --build-arg NPM_REGISTRY=https://registry.npmjs.org `
  --build-arg NPM_REPLACE_REGISTRY_HOST=npmjs `
  -t $piImage `
  -f apps/pi-coding-web/Dockerfile .
if ($LASTEXITCODE -ne 0) { throw "PI image build failed." }

docker save --output $piArchive $piImage
if ($LASTEXITCODE -ne 0) { throw "PI image export failed." }

$piHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $piArchive).Hash.ToLowerInvariant()
"$piHash  $piArchiveName" | Set-Content -Encoding ascii -LiteralPath $piChecksum
$piExpectedHash = ((Get-Content -Raw -LiteralPath $piChecksum) -split '\s+')[0].ToLowerInvariant()
$piActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $piArchive).Hash.ToLowerInvariant()
if ($piActualHash -ne $piExpectedHash) { throw "PI archive SHA256 verification failed." }
Write-Host "Created and verified $piArchive"
```

Bash（Linux/CI 构建机）：

```bash
PI_RELEASE_TAG=0.73.0-intranet-20260721-r1
PI_IMAGE=pi-coding-web:${PI_RELEASE_TAG}
PI_ARCHIVE_NAME=pi-coding-web-offline-${PI_RELEASE_TAG}.tar
PI_ARCHIVE=docker/pi-coding-web/${PI_ARCHIVE_NAME}

podman build \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  --build-arg NPM_REPLACE_REGISTRY_HOST=npmjs \
  -t "${PI_IMAGE}" \
  -f apps/pi-coding-web/Dockerfile .

podman save --format oci-archive --output "${PI_ARCHIVE}" "${PI_IMAGE}"
(cd docker/pi-coding-web && \
  sha256sum "${PI_ARCHIVE_NAME}" > "${PI_ARCHIVE_NAME}.sha256" && \
  sha256sum --check "${PI_ARCHIVE_NAME}.sha256")
```

把 `.tar` 和 `.sha256` 一起复制到内网服务器，以运行 PI 的同一个 rootless Podman 用户加载：

```bash
sha256sum --check pi-coding-web-offline-0.73.0-intranet-20260721-r1.tar.sha256
podman load --input pi-coding-web-offline-0.73.0-intranet-20260721-r1.tar
podman image inspect pi-coding-web:0.73.0-intranet-20260721-r1 >/dev/null
```

随后将服务器 `.env` 中的 `PI_CODING_WEB_IMAGE` 设置为 `pi-coding-web:0.73.0-intranet-20260721-r1`。旧的 `pi-coding-web-offline-0.73.0-intranet-20260630.tar` 不得继续用于部署。PostgreSQL、Redis 及构建镜像可由能够访问网络的内网服务器直接拉取。

## 配置

把本目录复制到服务器并确保当前部署用户可读写，然后创建配置：

```bash
cp .env.example .env
chmod 600 .env
```

至少修改以下值：

```env
PI_CODING_WEB_IMAGE=registry.intranet.example/pi/pi-coding-web:0.73.0-intranet-20260721-r1
PI_CODING_WEB_HOST_BIND=0.0.0.0
PI_CODING_WEB_PORT=5173

PI_PREVIEW_BASE_URL=http://pi.intranet.example:5173
PI_PREVIEW_INTERNAL_ORIGIN=http://pi-coding-web:5173

PI_BUILD_CONTAINER_ENGINE=podman

PI_POSTGRES_PASSWORD=change-me-with-a-strong-random-value
PI_POSTGRES_URL=postgres://pi:change-me-with-a-strong-random-value@postgres:5432/pi_coding
```

`PI_PREVIEW_INTERNAL_ORIGIN` 已补齐到模板和 Compose 默认值中。即使浏览器通过反向代理或 HTTPS 访问，内部值仍保持 `http://pi-coding-web:5173`。

模型供应商、默认模型和 Langfuse 等配置继续写入同一个 `.env`。不要把真实密钥提交到 Git。

## 构建服务镜像与限制

生成项目使用以下固定摘要镜像，避免标签漂移：

```env
PI_BUILD_CONTAINER_IMAGE=docker.io/library/node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
PI_BUILD_PROXY_IMAGE=docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029
PI_BUILD_REGISTRY_ORIGINS=https://registry.npmjs.org
PI_BUILD_TIMEOUT_MS=300000
PI_BUILD_CPUS=1
PI_BUILD_MEMORY_MB=1024
PI_BUILD_PIDS_LIMIT=128
```

首次启动前，以运行 Compose 的同一当前用户预拉取所有运行和构建镜像：

```bash
podman pull docker.io/library/postgres:16-alpine
podman pull docker.io/library/redis:7-alpine
podman pull docker.io/library/node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
podman pull docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029
podman pull registry.intranet.example/pi/pi-coding-web:0.73.0-intranet-20260721-r1
```

Compose 默认 `pull_policy=never`，这样生产启动不会因为仓库抖动而更换镜像。升级时先显式 pull/load 新镜像，再修改 `.env` 中的版本。

如果公司使用 npm 镜像站，把纯 HTTPS origin 加入逗号分隔的 `PI_BUILD_REGISTRY_ORIGINS`，并确保生成项目的 `package-lock.json` 中所有 `resolved` 域名都在该列表内。不要为了绕过失败而关闭 registry allowlist。

## 启动与部署前置检查

```bash
test -n "$XDG_RUNTIME_DIR"
podman_socket="$XDG_RUNTIME_DIR/podman/podman.sock"
test -S "$podman_socket"
test -r "$podman_socket" && test -w "$podman_socket"
podman info >/dev/null
podman compose config >/dev/null
podman compose up -d --no-build postgres redis pi-coding-web pi-worker
podman compose ps
```

主 Compose 文件只包含四个长期服务，因此普通 `podman compose up -d` 不会触发一次性的生产切换演练，也兼容不会正确处理 Compose `profiles` 的旧版 `podman-compose`。

Worker 的健康检查会执行 `podman info`。Socket 缺失、权限不匹配、PI 镜像没有 Podman 客户端时，Worker 会明确保持 unhealthy，不会等到用户发起生成任务后才暴露问题。

继续验证 Worker 到构建服务和 Web 内部地址：

```bash
podman compose exec pi-worker podman info
podman compose exec pi-worker node -e \
  "fetch(process.env.PI_PREVIEW_INTERNAL_ORIGIN + '/api/pi-storage/status').then(r => { if (!r.ok) process.exit(1); console.log(r.status) })"
```

查看日志：

```bash
podman compose logs --tail=200 pi-coding-web
podman compose logs --tail=200 pi-worker
podman compose logs --tail=100 postgres redis
```

如需单独执行生产切换演练，先配置 `.env` 中的 `PI_CUTOVER_MODEL_PROVIDER` 和 `PI_CUTOVER_MODEL_ID`，然后显式加载独立文件：

```bash
podman compose \
  -f docker-compose.yaml \
  -f docker-compose.cutover.yaml \
  run --rm pi-cutover-rehearsal
```

不要在普通启动时加载 `docker-compose.cutover.yaml`。

浏览器访问：

```text
http://pi.intranet.example:5173
```

## 上线验收

仅打开首页不能验证构建服务。至少完成以下验收：

1. 创建一个只含 `index.html` 的简单应用，确认静态预览可访问。
2. 创建一个含 `package.json`、`package-lock.json` 和 Vite 构建脚本的可视化应用，确认确实触发临时 Podman 构建并交付预览。
3. 同时提交 2 个应用生成任务，确认 Worker、Podman、PostgreSQL 和 Redis 没有争用或重复消费。
4. 从另一台内网电脑打开两个预览 URL，确认 URL 使用 `PI_PREVIEW_BASE_URL`，且页面不依赖该电脑无法访问的公网 CDN。
5. 重启 `pi-worker`，确认持久化队列可继续处理未完成任务。

构建完成后可确认没有遗留临时资源；正常名称以 `pi-build-` 开头：

```bash
podman ps -a --filter name=pi-build-
podman network ls --filter name=pi-build-
podman volume ls --filter name=pi-build-
```

## 数据与技能

共享数据目录：

```text
docker/pi-coding-web/data/app/
```

自定义技能放在：

```text
docker/pi-coding-web/data/app/skills/<skill-name>/SKILL.md
```

更新技能后执行：

```bash
podman compose restart pi-coding-web pi-worker
```

PostgreSQL 和 Redis 使用 rootless Podman named volume，避免内网文件系统对 bind mount `chown` 的限制。PostgreSQL 和 Redis 均未发布到宿主机端口。

## 升级

```bash
podman pull registry.intranet.example/pi/pi-coding-web:0.73.0-intranet-20260722-r1
```

修改 `.env` 的 `PI_CODING_WEB_IMAGE` 后：

```bash
podman compose up -d --no-build --force-recreate pi-coding-web pi-worker
podman compose ps
podman compose exec pi-worker podman info
```

不要复用旧标签覆盖镜像；使用唯一 build tag 才能确认服务器实际运行的是新版本。

## 常见故障

### Worker unhealthy

依次检查：

```bash
systemctl --user status podman.socket --no-pager
echo "$XDG_RUNTIME_DIR/podman/podman.sock"
ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"
podman compose exec pi-worker sh -lc 'command -v podman && echo "$CONTAINER_HOST" && podman info'
```

出现 `statfs /run/user/<uid>/podman/podman.sock: permission denied` 时，通常是仍在使用旧版 Compose 文件中的固定 UID 路径，或切换了运行 Compose 的 Linux 用户。更新为当前 Compose 文件后，Socket 会自动取自当前用户的 `XDG_RUNTIME_DIR`。常见原因还包括当前用户的 `podman.socket` 未启动，或仍在使用未安装 Podman 客户端的旧 PI 镜像。

### 预览校验访问了 localhost

确认：

```env
PI_PREVIEW_BASE_URL=http://pi.intranet.example:5173
PI_PREVIEW_INTERNAL_ORIGIN=http://pi-coding-web:5173
```

修改后重建 Web 和 Worker 容器。

### 构建报 image not known / short-name 错误

必须以运行 Compose 的同一 rootless 用户预拉取 `.env` 中两个摘要镜像。模板使用 fully-qualified image name，避免 Podman 的 short-name 交互解析。

### npm 依赖恢复失败

检查服务器能访问 `PI_BUILD_REGISTRY_ORIGINS`，并检查 lockfile 的 `resolved` 域名。依赖恢复通过受限 Squid 代理；build 阶段没有网络，这是预期行为。

### 彻底清空测试数据

以下操作会删除会话、Run、生成项目、技能、日志、PostgreSQL 和 Redis 数据，只能在明确不保留数据时执行：

```bash
podman compose down -v --remove-orphans
rm -rf ./data/app
podman compose up -d --no-build postgres redis pi-coding-web pi-worker
```

生产环境不要执行该操作。
