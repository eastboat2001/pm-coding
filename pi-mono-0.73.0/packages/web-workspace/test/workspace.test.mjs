import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	configuredStoragePlugin,
	isUnsafeProjectCommand,
	loadStorageConfig,
	WorkspaceCommandService,
	WorkspaceDiagnosticLogService,
	WorkspaceFileService,
	WorkspacePreviewService,
	WorkspaceSessionService,
	WorkspaceSkillService,
	WorkspaceTaskService,
} from "../dist/index.js";

function tempRoot() {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-"));
}

function testConfig(root, overrides = {}) {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		clientIdRequired: true,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "data", "logs", "pi-diagnostics.sqlite"),
		loggingEnabled: true,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 12000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 20000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 20000,
		modelStreamIdleTimeoutMs: 60000,
		logRetentionDays: 30,
		logMaxEvents: 50000,
		logCleanupIntervalMs: 3600000,
		logVacuumIntervalMs: 86400000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 5000,
		langfuseBatchSize: 50,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
		...overrides,
	};
}

async function test(name, fn) {
	await fn();
	console.log(`ok - ${name}`);
}

await test("loadStorageConfig reads .env from the app root and strips preview trailing slash", () => {
	const root = tempRoot();
	writeFileSync(
		join(root, ".env"),
		[
			"PI_SETTINGS_FILE=runtime/settings.json",
			"PI_CLIENTS_ROOT_DIR=runtime/clients",
			"PI_SKILLS_DIR=runtime/skills",
			"PI_PREVIEW_BASE_URL=http://localhost:5173/",
			"PI_DEFAULT_MODEL_PROVIDER=openai",
			"PI_DEFAULT_MODEL_ID=gpt-5.1",
			"PI_HANDOFF_DEFAULT_THINKING_LEVEL=medium",
		].join("\n"),
		"utf8",
	);

	const config = loadStorageConfig(root);

	assert.equal(config.envFile, resolve(root, ".env"));
	assert.equal(config.envFileExists, true);
	assert.equal(config.settingsFile, resolve(root, "runtime/settings.json"));
	assert.equal(config.clientsRootDir, resolve(root, "runtime/clients"));
	assert.equal(config.skillsDir, resolve(root, "runtime/skills"));
	assert.equal(config.previewBaseUrl, "http://localhost:5173");
	assert.equal(config.defaultModelProvider, "openai");
	assert.equal(config.defaultModelId, "gpt-5.1");
	assert.equal(config.handoffDefaultThinkingLevel, "medium");
	assert.equal(config.logsDbFile, resolve(root, "data/logs/pi-diagnostics.sqlite"));
	assert.equal(config.loggingEnabled, true);
	assert.equal(config.logStdoutEnabled, true);
	assert.equal(config.rawProviderLoggingEnabled, false);
	assert.equal(config.rawProviderLogMaxChars, 12000);
	assert.equal(config.promptSnapshotLoggingEnabled, false);
	assert.equal(config.promptSnapshotMaxChars, 20000);
	assert.equal(config.modelOutputSnapshotLoggingEnabled, false);
	assert.equal(config.modelOutputSnapshotMaxChars, 20000);
	assert.equal(config.modelStreamIdleTimeoutMs, 60000);
	assert.equal(config.logRetentionDays, 30);
	assert.equal(config.logMaxEvents, 50000);
	assert.equal(config.logCleanupIntervalMs, 3600000);
	assert.equal(config.logVacuumIntervalMs, 86400000);
	assert.equal(config.langfuseEnabled, false);
	assert.equal(config.langfuseHost, "");
	assert.equal(config.langfusePublicKey, "");
	assert.equal(config.langfuseSecretKey, "");
	assert.equal(config.langfuseOtelEndpoint, "");
	assert.equal(config.langfuseFlushIntervalMs, 5000);
	assert.equal(config.langfuseBatchSize, 50);
	assert.equal(config.langfuseExportPromptSnapshots, false);
	assert.equal(config.langfuseExportRawChunks, false);
	assert.equal(config.langfuseExportModelOutputSnapshots, false);
	assert.equal(config.otelServiceName, "pi-coding-web");
	assert.equal(config.otelDeploymentEnvironment, "");
});

