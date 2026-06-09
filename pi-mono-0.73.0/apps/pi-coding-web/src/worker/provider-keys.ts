import { existsSync, readFileSync } from "node:fs";
import type { StorageConfig } from "@mariozechner/pi-web-workspace";

export function readServerProviderApiKey(
	config: Pick<StorageConfig, "settingsFile">,
	provider: string,
): string | undefined {
	const settings = readSettings(config.settingsFile);
	const providerKeys = isRecord(settings?.providerKeys) ? settings.providerKeys : {};
	const providerKey = providerKeys[provider];
	if (typeof providerKey === "string" && providerKey) {
		return providerKey;
	}

	const customProviders = Array.isArray(settings?.customProviders) ? settings.customProviders : [];
	const customProvider = customProviders.find((candidate) => isRecord(candidate) && candidate.name === provider);
	if (isRecord(customProvider) && typeof customProvider.apiKey === "string" && customProvider.apiKey) {
		return customProvider.apiKey;
	}

	return undefined;
}

function readSettings(settingsFile: string): Record<string, unknown> | undefined {
	if (!existsSync(settingsFile)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
