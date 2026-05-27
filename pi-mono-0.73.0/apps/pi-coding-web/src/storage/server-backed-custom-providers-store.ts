import { type CustomProvider, CustomProvidersStore } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "./configured-server-storage.js";

type ServerCustomProvidersState = {
	hasCustomProviders: boolean;
	providers: CustomProvider[];
};

const LOCAL_CACHE_TIMEOUT_MS = 1500;

export class ServerBackedCustomProvidersStore extends CustomProvidersStore {
	constructor(private readonly configuredStorage: ConfiguredServerStorage) {
		super();
	}

	override async get(id: string): Promise<CustomProvider | null> {
		const serverState = await this.readServerCustomProviders();
		if (serverState.hasCustomProviders && serverState.providers.length > 0) {
			const provider = serverState.providers.find((item) => item.id === id) ?? null;
			if (provider) {
				void this.writeLocalProvider(provider);
			} else {
				void this.deleteLocalProvider(id);
			}
			return provider;
		}

		const localProvider = await this.readLocalProvider(id);
		if (localProvider) {
			await this.writeServerProviders(await this.readLocalProviders());
		}
		return localProvider;
	}

	override async set(provider: CustomProvider): Promise<void> {
		const serverState = await this.readServerCustomProviders();
		const providers = await this.readProvidersForWrite(serverState);
		const wroteServer = await this.writeServerProviders(upsertProvider(providers, provider));
		if (wroteServer) {
			void this.writeLocalProvider(provider);
			return;
		}
		const wroteLocal = await this.writeLocalProvider(provider);
		if (!wroteLocal) throw new Error("Failed to save provider settings.");
	}

	override async delete(id: string): Promise<void> {
		const serverState = await this.readServerCustomProviders();
		const providers = await this.readProvidersForWrite(serverState);
		const wroteServer = await this.writeServerProviders(providers.filter((provider) => provider.id !== id));
		if (wroteServer) {
			void this.deleteLocalProvider(id);
			return;
		}
		const wroteLocal = await this.deleteLocalProvider(id);
		if (!wroteLocal) throw new Error("Failed to delete provider settings.");
	}

	override async getAll(): Promise<CustomProvider[]> {
		const serverState = await this.readServerCustomProviders();
		if (serverState.hasCustomProviders) {
			if (serverState.providers.length === 0) {
				const localProviders = await this.readLocalProviders();
				if (localProviders.length > 0) {
					await this.writeServerProviders(localProviders);
					return localProviders;
				}
			}
			void this.replaceLocalProviders(serverState.providers);
			return serverState.providers;
		}

		const localProviders = await this.readLocalProviders();
		if (localProviders.length > 0) {
			await this.writeServerProviders(localProviders);
		}
		return localProviders;
	}

	override async has(id: string): Promise<boolean> {
		return (await this.get(id)) !== null;
	}

	private async readServerCustomProviders(): Promise<ServerCustomProvidersState> {
		const settings = await this.configuredStorage.readSettings();
		const rawProviders = settings?.customProviders;
		return {
			hasCustomProviders: Array.isArray(rawProviders),
			providers: Array.isArray(rawProviders) ? rawProviders.filter(isCustomProvider) : [],
		};
	}

	private async writeServerProviders(providers: CustomProvider[]): Promise<boolean> {
		return await this.configuredStorage.writeSettings({ customProviders: providers });
	}

	private async readProvidersForWrite(serverState: ServerCustomProvidersState): Promise<CustomProvider[]> {
		if (!serverState.hasCustomProviders || serverState.providers.length === 0) {
			return await this.readLocalProviders();
		}
		return serverState.providers;
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

	private async readLocalProvider(id: string): Promise<CustomProvider | null> {
		return await withTimeout(super.get(id), LOCAL_CACHE_TIMEOUT_MS, null);
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