await test("loadStorageConfig supports an explicit env file path", () => {
	const root = tempRoot();
	writeFileSync(
		join(root, "pi.runtime.env"),
		[
			"PI_SETTINGS_FILE=env/settings.json",
			"PI_CLIENTS_ROOT_DIR=env/clients",
			"PI_SKILLS_DIR=env/skills",
			"PI_DEFAULT_SKILLS_DIR=env/default-skills",
			"PI_PREVIEW_BASE_URL=http://env.local/",
			"PI_PROJECT_INSTALL_COMMAND=pnpm install",
			"PI_PROJECT_BUILD_COMMAND=pnpm build",
			"PI_PROJECT_INSTALL_TIMEOUT_MS=300000",
			"PI_PROJECT_BUILD_TIMEOUT_MS=310000",
			"PI_DEFAULT_MODEL_PROVIDER=env-provider",
			"PI_DEFAULT_MODEL_ID=env-model",
			"PI_HANDOFF_DEFAULT_THINKING_LEVEL=low",
			"PI_LOG_DB=env/logs.sqlite",
			"PI_LANGFUSE_ENABLED=true",
			"LANGFUSE_PUBLIC_KEY=pk-from-env-file",
			"LANGFUSE_SECRET_KEY=sk-from-env-file",
		].join("\n"),
		"utf8",
	);

	const envNames = [
		"PI_STORAGE_ENV_FILE",
		"PI_SETTINGS_FILE",
		"PI_CLIENTS_ROOT_DIR",
		"PI_SKILLS_DIR",
		"PI_DEFAULT_SKILLS_DIR",
		"PI_PREVIEW_BASE_URL",
		"PI_PROJECT_INSTALL_COMMAND",
		"PI_PROJECT_BUILD_COMMAND",
		"PI_PROJECT_INSTALL_TIMEOUT_MS",
		"PI_PROJECT_BUILD_TIMEOUT_MS",
		"PI_DEFAULT_MODEL_PROVIDER",
		"PI_DEFAULT_MODEL_ID",
		"PI_HANDOFF_DEFAULT_THINKING_LEVEL",
		"PI_LOG_DB",
		"PI_LANGFUSE_ENABLED",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	];
	const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
	try {
		for (const name of envNames) delete process.env[name];
		const config = loadStorageConfig(root, "pi.runtime.env");

		assert.equal(config.envFile, resolve(root, "pi.runtime.env"));
		assert.equal(config.envFileExists, true);
		assert.equal(config.settingsFile, resolve(root, "env/settings.json"));
		assert.equal(config.clientsRootDir, resolve(root, "env/clients"));
		assert.equal(config.skillsDir, resolve(root, "env/skills"));
		assert.equal(config.defaultSkillsDir, resolve(root, "env/default-skills"));
		assert.equal(config.previewBaseUrl, "http://env.local");
		assert.equal(config.projectInstallCommand, "pnpm install");
		assert.equal(config.projectBuildCommand, "pnpm build");
		assert.equal(config.projectInstallTimeoutMs, 300000);
		assert.equal(config.projectBuildTimeoutMs, 310000);
		assert.equal(config.defaultModelProvider, "env-provider");
		assert.equal(config.defaultModelId, "env-model");
		assert.equal(config.handoffDefaultThinkingLevel, "low");
		assert.equal(config.logsDbFile, resolve(root, "env/logs.sqlite"));
		assert.equal(config.langfuseEnabled, true);
		assert.equal(config.langfusePublicKey, "pk-from-env-file");
		assert.equal(config.langfuseSecretKey, "sk-from-env-file");
	} finally {
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

await test("loadStorageConfig supports PI_STORAGE_DIR defaults", () => {
	const root = tempRoot();
	writeFileSync(join(root, ".env"), "PI_STORAGE_DIR=runtime\n", "utf8");

	const config = loadStorageConfig(root);

	assert.equal(config.envFile, resolve(root, ".env"));
	assert.equal(config.envFileExists, true);
	assert.equal(config.settingsFile, resolve(root, "runtime/settings.json"));
	assert.equal(config.clientsRootDir, resolve(root, "runtime/clients"));
	assert.equal(config.runtimeDbFile, resolve(root, "runtime/runtime/pi-runtime.sqlite"));
	assert.equal(config.skillsDir, resolve(root, "data/skills"));
	assert.equal(config.defaultModelProvider, "");
	assert.equal(config.defaultModelId, "");
	assert.equal(config.handoffDefaultThinkingLevel, "high");
	assert.equal(config.logsDbFile, resolve(root, "data/logs/pi-diagnostics.sqlite"));
	assert.equal(config.loggingEnabled, true);
	assert.equal(config.logStdoutEnabled, true);
	assert.equal(config.rawProviderLoggingEnabled, false);
	assert.equal(config.promptSnapshotLoggingEnabled, false);
	assert.equal(config.modelOutputSnapshotLoggingEnabled, false);
	assert.equal(config.logRetentionDays, 30);
	assert.equal(config.logMaxEvents, 50000);
	assert.equal(config.langfuseEnabled, false);
	assert.equal(config.langfuseHost, "");
	assert.equal(config.langfuseOtelEndpoint, "");
	assert.equal(config.otelServiceName, "pi-coding-web");
});

await test("loadStorageConfig lets process env override .env values", () => {
	const root = tempRoot();
	writeFileSync(
		join(root, ".env"),
		[
			"# local config file",
			"LANGFUSE_PUBLIC_KEY=pk-from-file",
			"LANGFUSE_SECRET_KEY=\"sk from file\"",
			"PI_LANGFUSE_HOST=https://cloud.langfuse.com/",
		].join("\n"),
		"utf8",
	);

	const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
	const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;
	const previousHost = process.env.PI_LANGFUSE_HOST;
	try {
		delete process.env.LANGFUSE_PUBLIC_KEY;
		process.env.LANGFUSE_SECRET_KEY = "sk-from-env";
		delete process.env.PI_LANGFUSE_HOST;

		const config = loadStorageConfig(root);

		assert.equal(config.envFile, resolve(root, ".env"));
		assert.equal(config.envFileExists, true);
		assert.equal(config.langfusePublicKey, "pk-from-file");
		assert.equal(config.langfuseSecretKey, "sk-from-env");
		assert.equal(config.langfuseHost, "https://cloud.langfuse.com");
	} finally {
		if (previousPublicKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
		else process.env.LANGFUSE_PUBLIC_KEY = previousPublicKey;
		if (previousSecretKey === undefined) delete process.env.LANGFUSE_SECRET_KEY;
		else process.env.LANGFUSE_SECRET_KEY = previousSecretKey;
		if (previousHost === undefined) delete process.env.PI_LANGFUSE_HOST;
		else process.env.PI_LANGFUSE_HOST = previousHost;
	}
});

await test("loadStorageConfig supports diagnostic log and Langfuse env settings", () => {
	const root = tempRoot();
	writeFileSync(
		join(root, ".env"),
		[
			"PI_LOG_DB=runtime/logs/diagnostics.sqlite",
			"PI_LOG_ENABLED=false",
			"PI_LOG_STDOUT=true",
			"PI_LOG_RAW_PROVIDER_ENABLED=true",
			"PI_LOG_RAW_PROVIDER_MAX_CHARS=1234",
			"PI_LOG_PROMPT_SNAPSHOT_ENABLED=true",
			"PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS=5678",
			"PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true",
			"PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS=8765",
			"PI_MODEL_STREAM_IDLE_TIMEOUT_MS=2345",
			"PI_LOG_RETENTION_DAYS=7",
			"PI_LOG_MAX_EVENTS=4321",
			"PI_LOG_CLEANUP_INTERVAL_MS=111",
			"PI_LOG_VACUUM_INTERVAL_MS=222",
			"PI_LANGFUSE_ENABLED=true",
			"PI_LANGFUSE_HOST=http://langfuse.local/",
			"LANGFUSE_PUBLIC_KEY=pk-test",
			"LANGFUSE_SECRET_KEY=sk-test",
			"PI_LANGFUSE_OTEL_ENDPOINT=http://otel-collector.local/v1/traces/",
			"PI_LANGFUSE_FLUSH_INTERVAL_MS=333",
			"PI_LANGFUSE_BATCH_SIZE=9",
			"PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=true",
			"PI_LANGFUSE_EXPORT_RAW_CHUNKS=true",
			"PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=true",
			"PI_OTEL_SERVICE_NAME=pi-worker",
			"PI_OTEL_DEPLOYMENT_ENVIRONMENT=staging",
		].join("\n"),
		"utf8",
	);

	const config = loadStorageConfig(root);

	assert.equal(config.envFile, resolve(root, ".env"));
	assert.equal(config.envFileExists, true);
	assert.equal(config.logsDbFile, resolve(root, "runtime/logs/diagnostics.sqlite"));
	assert.equal(config.loggingEnabled, false);
	assert.equal(config.logStdoutEnabled, true);
	assert.equal(config.rawProviderLoggingEnabled, true);
	assert.equal(config.rawProviderLogMaxChars, 1234);
	assert.equal(config.promptSnapshotLoggingEnabled, true);
	assert.equal(config.promptSnapshotMaxChars, 5678);
	assert.equal(config.modelOutputSnapshotLoggingEnabled, true);
	assert.equal(config.modelOutputSnapshotMaxChars, 8765);
	assert.equal(config.modelStreamIdleTimeoutMs, 2345);
	assert.equal(config.logRetentionDays, 7);
	assert.equal(config.logMaxEvents, 4321);
	assert.equal(config.logCleanupIntervalMs, 111);
	assert.equal(config.logVacuumIntervalMs, 222);
	assert.equal(config.langfuseEnabled, true);
	assert.equal(config.langfuseHost, "http://langfuse.local");
	assert.equal(config.langfusePublicKey, "pk-test");
	assert.equal(config.langfuseSecretKey, "sk-test");
	assert.equal(config.langfuseOtelEndpoint, "http://otel-collector.local/v1/traces");
	assert.equal(config.langfuseFlushIntervalMs, 333);
	assert.equal(config.langfuseBatchSize, 9);
	assert.equal(config.langfuseExportPromptSnapshots, true);
	assert.equal(config.langfuseExportRawChunks, true);
	assert.equal(config.langfuseExportModelOutputSnapshots, true);
	assert.equal(config.otelServiceName, "pi-worker");
	assert.equal(config.otelDeploymentEnvironment, "staging");
});

await test("WorkspaceDiagnosticLogService stores sanitized events and filters by session", () => {
	const root = tempRoot();
	const service = new WorkspaceDiagnosticLogService(testConfig(root));
	service.ensureDirs();

	const written = service.writeEvents({
		events: [
			{
				timestamp: "2026-06-04T00:00:00.000Z",
				level: "info",
				category: "provider",
				eventType: "provider.payload",
				sessionId: "session-a",
				traceId: "trace-a",
				spanId: "span-a",
				data: {
					Authorization: "Bearer secret",
					apiKey: "secret-key",
					nested: { cookie: "abc", ok: "kept" },
				},
			},
			{
				timestamp: "2026-06-04T00:01:00.000Z",
				level: "error",
				category: "model",
				eventType: "stream.error",
				sessionId: "session-b",
				traceId: "trace-b",
				spanId: "span-b",
				data: { message: "failed" },
			},
		],
	});

	assert.equal(written.accepted, 2);
	const result = service.queryEvents({ sessionId: "session-a", limit: 10 });
	assert.equal(result.events.length, 1);
	assert.equal(result.events[0].data.Authorization, "[redacted]");
	assert.equal(result.events[0].data.apiKey, "[redacted]");
	assert.equal(result.events[0].data.nested.cookie, "[redacted]");
	assert.equal(result.events[0].data.nested.ok, "kept");
	assert.equal(result.events[0].eventType, "provider.payload");
});

await test("WorkspaceDiagnosticLogService reports disabled status without writing events", () => {
	const root = tempRoot();
	const service = new WorkspaceDiagnosticLogService(testConfig(root, { loggingEnabled: false }));
	service.ensureDirs();

	const written = service.writeEvents({
		events: [
			{
				level: "warn",
				category: "system",
				eventType: "system.warning",
				data: { message: "ignored" },
			},
		],
	});

	assert.equal(written.accepted, 0);
	const status = service.status();
	assert.equal(status.enabled, false);
	assert.equal(status.eventCount, 0);
});

await test("WorkspaceDiagnosticLogService reports configured model stream idle timeout", () => {
	const root = tempRoot();
	const service = new WorkspaceDiagnosticLogService(testConfig(root, { modelStreamIdleTimeoutMs: 2345 }));
	service.ensureDirs();

	const status = service.status();

	assert.equal(status.modelStreamIdleTimeoutMs, 2345);
});

await test("WorkspaceDiagnosticLogService prunes old events and caps retained rows", () => {
	const root = tempRoot();
	const service = new WorkspaceDiagnosticLogService(
		testConfig(root, {
			logRetentionDays: 1,
			logMaxEvents: 3,
			logCleanupIntervalMs: 0,
			logVacuumIntervalMs: 0,
		}),
	);
	const oldTimestamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
	const freshTimestamp = new Date().toISOString();

	service.writeEvents({
		events: [
			{
				timestamp: oldTimestamp,
				level: "info",
				category: "system",
				eventType: "old.event",
			},
			...Array.from({ length: 5 }, (_, index) => ({
				timestamp: freshTimestamp,
				level: "info",
				category: "system",
				eventType: `fresh.event.${index}`,
			})),
		],
	});

	const status = service.status();
	const result = service.queryEvents({ category: "system", limit: 10 });
	assert.equal(status.eventCount, 3);
	assert.equal(result.events.length, 3);
	assert.deepEqual(
		result.events.map((event) => event.eventType),
		["fresh.event.4", "fresh.event.3", "fresh.event.2"],
	);
	assert.equal(result.events.some((event) => event.eventType === "old.event"), false);
});

await test("WorkspaceDiagnosticLogService exports sanitized Langfuse OTLP trace batches", async () => {
	const root = tempRoot();
	const requests = [];
	const service = new WorkspaceDiagnosticLogService(
		testConfig(root, {
			langfuseEnabled: true,
			langfuseHost: "http://langfuse.local",
			langfusePublicKey: "pk-test",
			langfuseSecretKey: "sk-test",
			langfuseBatchSize: 20,
			langfuseFlushIntervalMs: 0,
			langfuseExportPromptSnapshots: false,
			langfuseExportRawChunks: false,
		}),
		{
			fetch: async (url, init) => {
				requests.push({
					url,
					authorization: init?.headers?.Authorization,
					ingestionVersion: init?.headers?.["x-langfuse-ingestion-version"],
					contentType: init?.headers?.["Content-Type"],
					body: JSON.parse(String(init?.body || "{}")),
				});
				return new Response(JSON.stringify({}), { status: 200 });
			},
		},
	);

	service.writeEvents({
		events: [
			{
				timestamp: "2026-06-04T00:00:00.000Z",
				level: "info",
				category: "provider",
				eventType: "provider.request.start",
				sessionId: "session-a",
				traceId: "trace-a",
				requestId: "request-a",
				provider: "Local vLLM",
				model: "qwen",
				data: { messageCount: 2, apiKey: "secret" },
			},
			{
				timestamp: "2026-06-04T00:00:01.000Z",
				level: "debug",
				category: "provider",
				eventType: "provider.payload.snapshot",
				sessionId: "session-a",
				traceId: "trace-a",
				requestId: "request-a",
				data: { payloadChunks: ["prompt text"] },
			},
			{
				timestamp: "2026-06-04T00:00:02.000Z",
				level: "debug",
				category: "provider",
				eventType: "provider.raw_chunk",
				sessionId: "session-a",
				traceId: "trace-a",
				requestId: "request-a",
				data: { chunkChunks: ["raw chunk"] },
			},
			{
				timestamp: "2026-06-04T00:00:03.000Z",
				level: "info",
				category: "model",
				eventType: "model.stream.summary",
				sessionId: "session-a",
				traceId: "trace-a",
				requestId: "request-a",
				provider: "Local vLLM",
				model: "qwen",
				durationMs: 3000,
				data: { textChars: 10, thinkingChars: 20, stopReason: "stop" },
			},
		],
	});

	await service.flushLangfuse();

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "http://langfuse.local/api/public/otel/v1/traces");
	assert.equal(requests[0].authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
	assert.equal(requests[0].ingestionVersion, "4");
	assert.equal(requests[0].contentType, "application/json");
	const resourceSpan = requests[0].body.resourceSpans[0];
	assert.equal(attributeValue(resourceSpan.resource.attributes, "service.name"), "pi-coding-web");
	assert.equal(attributeValue(resourceSpan.resource.attributes, "telemetry.sdk.name"), "pi-diagnostic-logger");
	const spans = resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans);
	assert.ok(spans.every((span) => /^[a-f0-9]{32}$/.test(span.traceId)));
	assert.ok(spans.every((span) => /^[a-f0-9]{16}$/.test(span.spanId)));
	assert.ok(spans.some((span) => span.name === "PI model request: Local vLLM / qwen"));
	assert.ok(
		spans.some(
			(span) =>
				attributeValue(span.attributes, "langfuse.observation.type") === "generation" &&
				attributeValue(span.attributes, "gen_ai.request.model") === "qwen",
		),
	);
	assert.ok(spans.some((span) => attributeValue(span.attributes, "pi.event_type") === "model.stream.summary"));
	const serialized = JSON.stringify(spans);
	assert.match(serialized, /Local vLLM/);
	assert.doesNotMatch(serialized, /prompt text/);
	assert.doesNotMatch(serialized, /raw chunk/);
	assert.doesNotMatch(serialized, /secret/);
});

await test("WorkspaceDiagnosticLogService exports readable generation input and output when snapshots are allowed", async () => {
	const root = tempRoot();
	const requests = [];
	const service = new WorkspaceDiagnosticLogService(
		testConfig(root, {
			langfuseEnabled: true,
			langfuseHost: "http://langfuse.local",
			langfusePublicKey: "pk-test",
			langfuseSecretKey: "sk-test",
			langfuseBatchSize: 20,
			langfuseFlushIntervalMs: 0,
			langfuseExportPromptSnapshots: true,
			langfuseExportModelOutputSnapshots: true,
		}),
		{
			fetch: async (url, init) => {
				requests.push({
					url,
					body: JSON.parse(String(init?.body || "{}")),
				});
				return new Response(JSON.stringify({}), { status: 200 });
			},
		},
	);

	service.writeEvents({
		events: [
			{
				timestamp: "2026-06-04T00:00:03.000Z",
				level: "info",
				category: "model",
				eventType: "model.stream.summary",
				sessionId: "session-readable",
				traceId: "trace-readable",
				requestId: "request-readable",
				provider: "Local vLLM",
				model: "qwen",
				durationMs: 3000,
				data: {
					textChars: 17,
					thinkingChars: 14,
					stopReason: "stop",
					inputSnapshot: {
						payloadChunks: ['{"messages":[{"role":"user","content":"build a dashboard"}]}'],
						truncated: false,
					},
					outputSnapshot: {
						textChunks: ["Here is the app."],
						thinkingChunks: ["I will build it"],
						toolCalls: [{ name: "project_file", arguments: '{"filename":"index.html"}' }],
						truncated: false,
					},
				},
			},
		],
	});

	await service.flushLangfuse();

	const spans = requests[0].body.resourceSpans[0].scopeSpans.flatMap((scopeSpan) => scopeSpan.spans);
	const generation = spans.find((span) => attributeValue(span.attributes, "langfuse.observation.type") === "generation");
	const input = JSON.parse(attributeValue(generation.attributes, "langfuse.observation.input"));
	const output = JSON.parse(attributeValue(generation.attributes, "langfuse.observation.output"));
	assert.match(JSON.stringify(input), /build a dashboard/);
	assert.match(JSON.stringify(output), /Here is the app/);
	assert.match(JSON.stringify(output), /I will build it/);
	assert.match(JSON.stringify(output), /project_file/);
});

await test("WorkspaceSkillService loads global skills and hides disabled skills from prompt metadata", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const skillDir = join(config.skillsDir, "ui-polish");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ui-polish
description: Use this skill when improving generated UI spacing, visual hierarchy, and responsive polish. Do not use for backend-only, data-only, or pure documentation tasks.
---

# UI Polish

Use stronger layout hierarchy.
`,
		"utf8",
	);
	mkdirSync(join(config.skillsDir, "private-skill"), { recursive: true });
	writeFileSync(
		join(config.skillsDir, "private-skill", "SKILL.md"),
		`---
name: private-skill
description: Use this skill when testing hidden skills. Do not use for visible model invocation.
disable-model-invocation: true
---

# Private
`,
		"utf8",
	);

	const service = new WorkspaceSkillService(config);
	const list = service.list();

	assert.deepEqual(
		list.skills.map((skill) => skill.name),
		["private-skill", "ui-polish"],
	);
	assert.deepEqual(
		list.promptSkills.map((skill) => skill.name),
		["ui-polish"],
	);
	assert.equal(list.diagnostics.length, 0);

	const loaded = service.load({ name: "ui-polish" });
	assert.equal(loaded.name, "ui-polish");
	assert.match(loaded.content, /Use stronger layout hierarchy/);
	assert.equal(loaded.location, "skill://ui-polish/SKILL.md");
});

await test("WorkspaceSkillService reads only text resources inside a skill directory", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const skillDir = join(config.skillsDir, "ui-polish");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ui-polish
description: Improve generated UI spacing.
---

# UI Polish
`,
		"utf8",
	);
	writeFileSync(join(skillDir, "references", "rules.md"), "# Rules\n\nUse clear spacing.", "utf8");
	writeFileSync(join(skillDir, "image.png"), "not really an image", "utf8");

	const service = new WorkspaceSkillService(config);
	const resource = service.readResource({ name: "ui-polish", path: "references/rules.md" });

	assert.equal(resource.name, "ui-polish");
	assert.equal(resource.path, "references/rules.md");
	assert.match(resource.content, /Use clear spacing/);
	assert.throws(() => service.readResource({ name: "ui-polish", path: "../outside.md" }), /escapes skill root/);
	assert.throws(() => service.readResource({ name: "ui-polish", path: "image.png" }), /not an allowed text resource/);
});

await test("WorkspaceSessionService merges and deletes server-backed provider keys in settings", () => {
	const root = tempRoot();
	const service = new WorkspaceSessionService(testConfig(root));

	service.writeSettings({ providerKeys: { anthropic: "sk-ant-test" } });
	service.writeSettings({ providerKeys: { openai: "sk-openai-test" } });
	service.writeSettings({ providerKeys: { anthropic: null } });

	const settings = service.readSettings();
	assert.deepEqual(settings.providerKeys, { openai: "sk-openai-test" });
});

await test("WorkspaceSessionService stores server-backed custom providers in settings", () => {
	const root = tempRoot();
	const service = new WorkspaceSessionService(testConfig(root));
	const providers = [
		{
			id: "provider-1",
			name: "Local Anthropic",
			type: "anthropic-messages",
			baseUrl: "http://localhost:3000",
			apiKey: "test-key",
			models: [{ id: "model-1", name: "Model 1", provider: "Local Anthropic" }],
		},
	];

	service.writeSettings({ customProviders: providers });

	const settings = service.readSettings();
	assert.deepEqual(settings.customProviders, providers);
});

await test("WorkspaceSessionService splits global provider settings from client state", () => {
	const root = tempRoot();
	const service = new WorkspaceSessionService(testConfig(root));
	const providers = [
		{
			id: "provider-1",
			name: "Shared Provider",
			type: "openai-completions",
			baseUrl: "https://example.test/v1",
			apiKey: "shared-key",
			models: [{ id: "model-1", name: "Model 1", provider: "custom-provider:provider-1" }],
		},
	];
	const selectedModel = { provider: "custom-provider:provider-1", id: "model-1" };

	service.writeSettings(
		{
			currentSessionId: "client-a-session",
			selectedModel,
			providerKeys: { "custom-provider:provider-1": "shared-key" },
			customProviders: providers,
		},
		"client-a",
	);

	const globalSettings = service.readSettings();
	assert.deepEqual(globalSettings.providerKeys, { "custom-provider:provider-1": "shared-key" });
	assert.deepEqual(globalSettings.customProviders, providers);
	assert.equal(globalSettings.currentSessionId, undefined);
	assert.equal(globalSettings.selectedModel, undefined);

	const clientSettings = service.readSettings("client-a");
	assert.equal(clientSettings.currentSessionId, "client-a-session");
	assert.deepEqual(clientSettings.selectedModel, selectedModel);
	assert.deepEqual(clientSettings.providerKeys, { "custom-provider:provider-1": "shared-key" });
	assert.deepEqual(clientSettings.customProviders, providers);
});

await test("WorkspaceFileService creates, rewrites, updates, lists, reads, and deletes files inside a session project", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));
	const context = { clientId: "client-a", sessionId: "session-123456789", title: "Demo App" };

	const created = service.handle({ ...context, command: "create", filename: "src/main.js", content: "console.log('a');" });
	assert.equal(created.action, "created");

	const rewritten = service.handle({ ...context, command: "rewrite", filename: "src/main.js", content: "console.log('b');" });
	assert.equal(rewritten.action, "updated");

	const updated = service.handle({ ...context, command: "update", filename: "src/main.js", old_str: "'b'", new_str: "'c'" });
	assert.equal(updated.action, "updated");

	const read = service.handle({ ...context, command: "get", filename: "src/main.js" });
	assert.equal(read.content, "console.log('c');");

	const listed = service.handle({ ...context, command: "list" });
	assert.deepEqual(listed.files, ["src\\main.js"]);

	const deleted = service.handle({ ...context, command: "delete", filename: "src/main.js" });
	assert.equal(deleted.action, "deleted");
});

