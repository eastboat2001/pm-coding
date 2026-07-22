import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import {
	type AgentV2ContextPacket,
	type AgentV2DiagnosticEvent,
	type AgentV2ModelExecutionInput,
	type AgentV2RepairModelExecutionInput,
	type AgentV2RunSnapshot,
	type AgentV2TaskNode,
	AGENT_V2_MODEL_ID_MAX_LENGTH,
	AGENT_V2_MODEL_PROVIDER_MAX_LENGTH,
	normalizeAgentV2StartPayload,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import { describe, expect, it, vi } from "vitest";
import {
	AgentV2PiModelExecution,
	AgentV2PiModelExecutionError,
	ConfiguredAgentV2ServerModelRegistry,
	type AgentV2ServerModelRegistry,
} from "../src/worker/agent-v2-pi-model-execution.js";
import {
	createGlobalProviderApiKeyResolver,
	loadAgentV2ServerSettingsSnapshot,
} from "../src/worker/global-provider-keys.js";

const SECRET_KEY = "task5-secret-api-key";
const RAW_PROVIDER_SECRET = "raw-provider-secret";

describe("AgentV2PiModelExecution", () => {
	it("shares the canonical start model-reference contract with the worker adapter", async () => {
		expect(AGENT_V2_MODEL_PROVIDER_MAX_LENGTH).toBe(128);
		expect(AGENT_V2_MODEL_ID_MAX_LENGTH).toBe(256);
		const normalized = normalizeAgentV2StartPayload(
			{
				input: { sessionId: "session-a", title: "Example", objective: "Build an example" },
				model: { provider: "custom-provider:team@prod", id: "model@revision+profile=stable" },
			},
			"run-a",
		);
		const model: Model<Api> = {
			...trustedModel(),
			provider: normalized.model.provider,
			id: normalized.model.id,
		};
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(model),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () =>
				assistantMessage(implementationJson(), { provider: model.provider, model: model.id }),
			),
		});

		await expect(execution.generateImplementation(executionInput(normalized.model))).resolves.toMatchObject({
			provider: normalized.model.provider,
			model: normalized.model.id,
		});
		for (const reference of [
			{ provider: "https://attacker.invalid", id: "model" },
			{ provider: "provider with-space", id: "model" },
			{ provider: "provider", id: "model\u0000control" },
			{ provider: "p".repeat(AGENT_V2_MODEL_PROVIDER_MAX_LENGTH + 1), id: "model" },
			{ provider: "provider", id: "m".repeat(AGENT_V2_MODEL_ID_MAX_LENGTH + 1) },
		]) {
			expect(() =>
				normalizeAgentV2StartPayload(
					{
						input: { sessionId: "session-a", title: "Example", objective: "Build an example" },
						model: reference,
					},
					"run-a",
				),
			).toThrow(/model/i);
		}
	});

	it("recovers from two malformed model results with an escalated strict instruction", async () => {
		const complete = vi
			.fn()
			.mockResolvedValueOnce(assistantMessage("I created the application, but omitted the required JSON envelope."))
			.mockResolvedValueOnce(assistantMessage("still not valid JSON"))
			.mockResolvedValueOnce(assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
		});

		await expect(execution.generateImplementation(executionInput())).resolves.toMatchObject({
			result: { taskId: "task-1", files: [{ path: "index.html" }] },
			usage: { input: 33, output: 21, totalTokens: 54, costTotal: 0.375 },
		});
		expect(complete).toHaveBeenCalledTimes(3);
		const recoveryContext = complete.mock.calls[1]?.[1];
		expect(recoveryContext?.systemPrompt).toContain("PROTOCOL RECOVERY");
		expect(recoveryContext?.systemPrompt).toContain("invalid_protocol");
		expect(recoveryContext?.messages[0]?.content).toBe(complete.mock.calls[0]?.[1]?.messages[0]?.content);
		expect(complete.mock.calls[2]?.[1]?.systemPrompt).toContain("second protocol recovery");
	});

	it("regenerates a compact complete result after the provider reaches its output limit", async () => {
		const complete = vi
			.fn()
			.mockResolvedValueOnce(assistantMessage("truncated", { stopReason: "length" }))
			.mockResolvedValueOnce(assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
		});

		await expect(execution.generateImplementation(executionInput())).resolves.toMatchObject({
			result: { taskId: "task-1", files: [{ path: "index.html" }] },
		});
		expect(complete).toHaveBeenCalledTimes(2);
		const recoveryContext = complete.mock.calls[1]?.[1];
		expect(recoveryContext?.systemPrompt).toContain("OUTPUT-LENGTH RECOVERY");
		expect(recoveryContext?.systemPrompt).toContain("For a static app, return only one root index.html");
		expect(recoveryContext?.systemPrompt).toContain("return one connected build entry and source tree");
		expect(recoveryContext?.systemPrompt).toContain("one complete bare JSON object");
		expect(recoveryContext?.messages[0]?.content).toBe(complete.mock.calls[0]?.[1]?.messages[0]?.content);
	});

	it("pins endpoint, key and capabilities to one immutable startup snapshot across settings replacement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-v2-model-snapshot-"));
		const settingsFile = join(dir, "settings.json");
		try {
			writeFileSync(settingsFile, JSON.stringify(customSettings("https://old.example/v1", "old-key")), "utf8");
			const snapshot = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile },
				{ getEnvApiKey: () => undefined, getBuiltinProviders: () => [] },
			);
			const registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
			const resolveApiKey = createGlobalProviderApiKeyResolver(snapshot);
			writeFileSync(settingsFile, JSON.stringify(customSettings("https://new.example/v1", "new-key")), "utf8");
			const observed: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry,
				resolveApiKey,
				complete: vi.fn(async (model, _context, options) => {
					observed.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
					return assistantMessage(implementationJson(), {
						provider: "custom-provider:provider-a",
						model: "custom-model",
					});
				}),
			});
			await Promise.all([
				execution.generateImplementation(executionInput({ provider: "custom-provider:provider-a", id: "custom-model" })),
				execution.generateImplementation(executionInput({ provider: "custom-provider:provider-a", id: "custom-model" })),
			]);
			expect(observed).toEqual([
				{ baseUrl: "https://old.example/v1", apiKey: "old-key" },
				{ baseUrl: "https://old.example/v1", apiKey: "old-key" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads one fresh atomic server settings snapshot for each model task", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-v2-model-refresh-"));
		const settingsFile = join(dir, "settings.json");
		try {
			writeFileSync(settingsFile, JSON.stringify(customSettings("https://old.example/v1", "old-key")), "utf8");
			const observed: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
			const execution = new AgentV2PiModelExecution({
				loadServerSettingsSnapshot: () =>
					loadAgentV2ServerSettingsSnapshot(
						{ settingsFile },
						{ getEnvApiKey: () => undefined, getBuiltinProviders: () => [] },
					),
				complete: vi.fn(async (model, _context, options) => {
					observed.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey });
					return assistantMessage(implementationJson(), {
						provider: "custom-provider:provider-a",
						model: "custom-model",
					});
				}),
			});

			await execution.generateImplementation(
				executionInput({ provider: "custom-provider:provider-a", id: "custom-model" }),
			);
			writeFileSync(settingsFile, JSON.stringify(customSettings("https://new.example/v1", "new-key")), "utf8");
			await execution.generateImplementation(
				executionInput({ provider: "custom-provider:provider-a", id: "custom-model" }),
			);

			expect(observed).toEqual([
				{ baseUrl: "https://old.example/v1", apiKey: "old-key" },
				{ baseUrl: "https://new.example/v1", apiKey: "new-key" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails before completion for duplicate custom identities and conflicting credential sources under concurrency", async () => {
		const configurations = [
			{
				customProviders: [
					{ ...customSettings("https://endpoint-a.invalid/v1", "").customProviders[0], apiKey: undefined },
					{ ...customSettings("https://endpoint-b.invalid/v1", "key-b").customProviders[0] },
				],
			},
			{
				providerKeys: { "custom-provider:provider-a": "root-key" },
				...customSettings("https://endpoint-a.invalid/v1", "embedded-key"),
			},
		];
		for (const settings of configurations) {
			const snapshot = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile: "unused" },
				{
					readSettingsFile: () => JSON.stringify(settings),
					getBuiltinProviders: () => [],
					getEnvApiKey: () => undefined,
				},
			);
			const complete = vi.fn(async () => assistantMessage(implementationJson(), {
				provider: "custom-provider:provider-a",
				model: "custom-model",
			}));
			const execution = new AgentV2PiModelExecution({
				modelRegistry: new ConfiguredAgentV2ServerModelRegistry(snapshot),
				resolveApiKey: createGlobalProviderApiKeyResolver(snapshot),
				complete,
			});
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, () =>
					execution.generateImplementation(executionInput({ provider: "custom-provider:provider-a", id: "custom-model" })),
				),
			);
			expect(results.every((result) => result.status === "rejected")).toBe(true);
			expect(complete).not.toHaveBeenCalled();
		}
	});

	it("resolves auto-discovery metadata only from the exact selected model and rebuilds its trusted endpoint", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-v2-auto-model-"));
		const settingsFile = join(dir, "settings.json");
		try {
			writeFileSync(
				settingsFile,
				JSON.stringify({
					customProviders: [{ id: "local", name: "Local", type: "ollama", baseUrl: "http://127.0.0.1:11434", useNonStreamingToolCalls: true }],
					selectedModel: {
						id: "qwen", name: "Qwen", provider: "custom-provider:local", api: "evil", baseUrl: "https://evil.invalid", headers: { authorization: "secret" },
						reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096,
					},
				}),
				"utf8",
			);
			const snapshot = loadAgentV2ServerSettingsSnapshot({ settingsFile }, { getEnvApiKey: () => undefined, getBuiltinProviders: () => [] });
			const registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
			expect(registry.resolve({ provider: "custom-provider:local", id: "qwen" })).toMatchObject({
				api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", contextWindow: 32768, maxTokens: 4096,
				compat: expect.objectContaining({ supportsDeveloperRole: false, maxTokensField: "max_tokens", useNonStreamingToolCalls: true }),
			});
			expect(registry.resolve({ provider: "custom-provider:local", id: "other" })).toBeUndefined();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("preserves exact manual compat and rejects unknown compat fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-v2-manual-compat-"));
		const settingsFile = join(dir, "settings.json");
		try {
			const value = customSettings("https://manual.example/v1", "key");
			(value.customProviders[0].models[0] as Record<string, unknown>).compat = {
				supportsDeveloperRole: false, maxTokensField: "max_tokens", useNonStreamingToolCalls: true,
			};
			writeFileSync(settingsFile, JSON.stringify(value), "utf8");
			let snapshot = loadAgentV2ServerSettingsSnapshot({ settingsFile }, { getEnvApiKey: () => undefined, getBuiltinProviders: () => [] });
			let registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
			expect(registry.resolve({ provider: "custom-provider:provider-a", id: "custom-model" })?.compat).toEqual({
				supportsDeveloperRole: false, maxTokensField: "max_tokens", useNonStreamingToolCalls: true,
			});
			(value.customProviders[0].models[0] as Record<string, unknown>).compat = { unknownWireFlag: true };
			writeFileSync(settingsFile, JSON.stringify(value), "utf8");
			snapshot = loadAgentV2ServerSettingsSnapshot({ settingsFile }, { getEnvApiKey: () => undefined, getBuiltinProviders: () => [] });
			registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
			expect(registry.resolve({ provider: "custom-provider:provider-a", id: "custom-model" })).toBeUndefined();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("accepts the persisted Xiaomi MiMo compatibility profile", () => {
		const settings = customSettings("https://token-plan-cn.xiaomimimo.com/v1", "key");
		(settings.customProviders[0].models[0] as Record<string, unknown>).compat = {
			customProviderProfile: "mimo",
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
			supportsReasoningEffort: true,
			maxTokensField: "max_completion_tokens",
		};
		const snapshot = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile: "unused" },
			{
				readSettingsFile: () => JSON.stringify(settings),
				getBuiltinProviders: () => [],
				getEnvApiKey: () => undefined,
			},
		);

		expect(
			new ConfiguredAgentV2ServerModelRegistry(snapshot).resolve({
				provider: "custom-provider:provider-a",
				id: "custom-model",
			})?.compat,
		).toMatchObject({
			customProviderProfile: "mimo",
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
			supportsReasoningEffort: true,
			maxTokensField: "max_completion_tokens",
		});
	});

	it("supports ambient auth and exact loopback keyless policy while remote custom remains fail-closed", async () => {
		for (const provider of ["google-vertex", "amazon-bedrock"]) {
			const model = { ...trustedModel(), provider };
			const complete = vi.fn(async () => assistantMessage(implementationJson(), { provider }));
			const execution = new AgentV2PiModelExecution({ modelRegistry: registry(model, "ambient-or-key"), resolveApiKey: () => "<authenticated>", complete });
			await expect(execution.generateImplementation(executionInput({ provider, id: model.id }))).resolves.toBeDefined();
			expect(complete.mock.calls[0][2]?.apiKey).toBe("<authenticated>");
		}
		const local = { ...trustedModel(), provider: "custom-provider:local", baseUrl: "http://127.0.0.1:11434/v1" };
		await expect(new AgentV2PiModelExecution({ modelRegistry: registry(local, "trusted-local-optional"), resolveApiKey: () => undefined, complete: vi.fn(async () => assistantMessage(implementationJson(), { provider: local.provider })) }).generateImplementation(executionInput({ provider: local.provider, id: local.id }))).resolves.toBeDefined();
		const remote = { ...local, provider: "custom-provider:remote", baseUrl: "https://remote.example/v1" };
		await expect(new AgentV2PiModelExecution({ modelRegistry: registry(remote, "required"), resolveApiKey: () => undefined, complete: vi.fn() }).generateImplementation(executionInput({ provider: remote.provider, id: remote.id }))).rejects.toMatchObject({ code: "missing_api_key" });
	});

	it("allows keyless auto providers only for unambiguous loopback URLs", () => {
		const accepted = ["http://localhost:11434", "http://127.0.0.1:8080", "https://127.9.8.7", "http://[::1]:1234"];
		const rejected = [
			"http://localhost.evil", "http://localhost.", "http://127.1", "http://127.000.0.1",
			"http://2130706433", "http://0x7f000001", "http://127.0.0.1@evil.example", "ftp://127.0.0.1",
			"https://remote.example",
		];
		for (const [baseUrl, expected] of [...accepted.map((value) => [value, "trusted-local-optional"]), ...rejected.map((value) => [value, "required"])] as const) {
			const dir = mkdtempSync(join(tmpdir(), "agent-v2-loopback-"));
			const settingsFile = join(dir, "settings.json");
			try {
				writeFileSync(settingsFile, JSON.stringify({ customProviders: [{ id: "local", name: "Local", type: "ollama", baseUrl }], selectedModel: { id: "m", name: "M", provider: "custom-provider:local", api: "ignored", baseUrl: "ignored", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } }), "utf8");
				const snapshot = loadAgentV2ServerSettingsSnapshot({ settingsFile }, { getEnvApiKey: () => undefined, getBuiltinProviders: () => [] });
				const registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
				expect(registry.resolveAuthentication({ provider: "custom-provider:local", id: "m" })).toBe(expected);
			} finally { rmSync(dir, { recursive: true, force: true }); }
		}
	});

	it("rejects accessor model references with one descriptor read and stable taxonomy", async () => {
		let reads = 0;
		const model = {} as Record<string, unknown>;
		Object.defineProperties(model, {
			provider: { enumerable: true, get: () => { reads++; return "trusted-provider"; } },
			id: { enumerable: true, value: "trusted-model" },
		});
		const execution = new AgentV2PiModelExecution({ modelRegistry: registry(trustedModel()), resolveApiKey: () => SECRET_KEY, complete: vi.fn() });
		await expect(execution.generateImplementation(executionInput(model))).rejects.toMatchObject({ code: "invalid_model_reference" });
		expect(reads).toBe(0);
	});

	it("sanitizes every hostile Proxy reflection trap on durable model references", async () => {
		const reflectionSentinels = [
			["getPrototypeOf", "model-reference-getPrototypeOf-sentinel"],
			["ownKeys", "model-reference-ownKeys-sentinel"],
			["getOwnPropertyDescriptor", "model-reference-descriptor-sentinel"],
		] as const;
		for (const [trap, sentinel] of reflectionSentinels) {
			const target = { provider: "trusted-provider", id: "trusted-model" };
			const model = new Proxy(target, {
				[trap]: () => {
					throw new Error(sentinel);
				},
			});
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(),
			});
			const error = await caught(execution.generateImplementation(executionInput(model)));
			expect(error, trap).toMatchObject({ code: "invalid_model_reference" });
			expect(observable(error), trap).not.toContain(sentinel);
		}
	});

	it("sanitizes hostile canonical model identity access inside the registry boundary", async () => {
		const sentinel = "registry-model-provider-sentinel";
		const hostileModel = new Proxy(trustedModel(), {
			get(target, property, receiver) {
				if (property === "provider") throw new Error(sentinel);
				return Reflect.get(target, property, receiver);
			},
		});
		const resolveApiKey = vi.fn(() => SECRET_KEY);
		const complete = vi.fn();
		const execution = new AgentV2PiModelExecution({
			modelRegistry: { resolve: () => hostileModel },
			resolveApiKey,
			complete,
		});
		const error = await caught(execution.generateImplementation(executionInput()));
		expect(error).toMatchObject({ code: "unknown_model" });
		expect(observable(error)).not.toContain(sentinel);
		expect(resolveApiKey).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it("strictly validates bounded plain provider messages and usage", async () => {
		const cases: unknown[] = [
			{ ...assistantMessage(implementationJson()), role: "user" },
			{ ...assistantMessage(implementationJson()), content: [{ type: "text", text: 123 }] },
			{ ...assistantMessage(implementationJson()), content: [{ type: "unknown", text: implementationJson() }] },
			{ ...assistantMessage(implementationJson()), content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })) },
			{ ...assistantMessage(implementationJson()), usage: { input: 1 } },
		];
		const accessor = assistantMessage(implementationJson()) as unknown as Record<string, unknown>;
		Object.defineProperty(accessor, "content", { enumerable: true, get: () => { throw new Error(RAW_PROVIDER_SECRET); } });
		cases.push(accessor);
		for (const [index, message] of cases.entries()) {
			const execution = new AgentV2PiModelExecution({ modelRegistry: registry(trustedModel()), resolveApiKey: () => SECRET_KEY, complete: vi.fn(async () => message as AssistantMessage) });
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error, `provider message case ${index}`).toMatchObject({ code: "invalid_provider_content" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		}
		let blockGetterReads = 0;
		const accessorBlock = {} as Record<string, unknown>;
		Object.defineProperty(accessorBlock, "type", {
			enumerable: true,
			get: () => {
				blockGetterReads++;
				throw new Error(RAW_PROVIDER_SECRET);
			},
		});
		const accessorExecution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => assistantMessage(implementationJson(), { content: [accessorBlock] as never })),
		});
		await expect(accessorExecution.generateImplementation(executionInput())).rejects.toMatchObject({
			code: "invalid_provider_content",
		});
		expect(blockGetterReads).toBe(0);
	});

	it("accepts bounded official diagnostics but ignores their redacted payload completely", async () => {
		const message = assistantMessage(implementationJson()) as AssistantMessage & { diagnostics?: unknown };
		message.diagnostics = [
			{
				type: "provider_transport_failure",
				timestamp: 1,
				error: { name: "Error", message: "redacted", stack: "redacted", code: "ECONNRESET" },
				details: {
					configuredTransport: "auto",
					fallbackTransport: "sse",
					eventsEmitted: false,
					phase: "before_message_stream_start",
					requestBytes: 123,
				},
			},
		];
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => message as AssistantMessage),
		});
		const result = await execution.generateImplementation(executionInput());
		expect(result.result.summary).toBe("implemented");
		expect(JSON.stringify(result)).not.toContain("provider_transport_failure");
		expect(JSON.stringify(result)).not.toContain("ECONNRESET");
	});

	it("rejects malformed or oversized diagnostics without reading getters or leaking secrets", async () => {
		let reads = 0;
		const getterDiagnostic = {} as Record<string, unknown>;
		Object.defineProperty(getterDiagnostic, "type", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error(`${RAW_PROVIDER_SECRET}:${SECRET_KEY}`);
			},
		});
		for (const diagnostics of [
			[getterDiagnostic],
			[{ type: "provider_transport_failure", timestamp: 1, details: { secret: RAW_PROVIDER_SECRET }, extra: true }],
			[{ type: "x".repeat(257), timestamp: 1 }],
			Array.from({ length: 65 }, () => ({ type: "provider_transport_failure", timestamp: 1 })),
		]) {
			const message = assistantMessage(implementationJson()) as AssistantMessage & { diagnostics?: unknown };
			message.diagnostics = diagnostics;
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(async () => message as AssistantMessage),
			});
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error).toMatchObject({ code: "invalid_provider_content" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
			expect(observable(error)).not.toContain(SECRET_KEY);
		}
		expect(reads).toBe(0);
	});

	it("rejects hostile content arrays without executing index accessors or custom iterators", async () => {
		let reads = 0;
		const numericAccessor = [] as unknown[];
		Object.defineProperty(numericAccessor, "0", {
			enumerable: true,
			configurable: true,
			get: () => {
				reads++;
				return { type: "text", text: implementationJson() };
			},
		});
		numericAccessor.length = 1;
		const customIterator = [{ type: "text", text: implementationJson() }] as unknown[];
		Object.defineProperty(customIterator, Symbol.iterator, {
			configurable: true,
			get: () => {
				reads++;
				return Array.prototype[Symbol.iterator];
			},
		});
		const sparse = new Array(1);
		const extraProperty = [{ type: "text", text: implementationJson() }] as unknown[] & { extra?: string };
		extraProperty.extra = "unexpected";
		for (const content of [numericAccessor, customIterator, sparse, extraProperty]) {
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(async () => assistantMessage(implementationJson(), { content: content as never })),
			});
			await expect(execution.generateImplementation(executionInput())).rejects.toMatchObject({
				code: "invalid_provider_content",
			});
		}
		expect(reads).toBe(0);
	});

	it("rejects non-enumerable provider-envelope fields without executing accessors", async () => {
		let getterReads = 0;
		const content = [{ type: "text", text: implementationJson() }];
		Object.defineProperty(content, "hidden", {
			get: () => {
				getterReads += 1;
				return RAW_PROVIDER_SECRET;
			},
		});
		const hiddenBlock = { type: "text", text: implementationJson() };
		Object.defineProperty(hiddenBlock, "hidden", {
			get: () => {
				getterReads += 1;
				return RAW_PROVIDER_SECRET;
			},
		});
		for (const hostileContent of [content, [hiddenBlock]]) {
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(async () => assistantMessage("", { content: hostileContent as never })),
			});
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error).toMatchObject({ code: "invalid_provider_content" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		}
		const diagnosticDetails = { phase: "before_message_stream_start" };
		Object.defineProperty(diagnosticDetails, "hidden", {
			get: () => {
				getterReads += 1;
				return RAW_PROVIDER_SECRET;
			},
		});
		const message = assistantMessage(implementationJson()) as AssistantMessage & { diagnostics?: unknown };
		message.diagnostics = [{ type: "provider_transport_failure", timestamp: 1, details: diagnosticDetails }];
		const diagnosticExecution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => message),
		});
		await expect(diagnosticExecution.generateImplementation(executionInput())).rejects.toMatchObject({
			code: "invalid_provider_content",
		});
		expect(getterReads).toBe(0);
	});

	it("rejects unknown custom provider, model and selected-model fields before resolution", () => {
		const manualCases = [
			(value: ReturnType<typeof customSettings>) => Object.assign(value.customProviders[0], { authorization: "secret" }),
			(value: ReturnType<typeof customSettings>) => Object.assign(value.customProviders[0].models[0], { endpointOverride: "https://evil.invalid" }),
		];
		for (const mutate of manualCases) {
			const settings = customSettings("https://safe.invalid/v1", "key");
			mutate(settings);
			const snapshot = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile: "unused" },
				{ readSettingsFile: () => JSON.stringify(settings), getBuiltinProviders: () => [], getEnvApiKey: () => undefined },
			);
			const registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
			expect(registry.resolve({ provider: "custom-provider:provider-a", id: "custom-model" })).toBeUndefined();
			expect(snapshot.resolveApiKey("custom-provider:provider-a")).toBeUndefined();
		}

		const autoSettings = {
			customProviders: [
				{ id: "local", name: "Local", type: "ollama", baseUrl: "http://127.0.0.1:11434" },
			],
			selectedModel: {
				id: "qwen",
				name: "Qwen",
				provider: "custom-provider:local",
				api: "ignored",
				baseUrl: "ignored",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
				apiKey: "must-not-be-accepted",
			},
		};
		const autoSnapshot = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile: "unused" },
			{
				readSettingsFile: () => JSON.stringify(autoSettings),
				getBuiltinProviders: () => [],
				getEnvApiKey: () => undefined,
			},
		);
		const autoRegistry = new ConfiguredAgentV2ServerModelRegistry(autoSnapshot);
		expect(autoRegistry.resolve({ provider: "custom-provider:local", id: "qwen" })).toBeUndefined();
		expect(autoSnapshot.customProvider("local")).toBeUndefined();
	});

	it("sanitizes hostile thenables without inspecting their payload", async () => {
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(() => ({
				get then() { throw new Error(`${RAW_PROVIDER_SECRET}:${SECRET_KEY}`); },
			}) as never),
		});
		const error = await caught(execution.generateImplementation(executionInput()));
		expect(error).toMatchObject({ code: "provider_failed" });
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		expect(observable(error)).not.toContain(SECRET_KEY);
	});
	it("resolves custom models only from exact trusted global configuration", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-v2-model-registry-"));
		const settingsFile = join(dir, "settings.json");
		try {
			writeFileSync(
				settingsFile,
				JSON.stringify({
					customProviders: [
						{
							id: "provider-a",
							name: "Display Alias",
							type: "openai-completions",
							baseUrl: "https://trusted-custom.example/v1/",
							apiKey: SECRET_KEY,
							models: [
								{
									id: "custom-model",
									name: "Custom Model",
									api: "openai-completions",
									provider: "custom-provider:provider-a",
									baseUrl: "https://trusted-custom.example/v1",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 16_000,
									maxTokens: 2_000,
								},
							],
						},
					],
				}),
				"utf8",
			);
			const registry = new ConfiguredAgentV2ServerModelRegistry(
				loadAgentV2ServerSettingsSnapshot({ settingsFile }, { getEnvApiKey: () => undefined, getBuiltinProviders: () => [] }),
			);
			const model = registry.resolve({ provider: "custom-provider:provider-a", id: "custom-model" });
			expect(model).toMatchObject({
				id: "custom-model",
				provider: "custom-provider:provider-a",
				api: "openai-completions",
				baseUrl: "https://trusted-custom.example/v1",
				contextWindow: 16_000,
				maxTokens: 2_000,
			});
			expect(JSON.stringify(model)).not.toContain(SECRET_KEY);
			expect(JSON.stringify(model)).not.toContain("https://client.invalid");
			expect(registry.resolve({ provider: "Display Alias", id: "custom-model" })).toBeUndefined();
			expect(registry.resolve({ provider: "provider-a", id: "custom-model" })).toBeUndefined();
			expect(registry.resolve({ provider: "custom-provider:provider-a", id: "missing" })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the exact durable reference and calls PI AI with the trusted canonical model and bounded v2 prompt", async () => {
		const model = trustedModel();
		const complete = vi.fn(async () => assistantMessage(implementationJson()));
		const resolveApiKey = vi.fn(() => SECRET_KEY);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(model),
			resolveApiKey,
			complete,
			maxOutputTokens: 4_000,
		});
		const input = executionInput();

		const envelope = await execution.generateImplementation(input);

		expect(resolveApiKey).toHaveBeenCalledTimes(1);
		expect(resolveApiKey).toHaveBeenCalledWith("trusted-provider");
		expect(complete).toHaveBeenCalledTimes(1);
		const [actualModel, context, options] = complete.mock.calls[0];
		expect(actualModel).toBe(model);
		expect(context.systemPrompt).toContain("Application Generation Agent v2 implementation executor");
		expect(context.messages).toEqual([
			expect.objectContaining({ role: "user", content: expect.stringContaining("Build a safe static app") }),
		]);
		const serializedContext = JSON.stringify(context);
		for (const forbidden of ["legacy prompt", "preview goal continuation", SECRET_KEY, "https://client.invalid"]) {
			expect(serializedContext).not.toContain(forbidden);
		}
		expect(options).toMatchObject({
			apiKey: SECRET_KEY,
			maxTokens: 4_000,
			sessionId: "agent-v2:run-a:task-1",
			maxRetries: 0,
		});
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(options?.onChunk).toEqual(expect.any(Function));
		expect(envelope).toEqual({
			result: { version: 1, taskId: "task-1", summary: "implemented", files: [{ path: "index.html", content: "ok" }] },
			provider: "trusted-provider",
			model: "trusted-model",
			usage: { input: 11, output: 7, totalTokens: 18, costTotal: 0.125 },
		});
		expect(JSON.stringify(envelope)).not.toContain(SECRET_KEY);
	});

	it("aborts idle provider attempts and retries them within the bounded provider budget", async () => {
		const complete = vi.fn(
			async (_model: Model<Api>, _context: unknown, options: { signal?: AbortSignal } | undefined) =>
				await new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() =>
							resolve(
								assistantMessage("", {
									content: [],
									stopReason: "aborted",
									errorMessage: `request aborted ${RAW_PROVIDER_SECRET}`,
								}),
							),
						{ once: true },
					);
				}),
		);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: complete as never,
			streamIdleTimeoutMs: 5,
		});

		const error = await caught(execution.generateImplementation(executionInput()));

		expect(complete).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({
			code: "provider_timeout",
			attempts: 3,
			retryable: true,
			hadObservableOutput: false,
		});
		expect(String(error)).toContain("timed out");
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		expect(observable(error)).not.toContain(SECRET_KEY);
	});

	it("retries one transient no-output provider error and succeeds", async () => {
		const complete = vi
			.fn()
			.mockResolvedValueOnce(
				assistantMessage("", {
					content: [],
					stopReason: "error",
					errorMessage: `fetch failed ${RAW_PROVIDER_SECRET}`,
				}),
			)
			.mockResolvedValueOnce(assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
			streamIdleTimeoutMs: 1_000,
		});

		await expect(execution.generateImplementation(executionInput())).resolves.toMatchObject({
			result: { taskId: "task-1" },
		});
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it.each([
		["429 too many requests", "provider_rate_limit"],
		["503 service unavailable", "provider_server_error"],
	] as const)("retries a safe no-output %s failure within the bounded budget", async (providerMessage, code) => {
		const complete = vi.fn(async () =>
			assistantMessage("", {
				content: [],
				stopReason: "error",
				errorMessage: `${providerMessage} ${RAW_PROVIDER_SECRET}`,
			}),
		);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
		});

		const error = await caught(execution.generateImplementation(executionInput()));

		expect(complete).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({ code, attempts: 3, hadObservableOutput: false });
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
	});

	it.each(["401 unauthorized", "content_filter policy refusal"])(
		"does not retry a non-retryable provider failure: %s",
		async (providerMessage) => {
			const complete = vi.fn(async () =>
				assistantMessage("", {
					content: [],
					stopReason: "error",
					errorMessage: `${providerMessage} ${RAW_PROVIDER_SECRET}`,
				}),
			);
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete,
			});

			const error = await caught(execution.generateImplementation(executionInput()));

			expect(complete).toHaveBeenCalledTimes(1);
			expect(error).toMatchObject({ code: "provider_error" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		},
	);

	it("discards incomplete observable output and safely retries an idle request", async () => {
		const complete = vi.fn(
			async (
				_model: Model<Api>,
				_context: unknown,
				options: { signal?: AbortSignal; onChunk?: () => void } | undefined,
			) => {
				options?.onChunk?.();
				return await new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(assistantMessage("", { content: [], stopReason: "aborted" })),
						{ once: true },
					);
				});
			},
		);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: complete as never,
			streamIdleTimeoutMs: 5,
		});

		const error = await caught(execution.generateImplementation(executionInput()));

		expect(complete).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({
			code: "provider_timeout",
			attempts: 3,
			retryable: true,
			hadObservableOutput: true,
		});
	});

	it("discards partial output and retries a transient provider error", async () => {
		const complete = vi.fn(async () =>
			assistantMessage("", {
				content: [{ type: "text", text: "partial output" }],
				stopReason: "error",
				errorMessage: `network error ${RAW_PROVIDER_SECRET}`,
			}),
		);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
			streamIdleTimeoutMs: 1_000,
		});

		const error = await caught(execution.generateImplementation(executionInput()));

		expect(complete).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({
			code: "provider_network",
			attempts: 3,
			retryable: true,
			hadObservableOutput: true,
		});
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
	});

	it("preserves user cancellation ahead of the idle watchdog without retrying", async () => {
		const controller = new AbortController();
		const complete = vi.fn(
			async (_model: Model<Api>, _context: unknown, options: { signal?: AbortSignal } | undefined) =>
				await new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(assistantMessage("", { content: [], stopReason: "aborted" })),
						{ once: true },
					);
				}),
		);
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: complete as never,
			streamIdleTimeoutMs: 1_000,
		});
		const promise = execution.generateImplementation(executionInput(undefined, controller.signal));

		controller.abort();
		const error = await caught(promise);

		expect(error).toMatchObject({ name: "AbortError" });
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("fails closed for unknown or client-shaped model references before key and completion", async () => {
		const resolve = vi.fn(() => undefined);
		const resolveApiKey = vi.fn(() => SECRET_KEY);
		const complete = vi.fn(async () => assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({ modelRegistry: { resolve }, resolveApiKey, complete });

		await expect(execution.generateImplementation(executionInput({ provider: "missing", id: "model" }))).rejects.toMatchObject({
			code: "unknown_model",
		});
		await expect(
			execution.generateImplementation(
				executionInput({
					provider: "trusted-provider",
					id: "trusted-model",
					api: "evil-api",
					baseUrl: "https://client.invalid",
					headers: { authorization: RAW_PROVIDER_SECRET },
				}),
			),
		).rejects.toMatchObject({ code: "invalid_model_reference" });
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolveApiKey).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails with a stable missing-key error before completion", async () => {
		const complete = vi.fn(async () => assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: (...args: string[]) => {
				expect(args).toEqual(["trusted-provider"]);
				return "   ";
			},
			complete,
		});

		await expect(execution.generateImplementation(executionInput())).rejects.toMatchObject({ code: "missing_api_key" });
		expect(complete).not.toHaveBeenCalled();
	});

	it("uses the strict repair parser and rejects malformed output without exposing provider data", async () => {
		const input = repairExecutionInput();
		const complete = vi.fn(async () => assistantMessage(repairJson()));
		const valid = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
		});
		await expect(valid.generateRepair(input)).resolves.toMatchObject({
			result: {
				taskId: "repair:validate:1",
				addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
			},
		});
		const repairContext = complete.mock.calls[0]?.[1];
		expect(repairContext?.systemPrompt).toContain("Application Generation Agent v2 repair executor");
		expect(repairContext?.messages[0]?.content).toContain("PI_REPAIR_WORKSPACE_SENTINEL");
		expect(repairContext?.messages[0]?.content).toContain("static.loading_visible");
		expect(JSON.stringify(repairContext)).not.toContain("RAW_VALIDATOR_MESSAGE");

		const invalid = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => assistantMessage(`{"taskId":"task-1","secret":"${RAW_PROVIDER_SECRET}"}`)),
		});
		const error = await caught(invalid.generateImplementation(executionInput()));
		expect(error).toMatchObject({ name: "AgentV2ModelContractError" });
		expect(observable(error)).not.toContain(SECRET_KEY);
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
	});

	it("recovers when a repair response makes no effective file change", async () => {
		const input = repairExecutionInput();
		const unchanged = JSON.stringify({
			version: 1,
			taskId: "repair:validate:1",
			summary: "unchanged",
			files: [{ path: "index.html", content: input.workspaceFiles[0]?.content }],
			addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
		});
		const complete = vi
			.fn()
			.mockResolvedValueOnce(assistantMessage(unchanged))
			.mockResolvedValueOnce(assistantMessage(repairJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete,
		});

		await expect(execution.generateRepair(input)).resolves.toMatchObject({
			result: { files: [{ path: "index.html", content: "fixed" }] },
		});
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[1]?.[1]?.systemPrompt).toContain("PROTOCOL RECOVERY");
	});

	it("rejects tool-only, mixed tool, missing-text, response identity and non-stop results", async () => {
		const cases: Array<[Partial<AssistantMessage>, string]> = [
			[{ content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: {} }] }, "invalid_provider_content"],
			[
				{ content: [{ type: "text", text: implementationJson() }, { type: "toolCall", id: "tool-1", name: "write", arguments: {} }] },
				"invalid_provider_content",
			],
			[{ content: [{ type: "thinking", thinking: "secret reasoning" }] }, "invalid_provider_content"],
			[{ provider: "response-override" }, "provider_identity_mismatch"],
			[{ stopReason: "length" }, "provider_length"],
			[{ stopReason: "toolUse" }, "provider_tool_use"],
			[{ stopReason: "error", errorMessage: RAW_PROVIDER_SECRET }, "provider_error"],
		];
		for (const [override, code] of cases) {
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(async () => assistantMessage(implementationJson(), override)),
			});
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error).toMatchObject({ code });
			expect(observable(error)).not.toContain(SECRET_KEY);
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		}
	});

	it("collects final text blocks and rejects non-finite or negative usage", async () => {
		const message = assistantMessage("", {
			content: [
				{ type: "thinking", thinking: "ignored" },
				{ type: "text", text: implementationJson().slice(0, 20) },
				{ type: "text", text: implementationJson().slice(20) },
			],
			usage: {
				input: Number.NaN,
				output: -1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Number.POSITIVE_INFINITY,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 },
			},
		});
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => message),
		});

		await expect(execution.generateImplementation(executionInput())).rejects.toMatchObject({
			code: "invalid_provider_content",
		});
	});

	it("preserves already-aborted and in-flight abort semantics with sanitized errors", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort(new Error(RAW_PROVIDER_SECRET));
		const neverCalled = vi.fn(async () => assistantMessage(implementationJson()));
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: neverCalled,
		});
		const first = await caught(execution.generateImplementation(executionInput(undefined, alreadyAborted.signal)));
		expect(first).toMatchObject({ name: "AbortError" });
		expect(observable(first)).not.toContain(RAW_PROVIDER_SECRET);
		expect(neverCalled).not.toHaveBeenCalled();

		const controller = new AbortController();
		const inFlight = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(
				async (_model, _context, options) =>
					await new Promise<AssistantMessage>((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(new Error(RAW_PROVIDER_SECRET)), { once: true });
					}),
			),
		});
		const promise = inFlight.generateImplementation(executionInput(undefined, controller.signal));
		controller.abort(new Error(RAW_PROVIDER_SECRET));
		const second = await caught(promise);
		expect(second).toMatchObject({ name: "AbortError" });
		expect(observable(second)).not.toContain(RAW_PROVIDER_SECRET);

		const providerAborted = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => assistantMessage("", { content: [], stopReason: "aborted", errorMessage: RAW_PROVIDER_SECRET })),
		});
		const third = await caught(providerAborted.generateImplementation(executionInput()));
		expect(third).toMatchObject({ name: "AbortError" });
		expect(observable(third)).not.toContain(RAW_PROVIDER_SECRET);
	});

	it("sanitizes provider rejections and never serializes the key or raw payload", async () => {
		const execution = new AgentV2PiModelExecution({
			modelRegistry: registry(trustedModel()),
			resolveApiKey: () => SECRET_KEY,
			complete: vi.fn(async () => {
				throw { message: RAW_PROVIDER_SECRET, apiKey: SECRET_KEY, body: { authorization: SECRET_KEY } };
			}),
		});
		const error = await caught(execution.generateImplementation(executionInput()));
		expect(error).toBeInstanceOf(AgentV2PiModelExecutionError);
		expect(error).toMatchObject({ code: "provider_failed" });
		expect(observable(error)).not.toContain(SECRET_KEY);
		expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
	});

	it("sanitizes authentication and completion abort-lookalike failures without inspecting hostile errors", async () => {
		const resolveApiKey = vi.fn(() => SECRET_KEY);
		const complete = vi.fn(async () => assistantMessage(implementationJson()));
		for (const resolveAuthentication of [
			() => {
				throw new Error(RAW_PROVIDER_SECRET);
			},
			() => "unsupported-auth" as never,
		]) {
			const execution = new AgentV2PiModelExecution({
				modelRegistry: { resolve: () => trustedModel(), resolveAuthentication },
				resolveApiKey,
				complete,
			});
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error).toMatchObject({ code: "provider_failed" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		}
		expect(resolveApiKey).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();

		let nameReads = 0;
		const hostile = new Error("opaque");
		Object.defineProperty(hostile, "name", {
			get: () => {
				nameReads += 1;
				throw new Error(RAW_PROVIDER_SECRET);
			},
		});
		for (const rejection of [hostile, Object.assign(new Error("opaque"), { name: "AbortError" })]) {
			const execution = new AgentV2PiModelExecution({
				modelRegistry: registry(trustedModel()),
				resolveApiKey: () => SECRET_KEY,
				complete: vi.fn(async () => {
					throw rejection;
				}),
			});
			const error = await caught(execution.generateImplementation(executionInput()));
			expect(error).toMatchObject({ code: "provider_failed" });
			expect(observable(error)).not.toContain(RAW_PROVIDER_SECRET);
		}
		expect(nameReads).toBe(0);
	});
});

