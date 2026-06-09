import type { SessionMetadata } from "@mariozechner/pi-web-ui";
import type { RunStatus, RuntimeSessionRecord } from "@mariozechner/pi-web-workspace";

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
	runStatus?: RunStatus;
	activeRunId?: string;
	runUpdatedAt?: string;
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

	return [...merged.values()]
		.filter(isListableMetadataEntry)
		.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

const EMPTY_USAGE: SessionMetadata["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

export function mergeRuntimeSessionMetadata(
	runtimeSessions: RuntimeSessionRecord[],
	browserSessions: SessionMetadata[],
	localSessions: SessionMetadata[],
): MergedSessionEntry[] {
	const metadataEntries = mergeSessionMetadata(browserSessions, localSessions);
	const metadataById = new Map(metadataEntries.map((entry) => [entry.id, entry]));
	const runtimeSessionIds = new Set(runtimeSessions.map((session) => session.sessionId));
	const runtimeEntries = runtimeSessions.map((session) =>
		runtimeSessionToMergedEntry(session, metadataById.get(session.sessionId)),
	);
	const missingMetadataEntries = metadataEntries.filter((entry) => !runtimeSessionIds.has(entry.id));
	return [...runtimeEntries, ...missingMetadataEntries].sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

function runtimeSessionToMergedEntry(session: RuntimeSessionRecord, metadata?: MergedSessionEntry): MergedSessionEntry {
	return {
		id: session.sessionId,
		title: session.title,
		createdAt: session.createdAt,
		lastModified: session.updatedAt,
		messageCount: metadata?.messageCount ?? 0,
		usage: metadata?.usage ?? EMPTY_USAGE,
		thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
		preview: metadata?.preview ?? session.title,
		browser: metadata?.browser,
		local: metadata?.local,
		preferredSource: "configured",
		...(session.lastRunStatus ? { runStatus: session.lastRunStatus } : {}),
		...(session.lastRunId ? { activeRunId: session.lastRunId } : {}),
		runUpdatedAt: session.updatedAt,
	};
}

function normalizeThinkingLevel(value: string): SessionMetadata["thinkingLevel"] {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	return "off";
}

function isListableMetadataEntry(entry: MergedSessionEntry): boolean {
	if (entry.messageCount > 0) return true;
	if (entry.activeRunId) return true;
	return entry.runStatus === "queued" || entry.runStatus === "running" || entry.runStatus === "cancelling";
}
