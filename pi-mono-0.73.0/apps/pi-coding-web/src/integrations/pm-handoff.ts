import { PI_CODING_HANDOFF_INSTRUCTIONS_BY_LANGUAGE } from "../prompts/coding-system-prompt.js";

export type PmHandoffDocument = {
	kind: string;
	filename: string;
	mime_type: string;
	download_url: string;
};

export type PmHandoffPayload = {
	source: string;
	transport: string;
	session_id: string;
	title: string;
	language?: string;
	documents_ready: boolean;
	implementation_prompt?: string;
	documents?: PmHandoffDocument[];
	expires_at?: string;
};

export type HandoffDocumentAttachment = {
	fileName: string;
	extractedText?: string;
};

export type HandoffDocumentFile = {
	kind: string;
	sourceFilename: string;
	filename: string;
	content: string;
};

export function buildPmApiUrl(path: string, currentHref = window.location.href): string {
	const url = new URL(currentHref);
	const baseUrl = url.searchParams.get("pm_api_base_url");
	if (!baseUrl) throw new Error("Missing pm_api_base_url query parameter");
	return new URL(path, baseUrl).toString();
}

export async function fetchPmHandoffPayload(token: string): Promise<PmHandoffPayload> {
	// PM handoff requests intentionally do not include X-PI-Client-ID. The client id scopes only PI-owned session/run/project APIs after the handoff is resolved.
	const response = await fetch(buildPmApiUrl(`/api/coding-handoffs/${encodeURIComponent(token)}`));
	const data = (await response.json().catch(() => ({}))) as PmHandoffPayload & { error?: string };
	if (!response.ok) throw new Error(data.error || `Failed to resolve handoff: ${response.status}`);
	return data;
}

function normalizeHandoffLanguage(language?: string): keyof typeof PI_CODING_HANDOFF_INSTRUCTIONS_BY_LANGUAGE {
	const normalized = String(language || "")
		.trim()
		.toLowerCase()
		.replace("_", "-");
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
	if (normalized === "de" || normalized.startsWith("de-")) return "de";
	if (normalized === "ms" || normalized.startsWith("ms-")) return "ms";
	return "en";
}

export function prepareHandoffDocumentFiles(
	documents: PmHandoffDocument[] = [],
	attachments: HandoffDocumentAttachment[] = [],
): HandoffDocumentFile[] {
	const used = new Set<string>();
	return documents.map((document, index) => {
		const attachment = attachments[index] ?? attachments.find((candidate) => candidate.fileName === document.filename);
		const content = attachment?.extractedText;
		if (!content) {
			throw new Error(`PM handoff document has no extracted text: ${document.filename || document.kind || index + 1}`);
		}
		const basename = uniqueFilename(sanitizeDocumentFilename(document.filename, `handoff-document-${index + 1}.md`), used);
		return {
			kind: document.kind,
			sourceFilename: document.filename,
			filename: `docs/${basename}`,
			content,
		};
	});
}

export function buildCodingHandoffPrompt(
	payload: PmHandoffPayload,
	documentFiles: HandoffDocumentFile[] = [],
): string {
	const sourcePrompt = (payload.implementation_prompt || "").trim();
	const platformInstructions = PI_CODING_HANDOFF_INSTRUCTIONS_BY_LANGUAGE[normalizeHandoffLanguage(payload.language)];
	const handoffDocumentInstructions = buildHandoffDocumentInstructions(payload.language, documentFiles);
	return [sourcePrompt, handoffDocumentInstructions, platformInstructions].filter(Boolean).join("\n\n---\n\n");
}

function buildHandoffDocumentInstructions(language: string | undefined, documentFiles: HandoffDocumentFile[]): string {
	if (documentFiles.length === 0) return "";
	const entries = documentFiles.map((file) => `- ${formatDocumentKind(file.kind)}: ${file.filename}`).join("\n");
	const normalized = normalizeHandoffLanguage(language);
	if (normalized === "zh") {
		return [
			"PI 已将 PM 交接文档保存到当前会话项目目录的 docs/ 子目录。",
			"开始编码前，必须使用 project_file get 逐个读取以下路径；如果 PM 原始提示词中出现原始附件名、\"PRD 文档：\"、\"系统设计文档：\" 等标签，请以这里的 docs/ 路径为准，不要读取原始附件名。",
			entries,
			"UI 中仍保留同名附件仅用于查看；模型上下文以这些 docs/ 文件为准。",
		].join("\n");
	}
	return [
		"PI has saved the PM handoff documents under the docs/ subdirectory of the current session project workspace.",
		"Before coding, use project_file get to read each exact path below. If the original PM prompt mentions attachment filenames or labels such as \"PRD document\" or \"design document\", use these docs/ paths instead and do not read the original attachment names.",
		entries,
		"The UI still shows the same attachments for review only; the model context should rely on these docs/ files.",
	].join("\n");
}

function formatDocumentKind(kind: string): string {
	const normalized = kind.trim().toLowerCase();
	if (normalized === "prd" || normalized === "requirements") return "PRD";
	if (normalized === "design" || normalized === "system-design") return "Design";
	return kind || "Document";
}

function sanitizeDocumentFilename(filename: string, fallback: string): string {
	const normalized = String(filename || "")
		.replace(/[\\/]+/g, "/")
		.split("/")
		.filter(Boolean)
		.at(-1);
	const candidate = (normalized || fallback)
		.replace(/[<>:"|?*：\x00-\x1f]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.trim();
	return candidate || fallback;
}

function uniqueFilename(filename: string, used: Set<string>): string {
	let candidate = filename;
	let suffix = 2;
	while (used.has(candidate.toLowerCase())) {
		const dotIndex = filename.lastIndexOf(".");
		const hasExtension = dotIndex > 0;
		const base = hasExtension ? filename.slice(0, dotIndex) : filename;
		const extension = hasExtension ? filename.slice(dotIndex) : "";
		candidate = `${base}-${suffix}${extension}`;
		suffix += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}
