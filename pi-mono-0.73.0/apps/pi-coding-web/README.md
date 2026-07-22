# PI Coding Web

This is the productized PI coding web application built on `@mariozechner/pi-web-ui` and `@mariozechner/pi-web-workspace`.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Podman production deployment

The Linux intranet deployment runs PostgreSQL, Redis, the Web service, and the
Agent v2 Worker with rootless Podman. Generated Vite/React applications are
built in short-lived containers through the host user's Podman API socket; only
the Worker receives that socket.

Use the production package under `docker/pi-coding-web`:

```bash
cd docker/pi-coding-web
cp .env.example .env
podman compose up -d --no-build
```

Production uses two distinct preview origins:

```env
# Browser-accessible PI origin; required and never 0.0.0.0.
PI_PREVIEW_BASE_URL=http://SERVER_IP:5173

# Compose-network origin used by Worker readiness checks.
PI_PREVIEW_INTERNAL_ORIGIN=http://pi-coding-web:5173
```

The second value must not be changed to `localhost`: inside `pi-worker`,
localhost refers to the Worker container itself. The deployment template also
requires the dedicated rootless Podman socket path and configures
`PI_BUILD_CONTAINER_ENGINE=podman`.

The complete service-account setup, Socket security boundary, fixed-digest
build images, resource sizing, preflight checks, and rollout procedure are
documented in `docker/pi-coding-web/README.md`.

## What's Included

This application includes:

- **ChatPanel** - The main chat interface component
- **System Prompt** - Custom configuration for the AI assistant
- **Server workspace tools** - The normal Web UI agent flow creates files and runs controlled static project tasks in a client/session-scoped server project directory
- **Browser-private session persistence** - Active and recent sessions are restored from browser IndexedDB only
- **Model persistence** - The selected model is remembered across refreshes and new sessions
- **Configured server storage** - Model configuration and generated project files use fixed paths from `.env`

## Configuration

### Model Providers

PI is configured for custom providers first. The Web UI agent uses models from user-configured local or compatible providers such as Ollama, llama.cpp, vLLM, LM Studio, OpenAI Completions compatible endpoints, OpenAI Responses compatible endpoints, or Anthropic Messages compatible endpoints. Built-in cloud providers with predefined model lists are hidden in the PI settings and model selector.

To use the chat:

1. Click the settings icon (⚙️) in the chat interface
2. Open "Providers & Models"
3. Add a custom provider
4. For auto-discovery providers, test the connection and select a discovered model
5. For compatible manual providers, enter one or more model IDs while creating the provider

Custom provider definitions, API keys, and the selected model are stored in the browser and mirrored to the configured PI server `settingsFile` so another browser can reuse the same model configuration. The mirrored API keys and custom provider credentials are stored as plaintext in `settings.json`; use this only for local or controlled deployments. For untrusted multi-user production, replace this with server-side credentials or a controlled proxy.

## Session Storage Behavior

The application uses **browser IndexedDB as its primary runtime store**.

By default, it persists:

- conversation history in the current browser only
- session titles and history metadata in the current browser only
- the current or most recent session pointer in the current browser only
- the last selected model
- provider API keys and custom providers
- settings under the configured settings file
- generated project files under the configured clients root directory

Temporary multi-user deployment behavior:

- PI chat sessions are intentionally not written to or restored from legacy file-backed session JSON.
- Runtime sessions, messages, runs, and run events are stored in SQLite and scoped by `X-PI-Client-ID`.
- Browser IndexedDB keeps a local session cache for immediate UI restore.
- A `session=<id>` URL restores from runtime SQLite when available, then falls back to that browser's IndexedDB cache.

Behavioral details:

1. **Refresh restore**
   - On startup, the app tries to restore the session from the URL first.
   - If no session is present in the URL, it falls back to the stored current session.
   - If that is unavailable, it falls back to the most recently saved session.

2. **Early session creation**
   - A session ID is created before the first send, so the initial conversation state can be saved without waiting for a completed assistant response.

3. **Model persistence**
   - The currently selected model is stored separately and reused when you start a new session.

4. **New session behavior**
   - Creating a new session resets the active conversation in memory without relying on a full page reload.

## Configured Server Storage

The application uses the Vite dev/preview server for generated project files, preview hosting, and selected shared configuration. The browser no longer asks the user to choose a local directory.

