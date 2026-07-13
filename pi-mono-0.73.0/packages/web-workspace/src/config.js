import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_ENV_FILE } from "./constants.js";
import { normalizePreviewOrigin } from "./preview-origin.js";
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
];
export class RetiredApplicationGenerationConfigError extends Error {
    variables;
    constructor(variables) {
        super(`Retired application generation configuration is not supported: ${variables.join(", ")}`);
        this.variables = variables;
        this.name = "RetiredApplicationGenerationConfigError";
    }
}
export function loadStorageConfig(rootDir, envFile = CONFIG_ENV_FILE) {
    const configEnv = loadConfigEnvFile(rootDir, stringValue(process.env.PI_STORAGE_ENV_FILE) || stringValue(envFile) || CONFIG_ENV_FILE);
    const retiredVariables = RETIRED_APPLICATION_GENERATION_ENV.filter((name) => process.env[name] !== undefined || Object.hasOwn(configEnv.values, name));
    if (retiredVariables.length > 0)
        throw new RetiredApplicationGenerationConfigError([...retiredVariables]);
    const env = (name) => envValue(name, configEnv.values);
    const envStorageDir = stringValue(env("PI_STORAGE_DIR"));
    const storageDir = envStorageDir ? resolveConfiguredPath(rootDir, envStorageDir) : undefined;
    const clientsRootDir = resolveConfiguredPath(rootDir, stringValue(env("PI_CLIENTS_ROOT_DIR")) || (storageDir ? join(storageDir, "clients") : "data/clients"));
    return {
        settingsFile: resolveConfiguredPath(rootDir, stringValue(env("PI_SETTINGS_FILE")) ||
            (storageDir ? join(storageDir, "settings.json") : "data/settings.json")),
        clientsRootDir,
        skillsDir: resolveConfiguredPath(rootDir, stringValue(env("PI_SKILLS_DIR")) || "data/skills"),
        defaultSkillsDir: resolveConfiguredPath(rootDir, stringValue(env("PI_DEFAULT_SKILLS_DIR")) || "data/default-skills"),
        runtimeDbFile: resolveConfiguredPath(rootDir, stringValue(env("PI_DB_FILE")) ||
            (storageDir ? join(storageDir, "runtime", "pi-runtime.sqlite") : "data/runtime/pi-runtime.sqlite")),
        redisUrl: stringValue(env("PI_REDIS_URL")) || "redis://127.0.0.1:6379",
        runtimeStore: stringValue(env("PI_RUNTIME_STORE")) === "sqlite" ? "sqlite" : "postgres",
        postgresUrl: stringValue(env("PI_POSTGRES_URL")) || "postgres://pi:pi@postgres:5432/pi_coding",
        agentV2: {
            queueName: stringValue(env("PI_AGENT_V2_RUN_QUEUE_NAME")) || "pi:agent-v2:runs",
            eventStreamMaxLen: positiveIntegerValue(env("PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN"), 5000),
            eventStreamTtlSeconds: positiveIntegerValue(env("PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS"), 3600),
        },
        workerId: stringValue(env("PI_WORKER_ID")) || "pi-worker",
        workerConcurrency: positiveIntegerValue(env("PI_WORKER_CONCURRENCY"), 2),
        clientIdRequired: envBooleanValue(env("PI_CLIENT_ID_REQUIRED")) ?? true,
        previewBaseUrl: optionalPreviewOrigin(stringValue(env("PI_PREVIEW_BASE_URL")), "PI_PREVIEW_BASE_URL"),
        previewInternalOrigin: normalizePreviewOrigin(stringValue(env("PI_PREVIEW_INTERNAL_ORIGIN")) || "http://127.0.0.1:5173", "PI_PREVIEW_INTERNAL_ORIGIN"),
        projectInstallCommand: stringValue(env("PI_PROJECT_INSTALL_COMMAND")) || "npm install",
        projectBuildCommand: stringValue(env("PI_PROJECT_BUILD_COMMAND")) || "npm run build",
        projectInstallTimeoutMs: positiveIntegerValue(env("PI_PROJECT_INSTALL_TIMEOUT_MS"), 120000),
        projectBuildTimeoutMs: positiveIntegerValue(env("PI_PROJECT_BUILD_TIMEOUT_MS"), 120000),
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
        modelStreamIdleTimeoutMs: positiveIntegerValue(env("PI_MODEL_STREAM_IDLE_TIMEOUT_MS"), 60000),
        modelMaxOutputTokens: nonNegativeIntegerValue(env("PI_MODEL_MAX_OUTPUT_TOKENS"), 12000),
        contextProviderPayloadBudgetChars: positiveIntegerValue(env("PI_CONTEXT_PROVIDER_PAYLOAD_BUDGET_CHARS"), 90000),
        logRetentionDays: nonNegativeIntegerValue(env("PI_LOG_RETENTION_DAYS"), 30),
        logMaxEvents: nonNegativeIntegerValue(env("PI_LOG_MAX_EVENTS"), 50000),
        logCleanupIntervalMs: nonNegativeIntegerValue(env("PI_LOG_CLEANUP_INTERVAL_MS"), 3600000),
        logVacuumIntervalMs: nonNegativeIntegerValue(env("PI_LOG_VACUUM_INTERVAL_MS"), 86400000),
        langfuseEnabled: envBooleanValue(env("PI_LANGFUSE_ENABLED")) ?? false,
        langfuseHost: normalizedHostValue(stringValue(env("PI_LANGFUSE_HOST")) ||
            stringValue(env("LANGFUSE_HOST")) ||
            stringValue(env("LANGFUSE_BASE_URL"))),
        langfusePublicKey: stringValue(env("PI_LANGFUSE_PUBLIC_KEY")) || stringValue(env("LANGFUSE_PUBLIC_KEY")),
        langfuseSecretKey: stringValue(env("PI_LANGFUSE_SECRET_KEY")) || stringValue(env("LANGFUSE_SECRET_KEY")),
        langfuseOtelEndpoint: normalizedHostValue(stringValue(env("PI_LANGFUSE_OTEL_ENDPOINT")) ||
            stringValue(env("LANGFUSE_OTEL_ENDPOINT")) ||
            stringValue(env("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))),
        langfuseFlushIntervalMs: nonNegativeIntegerValue(env("PI_LANGFUSE_FLUSH_INTERVAL_MS"), 5000),
        langfuseBatchSize: positiveIntegerValue(env("PI_LANGFUSE_BATCH_SIZE"), 50),
        langfuseExportPromptSnapshots: envBooleanValue(env("PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS")) ?? false,
        langfuseExportRawChunks: envBooleanValue(env("PI_LANGFUSE_EXPORT_RAW_CHUNKS")) ?? false,
        langfuseExportModelOutputSnapshots: envBooleanValue(env("PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS")) ?? false,
        otelServiceName: stringValue(env("PI_OTEL_SERVICE_NAME")) || stringValue(env("OTEL_SERVICE_NAME")) || "pi-coding-web",
        otelDeploymentEnvironment: stringValue(env("PI_OTEL_DEPLOYMENT_ENVIRONMENT")) ||
            stringValue(env("OTEL_DEPLOYMENT_ENVIRONMENT")) ||
            stringValue(env("DEPLOYMENT_ENVIRONMENT")),
    };
}
function loadConfigEnvFile(rootDir, value) {
    const configured = stringValue(value).trim();
    if (!configured)
        return { file: "", exists: false, values: {} };
    const file = resolveConfiguredPath(rootDir, configured);
    if (!existsSync(file))
        return { file, exists: false, values: {} };
    return { file, exists: true, values: parseEnvFile(readFileSync(file, "utf8")) };
}
function parseEnvFile(content) {
    const values = {};
    for (const rawLine of content.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        if (line.startsWith("export "))
            line = line.slice("export ".length).trim();
        const separator = line.indexOf("=");
        if (separator <= 0)
            continue;
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        values[key] = parseEnvValue(line.slice(separator + 1).trim());
    }
    return values;
}
function parseEnvValue(value) {
    if (value.length >= 2) {
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
            const inner = value.slice(1, -1);
            return quote === '"' ? unescapeDoubleQuotedEnvValue(inner) : inner;
        }
    }
    return stripInlineComment(value).trim();
}
function stripInlineComment(value) {
    const index = value.search(/\s#/);
    return index === -1 ? value : value.slice(0, index);
}
function unescapeDoubleQuotedEnvValue(value) {
    return value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}
function envValue(name, fileEnv) {
    const processValue = process.env[name];
    return processValue !== undefined && processValue !== "" ? processValue : fileEnv[name];
}
function resolveConfiguredPath(rootDir, value) {
    const rawPath = value.trim();
    if (!rawPath)
        return resolve(rootDir, "data");
    return isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
function normalizedHostValue(value) {
    return value.trim().replace(/\/+$/, "");
}
function optionalPreviewOrigin(value, variableName) {
    const configured = value.trim();
    return configured ? normalizePreviewOrigin(configured, variableName) : "";
}
function positiveIntegerValue(envValue, defaultValue) {
    const envNumber = integerFromString(envValue);
    if (envNumber !== undefined && envNumber > 0)
        return envNumber;
    return defaultValue;
}
function nonNegativeIntegerValue(envValue, defaultValue) {
    const envNumber = integerFromString(envValue);
    if (envNumber !== undefined && envNumber >= 0)
        return envNumber;
    return defaultValue;
}
function integerFromString(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}
function envBooleanValue(value) {
    if (value === undefined)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
function thinkingLevelValue(value) {
    const normalized = stringValue(value).trim().toLowerCase();
    return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "high";
}
//# sourceMappingURL=config.js.map