function registry(
	model: Model<Api>,
	authentication: "required" | "ambient-or-key" | "trusted-local-optional" = "required",
): AgentV2ServerModelRegistry {
	return {
		resolve: (reference) => (reference.provider === model.provider && reference.id === model.id ? model : undefined),
		resolveAuthentication: () => authentication,
	};
}

function customSettings(baseUrl: string, apiKey: string) {
	return {
		customProviders: [
			{
				id: "provider-a",
				name: "Provider A",
				type: "openai-completions",
				baseUrl,
				apiKey,
				models: [
					{
						id: "custom-model",
						name: "Custom Model",
						api: "openai-completions",
						provider: "custom-provider:provider-a",
						baseUrl,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16_000,
						maxTokens: 2_000,
					},
				],
			},
		],
	};
}

function trustedModel(): Model<Api> {
	return {
		id: "trusted-model",
		name: "Trusted Model",
		api: "openai-completions",
		provider: "trusted-provider",
		baseUrl: "https://trusted.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 8_000,
		headers: { "x-trusted": "server" },
	};
}

function assistantMessage(text: string, override: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "trusted-provider",
		model: "trusted-model",
		usage: {
			input: 11,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 18,
			cost: { input: 0.025, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.125 },
		},
		stopReason: "stop",
		timestamp: 1,
		...override,
	};
}

