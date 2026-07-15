import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_ENV_FILE } from "./constants.js";
import { normalizePreviewOrigin } from "./preview-origin.js";
import { parseExactRegistryOrigin } from "./registry-origin.js";
import type { StorageConfig } from "./types.js";

const RETIRED_APPLICATION_GENERATION_ENV = [
	"PI_APP_AGENT_VERSION",
	"PI_RUNS_ENABLED",
	"PI_RUN_QUEUE_NAME",
	"PI_RUN_EVENT_RETENTION_DAYS",
	"PI_RUN_EVENT_STREAM_MAXLEN",
	"PI_RUN_EVENT_STREAM_TTL_SECONDS",
	"PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS",
	"PI_RUN_EVENT_CHECKPOINT_MIN_CHARS",
	"PI_RUN_RETRY_MAX_ATTEMPTS",
	"PI_RUN_RETRY_BASE_DELAY_MS",
	"PI_RUN_RETRY_MAX_DELAY_MS",
	"PI_RUN_RETRY_JITTER_RATIO",
	"PI_RUN_MAX_AGENT_TURNS",
	"PI_RUN_MAX_AGENT_TOOL_EXECUTIONS",
	"PI_PROJECT_INSTALL_COMMAND",
	"PI_PROJECT_BUILD_COMMAND",
	"PI_PROJECT_INSTALL_TIMEOUT_MS",
	"PI_PROJECT_BUILD_TIMEOUT_MS",
] as const;

const DEFAULT_BUILD_CONTAINER_IMAGE = "node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752";
const DEFAULT_BUILD_PROXY_IMAGE =
	"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export class RetiredApplicationGenerationConfigError extends Error {
	constructor(readonly variables: string[]) {
		super(`Retired application generation configuration is not supported: ${variables.join(", ")}`);
		this.name = "RetiredApplicationGenerationConfigError";
	}
}

export class InvalidRuntimeConfigError extends Error {
	constructor(
		readonly variable: string,
		readonly expectation: string,
	) {
		super(`Invalid runtime configuration: ${variable} must be ${expectation}.`);
		this.name = "InvalidRuntimeConfigError";
	}
}