await test("WorkspaceFileService lists current project files without write-side effects", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { clientId: "client-a", sessionId: "session-files", title: "Demo App" };

	service.handle({ ...context, command: "create", filename: "src/main.js", content: "console.log('ok');" });
	service.handle({ ...context, command: "create", filename: "src/components/App.vue", content: "<template></template>" });
	const siblingDir = join(root, "data", "projects", "legacy-session-");
	mkdirSync(siblingDir, { recursive: true });

	const listed = service.listProjectFiles(context);
	const missing = service.listProjectFiles({ clientId: "client-a", sessionId: "session-missing", title: "Missing App" });

	assert.deepEqual(listed.files, ["src/components/App.vue", "src/main.js"]);
	assert.equal(listed.fileCount, 2);
	assert.equal(existsSync(siblingDir), true);
	assert.deepEqual(missing.files, []);
	assert.equal(existsSync(join(root, "data", "projects", "missing-app-session-")), false);
});

await test("WorkspaceFileService previews a current project text file without write-side effects", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { clientId: "client-a", sessionId: "session-preview", title: "Preview App" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const siblingDir = join(root, "data", "projects", "legacy-session-");
	mkdirSync(siblingDir, { recursive: true });

	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });

	assert.equal(preview.filename, "src/main.ts");
	assert.equal(preview.content, "export const answer = 42;\n");
	assert.equal(preview.language, "typescript");
	assert.equal(preview.binary, false);
	assert.equal(preview.truncated, false);
	assert.equal(preview.hash.length, 64);
	assert.equal(existsSync(siblingDir), true);
	assert.throws(() => service.readProjectFilePreview({ ...context, filename: "../outside.txt" }), /Project path component/);
});

