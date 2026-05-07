from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .business_template_library import BusinessTemplateLibrary
from .llm_client import MiniMaxChatClient
from .session_store import SQLiteSessionStore
from .structured_requirement_model import (
    build_structured_requirement_model_prompt,
    empty_structured_requirement_model,
    normalize_structured_requirement_model,
)


PM_SYSTEM_PROMPT = """You are a principal Product Manager leading professional requirement discovery.
Your mission is to turn ambiguous stakeholder input into implementation-ready requirement context for engineering and system design.

You are not just collecting feature requests.
You must uncover the business problem, user task, operating context, decision rules, data model implications, delivery constraints, and measurable success criteria behind each request.

Your output should support a complete System Design Document, including:
- Product scope and business goals
- Personas, roles, and permissions
- Core scenarios and system use cases
- Functional requirements and workflow rules
- Non-functional requirements (security, performance, reliability, compliance, observability)
- Data entities, relationships, lifecycle, consistency, and audit requirements
- Integrations, API/domain boundaries, and operational constraints
- Assumptions, risks, release scope, and acceptance criteria

Professional discovery approach:
1) Start from the problem before the solution.
   If the user proposes features, trace them back to goal, user, scenario, pain point, and success metric.
2) Think in layers:
   business objective -> target users/roles -> high-value scenarios -> workflow steps -> business rules/data -> non-functional constraints -> rollout and priority.
3) Use these frameworks internally when helpful:
   - 5W1H for context completeness
   - JTBD for the underlying user task and motivation
   - KANO or Must/Should/Could/Won't for release priority and scope
   - happy path / alternate path / exception path for workflow completeness
   - risk / assumption analysis for missing or uncertain inputs
4) Distinguish real needs from pseudo-needs.
   If the user describes a solution, test whether it is the true requirement or just one possible implementation.
5) Prefer concrete reality over abstract preference.
   Ask about actual users, current process, recent examples, edge cases, frequency, volume, SLAs, and failure consequences.

What you must collect over time:
- Why this project exists now, what business outcome matters, and how success will be measured
- Who the actors are, what permissions or responsibilities differ by role
- What the top user scenarios are, including trigger, preconditions, main flow, alternate flow, exception flow, and completion criteria
- What business rules, validations, approvals, states, notifications, and audit behavior apply
- What core entities, identifiers, relationships, retention rules, and privacy/security constraints exist
- What integrations, upstream/downstream systems, external APIs, imports/exports, or manual handoffs exist
- What non-functional expectations exist: latency, throughput, uptime, security, compliance, traceability, localization, etc.
- What delivery constraints exist: timeline, budget, legacy systems, staffing, rollout scope, MVP boundaries

Conversation rules:
1) Ask exactly one highest-value clarification question per turn.
   Never ask multiple questions in a single turn.
2) Keep responses concise, professional, and friendly.
3) Choose the next question based on the single biggest uncertainty that blocks system design quality.
4) If the user answer is broad, narrow it with one concrete follow-up question.
5) If the user statements conflict, call out the conflict explicitly and ask for confirmation.
6) When enough detail exists for a topic, briefly summarize what is confirmed and move to the next biggest gap.
7) If the user asks to move quickly or to make assumptions, use reasonable defaults but label them clearly as assumptions rather than facts.

Preferred response pattern:
- First, briefly synthesize what is now understood.
- Second, if relevant, note the biggest risk, ambiguity, or assumption.
- Third, ask exactly one precise next question.

Do not:
- dump long checklists in every turn
- ask generic multi-part questions
- invent business facts
- jump into architecture recommendations before the requirement is sufficiently clear
"""

PM_SYSTEM_PROMPT_ZH = """你是一位资深且方法论扎实的产品经理，负责主导专业的需求采集。
你的任务不是机械记录功能点，而是把模糊的业务想法转化为工程团队可落地的需求上下文，为后续系统设计文档提供高质量输入。

你要持续追问并澄清：
- 业务为什么现在要做这件事
- 真正的用户是谁、要完成什么任务
- 现有流程和痛点是什么
- 规则、数据、接口、约束和风险分别是什么
- 什么算做成、什么先做、什么暂时不做

你的输出最终要支撑完整的系统设计文档，包括：
- 产品范围和业务目标
- 角色、权限和关键参与方
- 核心场景和系统用例
- 功能需求、流程规则和异常处理
- 非功能需求（安全、性能、可靠性、合规、可观测性）
- 数据实体、关系、生命周期、一致性和审计要求
- 集成依赖、接口边界、上下游系统
- 假设、风险、发布范围和验收标准

请采用专业的需求分析方法，但只在必要时对外显式表达方法名：
1) 先问题，后方案。
   如果用户一上来给的是功能或实现方案，要先追溯背后的业务目标、用户任务、场景、痛点和成功标准。
2) 分层推进需求采集：
   业务目标 -> 用户/角色 -> 核心场景 -> 流程步骤 -> 业务规则/数据 -> 非功能约束 -> 发布范围与优先级。
3) 在内部灵活使用这些方法：
   - 5W1H：补齐上下文
   - JTBD：识别用户真正要完成的任务和动机
   - KANO 或 Must/Should/Could/Won't：判断优先级和MVP边界
   - 主流程 / 备选流程 / 异常流程：补齐用例
   - 风险 / 假设分析：识别不确定项
4) 识别“伪需求”。
   用户描述的可能只是某个解决方案，不一定是真正需求；你要判断背后的目标是什么。
5) 优先追问真实业务事实，而不是停留在抽象偏好。
   尽量问清：当前怎么做、谁来做、多久一次、量级多大、失败后果是什么、是否有审批/通知/审计/权限边界。

你需要逐步收集的信息包括：
- 项目背景：为什么现在做、业务目标是什么、成功如何衡量
- 用户与角色：谁使用、谁审批、谁查看、谁维护，不同角色的权限差异
- 核心场景：触发条件、前置条件、主流程、备选流程、异常处理、完成标准
- 业务规则：校验规则、状态流转、审批机制、通知机制、边界条件
- 数据要求：核心实体、唯一标识、关联关系、保留周期、审计、隐私与安全
- 集成要求：上下游系统、外部接口、导入导出、人工交接点
- 非功能要求：性能、可靠性、安全、合规、可观测性、国际化/本地化等
- 交付约束：时间、预算、现有系统、团队资源、MVP边界、发布优先级

对话规则：
1) 每次只问一个“当前最有价值”的澄清问题，绝不一次问多个问题。
2) 回答保持简洁、专业、友好，不要把每轮都变成冗长问卷。
3) 下一个问题要围绕“当前最影响系统设计质量的不确定性”来选。
4) 如果用户回答过于宽泛，就把问题收窄到一个具体场景、一个具体角色或一个具体规则。
5) 如果发现前后信息冲突，要明确指出并请求确认。
6) 当某个主题已经足够清晰时，先简短总结已确认内容，再转向下一个最大缺口。
7) 如果用户要求快速推进或允许你自行假设，可以给出合理默认假设，但必须明确标注“这是假设，不是已确认事实”。

建议的回答结构：
- 先用一句话概括当前已明确的关键信息
- 如有必要，再指出当前最大的风险、模糊点或假设
- 最后只问一个精准的问题

不要：
- 每轮都抛出长清单式问题
- 提多个并列问题让用户一次回答
- 臆造业务事实
- 在需求还没清楚时，过早给出架构方案
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

DESIGN_DOC_SYSTEM_PROMPT_ZH = """你是一位资深解决方案架构师和技术产品架构师。
你的任务是把已收集的需求对话整理成一份可直接指导研发落地的《系统设计文档》Markdown。

输出目标：
1) 文档要能直接指导开发团队实施。
2) 必须包含明确的系统用例和数据库设计建议。
3) 已确认信息与假设/TBD 要清晰区分。
4) 如果信息缺失，必须包含“待确认问题 / 缺失输入”章节。
5) 全文请使用简体中文输出。

