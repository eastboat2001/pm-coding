import type { StorageBackend } from "@mariozechner/pi-web-ui";
import { beforeAll, describe, expect, it } from "vitest";

let ServerBackedCustomProvidersStore: typeof import("../src/storage/server-backed-custom-providers-store.js").ServerBackedCustomProvidersStore;

const localProvider = {
	id: "local-vllm",
	name: "Local vLLM",
	type: "vllm",
	baseUrl: "http://localhost:8000",
	apiKey: "test-key",
} as const;

describe("ServerBackedCustomProvidersStore", () => {
	beforeAll(async () => {
		class TestDOMMatrix {}
		class TestImageData {}
		class TestPath2D {}
		Object.assign(globalThis, {
			DOMMatrix: TestDOMMatrix,
			ImageData: TestImageData,
			Path2D: TestPath2D,
		});
		({ ServerBackedCustomProvidersStore } = await import("../src/storage/server-backed-custom-providers-store.js"));
	});

	it("treats an empty server customProviders array as authoritative over legacy browser providers", async () => {
		const writes: unknown[] = [];
		const store = new ServerBackedCustomProvidersStore({
			readSettings: async () => ({ customProviders: [] }),
			writeSettings: async (settings: unknown) => {
				writes.push(settings);
				return true;
			},
		} as any);
		store.setBackend(createMemoryBackend([localProvider]));

		const providers = await store.getAll();

		expect(providers).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("does not merge legacy browser providers into an explicit server write", async () => {
		const newProvider = {
			id: "manual-openai",
			name: "Manual OpenAI",
			type: "openai-completions",
			baseUrl: "https://example.test/v1",
			models: [],
		} as const;
		const writes: unknown[] = [];
		const store = new ServerBackedCustomProvidersStore({
			readSettings: async () => ({ customProviders: [] }),
			writeSettings: async (settings: unknown) => {
				writes.push(settings);
				return true;
			},
		} as any);
		store.setBackend(createMemoryBackend([localProvider]));

		await store.set(newProvider);

		expect(writes).toEqual([{ customProviders: [newProvider] }]);
	});

	it("repairs stale manual model provider identities before returning server providers", async () => {
		const staleProvider = {
			id: "manual-mimo",
			name: "mimo",
			type: "openai-completions",
			baseUrl: "https://example.test/v1",
			models: [
				{
					id: "mimo-v2.5",
					name: "mimo-v2.5",
					api: "openai-completions",
					provider: "mimo",
					baseUrl: "https://example.test/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		} as const;
		const writes: unknown[] = [];
		const store = new ServerBackedCustomProvidersStore({
			readSettings: async () => ({ customProviders: [staleProvider] }),
			writeSettings: async (settings: unknown) => {
				writes.push(settings);
				return true;
			},
		} as any);
		store.setBackend(createMemoryBackend([]));

		const providers = await store.getAll();

		expect(providers[0]?.models?.[0]?.provider).toBe("custom-provider:manual-mimo");
		expect(writes).toEqual([
			{
				customProviders: [
					expect.objectContaining({
						id: "manual-mimo",
						models: [expect.objectContaining({ provider: "custom-provider:manual-mimo" })],
					}),
				],
			},
		]);
	});
});

function createMemoryBackend(providers: Array<typeof localProvider>): StorageBackend {
	const stores = new Map<string, Map<string, unknown>>();
	const customProviders = new Map<string, unknown>();
	for (const provider of providers) customProviders.set(provider.id, provider);
	stores.set("custom-providers", customProviders);

	const getStore = (name: string) => {
		let store = stores.get(name);
		if (!store) {
			store = new Map();
			stores.set(name, store);
		}
		return store;
	};

	return {
		async get(storeName, key) {
			return (getStore(storeName).get(key) as never) ?? null;
		},
		async set(storeName, key, value) {
			getStore(storeName).set(key, value);
		},
		async delete(storeName, key) {
			getStore(storeName).delete(key);
		},
		async keys(storeName) {
			return [...getStore(storeName).keys()];
		},
		async getAllFromIndex() {
			return [];
		},
		async clear(storeName) {
			getStore(storeName).clear();
		},
		async has(storeName, key) {
			return getStore(storeName).has(key);
		},
		async transaction(_storeNames, _mode, operation) {
			return await operation(this);
		},
		async getQuotaInfo() {
			return { usage: 0, quota: 0, percent: 0 };
		},
		async requestPersistence() {
			return true;
		},
	};
}
