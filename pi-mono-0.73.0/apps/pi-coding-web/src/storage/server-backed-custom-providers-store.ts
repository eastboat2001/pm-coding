import { type CustomProvider, CustomProvidersStore } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "./configured-server-storage.js";

type ServerCustomProvidersState = {
	providers: CustomProvider[];
};

const LOCAL_CACHE_TIMEOUT_MS = 1500;

export class ServerBackedCustomProvidersStore extends CustomProvidersStore {
	constructor(private readonly configuredStorage: ConfiguredServerStorage) {
		super();
	}

	override async get(id: string): Promise<CustomProvider | null> {
		const serverState = await this.readServerCustomProviders();
		const provider = serverState.providers.find((item) => item.id === id) ?? null;
		if (provider) void this.writeLocalProvider(provider);
		else void this.deleteLocalProvider(id);
		return provider;
	}

	override async set(provider: CustomProvider): Promise<void> {
		const serverState = await this.readServerCustomProviders();
		const wroteServer = await this.writeServerProviders(upsertProvider(serverState.providers, provider));
		if (!wroteServer) throw new Error("Failed to synchronize provider settings with the PI server.");
		void this.writeLocalProvider(provider);
	}

	override async delete(id: string): Promise<void> {
		const serverState = await this.readServerCustomProviders();
		const wroteServer = await this.writeServerProviders(
			serverState.providers.filter((provider) => provider.id !== id),
		);
		if (!wroteServer) throw new Error("Failed to synchronize provider deletion with the PI server.");
		void this.deleteLocalProvider(id);
	}

	override async getAll(): Promise<CustomProvider[]> {
		const serverState = await this.readServerCustomProviders();
		void this.replaceLocalProviders(serverState.providers);
		return serverState.providers;
	}

	override async has(id: string): Promise<boolean> {
		return (await this.get(id)) !== null;
	}

	private async readServerCustomProviders(): Promise<ServerCustomProvidersState> {
		const settings = await this.configuredStorage.readSettings();
		const rawProviders = settings?.customProviders;
		const providers = Array.isArray(rawProviders) ? rawProviders.filter(isCustomProvider) : [];
		const normalizedProviders = providers.map(normalizeCustomProviderModelIdentities);
		if (normalizedProviders.some((provider, index) => provider !== providers[index])) {
			const wroteServer = await this.writeServerProviders(normalizedProviders);
			if (!wroteServer) throw new Error("Failed to synchronize normalized provider settings with the PI server.");
		}
		return {
			providers: normalizedProviders,
		};
	}

	private async writeServerProviders(providers: CustomProvider[]): Promise<boolean> {
		return await this.configuredStorage.writeSettings({
			customProviders: providers.map(normalizeCustomProviderModelIdentities),
		});
	}

	private async readLocalProviders(): Promise<CustomProvider[]> {
		return await withTimeout(this.readLocalProvidersFromBackend(), LOCAL_CACHE_TIMEOUT_MS, []);
	}

	private async readLocalProvidersFromBackend(): Promise<CustomProvider[]> {
		const backend = this.getBackend();
		const storeName = this.getConfig().name;
		const providers: CustomProvider[] = [];
		for (const key of await backend.keys(storeName)) {
			const provider = await backend.get<CustomProvider>(storeName, key);
			if (provider) providers.push(provider);
		}
		return providers;
	}

	private async replaceLocalProviders(providers: CustomProvider[]): Promise<void> {
		const localProviders = await this.readLocalProviders();
		const serverIds = new Set(providers.map((provider) => provider.id));
		for (const provider of providers) {
			await this.writeLocalProvider(provider);
		}
		for (const provider of localProviders) {
			if (!serverIds.has(provider.id)) {
				await this.deleteLocalProvider(provider.id);
			}
		}
	}

	private async writeLocalProvider(provider: CustomProvider): Promise<boolean> {
		return await withTimeout(
			super.set(provider).then(() => true),
			LOCAL_CACHE_TIMEOUT_MS,
			false,
		);
	}

	private async deleteLocalProvider(id: string): Promise<boolean> {
		return await withTimeout(
			super.delete(id).then(() => true),
			LOCAL_CACHE_TIMEOUT_MS,
			false,
		);
	}
}

function upsertProvider(providers: CustomProvider[], provider: CustomProvider): CustomProvider[] {
	const nextProviders = providers.filter((item) => item.id !== provider.id);
	nextProviders.push(provider);
	return nextProviders;
}

function isCustomProvider(value: unknown): value is CustomProvider {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<CustomProvider>;
	return (
		typeof item.id === "string" &&
		typeof item.name === "string" &&
		typeof item.type === "string" &&
		typeof item.baseUrl === "string"
	);
}

function normalizeCustomProviderModelIdentities(provider: CustomProvider): CustomProvider {
	if (!Array.isArray(provider.models)) return provider;
	const identity = `custom-provider:${provider.id}`;
	let changed = false;
	const models = provider.models.map((model) => {
		if (model.provider === identity) return model;
		if (model.provider !== provider.id && model.provider !== provider.name) return model;
		changed = true;
		return { ...model, provider: identity };
	});
	return changed ? { ...provider, models } : provider;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
			}),
		]);
	} catch {
		return fallback;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