await test("WorkspaceFileService saves a text file preview with hash conflict protection", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { clientId: "client-a", sessionId: "session-save", title: "Save App" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });
	const saved = service.saveProjectFile({
		...context,
		filename: "src/main.ts",
		content: "export const answer = 43;\n",
		baseHash: preview.hash,
	});
	const read = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });

	assert.equal(saved.filename, "src/main.ts");
	assert.equal(saved.content, "export const answer = 43;\n");
	assert.equal(saved.hash, read.hash);
	assert.notEqual(saved.hash, preview.hash);
	assert.equal(read.content, "export const answer = 43;\n");
});

await test("WorkspaceFileService rejects saving when the base hash is stale", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { clientId: "client-a", sessionId: "session-save-conflict", title: "Save Conflict" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });
	service.handle({ ...context, command: "rewrite", filename: "src/main.ts", content: "export const answer = 99;\n" });

	assert.throws(
		() =>
			service.saveProjectFile({
				...context,
				filename: "src/main.ts",
				content: "export const answer = 43;\n",
				baseHash: preview.hash,
			}),
		/File has changed since it was opened/,
	);
	assert.equal(service.readProjectFilePreview({ ...context, filename: "src/main.ts" }).content, "export const answer = 99;\n");
});

await test("WorkspaceFileService rejects update when old_str is not unique", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));
	const context = { clientId: "client-a", sessionId: "session-123456789", title: "Demo App" };

	service.handle({
		...context,
		command: "create",
		filename: "src/main.js",
		content: "const label = 'Save';\nconst buttonLabel = 'Save';\n",
	});

	assert.throws(
		() =>
			service.handle({
				...context,
				command: "update",
				filename: "src/main.js",
				old_str: "'Save'",
				new_str: "'Submit'",
			}),
		/old_str must match exactly one location/,
	);

	const read = service.handle({ ...context, command: "get", filename: "src/main.js" });
	assert.equal(read.content, "const label = 'Save';\nconst buttonLabel = 'Save';\n");
});