必备章节（Markdown 标题）：
# 系统设计文档
## 1. 范围与目标
## 2. 用户角色与参与方
## 3. 系统用例
## 4. 功能需求
## 5. 非功能需求
## 6. 高层架构设计
## 7. 模块职责划分
## 8. API 设计（草案）
## 9. 数据模型与数据库设计
## 10. 关键流程 / 时序说明
## 11. 安全、隐私与合规
## 12. 可观测性与运维
## 13. 部署与环境规划
## 14. 测试与验收方案
## 15. 风险、权衡与假设
## 16. 里程碑与交付计划
## 17. 待确认问题 / 缺失输入

数据库设计章节要求：
- 候选表/实体及用途
- 关键字段（PK/FK/唯一约束/索引建议）
- 关系与基数
- 数据约束与一致性规则
- 保留/审计与敏感数据处理

系统用例章节要求：
- 参与者
- 触发条件
- 前置条件
- 主流程
- 备选/异常流程
- 后置条件
- 验收检查点

风格要求：
- 实用、简洁、偏工程落地
- 适当使用项目符号和小表格
- 不要臆造未知业务事实；未知项请标记为 TBD
"""

PRD_DOC_SYSTEM_PROMPT = """You are a senior product manager and PRD writer.
Your task is to transform the collected requirement conversation plus the structured requirement model into a concise Product Requirement Document in Markdown.

Output goals:
1) Follow the provided PRD template closely in section order and intent.
2) Use the structured requirement model as the primary source of truth, and use the raw conversation only to resolve phrasing or add clearly supported detail.
3) When requirement collection is incomplete, produce a draft PRD with simple assumptions. Every assumption must be explicitly labeled as an assumption, never presented as confirmed fact.
4) Keep the PRD practical and readable for product, design, and engineering handoff.
5) Preserve unresolved or uncertain items in a clear open-questions section.

Writing rules:
- Output Markdown only.
- Prefer concise bullet points and short explanatory paragraphs.
- Do not invent architecture, APIs, or database design unless directly required by the template and clearly supported by the conversation.
- Use TBD only when neither confirmed facts nor a small, clearly labeled assumption is appropriate.
- If collection progress is incomplete, mention the draft nature of the document near the beginning.
- If acceptance criteria exist in the structured requirement model, append an Acceptance Criteria section even if the simple template does not contain one explicitly.
"""

PRD_EMPTY_BY_LANGUAGE = {
    "en": "# Product Requirement Document\n\nTBD: no requirement conversation found in this session.",
    "de": "# Produktanforderungsdokument\n\nTBD: In dieser Sitzung wurde noch kein ausreichender Anforderungsdialog gefunden.",
    "zh": "# 产品需求文档\n\nTBD：当前会话中还没有足够的需求对话内容。",
    "ms": "# Dokumen Keperluan Produk\n\nTBD: belum ada perbualan keperluan yang mencukupi dalam sesi ini.",
}

PRD_TEMPLATE_FILE_BY_LANGUAGE = {
    "en": "simple-prd-template.en.md",
    "de": "simple-prd-template.de.md",
    "zh": "simple-prd-template.zh-CN.md",
    "ms": "simple-prd-template.ms.md",
}

PROMPT_TEMPLATE_PERSONAL_PROJECT = "personal_project"
PROMPT_TEMPLATE_STANDARD = "standard"

SUPPORTED_OUTPUT_LANGUAGES = {"en", "de", "zh", "ms"}

DESIGN_DOC_EMPTY_BY_LANGUAGE = {
    "en": "# System Design Document\n\nTBD: no requirement conversation found in this session.",
    "de": "# Systemdesign-Dokument\n\nTBD: In dieser Sitzung wurde noch kein ausreichender Anforderungsdialog gefunden.",
    "zh": "# 系统设计文档\n\nTBD：当前会话中还没有足够的需求对话内容。",
    "ms": "# Dokumen Reka Bentuk Sistem\n\nTBD: belum ada perbualan keperluan yang mencukupi dalam sesi ini.",
}

CONVERSATION_LABELS = {
    "en": "Requirement conversation messages",
    "de": "Nachrichten aus dem Anforderungsdialog",
    "zh": "需求对话消息",
    "ms": "Mesej perbualan keperluan",
}

SUMMARY_LABELS = {
    "en": "Structured requirement model",
    "de": "Strukturiertes Anforderungsmodell",
    "zh": "结构化摘要",
    "ms": "Model keperluan berstruktur",
}

OUTPUT_LANGUAGE_INSTRUCTIONS = {
    "en": "Output language requirement:\n- Respond entirely in English, including section headings, lists, and tables.",
    "de": "Output language requirement:\n- Respond entirely in German, including section headings, lists, and tables.",
    "zh": "输出语言要求：\n- 全文请使用简体中文输出，包括章节标题、列表和表格。",
    "ms": "Output language requirement:\n- Respond entirely in Bahasa Melayu, including section headings, lists, and tables.",
}

PERSONAL_PROJECT_PM_ADDENDUM = """
Project template: personal project demo.
Assume the default implementation stack is:
- Frontend: Vue
- Backend: Flask
- Database: SQLite

Constraint profile for this template:
- Prioritize single-developer delivery and fast implementation.
- Treat the target as a demo / MVP / personal project unless the user explicitly asks for production-grade complexity.
- Do not optimize for high concurrency, multi-region deployment, distributed systems, or enterprise-scale governance by default.
- Prefer a single deployable application shape with simple REST APIs and straightforward module boundaries.
- Focus requirement discovery on pages, core flows, data tables, API contracts, and minimal deployment/testing needs.
- Only raise advanced concerns such as caching, queues, horizontal scaling, complex permissions, or heavy observability when the user explicitly needs them.
"""

PERSONAL_PROJECT_PM_ADDENDUM_ZH = """
项目模板：个人项目 Demo 版。
默认实现技术栈假设为：
- 前端：Vue
- 后端：Flask
- 数据库：SQLite

该模板的约束偏好：
- 优先支持单人开发、快速落地。
- 除非用户明确提出更高要求，否则默认目标是 Demo / MVP / 个人项目，而不是企业级生产系统。
- 默认不重点考虑高并发、多地域部署、分布式系统、复杂中间件和重型治理要求。
- 优先采用单体、易部署、REST API 清晰、模块边界简单直接的方案。
- 需求采集重点放在页面、核心流程、数据表、接口约定，以及最小可用的部署/测试方式上。
- 只有当用户明确提出时，才深入追问缓存、消息队列、水平扩展、复杂权限体系、重型可观测性等高级能力。
"""

PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM = """
Solution template: personal project demo.
Target implementation stack:
- Frontend: Vue
- Backend: Flask
- Database: SQLite

Document constraints:
- Produce a design suitable for a personal project / demo / MVP.
- Default to a simple monolithic structure unless the user explicitly asks otherwise.
- Do not introduce high-concurrency architecture, distributed services, message queues, service mesh, read-write splitting, or other enterprise-scale mechanisms unless explicitly required.
- API design should be pragmatic and lightweight, suitable for Flask REST endpoints.
- Database design should stay compatible with SQLite capabilities and limitations.
- Deployment should favor local development and low-cost simple hosting.
- Security, observability, and testing should be right-sized for a demo, while still calling out basic minimum good practices.
"""

PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM_ZH = """
方案模板：个人项目 Demo 版。
目标实现技术栈：
- 前端：Vue
- 后端：Flask
- 数据库：SQLite

文档约束：
- 生成的设计文档应服务于个人项目 / Demo / MVP 落地。
- 除非用户明确要求，否则默认采用简单单体结构。
- 不要默认引入高并发架构、分布式服务、消息队列、服务网格、读写分离等企业级复杂机制。
- API 设计应务实轻量，适合 Flask 风格 REST 接口实现。
- 数据库设计要兼容 SQLite 的能力和限制。
- 部署方案优先本地开发与低成本、简单托管。
- 安全、可观测性、测试方案要符合 Demo 尺度，但仍需给出基本的最低实践建议。
"""

PERSONAL_PROJECT_PM_ADDENDUM_V2 = """
Project template: personal project demo.
Do not treat the technology stack as fixed.
If the user explicitly specifies a frontend, backend, or database stack, follow the user's choice.
Only when the user does not specify a stack, default to a lightweight personal-project stack selected from:
- Frontend: Vue
- Backend: Flask
- Database: SQLite

