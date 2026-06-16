import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ProjectFileSeed = {
	filename: string;
	content: string;
	encoding?: "base64";
};

type AttachmentProjectFileSeed = {
	type?: unknown;
	fileName?: unknown;
	mimeType?: unknown;
	content?: unknown;
	extractedText?: unknown;
	projectFilePath?: unknown;
	llmContext?: unknown;
};

export function collectProjectFilesFromMessages(messages: AgentMessage[]): ProjectFileSeed[] {
	const files: ProjectFileSeed[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		const attachments = (message as { attachments?: unknown }).attachments;
		if (!Array.isArray(attachments)) continue;
		for (const attachment of attachments as AttachmentProjectFileSeed[]) {
			if (typeof attachment.projectFilePath !== "string" || !attachment.projectFilePath.trim()) continue;
			const filename = attachment.projectFilePath.trim();
			if (seen.has(filename)) continue;
			seen.add(filename);
			if (typeof attachment.extractedText === "string") {
				files.push({ filename, content: attachment.extractedText });
				continue;
			}
			if (attachment.type === "image" && typeof attachment.content === "string") {
				files.push({ filename, content: attachment.content, encoding: "base64" });
			}
		}
	}
	return files;
}

export function prepareAttachmentProjectFileSeeds<T extends AttachmentProjectFileSeed>(attachments: T[]): T[] {
	const used = new Set<string>();
	return attachments.map((attachment, index) => {
		if (typeof attachment.projectFilePath === "string" && attachment.projectFilePath.trim()) {
			used.add(attachment.projectFilePath.trim().toLowerCase());
			return attachment;
		}
		const fileName = typeof attachment.fileName === "string" ? attachment.fileName : `attachment-${index + 1}`;
		if (attachment.type === "document" && typeof attachment.extractedText === "string") {
			const filename = uniqueProjectPath(
				`attachments/${documentProjectFilename(fileName, attachment.mimeType, index)}`,
				used,
			);
			return { ...attachment, projectFilePath: filename };
		}
		if (attachment.type === "image" && typeof attachment.content === "string") {
			const filename = uniqueProjectPath(`attachments/${safeFilename(fileName, `image-${index + 1}`)}`, used);
			return { ...attachment, projectFilePath: filename };
		}
		return attachment;
	});
}

function documentProjectFilename(fileName: string, mimeType: unknown, index: number): string {
	const fallbackExtension = fallbackTextExtensionForMime(mimeType) || ".md";
	const safe = safeFilename(fileName, `attachment-${index + 1}${fallbackExtension}`);
	const dotIndex = safe.lastIndexOf(".");
	const base = dotIndex > 0 ? safe.slice(0, dotIndex) : safe;
	if (shouldPreserveDocumentFilename(safe, mimeType)) {
		return safe;
	}
	const extension = fallbackTextExtensionForMime(mimeType);
	if (dotIndex <= 0 && extension) {
		return `${base || `attachment-${index + 1}`}${extension}`;
	}
	return `${base || `attachment-${index + 1}`}.md`;
}

function shouldPreserveDocumentFilename(fileName: string, mimeType: unknown): boolean {
	const extension = fileExtension(fileName);
	if (!extension) return false;
	if (TEXT_DOCUMENT_EXTENSIONS.has(extension)) return true;
	const normalizedMimeType = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
	return normalizedMimeType.startsWith("text/");
}

function fallbackTextExtensionForMime(mimeType: unknown): string {
	const normalized = typeof mimeType === "string" ? mimeType.toLowerCase().split(";")[0].trim() : "";
	if (normalized === "text/plain") return ".txt";
	if (normalized === "text/markdown" || normalized === "text/x-markdown") return ".md";
	if (normalized === "text/csv") return ".csv";
	if (normalized === "application/json") return ".json";
	if (normalized === "application/xml" || normalized === "text/xml") return ".xml";
	if (normalized === "application/yaml" || normalized === "application/x-yaml" || normalized === "text/yaml") {
		return ".yaml";
	}
	return "";
}

function fileExtension(fileName: string): string {
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "";
	return fileName.slice(dotIndex + 1).toLowerCase();
}

const TEXT_DOCUMENT_EXTENSIONS = new Set([
	"css",
	"csv",
	"html",
	"js",
	"json",
	"jsx",
	"md",
	"mdx",
	"mjs",
	"ts",
	"tsx",
	"txt",
	"xml",
	"yaml",
	"yml",
]);

function safeFilename(fileName: string, fallback: string): string {
	const normalized = fileName
		.replace(/[\\/]+/g, "/")
		.split("/")
		.filter(Boolean)
		.at(-1);
	const cleaned = (normalized || fallback)
		.replace(/[<>:"|?*\x00-\x1f]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.trim();
	return cleaned || fallback;
}

function uniqueProjectPath(path: string, used: Set<string>): string {
	let candidate = path;
	let suffix = 2;
	while (used.has(candidate.toLowerCase())) {
		const slashIndex = path.lastIndexOf("/");
		const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
		const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
		const dotIndex = filename.lastIndexOf(".");
		const hasExtension = dotIndex > 0;
		const base = hasExtension ? filename.slice(0, dotIndex) : filename;
		const extension = hasExtension ? filename.slice(dotIndex) : "";
		candidate = `${directory}${base}-${suffix}${extension}`;
		suffix += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}
