# PI Coding Web Docker Deployment

This directory is the offline deployment package for the PI Coding Web container.

## Files

- `docker-compose.yaml`: Docker runtime configuration.
- `pi-storage.config.json`: PI runtime storage and preview configuration.
- `data/`: persistent runtime data directory on the server.
- `pi-coding-web-0.73.0.tar`: exported offline image, generated locally and copied to the server.

The exported image tar is deployment output, not source code. Do not commit it to Git.

## Build Package

Run these commands from the repository root:

```bash
cd /path/to/pi-mono-0.73.0
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
docker save -o docker/pi-coding-web/pi-coding-web-0.73.0.tar pi-coding-web:0.73.0
```

If `docker build` reports an unusually large `transferring context`, check for unignored image tar files, runtime `data` directories, or generated project `node_modules` directories. The repository `.dockerignore` already excludes recursive `*.tar`, `*.tar.gz`, `data`, `dist`, and `node_modules` paths.

## Server Configuration

Copy this directory to the server, for example:

```text
/opt/pi-coding-web/
  pi-coding-web-0.73.0.tar
  docker-compose.yaml
  pi-storage.config.json
  data/
```

Before starting, edit `pi-storage.config.json` on the server:

```json
{
  "sessionsDir": "./data/sessions",
  "settingsFile": "./data/settings.json",
  "projectsRootDir": "./data/projects",
  "skillsDir": "./data/skills",
  "defaultSkillsDir": "./data/default-skills",
  "previewBaseUrl": "http://SERVER_IP:5173",
  "serverSessionSyncEnabled": false,
  "defaultModelProvider": "",
  "defaultModelId": "",
  "handoffDefaultThinkingLevel": "high",
  "projectInstallCommand": "npm install",
  "projectBuildCommand": "npm run build",
  "projectInstallTimeoutMs": 300000,
  "projectBuildTimeoutMs": 300000
}
```

Set `previewBaseUrl` to the address that users' browsers can open. Use `http://localhost:5173` only when the browser runs on the same machine as Docker. Do not use `0.0.0.0` as `previewBaseUrl`; it is only a listen address. If `previewBaseUrl` is left empty, PI builds preview links from the incoming request host and the `x-forwarded-proto` header.

If server port `5173` is already used, set `PI_CODING_WEB_PORT` before starting:

```bash
export PI_CODING_WEB_PORT=8080
```

Then set `previewBaseUrl` to the same external port, for example `http://SERVER_IP:8080`.

## Start

```bash
cd /opt/pi-coding-web
mkdir -p data
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d
```

Check status:

```bash
docker compose ps
docker compose logs -f pi-coding-web
curl http://SERVER_IP:5173/api/pi-storage/status
```

If you used a custom host port, replace `5173` in the `curl` command with that port.

## Upgrade

```bash
cd /opt/pi-coding-web
docker compose down
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d
```

The `data/` directory is mounted into the container and is preserved across upgrades.

## PM Integration

PM must point to the same public PI address:

```env
VITE_GO_CODING_URL=http://SERVER_IP:5173
```

The PM backend CORS configuration must also allow this PI origin:

```env
CORS_ORIGINS=http://SERVER_IP:5173
```
