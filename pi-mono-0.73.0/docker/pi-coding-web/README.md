# PI Coding Web Docker Deployment

This directory is the server deployment package for the PI Coding Web container.

## Files

- `docker-compose.yaml`: Docker runtime configuration.
- `pi-storage.config.json`: PI application runtime configuration.
- `data/`: persistent runtime data directory created on the server.

The Docker image itself is built from the repository root with:

```bash
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
```

Export the offline image:

```bash
docker save -o pi-coding-web-0.73.0.tar pi-coding-web:0.73.0
```

## Server Usage

Copy these files to the server:

```text
pi-coding-web-0.73.0.tar
docker-compose.yaml
pi-storage.config.json
```

Recommended server layout:

```text
/opt/pi-coding-web/
  pi-coding-web-0.73.0.tar
  docker-compose.yaml
  pi-storage.config.json
  data/
```

Before starting, edit `pi-storage.config.json`:

```json
{
  "sessionsDir": "./data/sessions",
  "settingsFile": "./data/settings.json",
  "projectsRootDir": "./data/projects",
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

Use `http://localhost:5173` only when the browser is running on the same machine as Docker.
For remote access, use the server IP or public domain. Do not use `0.0.0.0` as `previewBaseUrl`.
If `previewBaseUrl` is left empty, PI builds preview links from the incoming request host and `x-forwarded-proto` header.

Load and start:

```bash
cd /opt/pi-coding-web
mkdir -p data
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d
```

Check status:

```bash
docker compose ps
docker compose logs -f
curl http://SERVER_IP:5173/api/pi-storage/status
```

## PM Integration

PM must point to the same public PI address:

```env
VITE_GO_CODING_URL=http://SERVER_IP:5173
```

The PM backend CORS configuration must also allow this PI origin:

```env
CORS_ORIGINS=http://SERVER_IP:5173
```
