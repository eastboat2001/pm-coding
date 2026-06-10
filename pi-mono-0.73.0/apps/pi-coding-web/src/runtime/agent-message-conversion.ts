import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";

type RuntimeAttachment = {
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	content: string;
	extractedText?: string;
	llmContext?: "full" | "none";
};

type UserMessageWithAttachmentsLike = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: RuntimeAttachment[];
};

function isArtifactMessage(message: AgentMessage): boolean {
	return (message as { role?: string }).role === "artifact";
}

function convertAttachments(attachments: RuntimeAttachment[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const attachment of attachments) {
		if (attachment.llmContext === "none") continue;
		if (attachment.type === "image") {
			content.push({
				type: "image",
				data: attachment.content,
				mimeType: attachment.mimeType,
			} as ImageContent);
			continue;
		}
		if (attachment.type === "document" && attachment.extractedText) {
			content.push({
				type: "text",
				text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
			} as TextContent);
		}
	}
	return content;
}

export function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.filter((message) => !isArtifactMessage(message))
		.map((message): Message | null => {
			const role = (message as { role?: string }).role;
			if (role === "user-with-attachments") {
				const attachmentMessage = message as unknown as UserMessageWithAttachmentsLike;
				const content: (TextContent | ImageContent)[] =
					typeof attachmentMessage.content === "string"
						? [{ type: "text", text: attachmentMessage.content }]
						: [...attachmentMessage.content];
				if (attachmentMessage.attachments) {
					content.push(...convertAttachments(attachmentMessage.attachments));
				}
				return {
					role: "user",
					content,
					timestamp: attachmentMessage.timestamp,
				} as Message;
			}
			if (role === "user" || role === "assistant" || role === "toolResult") {
				return message as Message;
			}
			return null;
		})
		.filter((message): message is Message => message !== null);
}