function implementationJson(): string {
	return JSON.stringify({
		version: 1,
		taskId: "task-1",
		summary: "implemented",
		files: [{ path: "index.html", content: "ok" }],
	});
}

function repairJson(): string {
	return JSON.stringify({
		version: 1,
		taskId: "repair:validate:1",
		summary: "repaired",
		files: [{ path: "index.html", content: "fixed" }],
		addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
	});
}

function repairExecutionInput(): AgentV2RepairModelExecutionInput {
	const base = executionInput();
	const content = "<!doctype html><main>PI_REPAIR_WORKSPACE_SENTINEL</main>";
	const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
	const task: AgentV2TaskNode = {
		taskId: "repair:validate:1",
		parentTaskId: "validate",
		kind: "repair",
		title: "Repair validation attempt 1",
		status: "ready",
		dependsOn: ["validate"],
		acceptanceCriteria: ["repair"],
		input: {
			baseValidationTaskId: "validate",
			failedValidationTaskId: "validate",
			validationId: "static:validate",
			validationAttempt: 1,
			diagnosticIds: ["agent_v2.validation_failed:validate:1"],
		},
		output: {},
		createdAt: base.run.createdAt,
		updatedAt: base.run.updatedAt,
	};
	const artifact = {
		clientId: base.run.clientId,
		runId: base.run.runId,
		artifactId: "file:index.html",
		kind: "source",
		path: "index.html",
		mediaType: "text/html",
		checksum,
		version: checksum,
		sourceTaskId: "implement",
		validationStatus: "failed",
		metadataJson: {},
		createdAt: base.run.createdAt,
		updatedAt: base.run.updatedAt,
	};
	return {
		...base,
		task,
		contextPacket: {
			...base.contextPacket,
			taskSelection: { task, reason: "running", blockedTaskIds: [], failedDependencyTaskIds: [] },
			activeTask: task,
			artifactIndex: {
				artifacts: [artifact],
				latestByPath: new Map([[artifact.path, artifact]]),
				pendingValidation: [artifact],
			},
			activeTaskArtifacts: [],
			openProblems: [],
		},
		diagnostics: [repairDiagnostic()],
		workspaceFiles: [
			{
				artifactId: artifact.artifactId,
				path: artifact.path,
				mediaType: artifact.mediaType,
				checksum,
				byteLength: Buffer.byteLength(content, "utf8"),
				content,
			},
		],
	};
}

