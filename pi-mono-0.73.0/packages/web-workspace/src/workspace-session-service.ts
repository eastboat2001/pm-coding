import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isObject, readJsonFile, writeJsonFile } from "./json.js";
import type { JsonObject, StorageConfig } from "./types.js";
import { assertInside, sanitizePathComponent } from "./workspace-paths.js";

export class WorkspaceSessionService {
	constructor(private readonly config: StorageConfig) {}

	readSettings(clientId?: string): JsonObject | undefined {
		const clientSettings = clientId ? this.migrateClientGlobalSettings(clientId) : undefined;
		const globalSettings = this.readSettingsFile(this.config.settingsFile);
		if (!clientId) return globalSettings;
		return mergeEffectiveSettings(globalSettings, clientSettings);
	}

	writeSettings(body: JsonObject, clientId?: string): JsonObject {
		if (clientId) this.migrateClientGlobalSettings(clientId);
		if (hasGlobalSettingsUpdate(body)) this.writeGlobalSettings(body);
		if (hasClientSettingsUpdate(body) || !hasGlobalSettingsUpdate(body)) this.writeClientSettings(body, clientId);
		return this.readSettings(clientId) ?? {};
	}

	private writeClientSettings(body: JsonObject, clientId?: string): JsonObject {
		const settingsPath = this.getSettingsPath(clientId);
		const record = this.settingsRecord(settingsPath);
		if (Object.hasOwn(body, "currentSessionId")) {
			const currentSessionId = body.currentSessionId;
			if (typeof currentSessionId === "string" && currentSessionId.trim()) {
				record.currentSessionId = currentSessionId;
			} else {
				delete record.currentSessionId;
			}
		}
		if (Object.hasOwn(body, "selectedModel")) {
			if (body.selectedModel === undefined || body.selectedModel === null) {
				delete record.selectedModel;
				delete record.selectedModelConfigRevision;
			} else {
				record.selectedModel = body.selectedModel;
				record.selectedModelConfigRevision = this.currentModelConfigRevision();
			}
		}
		writeJsonFile(settingsPath, record);
		return record;
	}

	private writeGlobalSettings(body: JsonObject): JsonObject {
		const record = this.settingsRecord(this.config.settingsFile);
		if (Object.hasOwn(body, "providerKeys")) {
			const existingProviderKeys = isObject(record.providerKeys) ? record.providerKeys : {};
			const incomingProviderKeys = isObject(body.providerKeys) ? body.providerKeys : {};
			const providerKeys: JsonObject = { ...existingProviderKeys };
			for (const [provider, value] of Object.entries(incomingProviderKeys)) {
				if (!provider.trim()) continue;
				if (typeof value === "string" && value) {
					providerKeys[provider] = value;
				} else if (value === null) {
					delete providerKeys[provider];
				}
			}
			if (Object.keys(providerKeys).length > 0) {
				record.providerKeys = providerKeys;
			} else {
				delete record.providerKeys;
			}
		}
		if (Object.hasOwn(body, "customProviders")) {
			if (Array.isArray(body.customProviders)) {
				record.customProviders = body.customProviders;
			} else {
				delete record.customProviders;
			}
		}
		record.modelConfigRevision = nextModelConfigRevision(record.modelConfigRevision);
		writeJsonFile(this.config.settingsFile, record);
		return record;
	}

