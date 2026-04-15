from __future__ import annotations

import json
from http import HTTPStatus

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context

from .services.llm_client import LLMError
from .services.requirement_collector import RequirementCollectorService
from .services.asr_client import ASRError

api = Blueprint("api", __name__, url_prefix="/api")


def _get_service() -> RequirementCollectorService:
    service = current_app.extensions.get("requirement_collector")
    if service is None:
        raise RuntimeError("Requirement collector service not initialized.")
    return service


def _get_asr_client():
    """获取ASR客户端"""
    asr_client = current_app.extensions.get("asr_client")
    if asr_client is None:
        raise RuntimeError("ASR client not initialized.")
    return asr_client


@api.post("/sessions")
def create_session():
    service = _get_service()
    session = service.create_session()
    return (
        jsonify(
            {
                "session_id": session.id,
                "created_at": session.created_at,
                "messages": session.messages,
            }
        ),
        HTTPStatus.CREATED,
    )


@api.get("/sessions/<session_id>")
def get_session(session_id: str):
    service = _get_service()
    session = service.get_session(session_id)
    if session is None:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    return jsonify(
        {
            "session_id": session.id,
            "created_at": session.created_at,
            "messages": session.messages,
        }
    )


@api.post("/sessions/<session_id>/messages")
def send_message(session_id: str):
    payload = request.get_json(silent=True) or {}
    user_message = str(payload.get("message", "")).strip()
    if not user_message:
        return jsonify({"error": "Field `message` is required."}), HTTPStatus.BAD_REQUEST

    service = _get_service()
    try:
        result = service.send_user_message(session_id, user_message)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(result)


@api.post("/sessions/<session_id>/messages/stream")
def stream_message(session_id: str):
    payload = request.get_json(silent=True) or {}
    user_message = str(payload.get("message", "")).strip()
    if not user_message:
        return jsonify({"error": "Field `message` is required."}), HTTPStatus.BAD_REQUEST

    service = _get_service()

    def event_stream():
        try:
            for item in service.stream_user_message(session_id, user_message):
                event_name = item.get("event", "message")
                data = json.dumps(item, ensure_ascii=False)
                yield f"event: {event_name}\n"
                yield f"data: {data}\n\n"
        except KeyError:
            data = json.dumps({"event": "error", "error": "Session not found."}, ensure_ascii=False)
            yield "event: error\n"
            yield f"data: {data}\n\n"
        except LLMError as exc:
            data = json.dumps({"event": "error", "error": str(exc)}, ensure_ascii=False)
            yield "event: error\n"
            yield f"data: {data}\n\n"
        except Exception as exc:  # Defensive fallback for streaming parsing issues.
            data = json.dumps({"event": "error", "error": str(exc)}, ensure_ascii=False)
            yield "event: error\n"
            yield f"data: {data}\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@api.get("/sessions/<session_id>/summary")
def get_summary(session_id: str):
    service = _get_service()
    try:
        summary = service.build_session_summary(session_id)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify({"session_id": session_id, "summary": summary})


@api.get("/sessions/<session_id>/design-doc")
def get_design_doc(session_id: str):
    service = _get_service()
    try:
        result = service.build_system_design_document(session_id)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(result)


@api.post("/asr/recognize")
def recognize_speech():
    """识别语音并返回文本"""
    if "audio" not in request.files:
        return jsonify({"error": "Field `audio` is required."}), HTTPStatus.BAD_REQUEST
    
    audio_file = request.files["audio"]
    audio_data = audio_file.read()
    
    # 保存录音文件
    import os
    import uuid
    from datetime import datetime
    
    # 创建录音保存目录
    recordings_dir = os.path.join(os.path.dirname(__file__), "..", "recordings")
    if not os.path.exists(recordings_dir):
        os.makedirs(recordings_dir)
    
    # 生成文件名
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"recording_{timestamp}_{str(uuid.uuid4())[:8]}.wav"
    filepath = os.path.join(recordings_dir, filename)
    
    # 保存录音
    with open(filepath, "wb") as f:
        f.write(audio_data)
    
    asr_client = _get_asr_client()
    try:
        result = asr_client.recognize(audio_data)
    except ASRError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    except Exception as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.INTERNAL_SERVER_ERROR
    
    return jsonify({"text": result, "recording_file": filename})
