import type { Model } from "@mariozechner/pi-ai";
import type { CustomProvider, SessionData, SessionMetadata } from "@mariozechner/pi-web-ui";

export interface ConfiguredStorageStatus {
	configured: boolean;
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
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
		return await this.request<ConfiguredStorageStatus>("/status", { allowMissing: true });
	}

	async writeSession(data: SessionData, metadata: SessionMetadata): Promise<void> {
		await this.request<ConfiguredSessionRecord>(`/sessions/${encodeURIComponent(data.id)}`, {
			method: "PUT",
			body: { data, metadata },
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

	async writeSettings(settingsData: ConfiguredSettingsUpdate): Promise<void> {
		await this.request<ConfiguredSettingsRecord>("/settings", {
			method: "PUT",
			body: settingsData,
			allowMissing: true,
		});
	}

	async readSettings(): Promise<ConfiguredSettingsRecord | null> {
		return await this.request<ConfiguredSettingsRecord>("/settings", { allowMissing: true });
	}

	private async request<T = unknown>(
		path: string,
		options: {
			method?: string;
			body?: unknown;
			allowMissing?: boolean;
		} = {},
	): Promise<T | null> {
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: options.method || "GET",
				headers: options.body ? { "Content-Type": "application/json" } : undefined,
				body: options.body ? JSON.stringify(options.body) : undefined,
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
		}
	}
}
