import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cloneJsonObject, isObject, readJsonFile, writeJsonFile } from "./json.js";
import type { JsonObject, StorageConfig } from "./types.js";
import {
	deleteSessionAndProjects,
	listProjectSourceFiles,
	projectDirectory,
	sanitizePathComponent,
} from "./workspace-paths.js";

export class WorkspaceSessionService {
	constructor(private readonly config: StorageConfig) {}

	listSessions(): JsonObject[] {
		if (!existsSync(this.config.sessionsDir)) return [];
		const sessions: JsonObject[] = [];
		for (const filename of readdirSync(this.config.sessionsDir)) {
			if (!filename.endsWith(".json")) continue;
			try {
				const record = readJsonFile(join(this.config.sessionsDir, filename));
				if (isObject(record.metadata)) sessions.push(record.metadata);
			} catch {
				// Ignore malformed session files so one bad record does not break startup.
			}
		}
		return sessions.sort((a, b) => String(b.lastModified || "").localeCompare(String(a.lastModified || "")));
	}

	readSession(sessionId: string): JsonObject | undefined {
		const sessionPath = this.getSessionPath(sessionId);
		if (!existsSync(sessionPath)) return undefined;
		const record = readJsonFile(sessionPath);
		return { ...record, project: projectSummary(this.config.projectsRootDir, record.data) };
	}

	writeSession(sessionId: string, data: JsonObject, metadata: JsonObject): JsonObject {
		if (String(data.id || "") !== sessionId || String(metadata.id || "") !== sessionId) {
			throw new Error("Session ID mismatch.");
		}
		const record: JsonObject = {
			version: 1,
			savedAt: new Date().toISOString(),
			data,
			metadata,
		};
		writeJsonFile(this.getSessionPath(sessionId), record);
		const project = persistProjectArtifacts(this.config.projectsRootDir, sessionId, data, metadata);
		return { ...record, project };
	}

	deleteSession(sessionId: string): boolean {
		return deleteSessionAndProjects(this.config.projectsRootDir, this.getSessionPath(sessionId), sessionId);
	}

	readSettings(): JsonObject | undefined {
		if (!existsSync(this.config.settingsFile)) return undefined;
		return readJsonFile(this.config.settingsFile);
	}

	writeSettings(body: JsonObject): JsonObject {
		const existing = existsSync(this.config.settingsFile) ? readJsonFile(this.config.settingsFile) : {};
		const record: JsonObject = {
			...(isObject(existing) ? existing : {}),
			version: 1,
			savedAt: new Date().toISOString(),
		};
		if (Object.hasOwn(body, "currentSessionId")) {
			const currentSessionId = body.currentSessionId;
			if (typeof currentSessionId === "string" && currentSessionId.trim()) {
				record.currentSessionId = currentSessionId;
			} else {
				delete record.currentSessionId;
			}
		}
		if (Object.hasOwn(body, "selectedModel")) record.selectedModel = body.selectedModel;
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

	ensureDirs(): void {
		mkdirSync(this.config.sessionsDir, { recursive: true });
		mkdirSync(this.config.projectsRootDir, { recursive: true });
	}

	private getSessionPath(sessionId: string): string {
		const safeSessionId = sanitizePathComponent(sessionId) || sessionId;
		return join(this.config.sessionsDir, `${safeSessionId}.json`);
	}
}

function projectSummary(projectsRootDir: string, sessionData: unknown): JsonObject {
	const data = isObject(sessionData) ? sessionData : {};
	const projectDir = projectDirectory(projectsRootDir, String(data.id || ""), String(data.title || ""));
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
): JsonObject {
	const projectDir = projectDirectory(projectsRootDir, sessionId, String(metadata.title || ""));
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