await test("WorkspaceFileService rejects project paths that escape the workspace", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));

	assert.throws(() =>
		service.handle({
			sessionId: "session-123456789",
			clientId: "client-a",
			title: "Demo App",
			command: "create",
			filename: "../outside.txt",
			content: "no",
		}),
	/Project path component is empty\./);
});

await test("WorkspaceCommandService rejects commands that can stop the PI server", async () => {
	const root = tempRoot();
	const service = new WorkspaceCommandService(testConfig(root));
	const context = { clientId: "client-a", sessionId: "session-command-safety", title: "Command Safety" };
	const command = "taskkill /F /IM node.exe 2>nul & echo Stopped";

	assert.equal(isUnsafeProjectCommand(command), true);
	await assert.rejects(
		() => service.run({ ...context, command }),
		/Refusing to run a command that can stop the PI server/,
	);
});

await test("configuredStoragePlugin ignores generated storage directories in the Vite watcher", async () => {
	const root = tempRoot();
	writeFileSync(
		join(root, "workspace.env"),
		[
			`PI_SETTINGS_FILE=${join(root, "runtime", "settings.json")}`,
			`PI_CLIENTS_ROOT_DIR=${join(root, "runtime", "clients")}`,
			`PI_SKILLS_DIR=${join(root, "runtime", "skills")}`,
			`PI_LOG_DB=${join(root, "data", "logs", "pi-diagnostics.sqlite")}`,
		].join("\n"),
		"utf8",
	);

	const plugin = configuredStoragePlugin(join(root, "workspace.env"));
	const viteConfig = plugin.config?.();
	const ignored = viteConfig?.server?.watch?.ignored;

	assert.ok(Array.isArray(ignored));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "clients")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "skills")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "data", "logs", "pi-diagnostics.sqlite"))));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "settings.json"))));
});

