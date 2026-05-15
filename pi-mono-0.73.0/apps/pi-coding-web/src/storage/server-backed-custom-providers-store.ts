import { type CustomProvider, CustomProvidersStore } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "./configured-server-storage.js";

type ServerCustomProvidersState = {
	hasCustomProviders: boolean;
	providers: CustomProvider[];
};

export class ServerBackedCustomProvidersStore extends CustomProvidersStore {
	constructor(private readonly configuredStorage: ConfiguredServerStorage) {
		super();
	}

	override async get(id: string): Promise<CustomProvider | null> {
		const serverState = await this.readServerCustomProviders();
		if (serverState.hasCustomProviders) {
			const provider = serverState.providers.find((item) => item.id === id) ?? null;
			if (provider) {
				await super.set(provider);
			} else {
				await super.delete(id);
			}
			return provider;
		}

		const localProvider = await super.get(id);
		if (localProvider) {
			await this.writeServerProviders(await this.readLocalProviders());
		}
		return localProvider;
	}

	override async set(provider: CustomProvider): Promise<void> {
		await super.set(provider);
		const serverState = await this.readServerCustomProviders();
		const providers = serverState.hasCustomProviders ? serverState.providers : await this.readLocalProviders();
		await this.writeServerProviders(upsertProvider(providers, provider));
	}

	override async delete(id: string): Promise<void> {
		await super.delete(id);
		const serverState = await this.readServerCustomProviders();
		const providers = serverState.hasCustomProviders ? serverState.providers : await this.readLocalProviders();
		await this.writeServerProviders(providers.filter((provider) => provider.id !== id));
	}

	override async getAll(): Promise<CustomProvider[]> {
		const serverState = await this.readServerCustomProviders();
		if (serverState.hasCustomProviders) {
			await this.replaceLocalProviders(serverState.providers);
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

	private async writeServerProviders(providers: CustomProvider[]): Promise<void> {
		await this.configuredStorage.writeSettings({ customProviders: providers });
	}

	private async readLocalProviders(): Promise<CustomProvider[]> {
		return await super.getAll();
	}

	private async replaceLocalProviders(providers: CustomProvider[]): Promise<void> {
		const localProviders = await super.getAll();
		const serverIds = new Set(providers.map((provider) => provider.id));
		for (const provider of providers) {
			await super.set(provider);
		}
		for (const provider of localProviders) {
			if (!serverIds.has(provider.id)) {
				await super.delete(provider.id);
			}
		}
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