Constraint profile for this template:
- Prioritize single-developer delivery and fast implementation.
- Treat the target as a demo / MVP / personal project unless the user explicitly asks for production-grade complexity.
- Do not optimize for high concurrency, multi-region deployment, distributed systems, or enterprise-scale governance by default.
- Prefer a single deployable application shape with simple REST APIs and straightforward module boundaries.
- Focus requirement discovery on pages, core flows, data tables, API contracts, and minimal deployment/testing needs.
- Only raise advanced concerns such as caching, queues, horizontal scaling, complex permissions, or heavy observability when the user explicitly needs them.
"""

PERSONAL_PROJECT_PM_ADDENDUM_ZH_V2 = """
项目模板：个人项目 Demo 版。
不要把技术栈视为固定不变。
如果用户明确指定了前端、后端或数据库技术栈，优先遵循用户选择。
只有当用户没有指定技术栈时，才默认从以下轻量个人项目技术栈中选择：
- 前端：Vue
- 后端：Flask
- 数据库：SQLite

该模板的约束偏好：
- 优先支持单人开发、快速落地。
- 除非用户明确提出更高要求，否则默认目标是 Demo / MVP / 个人项目，而不是企业级生产系统。
- 默认不重点考虑高并发、多地域部署、分布式系统、复杂中间件和重型治理要求。
- 优先采用单体、易部署、REST API 清晰、模块边界简单直接的方案。
- 需求采集重点放在页面、核心流程、数据表、接口约定，以及最小可用的部署/测试方式上。
- 只有当用户明确提出时，才深入追问缓存、消息队列、水平扩展、复杂权限体系、重型可观测性等高级能力。
"""

PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM_V2 = """
Solution template: personal project demo.
Do not hard-code the technology stack.
If the user explicitly specifies the frontend, backend, or database stack, generate the design around that stack.
Only when the user does not specify a stack, default to a lightweight implementation selected from:
- Frontend: Vue
- Backend: Flask
- Database: SQLite

Document constraints:
- Produce a design suitable for a personal project / demo / MVP.
- Default to a simple monolithic structure unless the user explicitly asks otherwise.
- Do not introduce high-concurrency architecture, distributed services, message queues, service mesh, read-write splitting, or other enterprise-scale mechanisms unless explicitly required.
- API design should match the chosen backend stack; if the default stack is used, prefer pragmatic Flask-style REST endpoints.
- Database design should match the chosen database stack; if the default stack is used, stay compatible with SQLite capabilities and limitations.
- Deployment should favor local development and low-cost simple hosting.
- Security, observability, and testing should be right-sized for a demo, while still calling out basic minimum good practices.
"""

PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM_ZH_V2 = """
方案模板：个人项目 Demo 版。
不要把技术栈写死。
如果用户明确指定了前端、后端或数据库技术栈，生成设计文档时优先围绕用户指定技术栈展开。
只有当用户没有指定技术栈时，才默认从以下轻量实现中选择：
- 前端：Vue
- 后端：Flask
- 数据库：SQLite