await test("WorkspacePreviewService serves dist when a project was built", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { clientId: "client-a", sessionId: "session-abcdef", title: "Built App" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "echo build" } }),
	});
	mkdirSync(join(String(created.projectRoot), "dist"), { recursive: true });
	writeFileSync(join(String(created.projectRoot), "dist", "index.html"), "<h1>Built</h1>", "utf8");

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "running");
	assert.equal(result.mode, "static");
	assert.equal(result.serveRoot, join(String(created.projectRoot), "dist"));
	assert.equal(result.previewUrl, "http://localhost:5173/preview/project-client-a-session-/");
	assert.match(readFileSync(join(String(created.projectRoot), ".pi-project.json"), "utf8"), /"status": "running"/);
});

await test("WorkspacePreviewService lists generated projects from preview metadata newest first", async () => {
	const root = tempRoot();
	const config = testConfig(root);
	const previewService = new WorkspacePreviewService(config);
	const olderDir = join(config.clientsRootDir, "client-a", "sessions", "session-old", "project");
	const newerDir = join(config.clientsRootDir, "client-a", "sessions", "session-new", "project");
	const brokenDir = join(config.clientsRootDir, "client-a", "sessions", "session-broken", "project");
	const incompleteDir = join(config.clientsRootDir, "client-a", "sessions", "session-incomplete", "project");
	mkdirSync(olderDir, { recursive: true });
	mkdirSync(newerDir, { recursive: true });
	mkdirSync(brokenDir, { recursive: true });
	mkdirSync(incompleteDir, { recursive: true });
	writeFileSync(
		join(olderDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "older-app",
			clientId: "client-a",
			sessionId: "session-old",
			title: "Older App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/older-app/",
			projectRoot: olderDir,
			serveRoot: olderDir,
			fileCount: 2,
			updatedAt: "2026-05-28T10:00:00.000Z",
			logs: ["old"],
		}),
		"utf8",
	);
	writeFileSync(
		join(newerDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "newer-app",
			clientId: "client-a",
			sessionId: "session-new",
			title: "Newer App",
			status: "failed",
			mode: "static",
			previewUrl: "",
			projectRoot: newerDir,
			serveRoot: "",
			fileCount: 4,
			updatedAt: "2026-05-29T10:00:00.000Z",
			logs: ["new"],
		}),
		"utf8",
	);
	writeFileSync(join(brokenDir, ".pi-project.json"), "{not json", "utf8");
	writeFileSync(join(incompleteDir, ".pi-project.json"), JSON.stringify({ projectId: "incomplete-app" }), "utf8");

	const result = previewService.listProjects();

	assert.deepEqual(
		result.projects.map((project) => project.projectId),
		["newer-app", "older-app"],
	);
	assert.equal(result.projects[0].title, "Newer App");
	assert.equal(result.projects[0].status, "failed");
	assert.equal(result.projects[0].previewUrl, "");
	assert.equal(result.projects[0].fileCount, 4);
	assert.equal(result.projects[0].sessionId, "session-new");
	assert.equal(result.projects[0].updatedAt, "2026-05-29T10:00:00.000Z");
	assert.equal("projectRoot" in result.projects[0], false);
	assert.equal("serveRoot" in result.projects[0], false);
	assert.equal("logs" in result.projects[0], false);
});

