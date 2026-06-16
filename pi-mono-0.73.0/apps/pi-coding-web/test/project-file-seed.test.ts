import { describe, expect, it } from "vitest";
import { collectProjectFilesFromMessages, prepareAttachmentProjectFileSeeds } from "../src/runtime/project-file-seed.js";

describe("collectProjectFilesFromMessages", () => {
	it("collects project files from handoff attachment metadata", () => {
		const files = collectProjectFilesFromMessages([
			{
				role: "user-with-attachments",
				content: "read docs",
				timestamp: 123,
				attachments: [
					{
						fileName: "需求.md",
						type: "document",
						mimeType: "text/markdown",
						size: 5,
						content: "",
						extractedText: "# PRD",
						projectFilePath: "docs/需求.md",
						llmContext: "none",
					},
				],
			} as never,
		]);

		expect(files).toEqual([{ filename: "docs/需求.md", content: "# PRD" }]);
	});

	it("ignores UI attachments that are not mapped to project files", () => {
		const files = collectProjectFilesFromMessages([
			{
				role: "user-with-attachments",
				content: "read docs",
				timestamp: 123,
				attachments: [
					{
						fileName: "普通附件.md",
						type: "document",
						mimeType: "text/markdown",
						size: 5,
						content: "",
						extractedText: "# Normal",
					},
				],
			} as never,
		]);

		expect(files).toEqual([]);
	});

	it("archives ordinary document attachments as project files while keeping inline model context", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "doc-1",
				fileName: "PRD 文档.pdf",
				type: "document",
				mimeType: "application/pdf",
				size: 1024,
				content: "base64-original",
				extractedText: "# Requirements",
			},
		] as never);

		expect(attachments).toEqual([
			expect.objectContaining({
				fileName: "PRD 文档.pdf",
				type: "document",
				content: "base64-original",
				extractedText: "# Requirements",
				projectFilePath: "attachments/PRD 文档.md",
			}),
		]);
		expect(attachments[0].llmContext).toBeUndefined();
		expect(collectProjectFilesFromMessages([{ role: "user-with-attachments", content: "read", attachments } as never])).toEqual([
			{ filename: "attachments/PRD 文档.md", content: "# Requirements" },
		]);
	});

	it("preserves text document attachment extensions in project file paths", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "doc-1",
				fileName: "n.txt",
				type: "document",
				mimeType: "text/plain",
				size: 8,
				content: "",
				extractedText: "你好 mimo",
			},
		] as never);

		expect(attachments[0].projectFilePath).toBe("attachments/n.txt");
		expect(collectProjectFilesFromMessages([{ role: "user-with-attachments", content: "read", attachments } as never])).toEqual([
			{ filename: "attachments/n.txt", content: "你好 mimo" },
		]);
	});

	it("keeps image attachments visible to the model while assigning original project paths", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "img-1",
				fileName: "screen shot.png",
				type: "image",
				mimeType: "image/png",
				size: 10,
				content: "png-base64",
				preview: "png-base64",
			},
		] as never);

		expect(attachments).toEqual([
			expect.objectContaining({
				fileName: "screen shot.png",
				type: "image",
				content: "png-base64",
				projectFilePath: "attachments/screen shot.png",
			}),
		]);
		expect(attachments[0].llmContext).toBeUndefined();
		expect(collectProjectFilesFromMessages([{ role: "user-with-attachments", content: "look", attachments } as never])).toEqual([
			{ filename: "attachments/screen shot.png", content: "png-base64", encoding: "base64" },
		]);
	});

	it("deduplicates ordinary attachment project filenames", () => {
		const attachments = prepareAttachmentProjectFileSeeds([
			{
				id: "doc-1",
				fileName: "notes.md",
				type: "document",
				mimeType: "text/markdown",
				size: 5,
				content: "",
				extractedText: "first",
			},
			{
				id: "doc-2",
				fileName: "notes.md",
				type: "document",
				mimeType: "text/markdown",
				size: 6,
				content: "",
				extractedText: "second",
			},
		] as never);

		expect(attachments.map((attachment) => attachment.projectFilePath)).toEqual([
			"attachments/notes.md",
			"attachments/notes-2.md",
		]);
	});
});
