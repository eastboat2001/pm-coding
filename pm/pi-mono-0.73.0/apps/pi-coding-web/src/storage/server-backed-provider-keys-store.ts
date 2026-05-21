import { ProviderKeysStore } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "./configured-server-storage.js";

export class ServerBackedProviderKeysStore extends ProviderKeysStore {
	constructor(
		private readonly configuredStorage: ConfiguredServerStorage,
		private readonly getCustomProviderApiKey?: (provider: string) => Promise<string | null>,
	) {
		super();
	}

	override async get(provider: string): Promise<string | null> {
		const localKey = await super.get(provider);
		if (localKey) {
			await this.persistLocalKeyIfNeeded(provider, localKey);
			return localKey;
		}

		const serverKeys = await this.readServerProviderKeys();
		const serverKey = serverKeys[provider];
		if (!serverKey) return await this.readCustomProviderApiKey(provider);

		await super.set(provider, serverKey);
		return serverKey;
	}

	override async set(provider: string, key: string): Promise<void> {
		await super.set(provider, key);
		await this.configuredStorage.writeSettings({ providerKeys: { [provider]: key } });
	}

	override async delete(provider: string): Promise<void> {
		await super.delete(provider);
		await this.configuredStorage.writeSettings({ providerKeys: { [provider]: null } });
	}

	override async list(): Promise<string[]> {
		const localProviders = await super.list();
		const serverProviders = Object.keys(await this.readServerProviderKeys());
		return [...new Set([...localProviders, ...serverProviders])].sort();
	}

	override async has(provider: string): Promise<boolean> {
		return (await this.get(provider)) !== null;
	}

	private async readServerProviderKeys(): Promise<Record<string, string>> {
		const settings = await this.configuredStorage.readSettings();
		return settings?.providerKeys && typeof settings.providerKeys === "object" ? settings.providerKeys : {};
	}

	private async readCustomProviderApiKey(provider: string): Promise<string | null> {
		return (await this.getCustomProviderApiKey?.(provider)) || null;
	}

	private async persistLocalKeyIfNeeded(provider: string, key: string): Promise<void> {
		const serverKeys = await this.readServerProviderKeys();
		if (serverKeys[provider] === key) return;
		await this.configuredStorage.writeSettings({ providerKeys: { [provider]: key } });
	}
}