	private migrateClientGlobalSettings(clientId: string): JsonObject | undefined {
		const settingsPath = this.getSettingsPath(clientId);
		const clientSettings = this.readSettingsFile(settingsPath);
		if (!clientSettings) return undefined;

		const hasLegacyProviderKeys =
			isObject(clientSettings.providerKeys) && Object.keys(clientSettings.providerKeys).length > 0;
		const hasLegacyCustomProviders = Array.isArray(clientSettings.customProviders);
		if (!hasLegacyProviderKeys && !hasLegacyCustomProviders) return clientSettings;

		const globalRecord = this.settingsRecord(this.config.settingsFile);
		if (hasLegacyProviderKeys) {
			const globalProviderKeys = isObject(globalRecord.providerKeys) ? globalRecord.providerKeys : {};
			const clientProviderKeys = isObject(clientSettings.providerKeys) ? clientSettings.providerKeys : {};
			globalRecord.providerKeys = {
				...clientProviderKeys,
				...globalProviderKeys,
			};
		}
		if (hasLegacyCustomProviders) {
			globalRecord.customProviders = mergeCustomProviders(
				Array.isArray(clientSettings.customProviders) ? clientSettings.customProviders : [],
				Array.isArray(globalRecord.customProviders) ? globalRecord.customProviders : [],
			);
		}
		globalRecord.modelConfigRevision = nextModelConfigRevision(globalRecord.modelConfigRevision);
		writeJsonFile(this.config.settingsFile, globalRecord);

		const nextClientSettings: JsonObject = {
			...clientSettings,
			version: 1,
			savedAt: new Date().toISOString(),
		};
		delete nextClientSettings.providerKeys;
		delete nextClientSettings.customProviders;
		if (nextClientSettings.selectedModel !== undefined) {
			nextClientSettings.selectedModelConfigRevision = currentModelConfigRevision(globalRecord);
		}
		writeJsonFile(settingsPath, nextClientSettings);
		return nextClientSettings;
	}

	private readSettingsFile(settingsPath: string): JsonObject | undefined {
		if (!existsSync(settingsPath)) return undefined;
		const settings = readJsonFile(settingsPath);
		return isObject(settings) ? settings : undefined;
	}

	private settingsRecord(settingsPath: string): JsonObject {
		const existing = this.readSettingsFile(settingsPath);
		return {
			...(existing ?? {}),
			version: 1,
			savedAt: new Date().toISOString(),
		};
	}

	private currentModelConfigRevision(): number {
		return currentModelConfigRevision(this.readSettingsFile(this.config.settingsFile));
	}

	ensureDirs(): void {
		mkdirSync(this.config.clientsRootDir, { recursive: true });
	}

	private getSettingsPath(clientId?: string): string {
		if (!clientId) return this.config.settingsFile;
		const settingsPath = join(
			this.config.clientsRootDir,
			requiredSafePathId(clientId, "client"),
			basename(this.config.settingsFile),
		);
		assertInside(this.config.clientsRootDir, settingsPath);
		return settingsPath;
	}
}

function currentModelConfigRevision(settings: JsonObject | undefined): number {
	const revision = settings?.modelConfigRevision;
	return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function nextModelConfigRevision(value: unknown): number {
	const current = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
	return current === Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

function hasGlobalSettingsUpdate(body: JsonObject): boolean {
	return Object.hasOwn(body, "providerKeys") || Object.hasOwn(body, "customProviders");
}

function hasClientSettingsUpdate(body: JsonObject): boolean {
	return Object.hasOwn(body, "currentSessionId") || Object.hasOwn(body, "selectedModel");
}

function mergeEffectiveSettings(
	globalSettings: JsonObject | undefined,
	clientSettings: JsonObject | undefined,
): JsonObject | undefined {
	if (!globalSettings && !clientSettings) return undefined;
	const merged: JsonObject = {
		...(globalSettings ?? {}),
		...(clientSettings ?? {}),
	};
	if (isObject(globalSettings?.providerKeys)) {
		merged.providerKeys = globalSettings.providerKeys;
	} else if (isObject(clientSettings?.providerKeys)) {
		merged.providerKeys = clientSettings.providerKeys;
	} else {
		delete merged.providerKeys;
	}
	if (Array.isArray(globalSettings?.customProviders)) {
		merged.customProviders = globalSettings.customProviders;
	} else if (Array.isArray(clientSettings?.customProviders)) {
		merged.customProviders = clientSettings.customProviders;
	} else {
		delete merged.customProviders;
	}
	return merged;
}

function mergeCustomProviders(clientProviders: unknown[], globalProviders: unknown[]): unknown[] {
	const providers = new Map<string, unknown>();
	for (const provider of clientProviders) {
		if (!isObject(provider) || typeof provider.id !== "string") continue;
		providers.set(provider.id, provider);
	}
	for (const provider of globalProviders) {
		if (!isObject(provider) || typeof provider.id !== "string") continue;
		providers.set(provider.id, provider);
	}
	return [...providers.values()];
}

function requiredSafePathId(value: string, label: "client" | "session"): string {
	const safeValue = sanitizePathComponent(value);
	if (!safeValue) throw new Error(`Invalid ${label} id.`);
	return safeValue;
}
