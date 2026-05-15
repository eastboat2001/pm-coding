# PI Web UI Docker Deployment

This directory is the server deployment package for the PI Web UI container.

## Files

- `docker-compose.yaml`: Docker runtime configuration.
- `pi-storage.config.json`: PI application runtime configuration.
- `data/`: persistent runtime data directory created on the server.

The Docker image itself is built from the repository root with:

```bash
docker build -t pi-web-ui:0.73.0 -f apps/pi-coding-web/Dockerfile .
```

Export the offline image:

```bash
docker save -o pi-web-ui-0.73.0.tar pi-web-ui:0.73.0
```

## Server Usage

Copy these files to the server:

```text
pi-web-ui-0.73.0.tar
docker-compose.yaml
pi-storage.config.json
```

Recommended server layout:

```text
/opt/pi-web-ui/
  pi-web-ui-0.73.0.tar
  docker-compose.yaml
  pi-storage.config.json
  data/
```

Before starting, edit `pi-storage.config.json`:

```json
{
  "previewBaseUrl": "http://SERVER_IP:5173"
}
```

Use `http://localhost:5173` only when the browser is running on the same machine as Docker.
For remote access, use the server IP or public domain. Do not use `0.0.0.0` as `previewBaseUrl`.

Load and start:

```bash
cd /opt/pi-web-ui
mkdir -p data
docker load -i pi-web-ui-0.73.0.tar
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
