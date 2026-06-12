import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServerProviderApiKey } from "../src/worker/provider-keys.js";

describe("worker provider keys", () => {
	let rootDir = "";
	let settingsFile = "";

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "pi-worker-provider-keys-"));
		mkdirSync(rootDir, { recursive: true });
		settingsFile = join(rootDir, "settings.json");
	});

	afterEach(() => {
		if (rootDir) rmSync(rootDir, { recursive: true, force: true });
	});

	it("reads direct provider keys from server settings", () => {
		writeSettings({ providerKeys: { mimo: "mimo-key" } });

		expect(readServerProviderApiKey({ settingsFile }, "mimo")).toBe("mimo-key");
	});

	it("falls back to custom provider apiKey from server settings", () => {
		writeSettings({
			customProviders: [
				{
					name: "mimo",
					apiKey: "custom-mimo-key",
				},
			],
		});

		expect(readServerProviderApiKey({ settingsFile }, "mimo")).toBe("custom-mimo-key");
	});

	it("uses stable custom provider identity when duplicate names exist", () => {
		const firstProvider = {
			id: "provider-a",
			name: "mimo",
			apiKey: "first-key",
		};
		const secondProvider = {
			id: "provider-b",
			name: "mimo",
			apiKey: "second-key",
		};
		writeSettings({ customProviders: [firstProvider, secondProvider] });

		expect(readServerProviderApiKey({ settingsFile }, "custom-provider:provider-b")).toBe("second-key");
	});

	it("prefers global provider settings over legacy client-scoped provider settings", () => {
		writeSettings({
			customProviders: [
				{
					id: "provider-a",
					name: "mimo",
					apiKey: "global-key",
				},
			],
		});
		writeClientSettings("client-a", {
			customProviders: [
				{
					id: "provider-a",
					name: "mimo",
					apiKey: "client-key",
				},
			],
		});

		expect(readServerProviderApiKey({ settingsFile }, "custom-provider:provider-a", "client-a")).toBe("global-key");
	});

	it("falls back to legacy client-scoped provider settings during migration", () => {
		writeSettings({ providerKeys: { openai: "openai-key" } });
		writeClientSettings("client-a", {
			customProviders: [
				{
					id: "provider-a",
					name: "mimo",
					apiKey: "client-key",
				},
			],
		});

		expect(readServerProviderApiKey({ settingsFile }, "custom-provider:provider-a", "client-a")).toBe("client-key");
	});

	it("returns undefined when settings do not contain the provider", () => {
		writeSettings({ providerKeys: { openai: "openai-key" } });

		expect(readServerProviderApiKey({ settingsFile }, "mimo")).toBeUndefined();
	});

	function writeSettings(settings: Record<string, unknown>): void {
		writeFileSync(settingsFile, JSON.stringify(settings), "utf8");
	}

	function writeClientSettings(clientId: string, settings: Record<string, unknown>): void {
		const clientDir = join(rootDir, "clients", clientId);
		mkdirSync(clientDir, { recursive: true });
		writeFileSync(join(clientDir, "settings.json"), JSON.stringify(settings), "utf8");
	}
});
