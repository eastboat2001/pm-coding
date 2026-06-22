import { describe, expect, it } from "vitest";
import { convertAgentMessagesToLlm } from "../src/runtime/agent-message-conversion.js";
import { prepareAttachmentProjectFileSeeds } from "../src/runtime/project-file-seed.js";
import { trimRecoverableProviderStallErrors } from "../src/runtime/runtime-message-conversion.js";

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
			{
				type: "text",
				text: "\n\n[Attached document: 需求.md]\nThis attachment is already provided inline below. Do not call project_file with the original attachment filename.\n\n# PRD",
			},
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

	it("uses model-only llmContent for handoff messages without changing visible content", () => {
		const messages = convertAgentMessagesToLlm([
			{
				role: "user-with-attachments",
				content: "用户可见的中文提示",
				llmContent: "Internal English handoff prompt for the model only.",
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

		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "Internal English handoff prompt for the model only." },
		]);
		expect(JSON.stringify(messages[0]?.content)).not.toContain("用户可见的中文提示");
	});

	it("keeps ordinary archived document attachments readable inline without path instructions", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "doc-1",
				type: "document",
				fileName: "n.txt",
				mimeType: "text/plain",
				size: 8,
				content: "",
				extractedText: "hello from file",
			},
		] as never);

		const messages = convertAgentMessagesToLlm([
			{
				role: "user-with-attachments",
				content: "分别说明文本和图片的内容",
				timestamp: 123,
				attachments,
			} as never,
		]);

		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "分别说明文本和图片的内容" },
			{
				type: "text",
				text: "\n\n[Attached document: n.txt]\nArchived project workspace path: attachments/n.txt\nThis attachment is already provided inline below. Do not call project_file with the original attachment filename.\n\nhello from file",
			},
		]);
		expect(JSON.stringify(messages[0]?.content)).not.toContain("Attachment documents have been saved");
		expect(JSON.stringify(messages[0]?.content)).not.toContain("project_file get");
	});

	it("places inline document text before image data even when images were attached first", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "image-1",
				type: "image",
				fileName: "screen.png",
				mimeType: "image/png",
				size: 7,
				content: "iVBORw0KGgo=",
			},
			{
				id: "doc-1",
				type: "document",
				fileName: "n.txt",
				mimeType: "text/plain",
				size: 11,
				content: "",
				extractedText: "你好 mimo",
			},
		] as never);

		const messages = convertAgentMessagesToLlm([
			{
				role: "user-with-attachments",
				content: "分别说明文本和图片的内容",
				timestamp: 123,
				attachments,
			} as never,
		]);

		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "分别说明文本和图片的内容" },
			{
				type: "text",
				text: "\n\n[Attached document: n.txt]\nArchived project workspace path: attachments/n.txt\nThis attachment is already provided inline below. Do not call project_file with the original attachment filename.\n\n你好 mimo",
			},
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
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

	it("can hide recoverable provider stalled error markers before continuation replay", () => {
		const messages = trimRecoverableProviderStallErrors([
			{
				messageId: 1,
				sessionId: "session-1",
				clientId: "client-1",
				role: "assistant",
				payload: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage: "Model stream stalled for 60000ms without events.",
				},
				createdAt: "2026-06-22T00:00:00.000Z",
			},
			{
				messageId: 2,
				sessionId: "session-1",
				clientId: "client-1",
				role: "assistant",
				payload: { role: "assistant", content: "keep me" },
				createdAt: "2026-06-22T00:00:01.000Z",
			},
		]);

		expect(messages.map((message) => message.messageId)).toEqual([2]);
	});
});
