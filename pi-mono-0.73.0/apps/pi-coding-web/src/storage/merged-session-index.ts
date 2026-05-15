import type { SessionMetadata } from "@mariozechner/pi-web-ui";

export type SessionSource = "browser" | "configured";

export interface MergedSessionEntry {
	id: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messageCount: number;
	usage: SessionMetadata["usage"];
	thinkingLevel: SessionMetadata["thinkingLevel"];
	preview: string;
	browser?: SessionMetadata;
	local?: SessionMetadata;
	preferredSource: SessionSource;
}

function pickPreferredSource(browser?: SessionMetadata, local?: SessionMetadata): SessionSource {
	if (!browser) return "configured";
	if (!local) return "browser";
	if (local.lastModified > browser.lastModified) return "configured";
	return "browser";
}

export function mergeSessionMetadata(
	browserSessions: SessionMetadata[],
	localSessions: SessionMetadata[],
): MergedSessionEntry[] {
	const merged = new Map<string, MergedSessionEntry>();

	for (const session of browserSessions) {
		merged.set(session.id, {
			...session,
			browser: session,
			preferredSource: "browser",
		});
	}

	for (const session of localSessions) {
		const existing = merged.get(session.id);
		if (!existing) {
			merged.set(session.id, {
				...session,
				local: session,
				preferredSource: "configured",
			});
			continue;
		}

		existing.local = session;
		existing.preferredSource = pickPreferredSource(existing.browser, session);
		const preferred = existing.preferredSource === "configured" ? session : existing.browser!;
		existing.title = preferred.title;
		existing.createdAt = preferred.createdAt;
		existing.lastModified = preferred.lastModified;
		existing.messageCount = preferred.messageCount;
		existing.usage = preferred.usage;
		existing.thinkingLevel = preferred.thinkingLevel;
		existing.preview = preferred.preview;
	}

	return [...merged.values()].sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}
