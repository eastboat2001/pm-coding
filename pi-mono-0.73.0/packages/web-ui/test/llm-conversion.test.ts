import { describe, expect, it } from "vitest";
import { convertAttachments, defaultConvertToLlm } from "../src/utils/llm-conversion.js";

describe("web-ui LLM conversion", () => {
	it("omits attachments marked as UI-only from converted LLM content", () => {
		expect(
			convertAttachments([
				{
					id: "doc-1",
					type: "document",
					fileName: "需求.md",
					mimeType: "text/markdown",
					size: 8,
					content: "",
					extractedText: "# PRD",
					llmContext: "none",
				},
			]),
		).toEqual([]);
	});

	it("keeps normal user attachments in converted LLM content", () => {
		const messages = defaultConvertToLlm([
			{
				role: "user-with-attachments",
				content: "请阅读附件",
				timestamp: 123,
				attachments: [
					{
						id: "doc-1",
						type: "document",
						fileName: "需求.md",
						mimeType: "text/markdown",
						size: 8,
						content: "",
						extractedText: "# PRD",
					},
				],
			} as never,
		]);

		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "请阅读附件" },
			{ type: "text", text: "\n\n[Document: 需求.md]\n# PRD" },
		]);
	});
});
