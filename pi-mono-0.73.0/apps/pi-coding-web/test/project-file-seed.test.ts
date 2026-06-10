import { describe, expect, it } from "vitest";
import { collectProjectFilesFromMessages } from "../src/runtime/project-file-seed.js";

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
});
