import json
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.services.business_template_library import BusinessTemplateLibrary
from app.services.requirement_collector import RequirementCollectorService
from app.services.session_store import SQLiteSessionStore


class FakeLLMClient:
    def __init__(self) -> None:
        self.calls: list[list[dict[str, str]]] = []
        self.stream_calls: list[list[dict[str, str]]] = []

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.3) -> str:
        self.calls.append(messages)
        return "# Generated PRD\n\nGenerated from seeded example requirements."

    def stream_chat(self, messages: list[dict[str, str]], temperature: float = 0.3):
        self.stream_calls.append(messages)
        yield {"type": "content", "text": "# Generated Streamed Document\n\n"}
        yield {"type": "content", "text": "Generated from seeded example requirements."}


class TemplateExampleStartTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db_path = Path(self.tmpdir.name) / "rqmd.sqlite3"
        self.llm_client = FakeLLMClient()
        self.service = RequirementCollectorService(
            self.llm_client,
            SQLiteSessionStore(str(db_path)),
        )
        self.template_id = "business_process_requirement_template_en"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_template_detail_exposes_example_metadata(self) -> None:
        library = BusinessTemplateLibrary(PROJECT_ROOT / "data" / "PRD_template")
        summary = next(item for item in library.list_templates() if item["template_id"] == self.template_id)
        detail = library.get_template(self.template_id)

        self.assertTrue(summary["has_example_model"])
        self.assertIsNotNone(detail)
        self.assertTrue(detail["template_markdown"].startswith("#"))
        self.assertIsInstance(detail["example_model"], dict)
        self.assertTrue(detail["example_model"]["document_info"]["requirement_name"])

    def test_template_prompt_context_includes_example_model(self) -> None:
        library = BusinessTemplateLibrary(PROJECT_ROOT / "data" / "PRD_template")

        context = library.get_template_prompt_context(self.template_id, "en")

        self.assertIsNotNone(context)
        self.assertIsInstance(context["example_model"], dict)
        self.assertTrue(context["example_model"]["document_info"]["project_name"])

    def test_all_enabled_templates_expose_example_models(self) -> None:
        library = BusinessTemplateLibrary(PROJECT_ROOT / "data" / "PRD_template")

        missing = [item["template_id"] for item in library.list_templates() if not item["has_example_model"]]

        self.assertEqual(missing, [])

    def test_chinese_template_examples_are_complete_text(self) -> None:
        template_dir = PROJECT_ROOT / "data" / "PRD_template"
        failures: list[str] = []

        for path in sorted(template_dir.glob("*.zh-CN.json")):
            model = json.loads(path.read_text(encoding="utf-8")).get("example_model", {})
            serialized = json.dumps(model, ensure_ascii=False)
            if "????" in serialized:
                failures.append(path.name)

        self.assertEqual(failures, [])

    def test_qdm_example_is_based_on_yield_dashboard_requirement(self) -> None:
        library = BusinessTemplateLibrary(PROJECT_ROOT / "data" / "PRD_template")

        detail = library.get_template("qdm_finished_lot_yield_dashboard_template_en")
        model = detail["example_model"]
        serialized = json.dumps(model, ensure_ascii=False)

        self.assertIn("D.CHQ.QDM Finished Lot Yield Dashboard", model["document_info"]["project_name"])
        self.assertIn("Finished Lot Performance Overview Trend", serialized)
        self.assertIn("Loss Ratio By Defect Code", serialized)
        self.assertIn("[QDMProductionDB].[IDA].[Yield_Dashboard_FinishedLotSummaryData_Internal]", serialized)
        self.assertIn("Yield_Dashboard_FinishedLotSummaryDefectData_Internal", serialized)
        self.assertIn("image_descriptions", serialized)
        self.assertIn("Lot Product Yield formula image", serialized)

    def test_all_template_examples_seed_ready_requirement_models(self) -> None:
        templates = self.service.list_business_templates()
        failures: list[str] = []

        for template in templates:
            language = "zh" if str(template["language"]).lower().startswith("zh") else template["language"]
            session = self.service.create_session(
                template_id=template["template_id"],
                language=language,
                template_start_mode="example",
            )
            summary = self.service.build_structured_requirement_model(session.id, language)
            progress = self.service._structured_requirement_progress(summary)
            if progress["collection_coverage_percentage"] != 100:
                failures.append(template["template_id"])

        self.assertEqual(failures, [])

    def test_guided_template_session_stays_empty(self) -> None:
        session = self.service.create_session(
            template_id=self.template_id,
            language="en",
        )

        self.assertEqual(session.applied_template_id, self.template_id)
        self.assertEqual(session.messages, [])

    def test_example_template_session_seeds_message_and_ready_summary(self) -> None:
        session = self.service.create_session(
            template_id=self.template_id,
            language="en",
            template_start_mode="example",
        )

        self.assertEqual(len(session.messages), 1)
        self.assertEqual(session.messages[0]["role"], "assistant")
        self.assertIn("Example Business", session.messages[0]["content"])

        summary = self.service.build_structured_requirement_model(session.id, "en")
        statuses = summary["collection_status"].values()
        self.assertTrue(all(item["status"] == "confirmed" for item in statuses))
        self.assertEqual(self.service._structured_requirement_progress(summary)["collection_coverage_percentage"], 100)
        self.assertEqual(self.llm_client.calls, [])

    def test_chinese_template_example_seed_is_pm_message_and_localized(self) -> None:
        session = self.service.create_session(
            template_id="qdm_finished_lot_yield_dashboard_template_zh_cn",
            language="zh",
            template_start_mode="example",
        )

        content = session.messages[0]["content"]
        self.assertEqual(session.messages[0]["role"], "assistant")
        self.assertNotIn("\u6211\u60f3\u57fa\u4e8e\u6a21\u677f\u793a\u4f8b\u4e1a\u52a1\u5f00\u59cb", content)
        self.assertNotIn("????", content)
        self.assertIn("\u793a\u4f8b\u4e1a\u52a1", content)
        self.assertIn("QDM Finished Lot \u826f\u7387\u770b\u677f", content)
        self.assertIn("Finished Lot Performance Overview Trend", content)
        self.assertIn("\u56fe\u7247\u6587\u5b57\u63cf\u8ff0", content)

    def test_example_template_session_can_generate_prd_without_insufficient_input(self) -> None:
        session = self.service.create_session(
            template_id=self.template_id,
            language="en",
            template_start_mode="example",
        )

        result = self.service.build_prd_document(session.id, "en", save_history=False)

        self.assertEqual(result["status"], "ok")
        self.assertIn("Generated PRD", result["document_markdown"])
        self.assertEqual(len(self.llm_client.calls), 1)

    def test_example_template_session_can_stream_documents_without_insufficient_input(self) -> None:
        session = self.service.create_session(
            template_id=self.template_id,
            language="en",
            template_start_mode="example",
        )

        prd_events = list(self.service.stream_prd_document(session.id, "en", save_history=True))
        design_events = list(self.service.stream_system_design_document(session.id, "en", save_history=True))

        self.assertEqual(prd_events[-1]["event"], "done")
        self.assertEqual(design_events[-1]["event"], "done")
        self.assertEqual(prd_events[-1]["status"], "ok")
        self.assertEqual(design_events[-1]["status"], "ok")
        self.assertIsNotNone(self.service.get_saved_prd_document(session.id))
        self.assertIsNotNone(self.service.get_saved_design_document(session.id))
        self.assertEqual(len(self.llm_client.stream_calls), 2)


if __name__ == "__main__":
    unittest.main()
