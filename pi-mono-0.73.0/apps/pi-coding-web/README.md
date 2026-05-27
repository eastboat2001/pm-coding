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

## Docker

Build the PI Coding Web application from the repository root:

```bash
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
```

Run it with a persistent data volume:

```bash
docker run -d --name pi-coding-web -p 5173:5173 -v pi-coding-web-data:/app/apps/pi-coding-web/data pi-coding-web:0.73.0
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

This image runs Vite preview instead of a static nginx server because the application depends on Vite server middleware for session storage, server-side project files, controlled project tasks, and `/preview/<project-id>/` URLs.

When deploying behind a domain or reverse proxy, set `previewBaseUrl` in `pi-storage.config.json` to the public PI origin, for example `https://pi.example.com`. Generated projects and optional server-synced sessions should stay in the mounted `data` volume, not inside the image.

For server deployment with an offline image, use the deployment package under `docker/pi-coding-web`. Copy `docker-compose.yaml` and `pi-storage.config.json` from that directory to the same server directory, load the image, then start the service:

```bash
docker load -i pi-coding-web-0.73.0.tar
docker compose up -d
```

The included compose file mounts `./data` as the persistent runtime directory and exposes PI on port `5173`.

### Server Configuration

PI uses three different address concepts during Docker deployment:

1. **Container listen address**
   - Configured in `Dockerfile`.
   - Must stay as `0.0.0.0` so the Vite preview server listens on all container network interfaces.
   - Example:

```dockerfile
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
```

2. **Docker host port**
   - Configured in `docker-compose.yaml`.
   - The default mapping exposes container port `5173` on server port `5173`.

```yaml
ports:
  - "5173:5173"
```

3. **Public browser URL**
   - Configured in `pi-storage.config.json` as `previewBaseUrl`.
   - This must be the address that users can open from their own computers.
   - Do **not** use `0.0.0.0` here. `0.0.0.0` is only a listen address, not a browser address.
   - Use `localhost` only for local testing on the same machine.

Local test:

```json
{
  "previewBaseUrl": "http://localhost:5173"
}
```

Server IP:

```json
{
  "previewBaseUrl": "http://SERVER_IP:5173"
}
```

Domain or reverse proxy:

```json
{
  "previewBaseUrl": "https://pi.example.com"
}
```

If PI is launched from PM, PM must point to the same public PI address:

```env
VITE_GO_CODING_URL=http://SERVER_IP:5173
```

The PM backend CORS configuration must also allow that PI origin:

```env
CORS_ORIGINS=http://SERVER_IP:5173
```

When using a domain, replace both values with the domain, for example `https://pi.example.com`.

## What's Included

This application includes:

- **ChatPanel** - The main chat interface component
- **System Prompt** - Custom configuration for the AI assistant
- **Server workspace tools** - The normal Web UI agent flow creates files and runs controlled static project tasks in a fixed server project root
- **Browser-private session persistence** - Active and recent sessions are restored from browser IndexedDB only
- **Model persistence** - The selected model is remembered across refreshes and new sessions
- **Configured server storage** - Model configuration and generated project files use fixed paths from `pi-storage.config.json`

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
- generated project files under the configured projects root directory

Temporary multi-user deployment behavior:

- PI sessions are intentionally not written to or restored from the configured server `sessionsDir`.
- The session list shows only sessions saved in the current browser.
- A `session=<id>` URL only restores the session if that browser already has the session in IndexedDB.
- This avoids exposing one user's chat history to another user on the same PI server.
- The server-session sync code path is controlled by `serverSessionSyncEnabled` in `pi-storage.config.json` for a future authenticated deployment where sessions can be scoped by user.

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

- Browser IndexedDB is the only active session store in the current temporary multi-user mode.
- Saved chat sessions are not mirrored to disk while `serverSessionSyncEnabled` is `false`.
- The session list only reads browser-backed records.
- The Web UI agent can call read-only global skill tools: `skill_load` and `skill_resource`.
- The Web UI agent can call server workspace tools: `project_file` and `project_task`.
- Global skills are loaded from the configured `skillsDir`; they provide instructions and reference text only, not script execution or arbitrary filesystem access.
- Project files are written directly under the configured project root on the server.
- `project_task` supports only controlled static tasks: `inspect`, `validate`, `build_static`, `preview`, and `logs`.
- Built-in browser artifacts are disabled for project generation in this application.

### Configuration

Edit `pi-storage.config.json`:

```json
{
  "sessionsDir": "./data/sessions",
  "settingsFile": "./data/settings.json",
  "projectsRootDir": "./data/projects",
  "skillsDir": "./data/skills",
  "previewBaseUrl": "",
  "serverSessionSyncEnabled": false,
  "defaultModelProvider": "",
  "defaultModelId": "",
  "handoffDefaultThinkingLevel": "high",
  "projectInstallCommand": "npm install",
  "projectBuildCommand": "npm run build",
  "projectInstallTimeoutMs": 120000,
  "projectBuildTimeoutMs": 120000
}
```

