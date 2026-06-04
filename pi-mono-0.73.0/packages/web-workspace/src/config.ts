import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE } from "./constants.js";
import { isObject } from "./json.js";
import type { JsonObject, StorageConfig } from "./types.js";

export function loadStorageConfig(rootDir: string, configFile = CONFIG_FILE): StorageConfig {
	const configPath = isAbsolute(configFile) ? configFile : join(rootDir, configFile);
	const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
	const record: JsonObject = isObject(raw) ? raw : {};
	const secrets = loadSecretsEnvFile(
		rootDir,
		stringValue(process.env.PI_STORAGE_SECRETS_ENV_FILE) || record.secretsEnvFile,
	);
	const env = (name: string) => envValue(name, secrets.values);
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
		secretsEnvFile: secrets.file,
		logsDbFile: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_LOG_DB")) || stringValue(record.logsDbFile) || "data/logs/pi-diagnostics.sqlite",
		),
		loggingEnabled: envBooleanValue(env("PI_LOG_ENABLED")) ?? optionalBooleanValue(record.loggingEnabled) ?? true,
		logStdoutEnabled:
			envBooleanValue(env("PI_LOG_STDOUT")) ?? optionalBooleanValue(record.logStdoutEnabled) ?? false,
		rawProviderLoggingEnabled:
			envBooleanValue(env("PI_LOG_RAW_PROVIDER_ENABLED")) ??
			optionalBooleanValue(record.rawProviderLoggingEnabled) ??
			false,
		rawProviderLogMaxChars: positiveIntegerValue(
			env("PI_LOG_RAW_PROVIDER_MAX_CHARS"),
			record.rawProviderLogMaxChars,
			12000,
		),
		promptSnapshotLoggingEnabled:
			envBooleanValue(env("PI_LOG_PROMPT_SNAPSHOT_ENABLED")) ??
			optionalBooleanValue(record.promptSnapshotLoggingEnabled) ??
			false,
		promptSnapshotMaxChars: positiveIntegerValue(
			env("PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS"),
			record.promptSnapshotMaxChars,
			20000,
		),
		modelOutputSnapshotLoggingEnabled:
			envBooleanValue(env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED")) ??
			optionalBooleanValue(record.modelOutputSnapshotLoggingEnabled) ??
			false,
		modelOutputSnapshotMaxChars: positiveIntegerValue(
			env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS"),
			record.modelOutputSnapshotMaxChars,
			20000,
		),
		logRetentionDays: nonNegativeIntegerValue(env("PI_LOG_RETENTION_DAYS"), record.logRetentionDays, 30),
		logMaxEvents: nonNegativeIntegerValue(env("PI_LOG_MAX_EVENTS"), record.logMaxEvents, 50000),
		logCleanupIntervalMs: nonNegativeIntegerValue(
			env("PI_LOG_CLEANUP_INTERVAL_MS"),
			record.logCleanupIntervalMs,
			3600000,
		),
		logVacuumIntervalMs: nonNegativeIntegerValue(
			env("PI_LOG_VACUUM_INTERVAL_MS"),
			record.logVacuumIntervalMs,
			86400000,
		),
		langfuseEnabled: envBooleanValue(env("PI_LANGFUSE_ENABLED")) ?? optionalBooleanValue(record.langfuseEnabled) ?? false,
		langfuseHost: normalizedHostValue(
			stringValue(env("PI_LANGFUSE_HOST")) ||
				stringValue(env("LANGFUSE_HOST")) ||
				stringValue(env("LANGFUSE_BASE_URL")) ||
				stringValue(record.langfuseHost),
		),
		langfusePublicKey:
			stringValue(env("PI_LANGFUSE_PUBLIC_KEY")) ||
			stringValue(env("LANGFUSE_PUBLIC_KEY")) ||
			stringValue(record.langfusePublicKey),
		langfuseSecretKey:
			stringValue(env("PI_LANGFUSE_SECRET_KEY")) ||
			stringValue(env("LANGFUSE_SECRET_KEY")) ||
			stringValue(record.langfuseSecretKey),
		langfuseOtelEndpoint: normalizedHostValue(
			stringValue(env("PI_LANGFUSE_OTEL_ENDPOINT")) ||
				stringValue(env("LANGFUSE_OTEL_ENDPOINT")) ||
				stringValue(env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) ||
				stringValue(record.langfuseOtelEndpoint),
		),
		langfuseFlushIntervalMs: nonNegativeIntegerValue(
			env("PI_LANGFUSE_FLUSH_INTERVAL_MS"),
			record.langfuseFlushIntervalMs,
			5000,
		),
		langfuseBatchSize: positiveIntegerValue(env("PI_LANGFUSE_BATCH_SIZE"), record.langfuseBatchSize, 50),
		langfuseExportPromptSnapshots:
			envBooleanValue(env("PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS")) ??
			optionalBooleanValue(record.langfuseExportPromptSnapshots) ??
			false,
		langfuseExportRawChunks:
			envBooleanValue(env("PI_LANGFUSE_EXPORT_RAW_CHUNKS")) ??
			optionalBooleanValue(record.langfuseExportRawChunks) ??
			false,
		langfuseExportModelOutputSnapshots:
			envBooleanValue(env("PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS")) ??
			optionalBooleanValue(record.langfuseExportModelOutputSnapshots) ??
			false,
		otelServiceName:
			stringValue(env("PI_OTEL_SERVICE_NAME")) ||
			stringValue(env("OTEL_SERVICE_NAME")) ||
			stringValue(record.otelServiceName) ||
			"pi-coding-web",
		otelDeploymentEnvironment:
			stringValue(env("PI_OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(record.otelDeploymentEnvironment),
	};
}

function loadSecretsEnvFile(rootDir: string, value: unknown): { file: string; values: Record<string, string> } {
	const configured = stringValue(value).trim();
	if (!configured) return { file: "", values: {} };
	const file = resolveConfiguredPath(rootDir, configured);
	if (!existsSync(file)) return { file, values: {} };
	return { file, values: parseEnvFile(readFileSync(file, "utf8")) };
}

function parseEnvFile(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice("export ".length).trim();
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		values[key] = parseEnvValue(line.slice(separator + 1).trim());
	}
	return values;
}

