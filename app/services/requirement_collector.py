from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterator

from .llm_client import MiniMaxChatClient


PM_SYSTEM_PROMPT = """You are a senior Product Manager.
Your primary mission is requirement discovery for producing a complete System Design Document for engineering.
The final output is expected to guide development end-to-end, including system use cases, database design, and implementation guidance.

Target document sections to support:
- Product scope and business goals
- Actors and system use cases
- Functional requirements and user flows
- Non-functional requirements (security, performance, reliability, compliance)
- Data entities, relationships, constraints, and lifecycle (for DB design)
- API/domain boundaries and integration dependencies
- Technical constraints, assumptions, and risks
- Acceptance criteria and release priorities

Rules:
1) Ask exactly one highest-value clarification question each turn.
   Never ask multiple questions in a single turn.
2) Keep responses concise, professional, and friendly.
3) Prioritize collecting info required for system design: business goals, actors, use cases, entities, data rules, interfaces, constraints, and acceptance criteria.
4) For each major feature, probe for: trigger, preconditions, main flow, alternate flow, exceptions, and measurable completion criteria.
5) For data-related topics, always clarify: entity definitions, unique keys, cardinality, consistency rules, retention/audit, and privacy/security needs.
6) When enough detail is available, provide a brief current requirement summary and explicitly list missing inputs needed to complete the design document.
7) If user statements conflict, call it out and ask for confirmation.
"""

PM_SYSTEM_PROMPT_ZH = """你是一位资深的产品经理。
你的主要任务是需求收集，以便为工程团队生成完整的系统设计文档。
最终输出应指导端到端开发，包括系统用例、数据库设计和实施指导。

需要支持的文档章节：
- 产品范围和业务目标
- 角色和系统用例
- 功能需求和用户流程
- 非功能性需求（安全性、性能、可靠性、合规性）
- 数据实体、关系、约束和生命周期（用于数据库设计）
- API/领域边界和集成依赖
- 技术约束、假设和风险
- 验收标准和发布优先级

规则：
1) 每次只问一个最高价值的澄清问题。
   绝不要在单次对话中问多个问题。
2) 回复要简洁、专业且友好。
3) 优先收集系统设计所需的信息：业务目标、角色、用例、实体、数据规则、接口、约束和验收标准。
4) 对于每个主要功能，要询问：触发条件、前置条件、主流程、备选流程、异常情况和可衡量的完成标准。
5) 对于数据相关主题，始终要澄清：实体定义、唯一键、基数、一致性规则、保留/审计以及隐私/安全需求。
6) 当有足够细节时，提供当前需求的简要总结，并明确列出完成设计文档所需的缺失输入。
7) 如果用户陈述有冲突，指出并要求确认。
"""

SUMMARY_SYSTEM_PROMPT = """You are a requirement analysis assistant.
Based on the conversation, output strict JSON only:
{
  "project_name": "string",
  "business_goal": "string",
  "target_users": ["string"],
  "core_scenarios": ["string"],
  "functional_requirements": ["string"],
  "non_functional_requirements": ["string"],
  "constraints": ["string"],
  "acceptance_criteria": ["string"],
  "open_questions": ["string"],
  "priority": "high|medium|low|unknown"
}
Requirements:
1) Output JSON only with no extra text.
2) Use empty string/array for missing information.
3) Do not hallucinate facts.
"""

