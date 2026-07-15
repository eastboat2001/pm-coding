import { normalizeHandoffLanguage } from "./handoff-language.js";

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

export function prepareHandoffDocumentFiles(
	documents: PmHandoffDocument[] = [],
	attachments: HandoffDocumentAttachment[] = [],
): HandoffDocumentFile[] {
	const used = new Set<string>();
	return documents.map((document, index) => {
		const attachment =
			attachments[index] ?? attachments.find((candidate) => candidate.fileName === document.filename);
		const content = attachment?.extractedText;
		if (!content) {
			throw new Error(
				`PM handoff document has no extracted text: ${document.filename || document.kind || index + 1}`,
			);
		}
		const basename = uniqueFilename(
			sanitizeDocumentFilename(document.filename, `handoff-document-${index + 1}.md`),
			used,
		);
		return {
			kind: document.kind,
			sourceFilename: document.filename,
			filename: `docs/${basename}`,
			content,
		};
	});
}

export function buildVisibleCodingHandoffPrompt(payload: PmHandoffPayload): string {
	const sourcePrompt = (payload.implementation_prompt || "").trim();
	if (sourcePrompt) return sourcePrompt;
	return HANDOFF_VISIBLE_FALLBACK[normalizeHandoffLanguage(payload.language)];
}

const HANDOFF_VISIBLE_FALLBACK = {
	en: "Generate the static project from the PM handoff.",
	zh: "请根据 PM 交接内容生成静态项目。",
	de: "Erstelle das statische Projekt anhand des PM-Handoffs.",
	ms: "Jana projek statik berdasarkan handoff PM.",
} as const;

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
