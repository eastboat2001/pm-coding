from __future__ import annotations

import json
from http import HTTPStatus

from flask import Blueprint, Response, current_app, jsonify, request, send_file, stream_with_context

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


def _request_language(default: str = "zh") -> str:
    payload = request.get_json(silent=True) or {}
    language = str(payload.get("language", request.args.get("language", default))).strip().lower()
    return language or default


def _structured_requirement_response(
    session_id: str,
    structured_requirement_model: dict[str, object],
    sync_status: str = "ready",
):
    return {
        "session_id": session_id,
        "summary": structured_requirement_model,
        "structured_requirement_model": structured_requirement_model,
        "structured_requirement_sync_status": sync_status,
    }


@api.post("/sessions")
def create_session():
    service = _get_service()
    payload = request.get_json(silent=True) or {}
    template_id = str(payload.get("template_id", "")).strip() or None
    language = _request_language()
    try:
        session = service.create_session(template_id=template_id, language=language)
    except KeyError:
        return jsonify({"error": "Business template not found."}), HTTPStatus.NOT_FOUND
    structured_requirement_snapshot = service.get_structured_requirement_snapshot(session.id, language)
    return (
        jsonify(
            {
                "session_id": session.id,
                "title": session.title,
                "prompt_template": session.prompt_template,
                "applied_template_id": session.applied_template_id,
                "applied_template_name": session.applied_template_name,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "messages": session.messages,
                "summary": structured_requirement_snapshot["structured_requirement_model"],
                "structured_requirement_model": structured_requirement_snapshot["structured_requirement_model"],
                "structured_requirement_sync_status": structured_requirement_snapshot["structured_requirement_sync_status"],
            }
        ),
        HTTPStatus.CREATED,
    )


@api.get("/sessions")
def list_sessions():
    service = _get_service()
    return jsonify({"sessions": service.list_sessions()})


@api.get("/templates")
def list_templates():
    service = _get_service()
    return jsonify({"templates": service.list_business_templates()})


@api.get("/templates/<template_id>")
def get_template(template_id: str):
    service = _get_service()
    template = service.get_business_template(template_id)
    if template is None:
        return jsonify({"error": "Business template not found."}), HTTPStatus.NOT_FOUND
    return jsonify(template)


@api.get("/sessions/<session_id>")
def get_session(session_id: str):
    service = _get_service()
    session = service.get_session(session_id)
    if session is None:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    structured_requirement_snapshot = service.get_structured_requirement_snapshot(
        session_id,
        _request_language(),
    )

    return jsonify(
        {
            "session_id": session.id,
            "title": session.title,
            "prompt_template": session.prompt_template,
            "applied_template_id": session.applied_template_id,
            "applied_template_name": session.applied_template_name,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "messages": session.messages,
            "summary": structured_requirement_snapshot["structured_requirement_model"],
            "structured_requirement_model": structured_requirement_snapshot["structured_requirement_model"],
            "structured_requirement_sync_status": structured_requirement_snapshot["structured_requirement_sync_status"],
        }
    )


@api.delete("/sessions/<session_id>")
def delete_session(session_id: str):
    service = _get_service()
    deleted = service.delete_session(session_id)
    if not deleted:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    return ("", HTTPStatus.NO_CONTENT)


@api.post("/sessions/<session_id>/prompt-template")
def update_session_prompt_template(session_id: str):
    payload = request.get_json(silent=True) or {}
    prompt_template = str(payload.get("prompt_template", "")).strip()
    if not prompt_template:
        return jsonify({"error": "Field `prompt_template` is required."}), HTTPStatus.BAD_REQUEST

    service = _get_service()
    try:
        session = service.update_session_prompt_template(session_id, prompt_template)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except ValueError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.CONFLICT

    return jsonify(
        {
            "session_id": session.id,
            "title": session.title,
            "prompt_template": session.prompt_template,
            "applied_template_id": session.applied_template_id,
            "applied_template_name": session.applied_template_name,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "messages": session.messages,
        }
    )


@api.post("/sessions/<session_id>/messages")
def send_message(session_id: str):
    payload = request.get_json(silent=True) or {}
    user_message = str(payload.get("message", "")).strip()
    language = str(payload.get("language", "zh")).strip()
    if not user_message:
        return jsonify({"error": "Field `message` is required."}), HTTPStatus.BAD_REQUEST

    service = _get_service()
    try:
        result = service.send_user_message(session_id, user_message, language)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY

    return jsonify(result)


@api.post("/sessions/<session_id>/messages/stream")
def stream_message(session_id: str):
    payload = request.get_json(silent=True) or {}
    user_message = str(payload.get("message", "")).strip()
    language = str(payload.get("language", "zh")).strip()
    if not user_message:
        return jsonify({"error": "Field `message` is required."}), HTTPStatus.BAD_REQUEST

    service = _get_service()

    def event_stream():
        try:
            for item in service.stream_user_message(session_id, user_message, language):
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
    language = _request_language()
    service = _get_service()
    try:
        structured_requirement_model = service.build_structured_requirement_model(session_id, language)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(_structured_requirement_response(session_id, structured_requirement_model, "ready"))


