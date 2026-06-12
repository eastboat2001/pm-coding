import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cloneJsonObject, isObject, readJsonFile, writeJsonFile } from "./json.js";
import type { JsonObject, StorageConfig } from "./types.js";
import {
	assertInside,
	deleteSessionAndProjects,
	listProjectSourceFiles,
	projectDirectory,
	sanitizePathComponent,
} from "./workspace-paths.js";

export class WorkspaceSessionService {
	constructor(private readonly config: StorageConfig) {}

	listSessions(clientId?: string): JsonObject[] {
		const sessionsDir = this.getSessionsDir(clientId);
		if (!existsSync(sessionsDir)) return [];
		const sessions: JsonObject[] = [];
		for (const filename of readdirSync(sessionsDir)) {
			if (!filename.endsWith(".json")) continue;
			try {
				const record = readJsonFile(join(sessionsDir, filename));
				if (isObject(record.metadata)) sessions.push(record.metadata);
			} catch {
				// Ignore malformed session files so one bad record does not break startup.
			}
		}
		return sessions.sort((a, b) => String(b.lastModified || "").localeCompare(String(a.lastModified || "")));
	}

	readSession(sessionId: string, clientId?: string): JsonObject | undefined {
		const sessionPath = this.getSessionPath(sessionId, clientId);
		if (!existsSync(sessionPath)) return undefined;
		const record = readJsonFile(sessionPath);
		return { ...record, project: projectSummary(this.config.projectsRootDir, record.data, clientId) };
	}

	writeSession(sessionId: string, data: JsonObject, metadata: JsonObject, clientId?: string): JsonObject {
		if (String(data.id || "") !== sessionId || String(metadata.id || "") !== sessionId) {
			throw new Error("Session ID mismatch.");
		}
		const record: JsonObject = {
			version: 1,
			savedAt: new Date().toISOString(),
			data,
			metadata,
		};
		writeJsonFile(this.getSessionPath(sessionId, clientId), record);
		const project = persistProjectArtifacts(this.config.projectsRootDir, sessionId, data, metadata, clientId);
		return { ...record, project };
	}

	deleteSession(sessionId: string, clientId?: string): boolean {
		return deleteSessionAndProjects(
			this.config.projectsRootDir,
			this.getSessionPath(sessionId, clientId),
			sessionId,
			clientId,
		);
	}

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
		if (Object.hasOwn(body, "selectedModel")) record.selectedModel = body.selectedModel;
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
		writeJsonFile(this.config.settingsFile, globalRecord);

		const nextClientSettings: JsonObject = {
			...clientSettings,
			version: 1,
			savedAt: new Date().toISOString(),
		};
		delete nextClientSettings.providerKeys;
		delete nextClientSettings.customProviders;
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

	ensureDirs(): void {
		mkdirSync(this.config.sessionsDir, { recursive: true });
		mkdirSync(this.config.projectsRootDir, { recursive: true });
	}

	private getSessionsDir(clientId?: string): string {
		if (!clientId) return this.config.sessionsDir;
		const sessionsDir = join(this.config.sessionsDir, requiredSafePathId(clientId, "client"));
		assertInside(this.config.sessionsDir, sessionsDir);
		return sessionsDir;
	}

	private getSessionPath(sessionId: string, clientId?: string): string {
		const sessionPath = join(this.getSessionsDir(clientId), `${requiredSafePathId(sessionId, "session")}.json`);
		assertInside(this.config.sessionsDir, sessionPath);
		return sessionPath;
	}

	private getSettingsPath(clientId?: string): string {
		if (!clientId) return this.config.settingsFile;
		const settingsRoot = dirname(this.config.settingsFile);
		const settingsPath = join(
			settingsRoot,
			"clients",
			requiredSafePathId(clientId, "client"),
			basename(this.config.settingsFile),
		);
		assertInside(settingsRoot, settingsPath);
		return settingsPath;
	}
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

function projectSummary(projectsRootDir: string, sessionData: unknown, clientId?: string): JsonObject {
	const data = isObject(sessionData) ? sessionData : {};
	const projectDir = projectDirectory(projectsRootDir, String(data.id || ""), String(data.title || ""), clientId);
	return {
		projectRoot: projectDir,
		fileCount: listProjectSourceFiles(projectDir).length,
	};
}

function persistProjectArtifacts(
	projectsRootDir: string,
	sessionId: string,
	sessionData: JsonObject,
	metadata: JsonObject,
	clientId?: string,
): JsonObject {
	const projectDir = projectDirectory(projectsRootDir, sessionId, String(metadata.title || ""), clientId);
	const artifacts = extractArtifactsFromMessages(sessionData.messages);
	if (Object.keys(artifacts).length === 0) {
		return {
			projectRoot: projectDir,
			fileCount: listProjectSourceFiles(projectDir).length,
		};
	}
	return {
		projectRoot: projectDir,
		fileCount: Object.keys(artifacts).length,
	};
}

function extractArtifactsFromMessages(messages: unknown): Record<string, string> {
	const toolCalls = new Map<string, JsonObject>();
	const operations: JsonObject[] = [];
	if (!Array.isArray(messages)) return {};

	for (const message of messages) {
		if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isObject(block) && block.type === "toolCall" && block.name === "artifacts") {
				toolCalls.set(String(block.id || ""), cloneJsonObject(block));
			}
		}
	}

	for (const message of messages) {
		if (!isObject(message)) continue;
		if (message.role === "artifact") {
			const action = String(message.action || "").trim();
			const filename = String(message.filename || "").trim();
			if (!filename) continue;
			if (action === "create") operations.push({ command: "create", filename, content: message.content || "" });
			if (action === "update") operations.push({ command: "rewrite", filename, content: message.content || "" });
			if (action === "delete") operations.push({ command: "delete", filename });
			continue;
		}
		if (message.role === "toolResult" && message.toolName === "artifacts" && message.isError === false) {
			const call = toolCalls.get(String(message.toolCallId || ""));
			if (isObject(call?.arguments)) operations.push(cloneJsonObject(call.arguments));
		}
	}

	const artifacts: Record<string, string> = {};
	for (const operation of operations) {
		const command = String(operation.command || "").trim();
		const filename = String(operation.filename || "").trim();
		if (!filename) continue;
		if ((command === "create" || command === "rewrite") && typeof operation.content === "string") {
			artifacts[filename] = operation.content;
			continue;
		}
		if (command === "update") {
			const existing = artifacts[filename];
			if (
				typeof existing === "string" &&
				typeof operation.old_str === "string" &&
				typeof operation.new_str === "string"
			) {
				artifacts[filename] = existing.replace(operation.old_str, operation.new_str);
			}
			continue;
		}
		if (command === "delete") delete artifacts[filename];
	}
	return artifacts;
}

function requiredSafePathId(value: string, label: "client" | "session"): string {
	const safeValue = sanitizePathComponent(value);
	if (!safeValue) throw new Error(`Invalid ${label} id.`);
	return safeValue;
}