await test("WorkspacePreviewService rewrites running project preview URLs for the current request host", async () => {
	const root = tempRoot();
	const config = testConfig(root, { previewBaseUrl: "" });
	const previewService = new WorkspacePreviewService(config);
	const projectDir = join(config.clientsRootDir, "client-a", "sessions", "session-current-host", "project");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "current-host-app",
			clientId: "client-a",
			sessionId: "session-current-host",
			title: "Current Host App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/current-host-app/",
			projectRoot: projectDir,
			serveRoot: projectDir,
			fileCount: 1,
			updatedAt: "2026-05-29T10:00:00.000Z",
			logs: [],
		}),
		"utf8",
	);

	const result = previewService.listProjects({ headers: { host: "127.0.0.1:5194" } });

	assert.equal(result.projects[0].previewUrl, "http://127.0.0.1:5194/preview/current-host-app/");
});

await test("WorkspacePreviewService renames generated project metadata", async () => {
	const root = tempRoot();
	const config = testConfig(root, { previewBaseUrl: "" });
	const previewService = new WorkspacePreviewService(config);
	const projectDir = join(config.clientsRootDir, "client-a", "sessions", "session-rename", "project");
	const updatedAt = "2026-05-29T10:00:00.000Z";
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "rename-app",
			clientId: "client-a",
			sessionId: "session-rename",
			title: "Original App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/rename-app/",
			projectRoot: projectDir,
			serveRoot: projectDir,
			fileCount: 2,
			updatedAt,
			logs: [],
		}),
		"utf8",
	);

	const result = previewService.renameProject("rename-app", "Renamed App", { headers: { host: "127.0.0.1:5194" } });
	const metadata = JSON.parse(readFileSync(join(projectDir, ".pi-project.json"), "utf8"));

	assert.equal(result.title, "Renamed App");
	assert.equal(result.status, "running");
	assert.equal(result.previewUrl, "http://127.0.0.1:5194/preview/rename-app/");
	assert.equal(result.updatedAt, updatedAt);
	assert.equal(metadata.title, "Renamed App");
	assert.equal(metadata.updatedAt, updatedAt);
});