### How it works

- Runtime SQLite is the authoritative server-side session store.
- Browser IndexedDB remains a local cache for session metadata and immediate restore.
- Session JSON mirroring is disabled and no longer configurable.
- The Web UI agent can call read-only global skill tools: `skill_load` and `skill_resource`.
- The Web UI agent can call server workspace tools: `project_file` and `project_task`.
- Global skills are loaded from the configured `skillsDir`; they provide instructions and reference text only, not script execution or arbitrary filesystem access.
- Project files are written directly under the client/session project directory on the server.
- `project_task` supports only controlled static tasks: `inspect`, `validate`, `build_static`, `preview`, and `logs`.
- Built-in browser artifacts are disabled for project generation in this application.

### Configuration

Edit `.env`:

```env
PI_SETTINGS_FILE=./data/settings.json
PI_CLIENTS_ROOT_DIR=./data/clients
PI_DB_FILE=./data/runtime/pi-runtime.sqlite
PI_SKILLS_DIR=./data/skills
PI_PREVIEW_BASE_URL=
PI_PREVIEW_INTERNAL_ORIGIN=http://127.0.0.1:5173
PI_DEFAULT_MODEL_PROVIDER=
PI_DEFAULT_MODEL_ID=
PI_HANDOFF_DEFAULT_THINKING_LEVEL=high
PI_RUNTIME_STORE=postgres
PI_POSTGRES_URL=postgresql://<user>:<password>@127.0.0.1:5432/<database>
PI_REDIS_URL=redis://127.0.0.1:6379
PI_AGENT_V2_RUN_QUEUE_NAME=pi:agent-v2:runs:local
PI_WORKER_ID=pi-local-worker
PI_BUILD_CONTAINER_ENGINE=docker
PI_BUILD_TIMEOUT_MS=120000
```

The container engine above is the local-development example. The production
intranet template uses a rootless Podman API socket, sets
`PI_BUILD_CONTAINER_ENGINE=podman`, and sets
`PI_PREVIEW_INTERNAL_ORIGIN=http://pi-coding-web:5173`; see
`docker/pi-coding-web/README.md` for the complete deployment and security
requirements.

Relative paths are resolved from `apps/pi-coding-web/`. Absolute paths are also supported.

The application writes:

- `<settingsFile>`
- runtime session records to `<runtimeDbFile>`
- generated project files under `<clientsRootDir>/<clientId>/sessions/<sessionId>/project`

The runtime layout uses `clientsRootDir` for project workspaces and `runtimeDbFile` for SQLite-backed sessions and runs.

`skillsDir` stores server-configured global skills. The first version supports directory-style skills only:

```text
data/skills/<skill-name>/SKILL.md
```

Each `SKILL.md` should include `name` and `description` frontmatter. Chat discloses bounded metadata only for skills that allow implicit invocation, loads full instructions with `skill_load`, and reads exact referenced text files under the same skill directory with `skill_resource`. Users can type `/skill` in the chat input to open the complete global skill picker; selecting an item inserts `/skill:<name>`, validates it against the current catalog, and applies that skill only to the current prompt.

PI supports Anthropic/Agent Skills style directory resources such as `references/`, `assets/`, and `scripts/` as read-only text resources when their file extension is allowed. It also recognizes OpenAI/Codex-style `agents/openai.yaml` metadata: `display_name` and `short_description` are used in the `/skill` picker, `default_prompt` is exposed after activation, and `policy.allow_implicit_invocation: false` makes a skill explicit-only while keeping it selectable. Icon/brand fields are parsed for future UI use. `agents/openai.yaml` is not listed as an agent-facing reference resource. Skills do not grant shell access and PI does not execute skill scripts.

With the default configuration, runtime data stays inside `apps/pi-coding-web/data/` and remains decoupled from any PM application directory.

Project directory names are stable per client and session and do not include the mutable session title.

## PM Handoff

The PM app can open this PI Web UI with a short-lived handoff token:

```text
/?handoff_token=<token>&pm_api_base_url=<pm-backend-base-url>
```

PI resolves the token through PM, downloads the PRD/design documents as attachments, and places the PM implementation prompt into the chat input. The PM prompt and documents are treated as the primary requirement source. PI's own handoff instructions only describe platform execution: write files into the client/session project directory, run controlled static project tasks when useful, publish with `project_task preview`, and return the Preview URL.

