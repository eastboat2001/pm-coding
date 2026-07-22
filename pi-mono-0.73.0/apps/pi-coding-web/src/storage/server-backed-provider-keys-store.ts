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
		const serverKeys = await this.readServerProviderKeys();
		const serverKey = serverKeys[provider];
		const authoritativeKey = serverKey || (await this.readCustomProviderApiKey(provider));
		if (!authoritativeKey) return await super.get(provider);

		await super.set(provider, authoritativeKey);
		return authoritativeKey;
	}

	override async set(provider: string, key: string): Promise<void> {
		const synchronized = await this.configuredStorage.writeSettings({ providerKeys: { [provider]: key } });
		if (!synchronized) throw new Error("Failed to synchronize provider credentials with the PI server.");
		await super.set(provider, key);
	}

	override async delete(provider: string): Promise<void> {
		const synchronized = await this.configuredStorage.writeSettings({ providerKeys: { [provider]: null } });
		if (!synchronized) throw new Error("Failed to synchronize provider credential deletion with the PI server.");
		await super.delete(provider);
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
}
