# PI Background Worker Runs Design

## Goal

PI must support long-running coding sessions that continue when the browser refreshes, closes, or switches to another session. The same PI server must support multiple concurrent sessions and multiple browser clients without exposing one client's sessions to another client.

## Current Constraint

The current `apps/pi-coding-web` execution model creates the `Agent` in the browser and calls `agent.prompt()` through `AgentInterface`. This ties model streaming, tool execution, abort state, and partial message state to the current page lifecycle. Browser refresh, tab close, or navigation destroys the active execution. Server session JSON sync is not enough because it only persists snapshots written by the browser.

## Chosen Architecture

Use an independent worker architecture:

- `pi-coding-web` remains the browser UI and HTTP API gateway.
- A separate `pi-worker` Node process consumes queued runs and executes server-side agents.
- Redis stores the queue, worker leases, and cancel signals.
- A durable DB stores clients, sessions, messages, runs, and run events.
- `packages/web-workspace` owns reusable server workspace services and shared run/session storage abstractions.

The first production-oriented version should use Redis for queueing and cancellation. The DB can start as SQLite for local/single-node deployment if the code keeps a storage interface that can support PostgreSQL in a future phase. JSON session files should be treated as compatibility/export data, not the authoritative runtime store for background runs.

## Client Isolation

PI generates a browser-scoped `PI_CLIENT_ID` on first load and stores it in `localStorage`. The frontend sends it on all PI session, run, and project API requests as:

```http
X-PI-Client-ID: <uuid>
```

Server rules:

- Reject session/run/project APIs without a valid `X-PI-Client-ID`.
- Persist every session and run with `client_id`.
- Query sessions and runs with both `client_id` and resource id.
- Write project files under a client-scoped directory, for example `data/projects/<client-id>/<session-slug>/`.
- Do not list or load sessions owned by another client.

This is isolation, not authentication. A user who can copy another browser's `PI_CLIENT_ID` can impersonate it. That is acceptable for this stage and should be documented as a temporary boundary before real login/auth.

## PM Handoff Impact

The `X-PI-Client-ID` requirement applies to PI APIs only. It should not require PM backend API changes.

Current PM handoff flow can remain:

```text
/?handoff_token=<token>&pm_api_base_url=<pm-backend-base-url>
```

PI browser behavior:

1. Generate or load `PI_CLIENT_ID`.
2. Resolve the PM handoff token through PM's existing `/api/coding-handoffs/<token>` endpoint.
3. Download PM documents as it does today.
4. Create a PI session under the current `PI_CLIENT_ID`.
5. Start the background run through PI's run API with `X-PI-Client-ID`.

PM document downloads and PM handoff resolution do not need `X-PI-Client-ID` unless PM chooses to enforce it in a future phase. If PM needs to reopen the same PI session from another browser, that is outside browser-client isolation and needs an explicit shared resume token or real user identity. Without that, the same PM handoff opened in a different browser should create or bind to that browser's own PI client context.

## Data Model

### clients

- `client_id`: browser generated UUID.
- `created_at`.
- `last_seen_at`.

### sessions

- `session_id`.
- `client_id`.
- `title`.
- `model_json`.
- `thinking_level`.
- `created_at`.
- `updated_at`.
- `last_run_status`.
- `last_run_id`.

### messages

- `message_id`.
- `session_id`.
- `client_id`.
- `seq`.
- `role`.
- `payload_json`.
- `created_at`.

Messages are the canonical transcript. The worker reconstructs `AgentState.messages` from this table.

### runs

- `run_id`.
- `session_id`.
- `client_id`.
- `status`: `queued`, `running`, `cancelling`, `cancelled`, `completed`, `failed`, `interrupted`.
- `worker_id`.
- `model_json`.
- `thinking_level`.
- `started_at`.
- `updated_at`.
- `ended_at`.
- `error`.

Only one run may be active for a session at a time. Multiple sessions can run concurrently subject to configured queue limits.

### run_events

- `event_id`.
- `run_id`.
- `session_id`.
- `client_id`.
- `seq`.
- `type`.
- `payload_json`.
- `created_at`.

Events mirror agent lifecycle events and UI-relevant run state transitions. The frontend uses them for SSE replay after refresh.

## API

### Client Bootstrap

`GET /api/pi-client/status`

Returns whether the supplied client id is known and updates `last_seen_at`.

### Sessions

`GET /api/pi-sessions`

Lists sessions for `X-PI-Client-ID`, including the latest run status.

`GET /api/pi-sessions/:sessionId`

Returns one session and its transcript if it belongs to the client.

`DELETE /api/pi-sessions/:sessionId`

Deletes the session, messages, runs, and client-scoped project files. If a run is active, the API should first request cancellation and return a conflict unless `force=true` is supplied.

### Runs

`POST /api/pi-runs/start`

Body includes session id, user message, attachments, model, thinking level, and optional source metadata such as PM handoff information. The API writes the user message, creates a `queued` run, pushes the run id to Redis, and returns run status.

`GET /api/pi-runs`

Lists active and recent runs for the current client.

`GET /api/pi-runs/:runId/status`