export function loadStorageConfig(rootDir: string, envFile = CONFIG_ENV_FILE): StorageConfig {
	const configEnv = loadConfigEnvFile(
		rootDir,
		stringValue(process.env.PI_STORAGE_ENV_FILE) || stringValue(envFile) || CONFIG_ENV_FILE,
	);
	const retiredVariables = RETIRED_APPLICATION_GENERATION_ENV.filter(
		(name) => process.env[name] !== undefined || Object.hasOwn(configEnv.values, name),
	);
	if (retiredVariables.length > 0) throw new RetiredApplicationGenerationConfigError([...retiredVariables]);
	const env = (name: string) => envValue(name, configEnv.values);
	const containerBuild = containerBuildConfig(env);
	const envStorageDir = stringValue(env("PI_STORAGE_DIR"));
	const storageDir = envStorageDir ? resolveConfiguredPath(rootDir, envStorageDir) : undefined;
	const clientsRootDir = resolveConfiguredPath(
		rootDir,
		stringValue(env("PI_CLIENTS_ROOT_DIR")) || (storageDir ? join(storageDir, "clients") : "data/clients"),
	);
	return {
		settingsFile: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_SETTINGS_FILE")) ||
				(storageDir ? join(storageDir, "settings.json") : "data/settings.json"),
		),
		clientsRootDir,
		skillsDir: resolveConfiguredPath(rootDir, stringValue(env("PI_SKILLS_DIR")) || "data/skills"),
		defaultSkillsDir: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_DEFAULT_SKILLS_DIR")) || "data/default-skills",
		),
		runtimeDbFile: resolveConfiguredPath(
			rootDir,
			stringValue(env("PI_DB_FILE")) ||
				(storageDir ? join(storageDir, "runtime", "pi-runtime.sqlite") : "data/runtime/pi-runtime.sqlite"),
		),
		redisUrl: connectionUrlValue(env("PI_REDIS_URL"), "redis://127.0.0.1:6379", "PI_REDIS_URL", [
			"redis:",
			"rediss:",
		]),
		runtimeStore: enumValue(env("PI_RUNTIME_STORE"), "postgres", "PI_RUNTIME_STORE", ["postgres", "sqlite"]),
		postgresUrl: connectionUrlValue(
			env("PI_POSTGRES_URL"),
			"postgres://pi:pi@postgres:5432/pi_coding",
			"PI_POSTGRES_URL",
			["postgres:", "postgresql:"],
		),
		agentV2: {
			queueName: nonBlankValue(env("PI_AGENT_V2_RUN_QUEUE_NAME"), "pi:agent-v2:runs", "PI_AGENT_V2_RUN_QUEUE_NAME"),
			eventStreamMaxLen: positiveIntegerValue(
				env("PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN"),
				5000,
				"PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN",
			),
			eventStreamTtlSeconds: positiveIntegerValue(
				env("PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS"),
				3600,
				"PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS",
			),
		},
		workerId: nonBlankValue(env("PI_WORKER_ID"), "pi-worker", "PI_WORKER_ID"),
		workerConcurrency: positiveIntegerValue(env("PI_WORKER_CONCURRENCY"), 2, "PI_WORKER_CONCURRENCY"),
		clientIdRequired: booleanValue(env("PI_CLIENT_ID_REQUIRED"), true, "PI_CLIENT_ID_REQUIRED"),
		previewBaseUrl: optionalPreviewOrigin(env("PI_PREVIEW_BASE_URL"), "PI_PREVIEW_BASE_URL"),
		previewInternalOrigin: previewOriginValue(
			env("PI_PREVIEW_INTERNAL_ORIGIN"),
			"http://127.0.0.1:5173",
			"PI_PREVIEW_INTERNAL_ORIGIN",
		),
		containerBuild,
		defaultModelProvider: stringValue(env("PI_DEFAULT_MODEL_PROVIDER")),
		defaultModelId: stringValue(env("PI_DEFAULT_MODEL_ID")),
		handoffDefaultThinkingLevel: thinkingLevelValue(env("PI_HANDOFF_DEFAULT_THINKING_LEVEL")),
		envFile: configEnv.file,
		envFileExists: configEnv.exists,
		logsDbFile: resolveConfiguredPath(rootDir, stringValue(env("PI_LOG_DB")) || "data/logs/pi-diagnostics.sqlite"),
		loggingEnabled: booleanValue(env("PI_LOG_ENABLED"), true, "PI_LOG_ENABLED"),
		logStdoutEnabled: booleanValue(env("PI_LOG_STDOUT"), true, "PI_LOG_STDOUT"),
		rawProviderLoggingEnabled: booleanValue(env("PI_LOG_RAW_PROVIDER_ENABLED"), false, "PI_LOG_RAW_PROVIDER_ENABLED"),
		rawProviderLogMaxChars: positiveIntegerValue(
			env("PI_LOG_RAW_PROVIDER_MAX_CHARS"),
			12000,
			"PI_LOG_RAW_PROVIDER_MAX_CHARS",
		),
		promptSnapshotLoggingEnabled: booleanValue(
			env("PI_LOG_PROMPT_SNAPSHOT_ENABLED"),
			false,
			"PI_LOG_PROMPT_SNAPSHOT_ENABLED",
		),
		promptSnapshotMaxChars: positiveIntegerValue(
			env("PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS"),
			20000,
			"PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS",
		),
		modelOutputSnapshotLoggingEnabled: booleanValue(
			env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED"),
			false,
			"PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED",
		),
		modelOutputSnapshotMaxChars: positiveIntegerValue(
			env("PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS"),
			20000,
			"PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS",
		),
		modelStreamIdleTimeoutMs: positiveIntegerValue(
			env("PI_MODEL_STREAM_IDLE_TIMEOUT_MS"),
			60000,
			"PI_MODEL_STREAM_IDLE_TIMEOUT_MS",
		),
		modelMaxOutputTokens: nonNegativeIntegerValue(
			env("PI_MODEL_MAX_OUTPUT_TOKENS"),
			12000,
			"PI_MODEL_MAX_OUTPUT_TOKENS",
		),
		contextProviderPayloadBudgetChars: positiveIntegerValue(
			env("PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS"),
			90000,
			"PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS",
		),
		logRetentionDays: nonNegativeIntegerValue(env("PI_LOG_RETENTION_DAYS"), 30, "PI_LOG_RETENTION_DAYS"),
		logMaxEvents: nonNegativeIntegerValue(env("PI_LOG_MAX_EVENTS"), 50000, "PI_LOG_MAX_EVENTS"),
		logCleanupIntervalMs: nonNegativeIntegerValue(
			env("PI_LOG_CLEANUP_INTERVAL_MS"),
			3600000,
			"PI_LOG_CLEANUP_INTERVAL_MS",
		),
		logVacuumIntervalMs: nonNegativeIntegerValue(
			env("PI_LOG_VACUUM_INTERVAL_MS"),
			86400000,
			"PI_LOG_VACUUM_INTERVAL_MS",
		),
		langfuseEnabled: booleanValue(env("PI_LANGFUSE_ENABLED"), false, "PI_LANGFUSE_ENABLED"),
		langfuseHost: optionalHttpEndpointValue(env, ["PI_LANGFUSE_HOST", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"]),
		langfusePublicKey: stringValue(env("PI_LANGFUSE_PUBLIC_KEY")) || stringValue(env("LANGFUSE_PUBLIC_KEY")),
		langfuseSecretKey: stringValue(env("PI_LANGFUSE_SECRET_KEY")) || stringValue(env("LANGFUSE_SECRET_KEY")),
		langfuseOtelEndpoint: optionalHttpEndpointValue(env, [
			"PI_LANGFUSE_OTEL_ENDPOINT",
			"LANGFUSE_OTEL_ENDPOINT",
			"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		]),
		langfuseFlushIntervalMs: nonNegativeIntegerValue(
			env("PI_LANGFUSE_FLUSH_INTERVAL_MS"),
			5000,
			"PI_LANGFUSE_FLUSH_INTERVAL_MS",
		),
		langfuseBatchSize: positiveIntegerValue(env("PI_LANGFUSE_BATCH_SIZE"), 50, "PI_LANGFUSE_BATCH_SIZE"),
		langfuseExportPromptSnapshots: booleanValue(
			env("PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS"),
			false,
			"PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS",
		),
		langfuseExportRawChunks: booleanValue(
			env("PI_LANGFUSE_EXPORT_RAW_CHUNKS"),
			false,
			"PI_LANGFUSE_EXPORT_RAW_CHUNKS",
		),
		langfuseExportModelOutputSnapshots: booleanValue(
			env("PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS"),
			false,
			"PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS",
		),
		otelServiceName:
			stringValue(env("PI_OTEL_SERVICE_NAME")) || stringValue(env("OTEL_SERVICE_NAME")) || "pi-coding-web",
		otelDeploymentEnvironment:
			stringValue(env("PI_OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("OTEL_DEPLOYMENT_ENVIRONMENT")) ||
			stringValue(env("DEPLOYMENT_ENVIRONMENT")),
	};
}

function containerBuildConfig(env: (name: string) => string | undefined): StorageConfig["containerBuild"] {
	const engineValue = enumValue(env("PI_BUILD_CONTAINER_ENGINE"), "docker", "PI_BUILD_CONTAINER_ENGINE", [
		"docker",
		"podman",
	]);
	const image = digestImageValue(
		env("PI_BUILD_CONTAINER_IMAGE") === undefined
			? DEFAULT_BUILD_CONTAINER_IMAGE
			: stringValue(env("PI_BUILD_CONTAINER_IMAGE")).trim(),
		"PI_BUILD_CONTAINER_IMAGE",
	);
	const proxyImage = digestImageValue(
		env("PI_BUILD_PROXY_IMAGE") === undefined
			? DEFAULT_BUILD_PROXY_IMAGE
			: stringValue(env("PI_BUILD_PROXY_IMAGE")).trim(),
		"PI_BUILD_PROXY_IMAGE",
	);
	return {
		engine: engineValue,
		image,
		proxyImage,
		timeoutMs: positiveConfigNumber(env("PI_BUILD_TIMEOUT_MS"), 120000, "PI_BUILD_TIMEOUT_MS", true),
		cpus: positiveConfigNumber(env("PI_BUILD_CPUS"), 1, "PI_BUILD_CPUS", false),
		memoryMb: positiveConfigNumber(env("PI_BUILD_MEMORY_MB"), 512, "PI_BUILD_MEMORY_MB", true),
		pidsLimit: positiveConfigNumber(env("PI_BUILD_PIDS_LIMIT"), 128, "PI_BUILD_PIDS_LIMIT", true),
		maxLogChars: positiveConfigNumber(env("PI_BUILD_MAX_LOG_CHARS"), 12000, "PI_BUILD_MAX_LOG_CHARS", true),
		registryOrigins: registryOriginValues(env("PI_BUILD_REGISTRY_ORIGINS")),
	};
}

function digestImageValue(value: string, variableName: string): string {
	if (!DIGEST_IMAGE.test(value)) throw invalidContainerBuildConfig(variableName);
	return value;
}

function positiveConfigNumber(
	value: string | undefined,
	defaultValue: number,
	variableName: string,
	requireInteger: boolean,
): number {
	if (value === undefined) return defaultValue;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed <= 0 || (requireInteger && !Number.isInteger(parsed))) {
		throw invalidContainerBuildConfig(variableName);
	}
	return parsed;
}

function registryOriginValues(value: string | undefined): string[] {
	const origins = value === undefined ? ["https://registry.npmjs.org"] : value.split(",").map((part) => part.trim());
	if (origins.length === 0 || origins.some((origin) => !isRegistryOrigin(origin))) {
		throw invalidContainerBuildConfig("PI_BUILD_REGISTRY_ORIGINS");
	}
	return origins;
}

function isRegistryOrigin(value: string): boolean {
	return parseExactRegistryOrigin(value) !== undefined;
}

function invalidContainerBuildConfig(variableName: string): Error {
	return new InvalidRuntimeConfigError(variableName, "a valid production container value");
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
	return processValue !== undefined ? processValue : fileEnv[name];
}

function resolveConfiguredPath(rootDir: string, value: string): string {
	const rawPath = value.trim();
	if (!rawPath) return resolve(rootDir, "data");
	return isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalHttpEndpointValue(env: (name: string) => string | undefined, variables: readonly string[]): string {
	for (const variable of variables) {
		const configured = env(variable);
		if (configured === undefined) continue;
		const value = configured.trim();
		if (!isReasonableHttpEndpoint(value)) {
			throw new InvalidRuntimeConfigError(variable, "a valid HTTP(S) endpoint without credentials");
		}
		return value.replace(/\/+$/, "");
	}
	return "";
}

function isReasonableHttpEndpoint(value: string): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			Boolean(url.hostname) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function optionalPreviewOrigin(value: string | undefined, variableName: string): string {
	if (value === undefined) return "";
	return previewOriginValue(value, "", variableName);
}

function positiveIntegerValue(value: string | undefined, defaultValue: number, variableName: string): number {
	if (value === undefined) return defaultValue;
	const parsed = strictInteger(value);
	if (parsed === undefined || parsed <= 0) throw new InvalidRuntimeConfigError(variableName, "a positive integer");
	return parsed;
}

function nonNegativeIntegerValue(value: string | undefined, defaultValue: number, variableName: string): number {
	if (value === undefined) return defaultValue;
	const parsed = strictInteger(value);
	if (parsed === undefined || parsed < 0) throw new InvalidRuntimeConfigError(variableName, "a non-negative integer");
	return parsed;
}

function strictInteger(value: string): number | undefined {
	if (!/^(?:0|[1-9]\d*)$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: string | undefined, defaultValue: boolean, variableName: string): boolean {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new InvalidRuntimeConfigError(variableName, "a boolean");
}

function nonBlankValue(value: string | undefined, defaultValue: string, variableName: string): string {
	if (value === undefined) return defaultValue;
	const normalized = value.trim();
	if (!normalized) throw new InvalidRuntimeConfigError(variableName, "a non-empty value");
	return normalized;
}

function enumValue<T extends string>(
	value: string | undefined,
	defaultValue: T,
	variableName: string,
	allowed: readonly T[],
): T {
	if (value === undefined) return defaultValue;
	const normalized = value.trim();
	if (!allowed.includes(normalized as T)) {
		throw new InvalidRuntimeConfigError(variableName, `one of ${allowed.join(", ")}`);
	}
	return normalized as T;
}

function connectionUrlValue(
	value: string | undefined,
	defaultValue: string,
	variableName: string,
	protocols: readonly string[],
): string {
	const configured = value === undefined ? defaultValue : value.trim();
	try {
		const url = new URL(configured);
		if (!protocols.includes(url.protocol) || !url.hostname) throw new Error("invalid protocol");
		return configured;
	} catch {
		throw new InvalidRuntimeConfigError(variableName, `a ${protocols.join(" or ")} URL`);
	}
}

function previewOriginValue(value: string | undefined, defaultValue: string, variableName: string): string {
	const configured = value === undefined ? defaultValue : value.trim();
	if (!configured) throw new InvalidRuntimeConfigError(variableName, "an HTTP(S) origin");
	try {
		return normalizePreviewOrigin(configured, variableName);
	} catch {
		throw new InvalidRuntimeConfigError(variableName, "an HTTP(S) origin without credentials, path, query, or hash");
	}
}

function thinkingLevelValue(value: string | undefined): string {
	return enumValue(value?.trim().toLowerCase(), "high", "PI_HANDOFF_DEFAULT_THINKING_LEVEL", [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
}