For the current stage, PM demos should target static HTML/CSS/JS projects or build-based static frontend projects such as Vite React/Vue. Backend services, databases, auth providers, queues, external APIs, and deployment topology from PM documents are treated as target-system context and should be simulated in the static frontend with sample data, local state, mock responses, and clear loading/empty/error/success states. Node services, multi-service stacks, Docker, external databases, and custom reverse-proxy routing are outside the current preview scope.

## Chat and Application Generation modes

Each session has an explicit mode selector:

1. A standalone new session defaults to **Chat**. Chat uses the normal multi-turn model stream, can read configured skills, and never creates Agent v2 runs, tasks, artifacts, or project files.
2. **App Generation** sends the current objective, selected skill names, attachments, and the bounded conversation snapshot to the server-owned Agent v2 runtime.
3. A trusted PM handoff defaults to App Generation; users can switch modes before execution starts.
4. The selected mode is stored with session metadata and restored after reload. Switching is disabled while a chat stream or Agent v2 run is active.
5. Agent v2 loads authorized skill instructions on the server, generates files, validates them, repairs retryable failures, and publishes the preview.
6. The browser renders replay-safe activity cards for skills, tasks, artifacts, validation, diagnostics, and preview delivery without synthesizing provider tool calls.
7. A successful run ends with a fact-based delivery report. A failed run reports the failed stage/task, completed work, diagnostics, repair attempts, remaining validation, safe-retry status, and next steps.

Preview URLs are served from this PI server at:

```text
/preview/<project-id>/
```

Set `PI_PREVIEW_BASE_URL` in `.env` when the server is behind a domain or reverse proxy, for example:

```env
PI_PREVIEW_BASE_URL=https://coding.example.com
```

This is optimized for generated static projects and build-based static frontend projects. Projects with static build output in `dist/` or `build/` are served from that directory. Static projects without `package.json` are served from the project root. `project_task preview` does not start Node services, run `npm start`, run `npm run dev`, or run arbitrary package scripts.

Because preview URLs may live under `/preview/<project-id>/`, generated apps should use relative URLs such as `./style.css`, `./page.html`, and `./api/items`. Avoid `http://localhost:<port>` and root-absolute browser paths such as `/api/items`; those bypass the preview route when PI is deployed on a server.

If a project root `index.html` still references build-source files such as `src/main.tsx` or `src/main.jsx`, static preview rejects the project and returns logs that tell the agent to run `project_task build_static` before previewing.

`project_task` never accepts raw shell commands. The only task that runs configured commands is `build_static`, and those commands come from `.env`.

### Limitations

- The configured storage API is provided by this application's Vite dev/preview server.
- If the app is served as static files without that server, the browser can still use IndexedDB, but disk mirroring and generated project file output are unavailable.
- Generated code dependencies and build scripts may execute on the server during `project_task build_static`. For production multi-user deployment, run the PI server inside an isolated environment and restrict filesystem, network, CPU, memory, dependency installation, and command timeout limits.

### Agent v2 reset and rollback

The Application Generation Agent v2 durable schema is intentionally reset as one unit; old run data is not migrated.

1. Stop v2 workers.
2. Run the Agent v2 reset maintenance operation with confirmation token application-generation-agent-v2.
3. Start v2 workers.
4. Verify /api/agent-v2/runs/start and event replay.

Rollback: redeploy the previous code version and restore from backup if required.

## Project Structure

```
apps/pi-coding-web/
├── src/
│   ├── main.ts                     # Main application entry point
│   ├── app.css                     # Application styles
│   ├── app/                        # Bootstrap, session, and model controllers
│   ├── dialogs/
│   │   ├── LocalSessionListDialog.ts
│   ├── integrations/               # PM handoff integration
│   ├── storage/
│   │   ├── configured-server-storage.ts
│   │   └── merged-session-index.ts
│   ├── project-tools/              # Browser-side tool schemas, API client, and renderers
│   ├── skill-tools/                # Browser-side global skill tools, picker, and slash expansion
│   └── prompts/                    # PI coding system prompt and PM handoff instructions
├── index.html        # HTML entry point
├── package.json      # Dependencies
├── .env.example
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
