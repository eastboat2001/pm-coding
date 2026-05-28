import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE } from "./constants.js";
import { isObject } from "./json.js";
import type { JsonObject, StorageConfig } from "./types.js";

export function loadStorageConfig(rootDir: string, configFile = CONFIG_FILE): StorageConfig {
	const configPath = isAbsolute(configFile) ? configFile : join(rootDir, configFile);
	const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
	const record: JsonObject = isObject(raw) ? raw : {};
	const legacyStorageDir =
		typeof record.storageDir === "string" ? resolveConfiguredPath(rootDir, record.storageDir) : undefined;
	return {
		sessionsDir: resolveConfiguredPath(
			rootDir,
			stringValue(record.sessionsDir) || (legacyStorageDir ? join(legacyStorageDir, "sessions") : "data/sessions"),
		),
		settingsFile: resolveConfiguredPath(
			rootDir,
			stringValue(record.settingsFile) ||
				(legacyStorageDir ? join(legacyStorageDir, "settings.json") : "data/settings.json"),
		),
		projectsRootDir: resolveConfiguredPath(rootDir, stringValue(record.projectsRootDir) || "data/projects"),
		skillsDir: resolveConfiguredPath(rootDir, stringValue(record.skillsDir) || "data/skills"),
		defaultSkillsDir: resolveConfiguredPath(rootDir, stringValue(record.defaultSkillsDir) || "data/default-skills"),
		previewBaseUrl: (stringValue(record.previewBaseUrl) || "").replace(/\/+$/, ""),
		projectInstallCommand: stringValue(record.projectInstallCommand) || "npm install",
		projectBuildCommand: stringValue(record.projectBuildCommand) || "npm run build",
		projectInstallTimeoutMs: numberValue(record.projectInstallTimeoutMs) || 120000,
		projectBuildTimeoutMs: numberValue(record.projectBuildTimeoutMs) || 120000,
		serverSessionSyncEnabled: booleanValue(record.serverSessionSyncEnabled),
		defaultModelProvider: stringValue(record.defaultModelProvider),
		defaultModelId: stringValue(record.defaultModelId),
		handoffDefaultThinkingLevel: thinkingLevelValue(record.handoffDefaultThinkingLevel),
	};
}

function resolveConfiguredPath(rootDir: string, value: string): string {
	const rawPath = value.trim();
	if (!rawPath) return resolve(rootDir, "data");
	return isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function thinkingLevelValue(value: unknown): string {
	const normalized = stringValue(value).trim().toLowerCase();
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "high";
}
