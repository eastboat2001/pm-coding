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

Build the PI Web UI example from the repository root:

```bash
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
```

Run it with a persistent data volume:

```bash
docker run -d --name pi-web-ui -p 5173:5173 -v pi-web-ui-data:/app/apps/pi-coding-web/data pi-coding-web:0.73.0
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

This image runs Vite preview instead of a static nginx server because the example depends on Vite server middleware for session storage, server-side project files, project commands, and `/preview/<project-id>/` URLs.

When deploying behind a domain or reverse proxy, set `previewBaseUrl` in `pi-storage.config.json` to the public PI origin, for example `https://pi.example.com`. Generated projects and sessions should stay in the mounted `data` volume, not inside the image.

For server deployment with an offline image, use the deployment package under `docker/pi-web-ui`. Copy `docker-compose.yaml` and `pi-storage.config.json` from that directory to the same server directory, load the image, then start the service:

```bash
docker load -i pi-web-ui-0.73.0.tar
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

This example demonstrates:

- **ChatPanel** - The main chat interface component
- **System Prompt** - Custom configuration for the AI assistant
- **Server workspace tools** - The normal Web UI agent flow creates files, runs commands, and publishes previews in a fixed server project root
- **Session persistence** - Active and recent sessions are restored from browser storage
- **Model persistence** - The selected model is remembered across refreshes and new sessions
- **Configured local storage** - Sessions and generated project files are mirrored to fixed directories from `pi-storage.config.json`

## Configuration

### API Keys

The example uses the browser-stored provider key for the Web UI agent. Server workspace tools do not call an AI provider; they only write files, run commands, and prepare previews.

To use the chat:

1. Click the settings icon (⚙️) in the chat interface
2. Click "Manage API Keys"
3. Add your API key for your preferred provider:
   - **Anthropic**: Get a key from [console.anthropic.com](https://console.anthropic.com/)
   - **OpenAI**: Get a key from [platform.openai.com](https://platform.openai.com/)
   - **Google**: Get a key from [makersuite.google.com](https://makersuite.google.com/)

API keys and custom providers are stored in the browser and mirrored to the configured PI server `settingsFile` so another browser can reuse the same model configuration. The mirrored API keys and custom provider credentials are stored as plaintext in `settings.json`; use this only for local or controlled deployments. For untrusted multi-user production, replace this with server-side credentials or a controlled proxy.

## Session Storage Behavior

The example uses **browser IndexedDB as its primary runtime store**.

By default, it persists:

- conversation history
- session titles and history metadata
- the current or most recent session pointer
- the last selected model
- provider API keys and custom providers
- a JSON mirror of sessions under the configured sessions directory
- settings under the configured settings file
- generated project files under the configured projects root directory

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

## Configured Local Storage

The example mirrors sessions and generated project files through the Vite dev/preview server. The browser no longer asks the user to choose a local directory.

### How it works

- Browser IndexedDB remains the active runtime store.
- Every saved session is also written to a JSON file on disk.
- The session list merges browser-backed and configured local records.
- If a configured local session exists without a browser copy, it is imported back into browser storage when opened.
- The Web UI agent can call server workspace tools: `project_file`, `project_bash`, and `project_preview`.
- Project files are written directly under the configured project root on the server.
- Built-in browser artifacts are disabled for project generation in this example.

### Configuration

Edit `pi-storage.config.json`:

```json
{
  "sessionsDir": "./data/sessions",
  "settingsFile": "./data/settings.json",
  "projectsRootDir": "./data/projects",
  "previewBaseUrl": "",
  "projectInstallCommand": "npm install",
  "projectBuildCommand": "npm run build",
  "projectInstallTimeoutMs": 120000,
  "projectBuildTimeoutMs": 120000
}
```

Relative paths are resolved from `apps/pi-coding-web/`. Absolute paths are also supported.

The example writes:

- `<sessionsDir>/<session-id>.json`
- `<settingsFile>`
- one project root directory per generated project under `projectsRootDir`

With the default configuration, runtime data stays inside `apps/pi-coding-web/data/` and remains decoupled from any PM application directory.

Project directory names are generated from a sanitized session title plus a stable session-id suffix, so multiple generated projects do not collide.

## PM Handoff

The PM app can open this PI Web UI with a short-lived handoff token:

```text
/?handoff_token=<token>&pm_api_base_url=<pm-backend-base-url>
```

PI resolves the token through PM, downloads the PRD/design documents as attachments, and places the PM implementation prompt into the chat input. The PM prompt and documents are treated as the primary requirement source. PI's own handoff instructions only describe platform execution: write files into the configured project root, run short validation/build commands when useful, publish with `project_preview`, and return the Preview URL.

For the current stage, PM demos should target static HTML/CSS/JS projects or Node frontend projects that can be built to static output such as Vite React/Vue. Backend services that require long-running Node processes, databases, or reverse-proxy routing need the later run-manager stage.

## Server Workspace Flow

The example keeps the regular Web UI agent conversation, model selector, API key flow, and tool-card rendering. No extra project panel, log panel, or preview button is added to the UI.

Expected conversation flow:

1. The user sends a request in the chat input.
2. The Web UI agent decides whether project execution is needed.
3. For app/site/project work, it calls `project_file` repeatedly to create or update server-side files.
4. When useful, it calls `project_bash` to run short checks or build commands in the server project root.
5. After files are ready, it calls `project_preview`.
6. If `package.json` exists, the server runs `projectInstallCommand` and then `projectBuildCommand` when a build script exists.
7. The server serves `dist/` when present, otherwise the project root.
8. The browser displays file, command, and preview tool cards plus the final assistant message with the preview URL.

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

This is currently optimized for generated frontend/static projects. Projects with a build output in `dist/` are served from `dist/`; otherwise the project root itself is served.

`project_bash` runs on the same operating system as the PI server process. Failed commands return the command output plus the server platform and shell, so the agent can adjust and retry with an environment-compatible command.

### Limitations

- The configured storage API is provided by this example's Vite dev/preview server.
- If the app is served as static files without that server, the browser can still use IndexedDB, but disk mirroring and generated project file output are unavailable.
- Generated code and model-requested commands may execute on the server. For production multi-user deployment, run the PI server inside an isolated environment and restrict filesystem, network, CPU, memory, and command timeout limits.

## Project Structure

```
example/
├── src/
│   ├── main.ts                     # Main application entry point
│   ├── app.css                     # Tailwind CSS configuration
│   ├── dialogs/
│   │   ├── LocalSessionListDialog.ts
│   ├── storage/
│   │   ├── configured-server-storage.ts
│   │   └── merged-session-index.ts
│   └── tools/
│       └── server-project.ts # Web UI agent tools for server files, commands, and preview
├── index.html        # HTML entry point
├── package.json      # Dependencies
├── pi-storage.config.json
├── src/project-tools/ # Browser-side tool schemas, API client, and renderers
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
