import { describe, expect, it } from "vitest";
import {
	buildCodingHandoffPrompt,
	prepareHandoffDocumentFiles,
	type PmHandoffDocument,
	type PmHandoffPayload,
} from "../src/integrations/pm-handoff.js";

describe("PM handoff document files", () => {
	it("prepares PM documents as docs/ files for the current PI session workspace", () => {
		const documents: PmHandoffDocument[] = [
			createDocument("prd", "需求文档-20260610.md"),
			createDocument("design", "设计文档-20260610.md"),
		];

		const files = prepareHandoffDocumentFiles(documents, [
			{ fileName: "需求文档-20260610.md", extractedText: "# PRD\n需求内容" },
			{ fileName: "设计文档-20260610.md", extractedText: "# Design\n设计内容" },
		]);

		expect(files).toEqual([
			{
				kind: "prd",
				sourceFilename: "需求文档-20260610.md",
				filename: "docs/需求文档-20260610.md",
				content: "# PRD\n需求内容",
			},
			{
				kind: "design",
				sourceFilename: "设计文档-20260610.md",
				filename: "docs/设计文档-20260610.md",
				content: "# Design\n设计内容",
			},
		]);
	});

	it("sanitizes and deduplicates document filenames under docs/", () => {
		const documents: PmHandoffDocument[] = [
			createDocument("prd", "../PRD 文档：需求.md"),
			createDocument("design", "PRD 文档：需求.md"),
		];

		const files = prepareHandoffDocumentFiles(documents, [
			{ fileName: "../PRD 文档：需求.md", extractedText: "first" },
			{ fileName: "PRD 文档：需求.md", extractedText: "second" },
		]);

		expect(files.map((file) => file.filename)).toEqual(["docs/PRD 文档-需求.md", "docs/PRD 文档-需求-2.md"]);
	});

	it("adds exact docs/ paths to the handoff prompt without embedding document contents", () => {
		const payload: PmHandoffPayload = {
			source: "pm",
			transport: "http",
			session_id: "pm-session",
			title: "测试项目",
			language: "zh",
			documents_ready: true,
			implementation_prompt:
				"开始编码前，必须先完整阅读以下文件：\n1. PRD 文档：需求文档-20260610.md\n2. 系统设计文档：设计文档-20260610.md",
		};

		const prompt = buildCodingHandoffPrompt(payload, [
			{
				kind: "prd",
				sourceFilename: "需求文档-20260610.md",
				filename: "docs/需求文档-20260610.md",
				content: "# PRD\n这段正文不应该被塞进 prompt",
			},
			{
				kind: "design",
				sourceFilename: "设计文档-20260610.md",
				filename: "docs/设计文档-20260610.md",
				content: "# Design\n这段正文也不应该被塞进 prompt",
			},
		]);

		expect(prompt).toContain("project_file get");
		expect(prompt).toContain("docs/需求文档-20260610.md");
		expect(prompt).toContain("docs/设计文档-20260610.md");
		expect(prompt).toContain("不要读取原始附件名");
		expect(prompt).not.toContain("这段正文不应该被塞进 prompt");
		expect(prompt).not.toContain("这段正文也不应该被塞进 prompt");
	});
});

function createDocument(kind: string, filename: string): PmHandoffDocument {
	return {
		kind,
		filename,
		mime_type: "text/markdown",
		download_url: `/downloads/${encodeURIComponent(filename)}`,
	};
}
