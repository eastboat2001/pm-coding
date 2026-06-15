import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ProjectFileSeed = {
	filename: string;
	content: string;
	encoding?: "base64";
};

type AttachmentProjectFileSeed = {
	type?: unknown;
	fileName?: unknown;
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
			const filename = uniqueProjectPath(`attachments/${documentProjectFilename(fileName, index)}`, used);
			return { ...attachment, projectFilePath: filename, llmContext: "none" as const };
		}
		if (attachment.type === "image" && typeof attachment.content === "string") {
			const filename = uniqueProjectPath(
				`attachments/original/${safeFilename(fileName, `image-${index + 1}`)}`,
				used,
			);
			return { ...attachment, projectFilePath: filename };
		}
		return attachment;
	});
}

function documentProjectFilename(fileName: string, index: number): string {
	const safe = safeFilename(fileName, `attachment-${index + 1}.md`);
	const dotIndex = safe.lastIndexOf(".");
	const base = dotIndex > 0 ? safe.slice(0, dotIndex) : safe;
	return `${base || `attachment-${index + 1}`}.md`;
}

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
