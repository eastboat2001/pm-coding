# Flask Project

## 1. Create virtual environment
```powershell
python -m venv .venv
```

## 2. Activate virtual environment
```powershell
.venv\Scripts\Activate.ps1
```

## 3. Install dependencies
```powershell
pip install -r requirements.txt
```

## 4. Configure LLM environment variables
```powershell
$env:LLM_PROVIDER="openai_compatible"
$env:LLM_BASE_URL="https://api.minimaxi.com/v1"
$env:LLM_API_KEY="your_api_key"
$env:LLM_MODEL="MiniMax-M2.7"
$env:LLM_TIMEOUT_SECONDS="500"
$env:CODING_UI_STORAGE_DIR="C:\PM-Coding\pm\data\coding_ui"
$env:CODING_UI_PROJECTS_ROOT="C:\PM-Coding\pm\data\generated_projects"
```

### Gemini on Vertex AI (service account)
If you use a Google Cloud service account JSON file instead of an OpenAI-compatible API:

```powershell
$env:LLM_PROVIDER="vertex_gemini"
$env:LLM_MODEL="gemini-2.5-flash"
$env:LLM_GCP_PROJECT_ID="your-gcp-project-id"
$env:LLM_GCP_LOCATION="global"
$env:LLM_GCP_CREDENTIALS_PATH="C:\path\to\service-account.json"
```

## 5. Start backend
```powershell
python run.py
```

Backend URL: `http://127.0.0.1:5000/`

## Requirement Collection API

1. Create session
```http
POST /api/sessions
```

2. Send user message (PM conversation)
```http
POST /api/sessions/{session_id}/messages
Content-Type: application/json

{
  "message": "We want to build an attendance system"
}
```

3. Stream message
```http
POST /api/sessions/{session_id}/messages/stream
Content-Type: application/json

{
  "message": "Our initial target is SMB companies"
}
```

4. Get session
```http
GET /api/sessions/{session_id}
```

5. Get structured summary
```http
GET /api/sessions/{session_id}/summary
```

6. Generate full system design document
```http
GET /api/sessions/{session_id}/design-doc
```

7. Get implementation context for downstream coding AI
```http
GET /api/sessions/{session_id}/implementation-context
```

## Coding UI backend persistence

The backend now owns coding UI local persistence. The browser no longer chooses a local directory in settings.

Configured directories:

- `CODING_UI_STORAGE_DIR`: stores coding UI session JSON and `settings.json`
- `CODING_UI_PROJECTS_ROOT`: stores generated project files reconstructed from the coding UI artifact state

Project directories are created automatically using a sanitized session-title slug plus a stable session-id suffix, which prevents multiple generated projects from colliding.

Additional coding UI endpoints:

- `GET /api/coding-ui/storage`
- `GET /api/coding-ui/sessions`
- `GET /api/coding-ui/sessions/{session_id}`
- `PUT /api/coding-ui/sessions/{session_id}`
- `DELETE /api/coding-ui/sessions/{session_id}`
- `GET /api/coding-ui/settings`
- `PUT /api/coding-ui/settings`

## Optional proxy settings
If your network requires a proxy to access the LLM endpoint:

```powershell
$env:LLM_PROXY_URL="http://127.0.0.1:7890"
$env:LLM_MAX_RETRIES="2"
```

Or in `.env`:

```env
LLM_PROXY_URL=http://127.0.0.1:7890
LLM_MAX_RETRIES=2
LLM_DEBUG_STREAM=true
LOG_LEVEL=INFO
CODING_UI_STORAGE_DIR=C:\PM-Coding\pm\data\coding_ui
CODING_UI_PROJECTS_ROOT=C:\PM-Coding\pm\data\generated_projects
# Optional: configure the Vite frontend in frontend/.env
VITE_API_BASE_URL=http://127.0.0.1:5000
VITE_GO_CODING_URL=http://localhost:8888
```