DESIGN_DOC_SYSTEM_PROMPT = """You are a senior Solution Architect and Technical Product Architect.
Your task is to transform collected requirement conversations into a complete, implementation-ready System Design Document in Markdown.

Output goals:
1) The document must guide development teams directly.
2) Include explicit system use cases and database design guidance.
3) Clearly separate confirmed information vs assumptions/TBDs.
4) If information is missing, include a "Open Questions / Missing Inputs" section.

Mandatory sections (Markdown headings):
# System Design Document
## 1. Scope and Objectives
## 2. Personas and Actors
## 3. System Use Cases
## 4. Functional Requirements
## 5. Non-Functional Requirements
## 6. High-Level Architecture
## 7. Module Responsibilities
## 8. API Design (Draft)
## 9. Data Model and Database Design
## 10. Key Workflows / Sequence Narratives
## 11. Security, Privacy, and Compliance
## 12. Observability and Operations
## 13. Deployment and Environment Plan
## 14. Testing and Acceptance Plan
## 15. Risks, Trade-offs, and Assumptions
## 16. Milestones and Delivery Plan
## 17. Open Questions / Missing Inputs

Database design section requirements:
- Candidate tables/entities and purpose
- Key fields (PK/FK/unique/index suggestions)
- Relationships/cardinality
- Data constraints and consistency rules
- Retention/audit and sensitive data handling

Use case section requirements:
- Actor
- Trigger
- Preconditions
- Main flow
- Alternate/exception flows
- Postconditions
- Acceptance checks

Style:
- Practical, concise, and engineering-oriented
- Use bullet lists and small tables when helpful
- Do not invent unknown business facts; mark as TBD
"""


@dataclass
class Session:
    id: str
    created_at: str
    messages: list[dict[str, str]] = field(default_factory=list)