@api.get("/sessions/<session_id>/structured-requirement")
def get_structured_requirement(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        structured_requirement_model = service.build_structured_requirement_model(session_id, language)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(_structured_requirement_response(session_id, structured_requirement_model, "ready"))


@api.get("/sessions/<session_id>/design-doc")
def get_design_doc(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.build_system_design_document(session_id, language, save_history=False)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(result)


@api.get("/sessions/<session_id>/prd-doc")
def get_prd_doc(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.build_prd_document(session_id, language, save_history=False)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(result)


@api.post("/sessions/<session_id>/prd-doc")
def post_prd_doc(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.build_prd_document(session_id, language, save_history=True)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(result)


@api.post("/sessions/<session_id>/prd-doc/stream")
def stream_prd_doc(session_id: str):
    language = _request_language()
    service = _get_service()

    def event_stream():
        try:
            for item in service.stream_prd_document(session_id, language, save_history=True):
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
        except Exception as exc:
            data = json.dumps({"event": "error", "error": str(exc)}, ensure_ascii=False)
            yield "event: error\n"
            yield f"data: {data}\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@api.post("/sessions/<session_id>/design-doc")
def post_design_doc(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.build_system_design_document(session_id, language, save_history=True)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND
    except LLMError as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_GATEWAY
    return jsonify(result)


@api.post("/sessions/<session_id>/design-doc/stream")
def stream_design_doc(session_id: str):
    language = _request_language()
    service = _get_service()

    def event_stream():
        try:
            for item in service.stream_system_design_document(session_id, language, save_history=True):
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
        except Exception as exc:
            data = json.dumps({"event": "error", "error": str(exc)}, ensure_ascii=False)
            yield "event: error\n"
            yield f"data: {data}\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@api.get("/sessions/<session_id>/design-doc/download")
def download_design_doc(session_id: str):
    service = _get_service()
    try:
        result = service.get_saved_design_document(session_id)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    if result is None:
        return jsonify({"error": "Design document not found. Generate it first."}), HTTPStatus.NOT_FOUND

    file_path, download_name = result
    return send_file(
        file_path,
        mimetype="text/markdown; charset=utf-8",
        as_attachment=True,
        download_name=download_name,
        max_age=0,
    )


@api.get("/sessions/<session_id>/messages/<int:message_id>/download")
def download_session_message_document(session_id: str, message_id: int):
    service = _get_service()
    try:
        result = service.get_saved_message_document(session_id, message_id)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    if result is None:
        return jsonify({"error": "Document not found for this history item."}), HTTPStatus.NOT_FOUND

    file_path, download_name = result
    return send_file(
        file_path,
        mimetype="text/markdown; charset=utf-8",
        as_attachment=True,
        download_name=download_name,
        max_age=0,
    )


@api.get("/sessions/<session_id>/prd-doc/download")
def download_prd_doc(session_id: str):
    service = _get_service()
    try:
        result = service.get_saved_prd_document(session_id)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    if result is None:
        return jsonify({"error": "PRD document not found. Generate it first."}), HTTPStatus.NOT_FOUND

    file_path, download_name = result
    return send_file(
        file_path,
        mimetype="text/markdown; charset=utf-8",
        as_attachment=True,
        download_name=download_name,
        max_age=0,
    )


@api.get("/sessions/<session_id>/implementation-context")
def get_implementation_context(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.build_implementation_context(session_id, language)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    if not result.get("documents_ready"):
        missing_documents = result.get("missing_documents", [])
        missing_summary = ", ".join(str(item) for item in missing_documents) or "prd, design"
        return (
            jsonify(
                {
                    "error": f"Required generated documents are missing: {missing_summary}.",
                    **result,
                }
            ),
            HTTPStatus.NOT_FOUND,
        )

    return jsonify(result)


@api.post("/sessions/<session_id>/coding-handoff")
def create_coding_handoff(session_id: str):
    language = _request_language()
    service = _get_service()
    try:
        result = service.create_coding_handoff(session_id, language)
    except KeyError:
        return jsonify({"error": "Session not found."}), HTTPStatus.NOT_FOUND

    if not result.get("payload", {}).get("documents_ready", result.get("documents_ready", False)):
        payload = result.get("payload") if isinstance(result.get("payload"), dict) else result
        missing_documents = payload.get("missing_documents", []) if isinstance(payload, dict) else []
        missing_summary = ", ".join(str(item) for item in missing_documents) or "prd, design"
        return (
            jsonify(
                {
                    "error": f"Required generated documents are missing: {missing_summary}.",
                    **payload,
                }
            ),
            HTTPStatus.NOT_FOUND,
        )

    open_url = request.args.get("open_url", "").strip()
    response_payload = {
        "handoff_token": result["handoff_token"],
        "expires_at": result["expires_at"],
    }
    if open_url:
        response_payload["open_url"] = open_url
    return jsonify(response_payload), HTTPStatus.CREATED


@api.get("/coding-handoffs/<token>")
def resolve_coding_handoff(token: str):
    service = _get_service()
    result = service.resolve_coding_handoff(token)
    if result is None:
        return jsonify({"error": "Coding handoff not found or expired."}), HTTPStatus.NOT_FOUND
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