function executionInput(model: unknown = { provider: "trusted-provider", id: "trusted-model" }, signal?: AbortSignal): AgentV2ModelExecutionInput {
	const run: AgentV2RunSnapshot = {
		clientId: "client-a",
		runId: "run-a",
		status: "running",
		phase: "implementation",
		attempt: 1,
		input: { objective: "Build a safe static app", prompt: "legacy prompt", previewGoal: "preview goal continuation" },
		model,
		createdAt: "2026-07-10T00:00:00.000Z",
		updatedAt: "2026-07-10T00:00:00.000Z",
	};
	const task: AgentV2TaskNode = {
		taskId: "task-1",
		kind: "implementation",
		title: "Create app",
		status: "running",
		dependsOn: [],
		acceptanceCriteria: ["safe"],
		input: {},
		output: {},
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
	const contextPacket: AgentV2ContextPacket = {
		run,
		taskSelection: { task, reason: "running", blockedTaskIds: [], failedDependencyTaskIds: [] },
		activeTask: task,
		documents: {},
		artifactIndex: { artifacts: [], latestByPath: new Map(), pendingValidation: [] },
		activeTaskArtifacts: [],
		openProblems: [],
		requiredRereads: [],
		markdown: "unused",
	};
	return { run, task, contextPacket, inputs: [], signal: signal ?? new AbortController().signal };
}

function repairDiagnostic(): AgentV2DiagnosticEvent {
	return {
		diagnosticId: "agent_v2.validation_failed:validate:1",
		clientId: "client-a",
		runId: "run-a",
		severity: "error",
		category: "validation",
		code: "agent_v2.validation_failed",
		phase: "validation",
		taskId: "validate",
		message: "RAW_VALIDATOR_MESSAGE",
		data: {
			validationId: "static:validate",
			attempt: 1,
			failureCount: 1,
			retryableFailureCount: 1,
			failureCodes: ["static.loading_visible"],
		},
		createdAt: "2026-07-10T00:00:00.000Z",
	};
}

async function caught(promise: Promise<unknown>): Promise<Error & { code?: string }> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (error) {
		return error as Error & { code?: string };
	}
}

function observable(error: unknown): string {
	return `${String(error)}\n${JSON.stringify(error)}\n${error instanceof Error ? error.stack ?? "" : ""}`;
}