function parseEnvValue(value: string): string {
	if (value.length >= 2) {
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
			const inner = value.slice(1, -1);
			return quote === '"' ? unescapeDoubleQuotedEnvValue(inner) : inner;
		}
	}
	return stripInlineComment(value).trim();
}

function stripInlineComment(value: string): string {
	const index = value.search(/\s#/);
	return index === -1 ? value : value.slice(0, index);
}

function unescapeDoubleQuotedEnvValue(value: string): string {
	return value
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function envValue(name: string, fileEnv: Record<string, string>): string | undefined {
	const processValue = process.env[name];
	return processValue !== undefined && processValue !== "" ? processValue : fileEnv[name];
}

function resolveConfiguredPath(rootDir: string, value: string): string {
	const rawPath = value.trim();
	if (!rawPath) return resolve(rootDir, "data");
	return isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function normalizedHostValue(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveIntegerValue(envValue: string | undefined, configValue: unknown, defaultValue: number): number {
	const envNumber = integerFromString(envValue);
	if (envNumber !== undefined && envNumber > 0) return envNumber;
	const configNumber = optionalNumberValue(configValue);
	if (configNumber !== undefined && configNumber > 0) return Math.round(configNumber);
	return defaultValue;
}

function nonNegativeIntegerValue(envValue: string | undefined, configValue: unknown, defaultValue: number): number {
	const envNumber = integerFromString(envValue);
	if (envNumber !== undefined && envNumber >= 0) return envNumber;
	const configNumber = optionalNumberValue(configValue);
	if (configNumber !== undefined && configNumber >= 0) return Math.round(configNumber);
	return defaultValue;
}

function optionalNumberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerFromString(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function optionalBooleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function envBooleanValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function thinkingLevelValue(value: unknown): string {
	const normalized = stringValue(value).trim().toLowerCase();
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "high";
}