文档约束：
- 生成的设计文档应服务于个人项目 / Demo / MVP 落地。
- 除非用户明确要求，否则默认采用简单单体结构。
- 不要默认引入高并发架构、分布式服务、消息队列、服务网格、读写分离等企业级复杂机制。
- API 设计要和已选后端技术栈保持一致；如果使用默认栈，则优先用轻量、务实的 Flask 风格 REST 接口。
- 数据库设计要和已选数据库技术栈保持一致；如果使用默认栈，则优先兼容 SQLite 的能力和限制。
- 部署方案优先本地开发与低成本、简单托管。
- 安全、可观测性、测试方案要符合 Demo 尺度，但仍需给出基本的最低实践建议。
"""


@dataclass
class Session:
    id: str
    created_at: str
    updated_at: str
    title: str = ""
    prompt_template: str = PROMPT_TEMPLATE_PERSONAL_PROJECT
    applied_template_id: str = ""
    applied_template_name: str = ""
    messages: list[dict[str, Any]] = field(default_factory=list)


class RequirementCollectorService:
    def __init__(self, llm_client: MiniMaxChatClient, session_store: SQLiteSessionStore) -> None:
        self.llm_client = llm_client
        self.session_store = session_store
        self.design_docs_dir = self.session_store.db_path.parent / "design_docs"
        self.prd_docs_dir = self.session_store.db_path.parent / "prd_docs"
        self.prd_templates_dir = Path(__file__).resolve().parents[2] / "data" / "PRD_template"
        self.business_template_library = BusinessTemplateLibrary(self.prd_templates_dir)
        self._lock = threading.Lock()

    def create_session(self, template_id: str | None = None) -> Session:
        session_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        applied_template_id = ""
        applied_template_name = ""
        title = ""

        if template_id:
            template_detail = self.get_business_template(template_id)
            if template_detail is None:
                raise KeyError("Business template not found.")
            applied_template_id = template_detail["template_id"]
            applied_template_name = template_detail["template_name"]
            title = applied_template_name

        record = self.session_store.create_session(
            session_id=session_id,
            created_at=created_at,
            title=title,
            applied_template_id=applied_template_id,
            applied_template_name=applied_template_name,
        )
        return self._session_from_record(record)

    def get_session(self, session_id: str) -> Session | None:
        record = self.session_store.get_session(session_id)
        if record is None:
            return None
        return self._session_from_record(record)

    def list_sessions(self) -> list[dict[str, Any]]:
        return self.session_store.list_sessions()

    def list_business_templates(self) -> list[dict[str, Any]]:
        return self.business_template_library.list_templates()

    def get_business_template(self, template_id: str) -> dict[str, Any] | None:
        return self.business_template_library.get_template(template_id)

    def delete_session(self, session_id: str) -> bool:
        return self.session_store.delete_session(session_id)

    def update_session_prompt_template(self, session_id: str, prompt_template: str) -> Session:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")
        if session.applied_template_id:
            raise ValueError("Prompt template is managed by the applied business template.")
        if self._session_has_user_messages(session):
            raise ValueError("Prompt template can only be changed before the first user message.")

        normalized_template = self._normalize_prompt_template(prompt_template)
        self.session_store.update_session_prompt_template(session_id, normalized_template)
        return self._require_session(session_id)

    def send_user_message(self, session_id: str, user_message: str, language: str = "zh") -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        self._append_message(session_id, "user", user_message)
        if not self._session_has_user_messages(session):
            self._update_session_title_from_message(session_id, user_message)
        session = self._require_session(session_id)

        system_prompt = self._pm_prompt(session, language)
        llm_messages = self._build_llm_messages(system_prompt, session.messages)
        assistant_text_raw = self.llm_client.chat(llm_messages)
        assistant_text, thinking_text = self._split_thinking(assistant_text_raw)

        self._append_message(session_id, "assistant", assistant_text, thinking_text)
        session = self._require_session(session_id)

        structured_requirement_model = self._build_and_cache_structured_requirement_model(session, language)
        return {
            "assistant_message": assistant_text,
            "assistant_thinking": thinking_text,
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "structured_requirement_sync_status": "ready",
            "session_id": session.id,
            "message_count": len(session.messages),
        }

    def stream_user_message(self, session_id: str, user_message: str, language: str = "zh") -> Iterator[dict[str, Any]]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        self._append_message(session_id, "user", user_message)
        if not self._session_has_user_messages(session):
            self._update_session_title_from_message(session_id, user_message)
        session = self._require_session(session_id)

        system_prompt = self._pm_prompt(session, language)
        llm_messages = self._build_llm_messages(system_prompt, session.messages)
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

        self._append_message(session_id, "assistant", assistant_text, thinking_text)
        session = self._require_session(session_id)

        if thinking_text:
            yield {"event": "thinking_done", "thinking": thinking_text}
        yield {"event": "assistant_done", "session_id": session.id, "message_count": len(session.messages)}
        structured_requirement_model = self._build_and_cache_structured_requirement_model(session, language)
        yield {
            "event": "summary",
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "structured_requirement_sync_status": "ready",
            "message_count": len(session.messages),
        }
        yield {"event": "done", "session_id": session.id, "message_count": len(session.messages)}

    def build_session_summary(self, session_id: str, language: str = "zh") -> dict[str, Any]:
        return self.build_structured_requirement_model(session_id, language)

    def build_structured_requirement_model(
        self,
        session_id: str,
        language: str = "zh",
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")
        message_count = self._message_count(session.messages)
        if not force_refresh:
            cached_model = self._get_cached_structured_requirement_model(
                session_id,
                language,
                message_count,
            )
            if cached_model is not None:
                return cached_model
        return self._build_and_cache_structured_requirement_model(session, language)

    def get_structured_requirement_snapshot(
        self,
        session_id: str,
        language: str = "zh",
    ) -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        message_count = self._message_count(session.messages)
        cached_entry = self.session_store.get_structured_requirement_cache_entry(session_id, language)
        if cached_entry is None:
            return {
                "structured_requirement_model": self._empty_structured_requirement_model(),
                "structured_requirement_sync_status": "ready" if message_count == 0 else "missing",
                "message_count": message_count,
            }

        cached_model = normalize_structured_requirement_model(cached_entry.get("model"))
        cached_message_count = self._safe_int(cached_entry.get("message_count"))
        sync_status = "ready" if cached_message_count == message_count else "stale"
        return {
            "structured_requirement_model": cached_model,
            "structured_requirement_sync_status": sync_status,
            "message_count": message_count,
        }

    def build_system_design_document(self, session_id: str, language: str = "zh") -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        if not session.messages:
            doc_markdown = self._default_design_doc(language)
            saved_at = self._save_design_document(session_id, doc_markdown)
            structured_requirement_model = self._empty_structured_requirement_model()
            return {
                "session_id": session_id,
                "document_markdown": doc_markdown,
                "document_type": "system_design_markdown",
                "filename": self._build_design_doc_filename(session),
                "download_url": f"/api/sessions/{session_id}/design-doc/download",
                "saved_at": saved_at,
                "summary": structured_requirement_model,
                "structured_requirement_model": structured_requirement_model,
                "status": "insufficient_input",
            }

        structured_requirement_model = self.build_structured_requirement_model(session_id, language)
        progress = self._structured_requirement_progress(structured_requirement_model)
        seed_markdown = self._build_design_doc_seed_markdown(
            structured_requirement_model,
            progress,
            language,
        )
        doc_markdown = self.llm_client.chat(
            self._build_design_doc_messages(
                session,
                session.messages,
                structured_requirement_model,
                progress,
                seed_markdown,
                language,
            ),
            temperature=0.2,
        )
        doc_markdown, _ = self._split_thinking(doc_markdown)
        doc_markdown = doc_markdown.strip() or seed_markdown
        saved_at = self._save_design_document(session_id, doc_markdown)
        return {
            "session_id": session_id,
            "document_markdown": doc_markdown,
            "document_type": "system_design_markdown",
            "filename": self._build_design_doc_filename(session),
            "download_url": f"/api/sessions/{session_id}/design-doc/download",
            "saved_at": saved_at,
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "status": "ok" if progress["ready_to_generate"] else "draft_with_assumptions",
        }

    def stream_system_design_document(self, session_id: str, language: str = "zh") -> Iterator[dict[str, Any]]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        if not session.messages:
            doc_markdown = self._default_design_doc(language)
            saved_at = self._save_design_document(session_id, doc_markdown)
            structured_requirement_model = self._empty_structured_requirement_model()
            yield {"event": "content", "delta": doc_markdown}
            yield {
                "event": "done",
                "session_id": session_id,
                "document_markdown": doc_markdown,
                "document_type": "system_design_markdown",
                "filename": self._build_design_doc_filename(session),
                "download_url": f"/api/sessions/{session_id}/design-doc/download",
                "saved_at": saved_at,
                "summary": structured_requirement_model,
                "structured_requirement_model": structured_requirement_model,
                "status": "insufficient_input",
            }
            return

        structured_requirement_model = self.build_structured_requirement_model(session_id, language)
        progress = self._structured_requirement_progress(structured_requirement_model)
        seed_markdown = self._build_design_doc_seed_markdown(
            structured_requirement_model,
            progress,
            language,
        )
        doc_parts: list[str] = []
        thinking_parts: list[str] = []
        llm_messages = self._build_design_doc_messages(
            session,
            session.messages,
            structured_requirement_model,
            progress,
            seed_markdown,
            language,
        )

        for item in self.llm_client.stream_chat(llm_messages, temperature=0.2):
            text = item.get("text", "")
            if not text:
                continue

            if item.get("type") == "thinking":
                thinking_parts.append(text)
                yield {"event": "thinking", "delta": text}
                continue

            doc_parts.append(text)
            yield {"event": "content", "delta": text}

        doc_markdown = "".join(doc_parts).strip()
        thinking_text = "".join(thinking_parts).strip()
        doc_markdown, content_embedded_thinking = self._split_thinking(doc_markdown)
        if content_embedded_thinking:
            thinking_text = f"{thinking_text}\n{content_embedded_thinking}".strip()

        if not doc_markdown:
            doc_markdown = seed_markdown
            if not doc_parts:
                yield {"event": "content", "delta": doc_markdown}

        saved_at = self._save_design_document(session_id, doc_markdown)
        if thinking_text:
            yield {"event": "thinking_done", "thinking": thinking_text}
        yield {
            "event": "done",
            "session_id": session_id,
            "document_markdown": doc_markdown,
            "document_type": "system_design_markdown",
            "filename": self._build_design_doc_filename(session),
            "download_url": f"/api/sessions/{session_id}/design-doc/download",
            "saved_at": saved_at,
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "status": "ok" if progress["ready_to_generate"] else "draft_with_assumptions",
        }

    def build_prd_document(self, session_id: str, language: str = "zh") -> dict[str, Any]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        if not session.messages:
            doc_markdown = self._load_prd_template(session, language) or self._default_prd_doc(language)
            saved_at = self._save_prd_document(session_id, doc_markdown)
            structured_requirement_model = self._empty_structured_requirement_model()
            return {
                "session_id": session_id,
                "document_markdown": doc_markdown,
                "document_type": "prd_markdown",
                "filename": self._build_prd_doc_filename(session),
                "download_url": f"/api/sessions/{session_id}/prd-doc/download",
                "saved_at": saved_at,
                "summary": structured_requirement_model,
                "structured_requirement_model": structured_requirement_model,
                "status": "template_scaffold" if session.applied_template_id else "insufficient_input",
            }

        structured_requirement_model = self.build_structured_requirement_model(session_id, language)
        progress = self._structured_requirement_progress(structured_requirement_model)
        doc_markdown = self.llm_client.chat(
            self._build_prd_doc_messages(
                session,
                session.messages,
                structured_requirement_model,
                progress,
                language,
            ),
            temperature=0.2,
        )
        saved_at = self._save_prd_document(session_id, doc_markdown)
        return {
            "session_id": session_id,
            "document_markdown": doc_markdown,
            "document_type": "prd_markdown",
            "filename": self._build_prd_doc_filename(session),
            "download_url": f"/api/sessions/{session_id}/prd-doc/download",
            "saved_at": saved_at,
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "status": "ok" if progress["ready_to_generate"] else "draft_with_assumptions",
        }

    def stream_prd_document(self, session_id: str, language: str = "zh") -> Iterator[dict[str, Any]]:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        if not session.messages:
            doc_markdown = self._load_prd_template(session, language) or self._default_prd_doc(language)
            saved_at = self._save_prd_document(session_id, doc_markdown)
            structured_requirement_model = self._empty_structured_requirement_model()
            yield {"event": "content", "delta": doc_markdown}
            yield {
                "event": "done",
                "session_id": session_id,
                "document_markdown": doc_markdown,
                "document_type": "prd_markdown",
                "filename": self._build_prd_doc_filename(session),
                "download_url": f"/api/sessions/{session_id}/prd-doc/download",
                "saved_at": saved_at,
                "summary": structured_requirement_model,
                "structured_requirement_model": structured_requirement_model,
                "status": "template_scaffold" if session.applied_template_id else "insufficient_input",
            }
            return

        structured_requirement_model = self.build_structured_requirement_model(session_id, language)
        progress = self._structured_requirement_progress(structured_requirement_model)
        doc_parts: list[str] = []
        thinking_parts: list[str] = []
        llm_messages = self._build_prd_doc_messages(
            session,
            session.messages,
            structured_requirement_model,
            progress,
            language,
        )

        for item in self.llm_client.stream_chat(llm_messages, temperature=0.2):
            text = item.get("text", "")
            if not text:
                continue

            if item.get("type") == "thinking":
                thinking_parts.append(text)
                yield {"event": "thinking", "delta": text}
                continue

            doc_parts.append(text)
            yield {"event": "content", "delta": text}

        doc_markdown = "".join(doc_parts).strip()
        thinking_text = "".join(thinking_parts).strip()
        doc_markdown, content_embedded_thinking = self._split_thinking(doc_markdown)
        if content_embedded_thinking:
            thinking_text = f"{thinking_text}\n{content_embedded_thinking}".strip()

        if not doc_markdown:
            raise RuntimeError("LLM returned empty streamed PRD document.")

        saved_at = self._save_prd_document(session_id, doc_markdown)
        if thinking_text:
            yield {"event": "thinking_done", "thinking": thinking_text}
        yield {
            "event": "done",
            "session_id": session_id,
            "document_markdown": doc_markdown,
            "document_type": "prd_markdown",
            "filename": self._build_prd_doc_filename(session),
            "download_url": f"/api/sessions/{session_id}/prd-doc/download",
            "saved_at": saved_at,
            "summary": structured_requirement_model,
            "structured_requirement_model": structured_requirement_model,
            "status": "ok" if progress["ready_to_generate"] else "draft_with_assumptions",
        }

    def get_saved_design_document(self, session_id: str) -> tuple[Path, str] | None:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        design_doc_path = self._design_doc_path(session_id)
        if not design_doc_path.exists():
            return None

        return design_doc_path, self._build_design_doc_filename(session)

    def get_saved_prd_document(self, session_id: str) -> tuple[Path, str] | None:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")

        prd_doc_path = self._prd_doc_path(session_id)
        if not prd_doc_path.exists():
            return None

        return prd_doc_path, self._build_prd_doc_filename(session)

    def _build_structured_requirement_model(self, session: Session, language: str = "zh") -> dict[str, Any]:
        if not session.messages:
            return self._empty_structured_requirement_model()

        raw_model = self.llm_client.chat(
            [
                {
                    "role": "system",
                    "content": self._structured_requirement_model_prompt(session, language),
                },
                {
                    "role": "user",
                    "content": json.dumps(self._conversation_messages(session.messages), ensure_ascii=False),
                },
            ],
            temperature=0.1,
        )
        return self._safe_parse_structured_requirement_model(raw_model)

    def _build_and_cache_structured_requirement_model(
        self,
        session: Session,
        language: str,
    ) -> dict[str, Any]:
        structured_requirement_model = self._build_structured_requirement_model(session, language)
        self.session_store.save_structured_requirement_cache_entry(
            session_id=session.id,
            language=language,
            message_count=self._message_count(session.messages),
            structured_requirement_model=structured_requirement_model,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        return structured_requirement_model

    def _get_cached_structured_requirement_model(
        self,
        session_id: str,
        language: str,
        message_count: int,
    ) -> dict[str, Any] | None:
        cached_entry = self.session_store.get_structured_requirement_cache_entry(session_id, language)
        if cached_entry is None:
            return None
        cached_message_count = self._safe_int(cached_entry.get("message_count"))
        if cached_message_count != message_count:
            return None
        return normalize_structured_requirement_model(cached_entry.get("model"))

    def _message_count(self, messages: list[dict[str, Any]]) -> int:
        return len(messages)

    def _safe_int(self, value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return -1

    def _session_from_record(self, record: dict[str, Any]) -> Session:
        return Session(
            id=record["session_id"],
            title=record.get("title", ""),
            prompt_template=self._normalize_prompt_template(record.get("prompt_template", PROMPT_TEMPLATE_PERSONAL_PROJECT)),
            applied_template_id=str(record.get("applied_template_id", "")).strip(),
            applied_template_name=str(record.get("applied_template_name", "")).strip(),
            created_at=record["created_at"],
            updated_at=record.get("updated_at", record["created_at"]),
            messages=record.get("messages", []),
        )

    def _conversation_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        return [
            {
                "role": str(item.get("role", "")),
                "content": str(item.get("content", "")),
            }
            for item in messages
        ]

    def _build_llm_messages(self, system_prompt: str, messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        return [{"role": "system", "content": system_prompt}, *self._conversation_messages(messages)]

    def _resolve_business_template(self, session: Session) -> dict[str, Any] | None:
        if not session.applied_template_id:
            return None
        return self.business_template_library.get_template_prompt_context(session.applied_template_id)

    def _business_template_pm_addendum(self, session: Session) -> str:
        template = self._resolve_business_template(session)
        if template is None:
            if not session.applied_template_name:
                return ""
            return (
                "An applied business requirement template is active for this session.\n"
                f"- Template name: {session.applied_template_name}\n"
                "- Drive discovery using the template structure instead of the generic project interview mode.\n"
                "- Prioritize collecting concrete answers for the next missing section in the template.\n"
                "- Keep questions aligned to the template's intended business domain and scope.\n"
                "- Do not fall back to the personal-project or expert generic prompting patterns."
            )

        return (
            "An applied business requirement template is active for this session.\n"
            "- Treat this template as the primary requirement-discovery backbone.\n"
            "- Do not use the generic personal-project or expert discovery pattern as the main strategy.\n"
            "- Move section by section through the template and prioritize the highest-value missing information.\n"
            "- Ask questions that help complete the template fields, business rules, and acceptance criteria.\n"
            "- Keep answers grounded in the template's domain and avoid drifting into unrelated discovery tracks.\n"
            f"- Template context: {json.dumps(template, ensure_ascii=False)}"
        )

    def _business_template_document_context(self, session: Session) -> str:
        template = self._resolve_business_template(session)
        if template is None:
            if not session.applied_template_name:
                return ""
            return (
                "Applied business template:\n"
                + json.dumps(
                    {
                        "template_name": session.applied_template_name,
                        "template_id": session.applied_template_id,
                    },
                    ensure_ascii=False,
                )
            )
        return "Applied business template:\n" + json.dumps(template, ensure_ascii=False)

    def _structured_requirement_model_prompt(self, session: Session, language: str) -> str:
        prompt_parts = [build_structured_requirement_model_prompt(language)]
        template_addendum = self._business_template_pm_addendum(session)
        if template_addendum:
            prompt_parts.append(
                "Template-aware extraction rules:\n"
                "- Use the applied business template as additional context for what information matters most.\n"
                "- Keep the structured requirement schema unchanged.\n"
                "- If the template contains fields not represented directly in the schema, map them into the closest schema section or preserve them as open questions.\n"
                + "\n"
                + template_addendum
            )
        return "\n\n".join(part for part in prompt_parts if part)

    def _build_design_doc_messages(
        self,
        session: Session,
        messages: list[dict[str, Any]],
        structured_requirement_model: dict[str, Any],
        progress: dict[str, Any],
        seed_markdown: str,
        language: str,
    ) -> list[dict[str, str]]:
        language = self._normalize_language(language)
        content_label = CONVERSATION_LABELS.get(language, CONVERSATION_LABELS["en"])
        summary_label = SUMMARY_LABELS.get(language, SUMMARY_LABELS["en"])
        draft_mode = "draft_with_assumptions" if not progress["ready_to_generate"] else "confirmed_design_doc"
        business_template_context = self._business_template_document_context(session)
        business_template_block = f"\n\n{business_template_context}" if business_template_context else ""
        return [
            {"role": "system", "content": self._design_doc_prompt(session, language)},
            {
                "role": "user",
                "content": (
                    "Design document scaffold:\n"
                    + seed_markdown
                    + "\n\nCollection progress:\n"
                    + json.dumps(progress, ensure_ascii=False)
                    + f"\n\nGeneration mode:\n{draft_mode}"
                    + f"\n\n{content_label}:\n"
                    + json.dumps(self._conversation_messages(messages), ensure_ascii=False)
                    + f"\n\n{summary_label}:\n"
                    + json.dumps(structured_requirement_model, ensure_ascii=False)
                    + business_template_block
                ),
            },
        ]

    def _append_message(self, session_id: str, role: str, content: str, thinking: str = "") -> None:
        created_at = datetime.now(timezone.utc).isoformat()
        self.session_store.append_message(
            session_id=session_id,
            role=role,
            content=content,
            created_at=created_at,
            thinking=thinking,
        )

    def _require_session(self, session_id: str) -> Session:
        session = self.get_session(session_id)
        if session is None:
            raise KeyError("Session not found.")
        return session

    def _session_has_user_messages(self, session: Session) -> bool:
        return any(item.get("role") == "user" for item in session.messages)

    def _update_session_title_from_message(self, session_id: str, user_message: str) -> None:
        title = self._derive_session_title(user_message)
        if title:
            self.session_store.update_session_title(session_id, title)

    def _derive_session_title(self, user_message: str) -> str:
        collapsed = " ".join(user_message.split())
        if not collapsed:
            return ""
        return collapsed[:39].rstrip() + "..." if len(collapsed) > 40 else collapsed

    def _default_design_doc(self, language: str) -> str:
        language = self._normalize_language(language)
        return DESIGN_DOC_EMPTY_BY_LANGUAGE.get(language, DESIGN_DOC_EMPTY_BY_LANGUAGE["en"])

    def _build_design_doc_seed_markdown(
        self,
        structured_requirement_model: dict[str, Any],
        progress: dict[str, Any],
        language: str,
    ) -> str:
        language = self._normalize_language(language)
        model = normalize_structured_requirement_model(structured_requirement_model)

        copy = {
            "title": "# System Design Document (Draft Scaffold)",
            "draft_hint": (
                "> This design draft is assembled from the structured requirement model first, "
                "then refined by the LLM."
            ),
            "missing_hint": "> Missing or unconfirmed information is explicitly marked as TBD.",
            "tbd": "TBD",
            "progress_label": "Collection coverage",
            "confirmation_label": "Confirmation progress",
            "sections": {
                "scope_goals": "## 1. Scope and Goals",
                "scope_in": "### 1.1 In Scope",
                "scope_out": "### 1.2 Out of Scope",
                "roles": "## 2. User Roles and Participants",
                "use_cases": "## 3. System Use Cases",
                "functional": "## 4. Functional Requirements",
                "feature_overview": "### 4.1 Feature Overview",
                "feature_details": "### 4.2 Feature Details",
                "business_rules": "### 4.3 Business Rules",
                "non_functional": "## 5. Non-functional Requirements",
                "architecture": "## 6. High-level Architecture Design",
                "modules": "## 7. Module Responsibilities",
                "module_candidates": "### 7.1 Candidate Modules",
                "page_touchpoints": "### 7.2 Page / Touchpoint Notes",
                "api": "## 8. API Design (Draft)",
                "data_model": "## 9. Data Model and Database Design",
                "dependencies": "### 9.1 Known Data / Dependency Inputs",
                "key_flows": "## 10. Key Flows / Sequence Notes",
                "security": "## 11. Security, Privacy, and Compliance",
                "observability": "## 12. Observability and Operations",
                "deployment": "## 13. Deployment and Environment Planning",
                "testing": "## 14. Testing and Acceptance Plan",
                "risks": "## 15. Risks, Trade-offs, and Assumptions",
                "milestones": "## 16. Milestones and Delivery Plan",
                "open_questions": "## 17. Open Questions / Missing Inputs",
            },
            "fields": {
                "project_name": "Project name",
                "requirement_name": "Requirement name",
                "background": "Background",
                "objective": "Objective",
                "description": "Description",
                "trigger": "Trigger",
                "processing_logic": "Processing logic",
                "inputs": "Inputs",
                "outputs": "Outputs",
                "exception_cases": "Exception cases",
                "page_name": "Page name",
                "entry_point": "Entry point",
                "page_elements": "Page elements",
                "button_actions": "Button actions",
                "draft_note": "Draft note",
            },
            "feature_label": "Feature",
            "page_label": "Page",
        }
        if language == "zh":
            copy = {
                "title": "# 系统设计文档（草稿骨架）",
                "draft_hint": "> 该设计文档会先基于结构化需求生成稳定骨架，再由模型补充和润色。",
                "missing_hint": "> 缺失或未确认的信息会明确标记为 TBD。",
                "tbd": "TBD",
                "progress_label": "收集覆盖率",
                "confirmation_label": "确认完成度",
                "sections": {
                    "scope_goals": "## 1. 范围与目标",
                    "scope_in": "### 1.1 本次范围",
                    "scope_out": "### 1.2 非本次范围",
                    "roles": "## 2. 用户角色与参与方",
                    "use_cases": "## 3. 系统用例",
                    "functional": "## 4. 功能需求",
                    "feature_overview": "### 4.1 功能概述",
                    "feature_details": "### 4.2 功能明细",
                    "business_rules": "### 4.3 业务规则",
                    "non_functional": "## 5. 非功能需求",
                    "architecture": "## 6. 高层架构设计",
                    "modules": "## 7. 模块职责划分",
                    "module_candidates": "### 7.1 候选模块",
                    "page_touchpoints": "### 7.2 页面 / 触点说明",
                    "api": "## 8. API 设计（草案）",
                    "data_model": "## 9. 数据模型与数据库设计",
                    "dependencies": "### 9.1 已识别的数据 / 依赖输入",
                    "key_flows": "## 10. 关键流程 / 时序说明",
                    "security": "## 11. 安全、隐私与合规",
                    "observability": "## 12. 可观测性与运维",
                    "deployment": "## 13. 部署与环境规划",
                    "testing": "## 14. 测试与验收方案",
                    "risks": "## 15. 风险、权衡与假设",
                    "milestones": "## 16. 里程碑与交付计划",
                    "open_questions": "## 17. 待确认问题 / 缺失输入",
                },
                "fields": {
                    "project_name": "项目名称",
                    "requirement_name": "需求名称",
                    "background": "背景说明",
                    "objective": "目标",
                    "description": "功能描述",
                    "trigger": "触发方式",
                    "processing_logic": "处理逻辑",
                    "inputs": "输入项",
                    "outputs": "输出结果",
                    "exception_cases": "异常情况",
                    "page_name": "页面名称",
                    "entry_point": "入口位置",
                    "page_elements": "页面元素",
                    "button_actions": "按钮动作",
                    "draft_note": "草稿说明",
                },
                "feature_label": "功能",
                "page_label": "页面",
            }

        tbd = copy["tbd"]

        def normalize_list(values: Any) -> list[str]:
            if not isinstance(values, list):
                return []
            return [str(item).strip() for item in values if str(item).strip()]

        def value_or_tbd(value: Any) -> str:
            normalized = str(value or "").strip()
            return normalized or tbd

        def bullet_lines(values: Any) -> list[str]:
            normalized = normalize_list(values)
            if not normalized:
                return ["", f"- {tbd}"]
            return ["", *[f"- {item}" for item in normalized]]

        def numbered_lines(values: Any) -> list[str]:
            normalized = normalize_list(values)
            if not normalized:
                return ["", f"1. {tbd}"]
            return ["", *[f"{index + 1}. {item}" for index, item in enumerate(normalized)]]

        def feature_lines() -> list[str]:
            features = model.get("functional_requirements", {}).get("feature_details", [])
            if not isinstance(features, list):
                return ["", f"- {tbd}"]

            filtered: list[dict[str, Any]] = []
            for item in features:
                if not isinstance(item, dict):
                    continue
                if any(
                    [
                        str(item.get("feature_name", "")).strip(),
                        str(item.get("description", "")).strip(),
                        str(item.get("trigger", "")).strip(),
                        str(item.get("processing_logic", "")).strip(),
                        normalize_list(item.get("inputs")),
                        normalize_list(item.get("outputs")),
                        normalize_list(item.get("exception_cases")),
                    ]
                ):
                    filtered.append(item)

            if not filtered:
                return ["", f"- {tbd}"]

            lines = [""]
            for index, item in enumerate(filtered, start=1):
                title = (
                    str(item.get("feature_name", "")).strip()
                    or str(item.get("description", "")).strip()
                    or tbd
                )
                lines.append(f"#### {copy['feature_label']} {index}: {title}")
                lines.append("")
                lines.append(f"- {copy['fields']['description']}: {value_or_tbd(item.get('description'))}")
                lines.append(f"- {copy['fields']['trigger']}: {value_or_tbd(item.get('trigger'))}")
                lines.append(
                    f"- {copy['fields']['processing_logic']}: {value_or_tbd(item.get('processing_logic'))}"
                )
                lines.append(
                    f"- {copy['fields']['inputs']}: {', '.join(normalize_list(item.get('inputs'))) or tbd}"
                )
                lines.append(
                    f"- {copy['fields']['outputs']}: {', '.join(normalize_list(item.get('outputs'))) or tbd}"
                )
                lines.append(
                    f"- {copy['fields']['exception_cases']}: "
                    f"{', '.join(normalize_list(item.get('exception_cases'))) or tbd}"
                )
                if index < len(filtered):
                    lines.append("")
            return lines

        def page_lines() -> list[str]:
            pages = model.get("page_and_interaction", {}).get("pages", [])
            if not isinstance(pages, list):
                return ["", f"- {tbd}"]

            filtered: list[dict[str, Any]] = []
            for item in pages:
                if not isinstance(item, dict):
                    continue
                if any(
                    [
                        str(item.get("page_name", "")).strip(),
                        str(item.get("entry_point", "")).strip(),
                        normalize_list(item.get("page_elements")),
                        normalize_list(item.get("button_actions")),
                    ]
                ):
                    filtered.append(item)

            if not filtered:
                return ["", f"- {tbd}"]

            lines = [""]
            for index, item in enumerate(filtered, start=1):
                title = (
                    str(item.get("page_name", "")).strip()
                    or str(item.get("entry_point", "")).strip()
                    or tbd
                )
                lines.append(f"#### {copy['page_label']} {index}: {title}")
                lines.append("")
                lines.append(f"- {copy['fields']['page_name']}: {value_or_tbd(item.get('page_name'))}")
                lines.append(f"- {copy['fields']['entry_point']}: {value_or_tbd(item.get('entry_point'))}")
                lines.append(
                    f"- {copy['fields']['page_elements']}: "
                    f"{', '.join(normalize_list(item.get('page_elements'))) or tbd}"
                )
                lines.append(
                    f"- {copy['fields']['button_actions']}: "
                    f"{', '.join(normalize_list(item.get('button_actions'))) or tbd}"
                )
                if index < len(filtered):
                    lines.append("")
            return lines

        candidate_modules: list[str] = []
        for item in model.get("functional_requirements", {}).get("feature_details", []):
            if not isinstance(item, dict):
                continue
            module_name = str(item.get("feature_name", "")).strip() or str(item.get("description", "")).strip()
            if module_name:
                candidate_modules.append(module_name)
        for item in model.get("page_and_interaction", {}).get("pages", []):
            if not isinstance(item, dict):
                continue
            module_name = str(item.get("page_name", "")).strip() or str(item.get("entry_point", "")).strip()
            if module_name:
                candidate_modules.append(module_name)
        candidate_modules = list(dict.fromkeys(candidate_modules))

        pending_questions: list[str] = []
        collection_status = model.get("collection_status", {})
        if isinstance(collection_status, dict):
            for item in collection_status.values():
                if not isinstance(item, dict):
                    continue
                pending_questions.extend(normalize_list(item.get("pending_questions")))
        open_questions = list(
            dict.fromkeys([*normalize_list(model.get("open_questions")), *pending_questions])
        )

        risk_notes = normalize_list(model.get("risks_and_notes"))
        if not progress.get("ready_to_generate"):
            risk_notes = list(
                dict.fromkeys(
                    [
                        f"{copy['fields']['draft_note']}: "
                        + (
                            "该文档仍包含基于未完全确认需求的草稿假设。"
                            if language == "zh"
                            else "This document still contains draft assumptions because not all requirements are fully confirmed."
                        ),
                        *risk_notes,
                    ]
                )
            )

        lines: list[str] = [
            copy["title"],
            "",
            copy["draft_hint"],
            copy["missing_hint"],
            (
                f"> {copy['progress_label']}: {progress.get('collection_coverage_percentage', 0)}% | "
                f"{copy['confirmation_label']}: {progress.get('confirmation_percentage', 0)}%"
            ),
            "",
            copy["sections"]["scope_goals"],
            "",
            f"- {copy['fields']['project_name']}: {value_or_tbd(model.get('document_info', {}).get('project_name'))}",
            f"- {copy['fields']['requirement_name']}: {value_or_tbd(model.get('document_info', {}).get('requirement_name'))}",
            f"- {copy['fields']['background']}: {value_or_tbd(model.get('background', {}).get('summary'))}",
            f"- {copy['fields']['objective']}: {value_or_tbd(model.get('background', {}).get('objective'))}",
            "",
            copy["sections"]["scope_in"],
            *bullet_lines(model.get("scope", {}).get("in_scope")),
            "",
            copy["sections"]["scope_out"],
            *bullet_lines(model.get("scope", {}).get("out_of_scope")),
            "",
            copy["sections"]["roles"],
            *bullet_lines(model.get("users_and_scenarios", {}).get("target_users")),
            "",
            copy["sections"]["use_cases"],
            *numbered_lines(model.get("users_and_scenarios", {}).get("core_scenarios")),
            "",
            copy["sections"]["functional"],
            "",
            copy["sections"]["feature_overview"],
            "",
            value_or_tbd(model.get("functional_requirements", {}).get("overview")),
            "",
            copy["sections"]["feature_details"],
            *feature_lines(),
            "",
            copy["sections"]["business_rules"],
            *bullet_lines(model.get("business_rules")),
            "",
            copy["sections"]["non_functional"],
            *bullet_lines([]),
            "",
            copy["sections"]["architecture"],
            *bullet_lines([]),
            "",
            copy["sections"]["modules"],
            "",
            copy["sections"]["module_candidates"],
            *bullet_lines(candidate_modules),
            "",
            copy["sections"]["page_touchpoints"],
            *page_lines(),
            "",
            copy["sections"]["api"],
            *bullet_lines([]),
            "",
            copy["sections"]["data_model"],
            "",
            copy["sections"]["dependencies"],
            *bullet_lines(model.get("data_and_dependencies")),
            "",
            copy["sections"]["key_flows"],
            *numbered_lines(model.get("page_and_interaction", {}).get("interaction_flow")),
            "",
            copy["sections"]["security"],
            *bullet_lines([]),
            "",
            copy["sections"]["observability"],
            *bullet_lines([]),
            "",
            copy["sections"]["deployment"],
            *bullet_lines([]),
            "",
            copy["sections"]["testing"],
            *bullet_lines(model.get("acceptance_criteria")),
            "",
            copy["sections"]["risks"],
            *bullet_lines(risk_notes),
            "",
            copy["sections"]["milestones"],
            *bullet_lines([]),
            "",
            copy["sections"]["open_questions"],
            *bullet_lines(open_questions),
        ]
        return "\n".join(lines)

    def _pm_prompt(self, session: Session, language: str) -> str:
        language = self._normalize_language(language)
        normalized = self._normalize_prompt_template(session.prompt_template)
        base_prompt = PM_SYSTEM_PROMPT_ZH if language == "zh" else PM_SYSTEM_PROMPT
        prompt_parts = [base_prompt]
        template_addendum = self._business_template_pm_addendum(session)
        if template_addendum:
            prompt_parts.append(template_addendum)
        elif normalized == PROMPT_TEMPLATE_PERSONAL_PROJECT:
            addendum = PERSONAL_PROJECT_PM_ADDENDUM_ZH_V2 if language == "zh" else PERSONAL_PROJECT_PM_ADDENDUM_V2
            prompt_parts.append(addendum)
        prompt_parts.append(self._language_output_instruction(language))
        return "\n\n".join(part for part in prompt_parts if part)

    def _design_doc_prompt(self, session: Session, language: str) -> str:
        language = self._normalize_language(language)
        normalized = self._normalize_prompt_template(session.prompt_template)
        base_prompt = DESIGN_DOC_SYSTEM_PROMPT_ZH if language == "zh" else DESIGN_DOC_SYSTEM_PROMPT
        prompt_parts = [base_prompt]
        if session.applied_template_id:
            prompt_parts.append(
                "A business requirement template is active for this session.\n"
                "- Respect the template's domain, section priorities, and business framing.\n"
                "- Keep the design document aligned to the collected facts and the template context.\n"
                "- Do not treat this session as a generic personal-project interview."
            )
        elif normalized == PROMPT_TEMPLATE_PERSONAL_PROJECT:
            addendum = (
                PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM_ZH_V2
                if language == "zh"
                else PERSONAL_PROJECT_DESIGN_DOC_ADDENDUM_V2
            )
            prompt_parts.append(addendum)
        prompt_parts.append(
            "Scaffold handling rules:\n"
            "- A design document scaffold will be provided in the user message.\n"
            "- Use that scaffold as the primary structure and preserve its section order.\n"
            "- Expand or rewrite section content only when it is supported by the conversation or the structured requirement model.\n"
            "- Keep unknown items explicitly marked as TBD; do not silently remove placeholders."
        )
        prompt_parts.append(self._language_output_instruction(language))
        return "\n\n".join(part for part in prompt_parts if part)

    def _prd_doc_prompt(self, session: Session, language: str) -> str:
        language = self._normalize_language(language)
        prompt_parts = [PRD_DOC_SYSTEM_PROMPT]
        if session.applied_template_id:
            prompt_parts.append(
                "A business requirement template is active for this session.\n"
                "- Use the applied template as the primary document structure instead of the generic simple PRD template.\n"
                "- Follow the template section order closely.\n"
                "- Keep missing facts marked as assumptions or open questions rather than inventing content."
            )
        prompt_parts.append(self._language_output_instruction(language))
        return "\n\n".join(part for part in prompt_parts if part)

    def _normalize_language(self, language: str | None) -> str:
        normalized = str(language or "").strip().lower()
        if normalized in SUPPORTED_OUTPUT_LANGUAGES:
            return normalized
        return "zh"

    def _language_output_instruction(self, language: str) -> str:
        normalized = self._normalize_language(language)
        return OUTPUT_LANGUAGE_INSTRUCTIONS.get(normalized, OUTPUT_LANGUAGE_INSTRUCTIONS["en"])

    def _normalize_prompt_template(self, prompt_template: str | None) -> str:
        normalized = str(prompt_template or "").strip().lower()
        if normalized == PROMPT_TEMPLATE_STANDARD:
            return PROMPT_TEMPLATE_STANDARD
        return PROMPT_TEMPLATE_PERSONAL_PROJECT

    def _default_prd_doc(self, language: str) -> str:
        language = self._normalize_language(language)
        return PRD_EMPTY_BY_LANGUAGE.get(language, PRD_EMPTY_BY_LANGUAGE["en"])

    def _save_design_document(self, session_id: str, doc_markdown: str) -> str:
        self.design_docs_dir.mkdir(parents=True, exist_ok=True)
        self._design_doc_path(session_id).write_text(doc_markdown, encoding="utf-8")
        return datetime.now(timezone.utc).isoformat()

    def _save_prd_document(self, session_id: str, doc_markdown: str) -> str:
        self.prd_docs_dir.mkdir(parents=True, exist_ok=True)
        self._prd_doc_path(session_id).write_text(doc_markdown, encoding="utf-8")
        return datetime.now(timezone.utc).isoformat()

    def _design_doc_path(self, session_id: str) -> Path:
        return self.design_docs_dir / f"{session_id}.md"

    def _prd_doc_path(self, session_id: str) -> Path:
        return self.prd_docs_dir / f"{session_id}.md"

    def _build_design_doc_filename(self, session: Session) -> str:
        base_name = self._slugify_filename(session.title) or f"system-design-{session.id[:8]}"
        return f"{base_name}.md"

    def _build_prd_doc_filename(self, session: Session) -> str:
        base_name = self._slugify_filename(session.title) or f"prd-{session.id[:8]}"
        return f"{base_name}-prd.md"

    def _slugify_filename(self, text: str) -> str:
        collapsed = " ".join(text.split()).strip().lower()
        if not collapsed:
            return ""

        slug = re.sub(r"[^a-z0-9]+", "-", collapsed).strip("-")
        return slug[:64].strip("-")

    def _safe_parse_structured_requirement_model(self, raw_model: str) -> dict[str, Any]:
        parsed = self._parse_json_from_model_output(raw_model)
        if parsed is None:
            fallback = self._empty_structured_requirement_model()
            fallback["open_questions"] = [f"Structured requirement parse failed. Raw output: {raw_model}"]
            return fallback

        return normalize_structured_requirement_model(parsed)

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

    def _empty_structured_requirement_model(self) -> dict[str, Any]:
        return empty_structured_requirement_model()

    def _build_prd_doc_messages(
        self,
        session: Session,
        messages: list[dict[str, Any]],
        structured_requirement_model: dict[str, Any],
        progress: dict[str, Any],
        language: str,
    ) -> list[dict[str, str]]:
        language = self._normalize_language(language)
        content_label = CONVERSATION_LABELS.get(language, CONVERSATION_LABELS["en"])
        summary_label = SUMMARY_LABELS.get(language, SUMMARY_LABELS["en"])
        template_content = self._load_prd_template(session, language)
        draft_mode = "draft_with_assumptions" if not progress["ready_to_generate"] else "confirmed_prd"
        business_template_context = self._business_template_document_context(session)
        business_template_block = f"\n\n{business_template_context}" if business_template_context else ""
        return [
            {"role": "system", "content": self._prd_doc_prompt(session, language)},
            {
                "role": "user",
                "content": (
                    "PRD template:\n"
                    + template_content
                    + "\n\nCollection progress:\n"
                    + json.dumps(progress, ensure_ascii=False)
                    + f"\n\nGeneration mode:\n{draft_mode}"
                    + f"\n\n{content_label}:\n"
                    + json.dumps(self._conversation_messages(messages), ensure_ascii=False)
                    + f"\n\n{summary_label}:\n"
                    + json.dumps(structured_requirement_model, ensure_ascii=False)
                    + business_template_block
                ),
            },
        ]

    def _load_prd_template(self, session: Session, language: str) -> str:
        if session.applied_template_id:
            template_markdown = self.business_template_library.get_template_markdown(session.applied_template_id)
            if template_markdown:
                return template_markdown

        normalized = self._normalize_language(language)
        filename = PRD_TEMPLATE_FILE_BY_LANGUAGE.get(normalized, PRD_TEMPLATE_FILE_BY_LANGUAGE["en"])
        template_path = self.prd_templates_dir / filename
        if not template_path.exists():
            return ""
        return template_path.read_text(encoding="utf-8")

    def _structured_requirement_progress(self, structured_requirement_model: dict[str, Any]) -> dict[str, Any]:
        collection_status = structured_requirement_model.get("collection_status")
        if not isinstance(collection_status, dict):
            collection_status = {}

        statuses: list[str] = []
        for key in (
            "objective",
            "scope",
            "users",
            "scenarios",
            "features",
            "pages",
            "rules",
            "integrations",
            "acceptance",
        ):
            item = collection_status.get(key)
            if isinstance(item, dict):
                status_value = str(item.get("status", "missing")).strip().lower()
            else:
                status_value = "missing"
            statuses.append(status_value)

        total_count = len(statuses)
        confirmed_count = sum(1 for status in statuses if status == "confirmed")
        collected_count = sum(1 for status in statuses if status != "missing")
        pending_confirmation_count = sum(1 for status in statuses if status == "pending_confirmation")
        conflict_count = sum(1 for status in statuses if status == "conflict")
        collection_coverage_percentage = (
            round((collected_count / total_count) * 100) if total_count else 0
        )
        confirmation_percentage = (
            round((confirmed_count / total_count) * 100) if total_count else 0
        )
        return {
            "total_count": total_count,
            "confirmed_count": confirmed_count,
            "collected_count": collected_count,
            "pending_confirmation_count": pending_confirmation_count,
            "conflict_count": conflict_count,
            "collection_coverage_percentage": collection_coverage_percentage,
            "confirmation_percentage": confirmation_percentage,
            "ready_to_generate": (
                total_count > 0
                and collection_coverage_percentage == 100
                and confirmation_percentage == 100
            ),
        }