Relative paths are resolved from `apps/pi-coding-web/`. Absolute paths are also supported.

The application writes:

- `<settingsFile>`
- one project root directory per generated project under `projectsRootDir`

`sessionsDir` is reserved for the future authenticated server-session mode. It is not used while browser-private sessions are enabled.

`skillsDir` stores server-configured global skills. The first version supports directory-style skills only:

```text
data/skills/<skill-name>/SKILL.md
```

Each `SKILL.md` should include `name` and `description` frontmatter. The agent sees skill names and descriptions in the system prompt, loads full instructions with `skill_load`, and reads referenced text files under the same skill directory with `skill_resource`. Users can type `/skill` in the chat input to open the global skill picker; selecting an item inserts `/skill:<name>`, which is expanded to that skill's `SKILL.md` before the message is sent.

PI supports Anthropic/Agent Skills style directory resources such as `references/`, `assets/`, and `scripts/` as read-only text resources when their file extension is allowed. It also recognizes OpenAI/Codex-style `agents/openai.yaml` interface metadata: `display_name` and `short_description` are used in the `/skill` picker, `default_prompt` is exposed in prompt metadata, and icon/brand fields are parsed for future UI use. `agents/openai.yaml` is not listed as an agent-facing reference resource. Skills do not grant shell access and PI does not execute skill scripts.

With the default configuration, runtime data stays inside `apps/pi-coding-web/data/` and remains decoupled from any PM application directory.

Project directory names are generated from a sanitized session title plus a stable session-id suffix, so multiple generated projects do not collide.

## PM Handoff

The PM app can open this PI Web UI with a short-lived handoff token:

```text
/?handoff_token=<token>&pm_api_base_url=<pm-backend-base-url>
```

PI resolves the token through PM, downloads the PRD/design documents as attachments, and places the PM implementation prompt into the chat input. The PM prompt and documents are treated as the primary requirement source. PI's own handoff instructions only describe platform execution: write files into the configured project root, run controlled static project tasks when useful, publish with `project_task preview`, and return the Preview URL.

For the current stage, PM demos should target static HTML/CSS/JS projects or build-based static frontend projects such as Vite React/Vue. Backend services, databases, auth providers, queues, external APIs, and deployment topology from PM documents are treated as target-system context and should be simulated in the static frontend with sample data, local state, mock responses, and clear loading/empty/error/success states. Node services, multi-service stacks, Docker, external databases, and custom reverse-proxy routing are outside the current preview scope.

## Server Workspace Flow

The application keeps the regular Web UI agent conversation, model selector, API key flow, and tool-card rendering. No extra project panel, log panel, or preview button is added to the UI.

Expected conversation flow:

1. The user sends a request in the chat input.
2. The Web UI agent decides whether project execution is needed.
3. If a configured global skill matches the task, it calls `skill_load`, then optionally `skill_resource` for referenced text resources.
4. For app/site/project work, it calls `project_file` repeatedly to create or update server-side files.
5. For dependency-free static projects, it calls `project_task validate` and then `project_task preview`.
6. For build-based static frontend projects, it calls `project_task build_static`, then `project_task validate`, and finally `project_task preview`.
7. `build_static` runs only the server-configured `projectInstallCommand` and `projectBuildCommand`; `preview` never runs package scripts.
8. The server serves `dist/`, `build/`, `public/`, or a root static `index.html` when present.
9. The browser displays skill, file, and task tool cards plus the final assistant message with the preview URL.

Preview URLs are served from this PI server at:

```text
/preview/<project-id>/
```

Set `previewBaseUrl` in `pi-storage.config.json` when the server is behind a domain or reverse proxy, for example:

```json
{
  "previewBaseUrl": "https://coding.example.com"
}
```

This is optimized for generated static projects and build-based static frontend projects. Projects with static build output in `dist/` or `build/` are served from that directory. Static projects without `package.json` are served from the project root. `project_task preview` does not start Node services, run `npm start`, run `npm run dev`, or run arbitrary package scripts.

Because preview URLs may live under `/preview/<project-id>/`, generated apps should use relative URLs such as `./style.css`, `./page.html`, and `./api/items`. Avoid `http://localhost:<port>` and root-absolute browser paths such as `/api/items`; those bypass the preview route when PI is deployed on a server.

If a project root `index.html` still references build-source files such as `src/main.tsx` or `src/main.jsx`, static preview rejects the project and returns logs that tell the agent to run `project_task build_static` before previewing.

`project_task` never accepts raw shell commands. The only task that runs configured commands is `build_static`, and those commands come from `pi-storage.config.json`.

### Limitations

- The configured storage API is provided by this application's Vite dev/preview server.
- If the app is served as static files without that server, the browser can still use IndexedDB, but disk mirroring and generated project file output are unavailable.
- Generated code dependencies and build scripts may execute on the server during `project_task build_static`. For production multi-user deployment, run the PI server inside an isolated environment and restrict filesystem, network, CPU, memory, dependency installation, and command timeout limits.

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
├── pi-storage.config.json
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
