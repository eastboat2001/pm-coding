# PI Diagnostic Logging Design

## Goal

Add a backend-only diagnostic logging system for PI Web that makes model, provider, agent, project, skill, and handoff failures traceable without exposing logs in the frontend UI.

## Scope

- PI-owned code only: `apps/pi-coding-web` and `packages/web-workspace`.
- No PM code changes.
- No visible frontend log panel.
- The browser may send hidden, redacted diagnostic events to the local PI backend because PI Web currently performs model streaming in the browser runtime.
- Local diagnostics remain usable without Langfuse or any external service.

## Architecture

The first implementation uses local SQLite as the canonical diagnostic store and stdout/stderr for container-friendly summaries. The schema keeps OpenTelemetry/Langfuse-compatible identifiers from day one:

- `traceId`: one session or user request level correlation id.
- `spanId`: one operation such as agent turn, provider request, tool execution, project task, or skill load.
- `parentSpanId`: optional operation parent.
- `category`: `model`, `provider`, `agent`, `tool`, `project`, `skill`, `handoff`, `storage`, or `system`.
- `eventType`: specific event such as `provider.request.start`, `provider.response`, `stream.summary`, `agent.message.end`, or `project.preview.logs`.

The web workspace Vite plugin exposes a backend-only API namespace:

- `GET /api/pi-logs/status`
- `POST /api/pi-logs/events`
- `GET /api/pi-logs/events?sessionId=&traceId=&level=&category=&limit=`

No app navigation or visible PI Web UI element links to these endpoints.

## Storage

Default database path:

```text
apps/pi-coding-web/data/logs/pi-diagnostics.sqlite
```

Config/env priority:

1. `PI_LOG_DB`
2. `logsDbFile` in `pi-storage.config.json`
3. `data/logs/pi-diagnostics.sqlite`

The logger should also support:

- `PI_LOG_ENABLED=false` to disable writes.
- `PI_LOG_STDOUT=true` to emit concise warn/error summaries to stdout/stderr.
- Retention and rotation in a later iteration if needed.

## Redaction

All events are sanitized before they are stored or exported:

- Drop API keys, Authorization, cookies, provider tokens, and secret-looking fields.
- Store provider payload summaries by default, not raw prompts or outputs.
- Store stream counters and truncated samples only when verbose diagnostics are enabled later.
- Apply the same sanitizer before future Langfuse export.

## Event Sources

Initial event sources:

- PI Web model stream wrapper: request start, payload summary, response status, stream text/thinking/toolcall counters, done/error, duration.
- Agent subscription: turn/message/tool lifecycle summaries.
- Existing server project preview/build logs.
- Existing skill diagnostics.
- Session/storage failure logs where currently only `console.error` exists.

## Docker

Docker deployments should mount the app data directory or set `PI_LOG_DB` to a mounted path. The logger emits concise warn/error summaries to stdout/stderr for Docker/Kubernetes log collectors.

SQLite is appropriate for single PI Web container instances. Multi-instance deployments should use per-instance SQLite files plus external log aggregation, or a later exporter-backed design.

## Langfuse Compatibility

Langfuse is a future optional exporter, not the source of truth. Local SQLite remains authoritative. The event model keeps trace/span fields so a later exporter can map:

- Session/request to trace.
- Agent turns/provider requests/tool executions to spans/observations.
- Stream and error details to events and metadata.