class RequirementCollectorService:
    def __init__(self, llm_client: MiniMaxChatClient) -> None:
        self.llm_client = llm_client
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create_session(self) -> Session:
        session = Session(
            id=str(uuid.uuid4()),
            created_at=datetime.now(timezone.utc).isoformat(),
            messages=[],
        )
        with self._lock:
            self._sessions[session.id] = session
        return session

    def get_session(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def send_user_message(self, session_id: str, user_message: str, language: str = "zh") -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        user_item = {"role": "user", "content": user_message}
        session.messages.append(user_item)

        system_prompt = PM_SYSTEM_PROMPT_ZH if language == "zh" else PM_SYSTEM_PROMPT
        llm_messages = [{"role": "system", "content": system_prompt}, *session.messages]
        assistant_text_raw = self.llm_client.chat(llm_messages)
        assistant_text, thinking_text = self._split_thinking(assistant_text_raw)

        assistant_item = {"role": "assistant", "content": assistant_text}
        session.messages.append(assistant_item)

        summary = self._build_summary(session.messages)
        return {
            "assistant_message": assistant_text,
            "assistant_thinking": thinking_text,
            "summary": summary,
            "session_id": session.id,
            "message_count": len(session.messages),
        }

    def stream_user_message(self, session_id: str, user_message: str, language: str = "zh") -> Iterator[dict[str, Any]]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        user_item = {"role": "user", "content": user_message}
        session.messages.append(user_item)

        system_prompt = PM_SYSTEM_PROMPT_ZH if language == "zh" else PM_SYSTEM_PROMPT
        llm_messages = [{"role": "system", "content": system_prompt}, *session.messages]
        assistant_text_parts: list[str] = []
        thinking_parts: list[str] = []

        for item in self.llm_client.stream_chat(llm_messages):
            text = item.get("text", "")
            if not text:
                continue

            if item.get("type") == "thinking":
                thinking_parts.append(text)
                yield {"event": "thinking", "delta": text}
                continue

            assistant_text_parts.append(text)
            yield {"event": "content", "delta": text}

        assistant_text = "".join(assistant_text_parts).strip()
        thinking_text = "".join(thinking_parts).strip()
        assistant_text, content_embedded_thinking = self._split_thinking(assistant_text)
        if content_embedded_thinking:
            thinking_text = f"{thinking_text}\n{content_embedded_thinking}".strip()
        if not assistant_text:
            raise RuntimeError("LLM returned empty streamed content.")

        assistant_item = {"role": "assistant", "content": assistant_text}
        session.messages.append(assistant_item)

        summary = self._build_summary(session.messages)
        if thinking_text:
            yield {"event": "thinking_done", "thinking": thinking_text}
        yield {"event": "summary", "summary": summary}
        yield {"event": "done", "session_id": session.id, "message_count": len(session.messages)}

    def build_session_summary(self, session_id: str) -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")
        return self._build_summary(session.messages)

    def build_system_design_document(self, session_id: str) -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        if not session.messages:
            return {
                "session_id": session_id,
                "document_markdown": "# System Design Document\n\nTBD: no requirement conversation found in this session.",
                "status": "insufficient_input",
            }

        summary = self._build_summary(session.messages)
        doc_markdown = self.llm_client.chat(
            [
                {"role": "system", "content": DESIGN_DOC_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "Requirement conversation messages:\n"
                        + json.dumps(session.messages, ensure_ascii=False)
                        + "\n\nStructured summary:\n"
                        + json.dumps(summary, ensure_ascii=False)
                    ),
                },
            ],
            temperature=0.2,
        )
        return {
            "session_id": session_id,
            "document_markdown": doc_markdown,
            "summary": summary,
            "status": "ok",
        }

    def _build_summary(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        if not messages:
            return self._empty_summary()

        raw_summary = self.llm_client.chat(
            [
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(messages, ensure_ascii=False)},
            ],
            temperature=0.1,
        )
        return self._safe_parse_summary(raw_summary)

    def _safe_parse_summary(self, raw_summary: str) -> dict[str, Any]:
        parsed = self._parse_json_from_model_output(raw_summary)
        if parsed is None:
            fallback = self._empty_summary()
            fallback["open_questions"] = [f"Summary parse failed. Raw output: {raw_summary}"]
            return fallback

        parsed.setdefault("project_name", "")
        parsed.setdefault("business_goal", "")
        parsed.setdefault("target_users", [])
        parsed.setdefault("core_scenarios", [])
        parsed.setdefault("functional_requirements", [])
        parsed.setdefault("non_functional_requirements", [])
        parsed.setdefault("constraints", [])
        parsed.setdefault("acceptance_criteria", [])
        parsed.setdefault("open_questions", [])
        parsed.setdefault("priority", "unknown")
        return parsed

    def _split_thinking(self, text: str) -> tuple[str, str]:
        think_regex = re.compile(r"<think>([\s\S]*?)</think>", re.IGNORECASE)
        thinking_parts = [chunk.strip() for chunk in think_regex.findall(text) if chunk.strip()]
        cleaned = think_regex.sub("", text).strip()
        return cleaned, "\n\n".join(thinking_parts)

    def _parse_json_from_model_output(self, raw: str) -> dict[str, Any] | None:
        if not raw:
            return None

        cleaned, _ = self._split_thinking(raw)
        candidates = [cleaned]

        fenced = re.findall(r"```(?:json)?\s*([\s\S]*?)```", cleaned, flags=re.IGNORECASE)
        candidates.extend(fenced)

        for candidate in candidates:
            obj = self._try_load_first_json_object(candidate)
            if obj is not None:
                return obj
        return None

    def _try_load_first_json_object(self, text: str) -> dict[str, Any] | None:
        stripped = text.strip()
        if not stripped:
            return None

        # First, try whole text directly.
        try:
            parsed = json.loads(stripped)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass

        # Then, scan for the first balanced JSON object.
        start = stripped.find("{")
        while start != -1:
            depth = 0
            in_string = False
            escaped = False
            for i in range(start, len(stripped)):
                ch = stripped[i]
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == '"':
                        in_string = False
                    continue
                if ch == '"':
                    in_string = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        snippet = stripped[start : i + 1]
                        try:
                            parsed = json.loads(snippet)
                            return parsed if isinstance(parsed, dict) else None
                        except json.JSONDecodeError:
                            break
            start = stripped.find("{", start + 1)
        return None

    def _empty_summary(self) -> dict[str, Any]:
        return {
            "project_name": "",
            "business_goal": "",
            "target_users": [],
            "core_scenarios": [],
            "functional_requirements": [],
            "non_functional_requirements": [],
            "constraints": [],
            "acceptance_criteria": [],
            "open_questions": [],
            "priority": "unknown",
        }
