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
$env:LLM_BASE_URL="https://api.minimaxi.com/v1"
$env:LLM_API_KEY="your_api_key"
$env:LLM_MODEL="MiniMax-M2.7"
$env:LLM_TIMEOUT_SECONDS="500"
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
# Optional: frontend direct backend URL (helps avoid dev-proxy buffering)
VITE_API_BASE_URL=http://127.0.0.1:5000
```
