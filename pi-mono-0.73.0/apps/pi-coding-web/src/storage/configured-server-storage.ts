import type { Model } from "@mariozechner/pi-ai";
import type { CustomProvider, SessionData, SessionMetadata } from "@mariozechner/pi-web-ui";

const READ_REQUEST_TIMEOUT_MS = 1000;
const WRITE_REQUEST_TIMEOUT_MS = 5000;

export interface ConfiguredStorageStatus {
	configured: boolean;
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
	skillsDir?: string;
	defaultSkillsDir?: string;
	previewBaseUrl?: string;
	serverSessionSyncEnabled?: boolean;
	defaultModelProvider?: string;
	defaultModelId?: string;
	handoffDefaultThinkingLevel?: string;
}

export interface ConfiguredSessionRecord {
	version: 1;
	savedAt: string;
	data: SessionData;
	metadata: SessionMetadata;
	project?: {
		projectRoot: string;
		fileCount: number;
	};
}

export interface ConfiguredSettingsRecord {
	version: 1;
	savedAt: string;
	currentSessionId?: string;
	selectedModel?: Model<any>;
	providerKeys?: Record<string, string>;
	customProviders?: CustomProvider[];
}

type ConfiguredSettingsUpdate = {
	currentSessionId?: string | null;
	selectedModel?: Model<any>;
	providerKeys?: Record<string, string | null>;
	customProviders?: CustomProvider[] | null;
};

export class ConfiguredServerStorage {
	private readonly baseUrl = "/api/pi-storage";

	async getStatus(): Promise<ConfiguredStorageStatus | null> {
		return await this.request<ConfiguredStorageStatus>("/status", {
			allowMissing: true,
			timeoutMs: READ_REQUEST_TIMEOUT_MS,
		});
	}

	async writeSession(data: SessionData, metadata: SessionMetadata): Promise<void> {
		await this.request<ConfiguredSessionRecord>(`/sessions/${encodeURIComponent(data.id)}`, {
			method: "PUT",
			body: { data, metadata },
			timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
			allowMissing: true,
		});
	}

	async readSession(sessionId: string): Promise<{ data: SessionData; metadata: SessionMetadata } | null> {
		const record = await this.request<ConfiguredSessionRecord>(`/sessions/${encodeURIComponent(sessionId)}`, {
			allowMissing: true,
		});
		return record ? { data: record.data, metadata: record.metadata } : null;
	}

	async listSessionMetadata(): Promise<SessionMetadata[]> {
		const result = await this.request<{ sessions: SessionMetadata[] }>("/sessions", { allowMissing: true });
		return result?.sessions ?? [];
	}

	async writeSettings(settingsData: ConfiguredSettingsUpdate): Promise<boolean> {
		return (
			(await this.request<ConfiguredSettingsRecord>("/settings", {
				method: "PUT",
				body: settingsData,
				allowMissing: true,
				timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
			})) !== null
		);
	}

	async readSettings(): Promise<ConfiguredSettingsRecord | null> {
		return await this.request<ConfiguredSettingsRecord>("/settings", {
			allowMissing: true,
			timeoutMs: READ_REQUEST_TIMEOUT_MS,
		});
	}

	private async request<T = unknown>(
		path: string,
		options: {
			method?: string;
			body?: unknown;
			allowMissing?: boolean;
			timeoutMs?: number;
		} = {},
	): Promise<T | null> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? READ_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: options.method || "GET",
				headers: options.body ? { "Content-Type": "application/json" } : undefined,
				body: options.body ? JSON.stringify(options.body) : undefined,
				signal: controller.signal,
			});
			if (options.allowMissing && response.status === 404) return null;
			const data = (await response.json().catch(() => ({}))) as T & { error?: string };
			if (!response.ok) {
				throw new Error(data.error || `Configured storage request failed: ${response.status}`);
			}
			return data;
		} catch (error) {
			if (options.allowMissing) return null;
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
