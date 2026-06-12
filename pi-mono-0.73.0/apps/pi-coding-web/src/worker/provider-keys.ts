import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StorageConfig } from "@mariozechner/pi-web-workspace";

const SAFE_CLIENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function readServerProviderApiKey(
	config: Pick<StorageConfig, "settingsFile">,
	provider: string,
	clientId?: string,
): string | undefined {
	return (
		readProviderApiKey(readSettings(config.settingsFile), provider) ??
		readLegacyClientProviderApiKey(config, provider, clientId)
	);
}

function readLegacyClientProviderApiKey(
	config: Pick<StorageConfig, "settingsFile">,
	provider: string,
	clientId: string | undefined,
): string | undefined {
	if (!clientId || !SAFE_CLIENT_ID_PATTERN.test(clientId)) return undefined;
	const clientSettingsFile = join(dirname(config.settingsFile), "clients", clientId, basename(config.settingsFile));
	return readProviderApiKey(readSettings(clientSettingsFile), provider);
}

function readProviderApiKey(settings: Record<string, unknown> | undefined, provider: string): string | undefined {
	const providerKeys = isRecord(settings?.providerKeys) ? settings.providerKeys : {};
	const providerKey = providerKeys[provider];
	if (typeof providerKey === "string" && providerKey) {
		return providerKey;
	}

	const customProviders = Array.isArray(settings?.customProviders) ? settings.customProviders : [];
	const customProvider = customProviders.find(
		(candidate) => isRecord(candidate) && customProviderMatchesIdentity(candidate, provider),
	);
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

function customProviderMatchesIdentity(candidate: Record<string, unknown>, identity: string): boolean {
	if (candidate.name === identity) return true;
	if (typeof candidate.id !== "string") return false;
	return identity === candidate.id || identity === `custom-provider:${candidate.id}`;
}