await test("WorkspaceTaskService previews static root without running package scripts", async () => {
	const root = tempRoot();
	const config = testConfig(root);
	const fileService = new WorkspaceFileService(config);
	const taskService = new WorkspaceTaskService(config);
	const context = { clientId: "client-a", sessionId: "session-static-script", title: "Static Script" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "index.html",
		content: "<h1>Static root</h1>",
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({
			scripts: {
				build:
					"node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.html','<h1>Build script ran</h1>')\"",
			},
		}),
	});

	const result = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "running");
	assert.equal(result.mode, "static");
	assert.equal(result.previewUrl, "http://localhost:5173/preview/project-client-a-session-/");
	assert.equal(result.serveRoot, String(created.projectRoot));
	assert.equal(existsSync(join(String(created.projectRoot), "dist", "index.html")), false);
	assert.match(result.logs.join(""), /does not run package scripts/);
});

await test("WorkspacePreviewService rejects build source entries before build_static", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { clientId: "client-a", sessionId: "session-vite-source", title: "Vite Source" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "vite build" }, dependencies: { "@vitejs/plugin-react": "latest" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "index.html",
		content: '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "src/main.tsx",
		content: "console.log('tsx source');",
	});

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /project_task build_static/);
});

await test("WorkspaceTaskService rejects Node services without a static entry", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const taskService = new WorkspaceTaskService(config);
	const context = { clientId: "client-a", sessionId: "session-node-service", title: "Node Service" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { start: "node server.js" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "server.js",
		content: "require('node:http').createServer((_req, res) => res.end('no')).listen(process.env.PORT)",
	});

	const result = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /Static preview requires an index\.html/);
	assert.match(result.logs.join(""), /Node services are not started/);
});

await test("WorkspaceTaskService build_static runs the configured build and exposes static output", async () => {
	const root = tempRoot();
	const config = testConfig(root, {
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm exec vite build",
	});
	const fileService = new WorkspaceFileService(config);
	const commands = [];
	const taskService = new WorkspaceTaskService(config, undefined, async (command, cwd, _timeoutMs, logs) => {
		commands.push(command);
		logs.push(`ran: ${command}\n`);
		if (command === "npm exec vite build") {
			mkdirSync(join(cwd, "dist"), { recursive: true });
			writeFileSync(join(cwd, "dist", "index.html"), "<h1>Built static</h1>", "utf8");
		}
	});
	const context = { clientId: "client-a", sessionId: "session-build-static", title: "Build Static" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "vite build" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "src/main.js",
		content: "console.log('source');",
	});

	const build = await taskService.run({ ...context, task: "build_static" });
	const preview = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(build.status, "passed");
	assert.equal(build.valid, true);
	assert.deepEqual(commands, ["npm install", "npm exec vite build"]);
	assert.equal(build.serveRoot, join(String(created.projectRoot), "dist"));
	assert.equal(existsSync(join(String(created.projectRoot), "dist", "index.html")), true);
	assert.match(build.logs.join(""), /Static build completed/);
	assert.equal(preview.status, "running");
	assert.equal(preview.serveRoot, join(String(created.projectRoot), "dist"));
});

await test("WorkspacePreviewService does not return a clickable URL for an unpreviewable project", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { clientId: "client-a", sessionId: "session-unpreviewable", title: "Unpreviewable" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { test: "node test.js" } }),
	});

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /Static preview requires an index\.html/);
});

function normalizeWatchPath(path) {
	return resolve(path).replace(/\\/g, "/");
}

function attributeValue(attributes, key) {
	const attribute = attributes.find((item) => item.key === key);
	const value = attribute?.value;
	if (!value) return undefined;
	if ("stringValue" in value) return value.stringValue;
	if ("intValue" in value) return Number(value.intValue);
	if ("doubleValue" in value) return Number(value.doubleValue);
	if ("boolValue" in value) return value.boolValue;
	if ("arrayValue" in value) return value.arrayValue.values.map((item) => Object.values(item)[0]);
	return undefined;
}
