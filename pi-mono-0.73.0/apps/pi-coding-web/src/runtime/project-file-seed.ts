import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ProjectFileSeed = {
	filename: string;
	content: string;
};

type AttachmentProjectFileSeed = {
	extractedText?: unknown;
	projectFilePath?: unknown;
};

export function collectProjectFilesFromMessages(messages: AgentMessage[]): ProjectFileSeed[] {
	const files: ProjectFileSeed[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		const attachments = (message as { attachments?: unknown }).attachments;
		if (!Array.isArray(attachments)) continue;
		for (const attachment of attachments as AttachmentProjectFileSeed[]) {
			if (typeof attachment.projectFilePath !== "string" || !attachment.projectFilePath.trim()) continue;
			if (typeof attachment.extractedText !== "string") continue;
			const filename = attachment.projectFilePath.trim();
			if (seen.has(filename)) continue;
			seen.add(filename);
			files.push({ filename, content: attachment.extractedText });
		}
	}
	return files;
}
