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
- **Session persistence** - Active and recent sessions are restored from browser storage
- **Model persistence** - The selected model is remembered across refreshes and new sessions
- **Optional local sync** - Sessions can also be mirrored to a local directory as JSON files

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

## Optional Local Directory Sync

The example can mirror sessions into a local directory using the browser's **File System Access API**.

### How it works

- Browser IndexedDB remains the active runtime store.
- When local sync is enabled, sessions are also written to JSON files on disk.
- The session list merges browser-backed and local-backed records.
- If a local session exists without a browser copy, it can be imported back into browser storage when opened.

### How to enable it

1. Open **Settings**.
2. Go to **Local Sync**.
3. Click **Choose Directory**.
4. Select a local directory.

After that, the example writes:

- `sessions/<session-id>.json`
- `settings.json`

### Limitations

- This feature depends on the **File System Access API**.
- It is only available in browsers that support directory handles and permission persistence.
- If browser support is missing, the app continues to work with browser IndexedDB only.
- API keys are **not** mirrored to local files by this feature.

## Project Structure

```
example/
├── src/
│   ├── main.ts                     # Main application entry point
│   ├── app.css                     # Tailwind CSS configuration
│   ├── dialogs/
│   │   ├── LocalSessionListDialog.ts
│   │   └── LocalSyncSettingsTab.ts
│   └── storage/
│       ├── file-system-access.d.ts
│       ├── local-session-sync.ts
│       ├── merged-session-index.ts
│       └── session-file-codec.ts
├── index.html        # HTML entry point
├── package.json      # Dependencies
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
