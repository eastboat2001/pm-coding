import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import type { Attachment } from "./attachment-utils.js";

type AttachmentWithLlmContext = Attachment & {
	llmContext?: "full" | "none";
};

type UserMessageWithAttachmentsLike = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: AttachmentWithLlmContext[];
};

type ArtifactMessageLike = {
	role: "artifact";
};

/**
 * Convert attachments to content blocks for LLM.
 * - Images become ImageContent blocks
 * - Documents with extractedText become TextContent blocks with filename header
 * - Attachments marked with llmContext "none" remain visible in UI but are not sent to the model
 */
export function convertAttachments(attachments: Attachment[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const attachment of attachments as AttachmentWithLlmContext[]) {
		if (attachment.llmContext === "none") continue;
		if (attachment.type === "image") {
			content.push({
				type: "image",
				data: attachment.content,
				mimeType: attachment.mimeType,
			} as ImageContent);
		} else if (attachment.type === "document" && attachment.extractedText) {
			content.push({
				type: "text",
				text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
			} as TextContent);
		}
	}
	return content;
}

/**
 * Check if a message is a UserMessageWithAttachments.
 */
export function isUserMessageWithAttachments(msg: AgentMessage): msg is AgentMessage & UserMessageWithAttachmentsLike {
	return (msg as { role?: string }).role === "user-with-attachments";
}

/**
 * Check if a message is an ArtifactMessage.
 */
export function isArtifactMessage(msg: AgentMessage): msg is AgentMessage & ArtifactMessageLike {
	return (msg as { role?: string }).role === "artifact";
}

/**
 * Default convertToLlm for web-ui apps.
 *
 * Handles:
 * - UserMessageWithAttachments: converts to user message with content blocks
 * - ArtifactMessage: filtered out (UI-only, for session reconstruction)
 * - Standard LLM messages (user, assistant, toolResult): passed through
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.filter((m) => {
			if (isArtifactMessage(m)) {
				return false;
			}
			return true;
		})
		.map((m): Message | null => {
			if (isUserMessageWithAttachments(m)) {
				const textContent: (TextContent | ImageContent)[] =
					typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];

				if (m.attachments) {
					textContent.push(...convertAttachments(m.attachments));
				}

				return {
					role: "user",
					content: textContent,
					timestamp: m.timestamp,
				} as Message;
			}

			if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
				return m as Message;
			}

			return null;
		})
		.filter((m): m is Message => m !== null);
}
