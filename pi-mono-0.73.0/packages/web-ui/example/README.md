# Pi Web UI - Example

This is a minimal example showing how to use `@mariozechner/pi-web-ui` in a web application.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## What's Included

This example demonstrates:

- **ChatPanel** - The main chat interface component
- **System Prompt** - Custom configuration for the AI assistant
- **Tools** - JavaScript REPL and artifacts tool
- **Deployment tool** - Generated artifacts can be published to a configured server directory and served by URL
- **Session persistence** - Active and recent sessions are restored from browser storage
- **Model persistence** - The selected model is remembered across refreshes and new sessions
- **Configured local storage** - Sessions and generated project files are mirrored to fixed directories from `pi-storage.config.json`

## Configuration

### API Keys

The example uses **Direct Mode** by default, which means it calls AI provider APIs directly from the browser.

To use the chat:

1. Click the settings icon (⚙️) in the chat interface
2. Click "Manage API Keys"
3. Add your API key for your preferred provider:
   - **Anthropic**: Get a key from [console.anthropic.com](https://console.anthropic.com/)
   - **OpenAI**: Get a key from [platform.openai.com](https://platform.openai.com/)
   - **Google**: Get a key from [makersuite.google.com](https://makersuite.google.com/)

API keys are stored in your browser's localStorage and never sent to any server except the AI provider's API.

## Session Storage Behavior

The example uses **browser IndexedDB as its primary runtime store**.

By default, it persists:

- conversation history
- session titles and history metadata
- the current or most recent session pointer
- the last selected model
- a JSON mirror of sessions under the configured sessions directory
- settings under the configured settings file
- generated artifact files under the configured projects root directory

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
- Files created through the `artifacts` tool are reconstructed into a per-session project directory.

### Configuration

Edit `pi-storage.config.json`:

```json
{
  "sessionsDir": "./data/sessions",
  "settingsFile": "./data/settings.json",
  "projectsRootDir": "./data/generated_projects",
  "deploymentsRootDir": "./data/deployments",
  "previewBaseUrl": "",
  "projectInstallCommand": "npm install",
  "projectBuildCommand": "npm run build",
  "projectInstallTimeoutMs": 120000,
  "projectBuildTimeoutMs": 120000
}
```

Relative paths are resolved from `packages/web-ui/example/`. Absolute paths are also supported.

The example writes:

- `<sessionsDir>/<session-id>.json`
- `<settingsFile>`
- one generated project directory per session under `projectsRootDir`
- one deployment directory per published project under `deploymentsRootDir`

With the default configuration, runtime data stays inside `packages/web-ui/example/data/` and remains decoupled from any PM application directory.

Project directory names are generated from a sanitized session title plus a stable session-id suffix, so multiple generated projects do not collide.

## Background Deployment

The example registers a `deploy_project` tool for the assistant. No extra project panel, log panel, or preview button is added to the UI.

Expected conversation flow:

1. The assistant creates runnable project files with the `artifacts` tool.
2. The assistant calls `deploy_project`.
3. The server writes those files under `deploymentsRootDir`.
4. If `package.json` exists, the server runs `projectInstallCommand` and then `projectBuildCommand` when a build script exists.
5. The final assistant message includes the preview URL.

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

This is currently optimized for generated frontend/static projects. Projects with a build output in `dist/` are served from `dist/`; otherwise the deployment directory itself is served.

### Limitations

- The configured storage API is provided by this example's Vite dev/preview server.
- If the app is served as static files without that server, the browser can still use IndexedDB, but disk mirroring and generated project file output are unavailable.
- API keys are **not** mirrored to local files by this feature.
- Generated code is executed during install/build. For production multi-user deployment, run the PI server inside an isolated environment and restrict filesystem, network, CPU, memory, and command timeout limits.

## Project Structure

```
example/
├── src/
│   ├── main.ts                     # Main application entry point
│   ├── app.css                     # Tailwind CSS configuration
│   ├── dialogs/
│   │   ├── LocalSessionListDialog.ts
│   ├── tools/
│   │   ├── deploy-project.ts
│   └── storage/
│       ├── configured-server-storage.ts
│       └── merged-session-index.ts
├── index.html        # HTML entry point
├── package.json      # Dependencies
├── pi-storage.config.json
├── storage-server.ts # Vite middleware for configured local storage and project file output
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
