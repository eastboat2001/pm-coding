import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_ENV_FILE } from "./constants.js";
import type { StorageConfig } from "./types.js";

export function loadStorageConfig(rootDir: string, envFile = CONFIG_ENV_FILE): StorageConfig {
	const configEnv = loadConfigEnvFile(
		rootDir,
		stringValue(process.env.PI_STORAGE_ENV_FILE) || stringValue(envFile) || CONFIG_ENV_FILE,
	);
	const env = (name: string) => envValue(name, configEnv.values);
	const envStorageDir = stringValue(env("PI_STORAGE_DIR"));
	const storageDir = envStorageDir ? resolveConfiguredPath(rootDir, envStorageDir) : undefined;
	return {
		sessionsDir: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_SESSIONS_DIR")) || (storageDir ? join(storageDir, "sessions") : "data/sessions"),
		),
		settingsFile: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_SETTINGS_FILE")) ||
				(storageDir ? join(storageDir, "settings.json") : "data/settings.json"),
		),
		projectsRootDir: resolveConfiguredPath(rootDir, stringValue(env("PI_PROJECTS_ROOT_DIR")) || "data/projects"),
		skillsDir: resolveConfiguredPath(rootDir, stringValue(env("PI_SKILLS_DIR")) || "data/skills"),
		defaultSkillsDir: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_DEFAULT_SKILLS_DIR")) || "data/default-skills",
		),
		runtimeDbFile: resolveConfiguredPath(rootDir, stringValue(env("PI_DB_FILE")) || "data/pi-runtime.sqlite"),
		redisUrl: stringValue(env("PI_REDIS_URL")) || "redis://127.0.0.1:6379",
		runsEnabled: envBooleanValue(env("PI_RUNS_ENABLED")) ?? true,
		workerId: stringValue(env("PI_WORKER_ID")) || "pi-worker",
		workerConcurrency: positiveIntegerValue(env("PI_WORKER_CONCURRENCY"), 2),
		runQueueName: stringValue(env("PI_RUN_QUEUE_NAME")) || "pi:runs",
		runEventRetentionDays: nonNegativeIntegerValue(env("PI_RUN_EVENT_RETENTION_DAYS"), 30),
		clientIdRequired: envBooleanValue(env("PI_CLIENT_ID_REQUIRED")) ?? true,
		previewBaseUrl: normalizedHostValue(stringValue(env("PI_PREVIEW_BASE_URL"))),
		projectInstallCommand: stringValue(env("PI_PROJECT_INSTALL_COMMAND")) || "npm install",
		projectBuildCommand: stringValue(env("PI_PROJECT_BUILD_COMMAND")) || "npm run build",
		projectInstallTimeoutMs: positiveIntegerValue(env("PI_PROJECT_INSTALL_TIMEOUT_MS"), 120000),
		projectBuildTimeoutMs: positiveIntegerValue(env("PI_PROJECT_BUILD_TIMEOUT_MS"), 120000),
		serverSessionSyncEnabled: envBooleanValue(env("PI_SERVER_SESSION_SYNC_ENABLED")) ?? false,
		defaultModelProvider: stringValue(env("PI_DEFAULT_MODEL_PROVIDER")),
		defaultModelId: stringValue(env("PI_DEFAULT_MODEL_ID")),
		handoffDefaultThinkingLevel: thinkingLevelValue(env("PI_HANDOFF_DEFAULT_THINKING_LEVEL")),
		envFile: configEnv.file,
		envFileExists: configEnv.exists,
		logsDbFile: resolveConfiguredPath(rootDir, stringValue(env("PI_LOG_DB")) || "data/logs/pi-diagnostics.sqlite"),
		loggingEnabled: envBooleanValue(env("PI_LOG_ENABLED")) ?? true,
		logStdoutEnabled: envBooleanValue(env("PI_LOG_STDOUT")) ?? true,
		rawProviderLoggingEnabled: envBooleanValue(env("PI_LOG_RAW_PROVIDER_ENABLED")) ?? false,
		rawProviderLogMaxChars: positiveIntegerValue(env("PI_LOG_RAW_PROVIDER_MAX_CHARS"), 12000),
		promptSnapshotLoggingEnabled: envBooleanValue(env("PI_LOG_PROMPT_SNAPSHOT_ENABLED")) ?? false,
		promptSnapshotMaxChars: positiveIntegerValue(env("PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS"), 20000),
		modelOutputSnapshotLoggingEnabled: envBooleanValue(env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED")) ?? false,
		modelOutputSnapshotMaxChars: positiveIntegerValue(env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS"), 20000),
		logRetentionDays: nonNegativeIntegerValue(env("PI_LOG_RETENTION_DAYS"), 30),
		logMaxEvents: nonNegativeIntegerValue(env("PI_LOG_MAX_EVENTS"), 50000),
		logCleanupIntervalMs: nonNegativeIntegerValue(env("PI_LOG_CLEANUP_INTERVAL_MS"), 3600000),
		logVacuumIntervalMs: nonNegativeIntegerValue(env("PI_LOG_VACUUM_INTERVAL_MS"), 86400000),
		langfuseEnabled: envBooleanValue(env("PI_LANGFUSE_ENABLED")) ?? false,
		langfuseHost: normalizedHostValue(
			stringValue(env("PI_LANGFUSE_HOST")) ||
				stringValue(env("LANGFUSE_HOST")) ||
				stringValue(env("LANGFUSE_BASE_URL")),
		),
		langfusePublicKey: stringValue(env("PI_LANGFUSE_PUBLIC_KEY")) || stringValue(env("LANGFUSE_PUBLIC_KEY")),
		langfuseSecretKey: stringValue(env("PI_LANGFUSE_SECRET_KEY")) || stringValue(env("LANGFUSE_SECRET_KEY")),
		langfuseOtelEndpoint: normalizedHostValue(
			stringValue(env("PI_LANGFUSE_OTEL_ENDPOINT")) ||
				stringValue(env("LANGFUSE_OTEL_ENDPOINT")) ||
				stringValue(env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")),
		),
		langfuseFlushIntervalMs: nonNegativeIntegerValue(env("PI_LANGFUSE_FLUSH_INTERVAL_MS"), 5000),
		langfuseBatchSize: positiveIntegerValue(env("PI_LANGFUSE_BATCH_SIZE"), 50),
		langfuseExportPromptSnapshots: envBooleanValue(env("PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS")) ?? false,
		langfuseExportRawChunks: envBooleanValue(env("PI_LANGFUSE_EXPORT_RAW_CHUNKS")) ?? false,
		langfuseExportModelOutputSnapshots: envBooleanValue(env("PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS")) ?? false,
		otelServiceName:
			stringValue(env("PI_OTEL_SERVICE_NAME")) || stringValue(env("OTEL_SERVICE_NAME")) || "pi-coding-web",
		otelDeploymentEnvironment:
			stringValue(env("PI_OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("DEPLOYMENT_ENVIRONMENT")),
	};
}

function loadConfigEnvFile(
	rootDir: string,
	value: unknown,
): { file: string; exists: boolean; values: Record<string, string> } {
	const configured = stringValue(value).trim();
	if (!configured) return { file: "", exists: false, values: {} };
	const file = resolveConfiguredPath(rootDir, configured);
	if (!existsSync(file)) return { file, exists: false, values: {} };
	return { file, exists: true, values: parseEnvFile(readFileSync(file, "utf8")) };
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

function positiveIntegerValue(envValue: string | undefined, defaultValue: number): number {
	const envNumber = integerFromString(envValue);
	if (envNumber !== undefined && envNumber > 0) return envNumber;
	return defaultValue;
}

function nonNegativeIntegerValue(envValue: string | undefined, defaultValue: number): number {
	const envNumber = integerFromString(envValue);
	if (envNumber !== undefined && envNumber >= 0) return envNumber;
	return defaultValue;
}

function integerFromString(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
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
