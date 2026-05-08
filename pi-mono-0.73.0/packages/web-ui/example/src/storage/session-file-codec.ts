import type { Model } from "@mariozechner/pi-ai";
import type { SessionData, SessionMetadata } from "@mariozechner/pi-web-ui";

export interface LocalSessionRecord {
	version: 1;
	savedAt: string;
	data: SessionData;
	metadata: SessionMetadata;
}

export interface LocalSettingsRecord {
	version: 1;
	savedAt: string;
	currentSessionId?: string;
	selectedModel?: Model<any>;
}

export function serializeSessionRecord(data: SessionData, metadata: SessionMetadata): string {
	const record: LocalSessionRecord = {
		version: 1,
		savedAt: new Date().toISOString(),
		data,
		metadata,
	};
	return JSON.stringify(record, null, 2);
}

export function parseSessionRecord(json: string): LocalSessionRecord {
	const parsed = JSON.parse(json) as Partial<LocalSessionRecord>;
	if (parsed.version !== 1 || !parsed.data || !parsed.metadata || !parsed.savedAt) {
		throw new Error("Invalid local session record");
	}
	return parsed as LocalSessionRecord;
}

export function serializeLocalSettings(settings: { currentSessionId?: string; selectedModel?: Model<any> }): string {
	const record: LocalSettingsRecord = {
		version: 1,
		savedAt: new Date().toISOString(),
		currentSessionId: settings.currentSessionId,
		selectedModel: settings.selectedModel,
	};
	return JSON.stringify(record, null, 2);
}

export function parseLocalSettings(json: string): LocalSettingsRecord {
	const parsed = JSON.parse(json) as Partial<LocalSettingsRecord>;
	if (parsed.version !== 1 || !parsed.savedAt) {
		throw new Error("Invalid local settings record");
	}
	return parsed as LocalSettingsRecord;
}
