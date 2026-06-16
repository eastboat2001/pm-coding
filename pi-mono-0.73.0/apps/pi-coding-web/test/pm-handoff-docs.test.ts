import { describe, expect, it } from "vitest";
import {
	buildCodingHandoffPrompt,
	buildVisibleCodingHandoffPrompt,
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
		expect(prompt).toContain("do not read the original attachment names");
		expect(prompt).not.toContain("这段正文不应该被塞进 prompt");
		expect(prompt).not.toContain("这段正文也不应该被塞进 prompt");
	});

	it.each(["en-US", "zh-CN", "de-DE", "ms-MY"])(
		"keeps appended AI handoff instructions in English for PM language %s",
		(language) => {
			const prompt = buildCodingHandoffPrompt(
				{
					source: "pm",
					transport: "http",
					session_id: "pm-session",
					title: "Localized project",
					language,
					documents_ready: true,
					implementation_prompt: "Build the app.",
				},
				[
					{
						kind: "prd",
						sourceFilename: "requirements.md",
						filename: "docs/requirements.md",
						content: "# Requirements",
					},
				],
			);

			expect(prompt).toContain("Build the app.");
			expect(prompt).toContain("PI has saved the PM handoff documents");
			expect(prompt).toContain("Platform execution requirements:");
			expect(prompt).toContain("docs/requirements.md");
			expect(prompt).not.toContain("PI 已将 PM 交接文档保存到当前会话项目目录");
			expect(prompt).not.toContain("PI hat die PM-Handoff-Dokumente");
			expect(prompt).not.toContain("PI telah menyimpan dokumen handoff PM");
			expect(prompt).not.toContain("平台执行要求：");
			expect(prompt).not.toContain("Ausfuehrungsanforderungen der Plattform:");
			expect(prompt).not.toContain("Keperluan pelaksanaan platform:");
		},
	);

	it("keeps internal AI handoff instructions out of the visible PM prompt", () => {
		const visiblePrompt = buildVisibleCodingHandoffPrompt({
			source: "pm",
			transport: "http",
			session_id: "pm-session",
			title: "测试项目",
			language: "zh-CN",
			documents_ready: true,
			implementation_prompt: "输出要求：\n- 先给出实现计划摘要，再开始编码。",
		});

		expect(visiblePrompt).toBe("输出要求：\n- 先给出实现计划摘要，再开始编码。");
		expect(visiblePrompt).not.toContain("PI has saved the PM handoff documents");
		expect(visiblePrompt).not.toContain("Platform execution requirements:");
		expect(visiblePrompt).not.toContain("project_file get");
	});

	it.each([
		["en", "Generate the static project from the PM handoff."],
		["zh", "请根据 PM 交接内容生成静态项目。"],
		["de", "Erstelle das statische Projekt anhand des PM-Handoffs."],
		["ms", "Jana projek statik berdasarkan handoff PM."],
	])("uses localized visible fallback text for PM language %s", (language, expected) => {
		expect(
			buildVisibleCodingHandoffPrompt({
				source: "pm",
				transport: "http",
				session_id: "pm-session",
				title: "Fallback",
				language,
				documents_ready: true,
			}),
		).toBe(expected);
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