Returns run status if the run belongs to the client.

`GET /api/pi-runs/:runId/events?after=<seq>`

Server-Sent Events endpoint. It first replays stored events with `seq > after`, then streams new events while connected.

`POST /api/pi-runs/:runId/cancel`

Marks the run as `cancelling` and publishes a Redis cancel signal. The worker calls `agent.abort()` and writes final `cancelled` status.

### Project APIs

Project APIs keep their current behavior but require `X-PI-Client-ID` and validate that the requested `sessionId` belongs to the client. Project directories are client-scoped.

## Worker Runtime

The worker process:

1. Claims a queued run from Redis.
2. Loads the session, model, thinking level, system prompt, and messages from DB.
3. Creates a server-side `Agent`.
4. Uses server-direct skill/project tools, not browser fetch tools.
5. Subscribes to agent lifecycle events.
6. Writes message snapshots and run events after every stable event.
7. Watches Redis cancel signals and calls `agent.abort()`.
8. Marks stale owned runs as `interrupted` on startup before claiming new work.

Server-direct tools should call:

- `WorkspaceSkillService` for `skill_load` and `skill_resource`.
- `WorkspaceFileService` for `project_file`.
- `WorkspaceTaskService` and `WorkspacePreviewService` for `project_task`.

`WorkspaceTaskService.build_static` must become abort-aware. If a cancel signal arrives during install/build, the worker should terminate the child process tree and mark the task result as aborted.

## Frontend Changes

The frontend should no longer treat the browser `Agent` as the execution owner for PI Coding Web. It should render session state from server data and use run APIs for execution.

Required UI behavior:

- On app load, generate or load `PI_CLIENT_ID`.
- Load session list from server APIs filtered by client id.
- If the current session has an active run, connect to its SSE stream.
- Sending a message calls `POST /api/pi-runs/start`.
- The message editor stop button calls `POST /api/pi-runs/:runId/cancel`.
- The session list shows run status badges.
- Running sessions show a stop button in the list.
- Switching sessions does not cancel active runs.
- Reopening a running session attaches to its event stream and continues rendering partial progress.

The existing browser IndexedDB session store can remain as a short-lived cache during migration, but server DB becomes authoritative for PI Coding Web.

## Status Semantics

- `queued`: run is accepted but not yet claimed.
- `running`: worker claimed run and agent loop is active.
- `cancelling`: cancel requested, worker has not finalized.
- `cancelled`: worker observed cancel and stopped.
- `completed`: agent ended normally.
- `failed`: worker ended with an error.
- `interrupted`: server or worker died while a run was active.

Session list should display `queued`, `running`, and `cancelling` prominently. `failed`, `cancelled`, and `interrupted` should remain visible until the next successful run updates the session.

## Configuration

Add `.env` settings:

```env
PI_RUNS_ENABLED=true
PI_DB_URL=sqlite:./data/pi-runtime.sqlite
PI_REDIS_URL=redis://127.0.0.1:6379
PI_WORKER_ID=
PI_WORKER_CONCURRENCY=2
PI_RUN_QUEUE_NAME=pi:runs
PI_RUN_EVENT_RETENTION_DAYS=30
PI_CLIENT_ID_REQUIRED=true
```

Docker compose should include:

- `pi-coding-web`.
- `pi-worker`.
- `redis`.
- A persistent volume for DB and project data.

If SQLite is used, the web and worker containers must share the same mounted data volume. For multi-replica web/worker deployment, PostgreSQL is preferred over SQLite.

## Error Handling

- Missing `X-PI-Client-ID`: return 401 with a PI-specific error code.
- Session not owned by client: return 404, not 403, to avoid leaking ids.
- Active run already exists for session: return 409 with existing run id/status.
- Redis unavailable: return 503 for run start/cancel APIs.
- Worker crash: startup recovery marks stale `running/cancelling` runs for that worker as `interrupted`.
- SSE disconnect: no run impact; client reconnects with last event sequence.

## Testing

Unit tests:

- Client id validation rejects missing/malformed ids.
- Session queries never return another client's session.
- Run start creates user message, queued run, and queue entry.
- Run cancel updates DB and emits cancel signal.
- Worker writes events and final statuses.
- Worker startup marks stale runs as interrupted.

Integration tests:

- Start a run, simulate frontend reconnect, replay events after a sequence number.
- Two different client ids cannot list or load each other's sessions.
- Running session appears in session list with status.
- Cancel from session list stops an active run.

Manual verification:

- Start a generation, refresh the page, confirm generation continues.
- Start a generation, close the browser, reopen, confirm the run completed or is still running.
- Start two sessions from one browser and confirm both can run.
- Start sessions from two browsers and confirm isolation.
- Open PM handoff URL and confirm PI creates a client-scoped session without PM backend changes.

## Out of Scope For First Implementation

- Real user login or organization-level auth.
- Sharing a PI session across browsers.
- Multi-tenant billing or quotas.
- Full sandbox isolation for generated dependency install/build.
- Running generated backend services.
- Multi-region distributed workers.

These should be future phases after the worker/queue/session model is stable.
