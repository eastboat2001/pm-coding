import { describe, expect, it } from "vitest";
import { convertAgentMessagesToLlm } from "../src/runtime/agent-message-conversion.js";

describe("worker agent message conversion", () => {
	it("converts user-with-attachments messages to LLM user messages", () => {
		const messages = convertAgentMessagesToLlm([
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

		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "请阅读附件" },
			{ type: "text", text: "\n\n[Document: 需求.md]\n# PRD" },
		]);
	});

	it("keeps UI-only attachments out of the LLM context", () => {
		const messages = convertAgentMessagesToLlm([
			{
				role: "user-with-attachments",
				content: "文档已经落盘，请读 docs/需求.md",
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
						llmContext: "none",
					},
				],
			} as never,
		]);

		expect(messages[0]?.content).toEqual([{ type: "text", text: "文档已经落盘，请读 docs/需求.md" }]);
	});

	it("filters artifact messages because they are UI-only", () => {
		const messages = convertAgentMessagesToLlm([
			{
				role: "artifact",
				action: "create",
				filename: "index.html",
				content: "<h1>UI only</h1>",
				timestamp: "2026-06-10T00:00:00.000Z",
			} as never,
		]);

		expect(messages).toEqual([]);
	});
});
