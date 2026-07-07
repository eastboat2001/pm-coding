import type { Model } from "@mariozechner/pi-ai";
import type { CustomProvider } from "@mariozechner/pi-web-ui";
import { piClientHeaders } from "../runtime/client-id.js";

const READ_REQUEST_TIMEOUT_MS = 1000;
const WRITE_REQUEST_TIMEOUT_MS = 5000;

export interface ConfiguredStorageStatus {
	configured: boolean;
	settingsFile: string;
	clientsRootDir: string;
	skillsDir?: string;
	defaultSkillsDir?: string;
	previewBaseUrl?: string;
	defaultModelProvider?: string;
	defaultModelId?: string;
	handoffDefaultThinkingLevel?: string;
	logsDbFile?: string;
	loggingEnabled?: boolean;
	logStdoutEnabled?: boolean;
	rawProviderLoggingEnabled?: boolean;
	rawProviderLogMaxChars?: number;
	promptSnapshotLoggingEnabled?: boolean;
	promptSnapshotMaxChars?: number;
	modelOutputSnapshotLoggingEnabled?: boolean;
	modelOutputSnapshotMaxChars?: number;
	modelStreamIdleTimeoutMs?: number;
	modelMaxOutputTokens?: number;
	contextProviderPayloadBudgetChars?: number;
	logRetentionDays?: number;
	logMaxEvents?: number;
	logCleanupIntervalMs?: number;
	logVacuumIntervalMs?: number;
	langfuseEnabled?: boolean;
	langfuseHost?: string;
	langfuseOtelEndpoint?: string;
	langfuseConfigured?: boolean;
	langfuseFlushIntervalMs?: number;
	langfuseBatchSize?: number;
	langfuseExportPromptSnapshots?: boolean;
	langfuseExportRawChunks?: boolean;
	langfuseExportModelOutputSnapshots?: boolean;
	otelServiceName?: string;
	otelDeploymentEnvironment?: string;
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
				headers: {
					...piClientHeaders(),
					...(options.body ? { "Content-Type": "application/json" } : {}),
				},
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
