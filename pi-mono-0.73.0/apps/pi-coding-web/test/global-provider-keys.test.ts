import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGlobalProviderApiKeyResolver,
	loadAgentV2ServerSettingsSnapshot,
	readGlobalProviderApiKey,
} from "../src/worker/global-provider-keys.js";

import * as globalProviderKeys from "../src/worker/global-provider-keys.js";

describe("global provider keys", () => {
	let dir = "";
	let settingsFile = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-global-keys-"));
		settingsFile = join(dir, "settings.json");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("prefers an exact global provider key and exposes a provider-only resolver", () => {
		write({ providerKeys: { openai: "  global-key  " } });
		const env = vi.fn(() => "env-key");
		const resolve = createGlobalProviderApiKeyResolver({ settingsFile }, { getEnvApiKey: env });

		expect(resolve.length).toBe(1);
		expect(resolve("openai")).toBe("global-key");
		expect(env).not.toHaveBeenCalledWith("openai");
	});

	it("falls back only to PI AI's standard environment resolver", () => {
		const env = vi.fn((provider: string) => (provider === "anthropic" ? "env-key" : undefined));
		expect(readGlobalProviderApiKey({ settingsFile }, "anthropic", { getEnvApiKey: env })).toBe("env-key");
		expect(env).toHaveBeenCalledWith("anthropic");
	});

	it("supports exact custom global provider identities", () => {
		write({
			customProviders: [
				{
					id: "provider-a",
					name: "display",
					type: "openai-completions",
					baseUrl: "https://provider-a.invalid/v1",
					apiKey: "custom-key",
					models: [],
				},
			],
		});
		expect(
			readGlobalProviderApiKey({ settingsFile }, "custom-provider:provider-a", { getEnvApiKey: () => undefined }),
		).toBe("custom-key");
		expect(readGlobalProviderApiKey({ settingsFile }, "display", { getEnvApiKey: () => undefined })).toBeUndefined();
	});

	it("fails closed for malformed settings, empty values and placeholders", () => {
		writeFileSync(settingsFile, "{broken", "utf8");
		expect(readGlobalProviderApiKey({ settingsFile }, "openai", { getEnvApiKey: () => undefined })).toBeUndefined();
		for (const value of ["", "   ", "YOUR_API_KEY", "<api-key>", "change-me"]) {
			write({ providerKeys: { openai: value } });
			expect(readGlobalProviderApiKey({ settingsFile }, "openai", { getEnvApiKey: () => undefined })).toBeUndefined();
		}
	});

	it("never reads a client-scoped settings fallback", () => {
		const clientDir = join(dir, "clients", "client-a");
		mkdirSync(clientDir, { recursive: true });
		writeFileSync(join(clientDir, "settings.json"), JSON.stringify({ providerKeys: { openai: "client-key" } }), "utf8");
		expect(readGlobalProviderApiKey({ settingsFile }, "openai", { getEnvApiKey: () => undefined })).toBeUndefined();
	});

	it("reads bounded settings exactly once and pins configured and environment credentials", () => {
		write({ providerKeys: { openai: "old-key" } });
		const readSettingsFile = vi.fn(() => JSON.stringify({ providerKeys: { openai: "old-key" } }));
		const env = vi.fn((provider: string) => (provider === "anthropic" ? "old-env" : undefined));
		const snapshot = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{ readSettingsFile, getEnvApiKey: env, getBuiltinProviders: () => ["openai", "anthropic"] },
		);
		const resolve = createGlobalProviderApiKeyResolver(snapshot);
		readSettingsFile.mockReturnValue(JSON.stringify({ providerKeys: { openai: "new-key" } }));
		env.mockReturnValue("new-env");
		expect(resolve("openai")).toBe("old-key");
		expect(resolve("anthropic")).toBe("old-env");
		expect(readSettingsFile).toHaveBeenCalledTimes(1);
		expect(env).toHaveBeenCalledTimes(1);
	});

	it("preserves only official ambient markers and rejects oversized settings", () => {
		const ambient = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{
				readSettingsFile: () => "{}",
				getBuiltinProviders: () => ["google-vertex", "amazon-bedrock", "openai"],
				getEnvApiKey: () => "<authenticated>",
			},
		);
		const resolveAmbient = createGlobalProviderApiKeyResolver(ambient);
		expect(resolveAmbient("google-vertex")).toBe("<authenticated>");
		expect(resolveAmbient("amazon-bedrock")).toBe("<authenticated>");
		expect(resolveAmbient("openai")).toBeUndefined();

		const oversized = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{ readSettingsFile: () => "x".repeat(1_048_577), getBuiltinProviders: () => [], getEnvApiKey: () => undefined },
		);
		expect(createGlobalProviderApiKeyResolver(oversized)("openai")).toBeUndefined();

		writeFileSync(settingsFile, "x".repeat(1_048_577), "utf8");
		const oversizedFile = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{ getBuiltinProviders: () => [], getEnvApiKey: () => undefined },
		);
		expect(createGlobalProviderApiKeyResolver(oversizedFile)("openai")).toBeUndefined();
	});

	it("fails closed when a custom identity or credential source is not unique", () => {
		const duplicate = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{
				readSettingsFile: () =>
					JSON.stringify({
						customProviders: [
							{ id: "duplicate", name: "Endpoint A", type: "openai-completions", baseUrl: "https://endpoint-a.invalid", models: [] },
							{ id: "duplicate", name: "Endpoint B", type: "openai-completions", baseUrl: "https://endpoint-b.invalid", apiKey: "key-b", models: [] },
						],
					}),
				getBuiltinProviders: () => [],
				getEnvApiKey: () => undefined,
			},
		);
		expect(duplicate.customProvider("duplicate")).toBeUndefined();
		expect(duplicate.resolveApiKey("custom-provider:duplicate")).toBeUndefined();

		for (const rootKey of ["root-key", "same-key"]) {
			const conflict = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile },
				{
					readSettingsFile: () =>
						JSON.stringify({
							providerKeys: { "custom-provider:provider-a": rootKey },
							customProviders: [
								{ id: "provider-a", name: "Provider A", type: "openai-completions", baseUrl: "https://endpoint-a.invalid", apiKey: "same-key", models: [] },
							],
						}),
					getBuiltinProviders: () => [],
					getEnvApiKey: () => undefined,
				},
			);
			expect(conflict.customProvider("provider-a")).toBeUndefined();
			expect(conflict.resolveApiKey("custom-provider:provider-a")).toBeUndefined();
		}
	});

	it("fails closed when a manual provider contains any duplicate model id", () => {
		const model = {
			id: "duplicate@revision",
			name: "Duplicate",
			provider: "custom-provider:provider-a",
			api: "openai-completions",
			baseUrl: "https://provider-a.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 2_000,
		};
		for (const second of [{ ...model }, { ...model, maxTokens: 999 }]) {
			const snapshot = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile },
				{
					readSettingsFile: () =>
						JSON.stringify({
							customProviders: [
								{
									id: "provider-a",
									name: "Provider A",
									type: "openai-completions",
									baseUrl: "https://provider-a.invalid/v1",
									models: [model, second],
								},
							],
						}),
					getBuiltinProviders: () => [],
					getEnvApiKey: () => undefined,
				},
			);
			expect(snapshot.customProvider("provider-a")).toBeUndefined();
			expect(snapshot.resolveApiKey("custom-provider:provider-a")).toBeUndefined();
		}
	});

	it("exposes snapshots only as a non-forgeable type boundary", async () => {
		expect(Object.hasOwn(globalProviderKeys, "AgentV2ServerSettingsSnapshot")).toBe(false);
		const legitimate = loadAgentV2ServerSettingsSnapshot(
			{ settingsFile },
			{ readSettingsFile: () => "{}", getBuiltinProviders: () => [], getEnvApiKey: () => undefined },
		);
		const ReflectedSnapshotConstructor = Object.getPrototypeOf(legitimate).constructor as new (
			input: unknown,
		) => unknown;
		expect(
			() =>
				new ReflectedSnapshotConstructor({
					providerKeys: new Map([["openai", "forged-secret"]]),
					customProviders: new Map(),
				}),
		).toThrow();
		const forgedResolve = vi.fn(() => "forged-secret");
		const forged = {
			settingsFile,
			resolveApiKey: forgedResolve,
			customProvider: () => undefined,
			selectedModel: () => undefined,
		};
		const readSettingsFile = vi.fn(() => JSON.stringify({ providerKeys: { openai: "trusted-key" } }));
		const resolve = createGlobalProviderApiKeyResolver(forged as never, {
			readSettingsFile,
			getBuiltinProviders: () => [],
			getEnvApiKey: () => undefined,
		});
		expect(resolve("openai")).toBe("trusted-key");
		expect(forgedResolve).not.toHaveBeenCalled();
		expect(readSettingsFile).toHaveBeenCalledTimes(1);
	});

	it("rejects prototype keys and unknown custom provider fields at the snapshot boundary", () => {
		const hostileSources = [
			'{"customProviders":[{"id":"poison","name":"Poison","__proto__":{"type":"openai-completions","baseUrl":"https://evil.invalid","models":[]}}]}',
			'{"customProviders":[{"id":"poison","name":"Poison","type":"openai-completions","baseUrl":"https://safe.invalid","models":[],"constructor":"evil"}]}',
			'{"customProviders":[{"id":"poison","name":"Poison","type":"openai-completions","baseUrl":"https://safe.invalid","models":[],"prototype":{}}]}',
			'{"customProviders":[{"id":"poison","name":"Poison","type":"openai-completions","baseUrl":"https://safe.invalid","models":[],"authorization":"secret"}]}',
		];
		for (const source of hostileSources) {
			const snapshot = loadAgentV2ServerSettingsSnapshot(
				{ settingsFile },
				{ readSettingsFile: () => source, getBuiltinProviders: () => [], getEnvApiKey: () => undefined },
			);
			expect(snapshot.customProvider("poison")).toBeUndefined();
			expect(snapshot.resolveApiKey("custom-provider:poison")).toBeUndefined();
		}
	});

	function write(value: unknown): void {
		writeFileSync(settingsFile, JSON.stringify(value), "utf8");
	}
});
