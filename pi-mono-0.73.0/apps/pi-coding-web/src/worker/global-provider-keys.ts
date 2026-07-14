import { closeSync, openSync, readSync } from "node:fs";
import { getEnvApiKey } from "@mariozechner/pi-ai/env-api-keys";
import { getProviders } from "@mariozechner/pi-ai/models";
import { normalizeAgentV2ModelReference } from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import type { StorageConfig } from "@mariozechner/pi-web-workspace/runtime-infra";

const MAX_SETTINGS_BYTES = 1_048_576;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 100_000;
const AMBIENT_AUTH_PROVIDERS = new Set(["google-vertex", "amazon-bedrock"]);
const PLACEHOLDER_KEY = /^(?:your[ _-]?(?:api[ _-]?)?key|change[ _-]?me|replace[ _-]?me|placeholder|<[^>]+>)$/iu;
const VALID_AGENT_V2_SERVER_SETTINGS_SNAPSHOTS = new WeakSet<object>();
const AGENT_V2_SERVER_SETTINGS_SNAPSHOT_CONSTRUCTION_TOKEN = Object.freeze({});

export interface GlobalProviderApiKeySources {
	getEnvApiKey(provider: string): string | undefined;
	getBuiltinProviders?(): readonly string[];
	readSettingsFile?(settingsFile: string): string;
}

const DEFAULT_SOURCES: Required<GlobalProviderApiKeySources> = {
	getEnvApiKey,
	getBuiltinProviders: getProviders,
	readSettingsFile: readSettingsFileBounded,
};

/** Immutable, non-serializable startup view shared by model and credential resolution. */
export interface AgentV2ServerSettingsSnapshot {
	resolveApiKey(provider: string): string | undefined;
	customProvider(id: string): Readonly<Record<string, unknown>> | undefined;
	selectedModel(): Readonly<Record<string, unknown>> | undefined;
}

class AgentV2ServerSettingsSnapshotImplementation implements AgentV2ServerSettingsSnapshot {
	readonly #providerKeys: ReadonlyMap<string, string>;
	readonly #customProviders: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	readonly #selectedModel: Readonly<Record<string, unknown>> | undefined;

	constructor(
		token: typeof AGENT_V2_SERVER_SETTINGS_SNAPSHOT_CONSTRUCTION_TOKEN,
		input: {
			providerKeys: ReadonlyMap<string, string>;
			customProviders: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
			selectedModel?: Readonly<Record<string, unknown>>;
		},
	) {
		if (token !== AGENT_V2_SERVER_SETTINGS_SNAPSHOT_CONSTRUCTION_TOKEN) {
			throw new Error("Agent v2 server settings snapshot construction is private.");
		}
		this.#providerKeys = new Map(input.providerKeys);
		this.#customProviders = new Map(input.customProviders);
		this.#selectedModel = input.selectedModel;
		Object.freeze(this);
		VALID_AGENT_V2_SERVER_SETTINGS_SNAPSHOTS.add(this);
	}

	resolveApiKey(provider: string): string | undefined {
		return this.#providerKeys.get(provider);
	}

	customProvider(id: string): Readonly<Record<string, unknown>> | undefined {
		return this.#customProviders.get(id);
	}

	selectedModel(): Readonly<Record<string, unknown>> | undefined {
		return this.#selectedModel;
	}
}

export function loadAgentV2ServerSettingsSnapshot(
	config: Pick<StorageConfig, "settingsFile">,
	sources: GlobalProviderApiKeySources = DEFAULT_SOURCES,
): AgentV2ServerSettingsSnapshot {
	const readSettingsFile = sources.readSettingsFile ?? DEFAULT_SOURCES.readSettingsFile;
	const getBuiltinProviders = sources.getBuiltinProviders ?? DEFAULT_SOURCES.getBuiltinProviders;
	let settings: Record<string, unknown> | undefined;
	try {
		const source = readSettingsFile(config.settingsFile);
		if (Buffer.byteLength(source, "utf8") <= MAX_SETTINGS_BYTES) {
			const parsed = JSON.parse(source) as unknown;
			if (isPlainRecord(parsed) && freezePlainData(parsed) && hasValidAgentV2SettingsShape(parsed))
				settings = parsed;
		}
	} catch {
		settings = undefined;
	}

	const providerKeys = new Map<string, string>();
	if (settings && isPlainRecord(settings.providerKeys)) {
		for (const [provider, value] of Object.entries(settings.providerKeys)) {
			if (!isProviderIdentity(provider) || provider.startsWith("custom-provider:") || typeof value !== "string") {
				settings = undefined;
				providerKeys.clear();
				break;
			}
			const key = usableKey(value, provider);
			if (key) providerKeys.set(provider, key);
		}
	}
	const builtinProviders = boundedProviderList(getBuiltinProviders);
	for (const provider of builtinProviders) {
		if (providerKeys.has(provider)) continue;
		let candidate: string | undefined;
		try {
			candidate = sources.getEnvApiKey(provider);
		} catch {
			candidate = undefined;
		}
		const key = usableKey(candidate, provider);
		if (key) providerKeys.set(provider, key);
	}

	const customProviders = new Map<string, Readonly<Record<string, unknown>>>();
	if (settings && Array.isArray(settings.customProviders)) {
		for (const value of settings.customProviders) {
			const id = value.id as string;
			const identity = `custom-provider:${id}`;
			if (customProviders.has(id)) {
				settings = undefined;
				providerKeys.clear();
				customProviders.clear();
				break;
			}
			if (typeof value.apiKey === "string") {
				const key = usableKey(value.apiKey, identity);
				if (key) providerKeys.set(identity, key);
			}
			const sanitized = projectCustomProvider(value);
			deepFreeze(sanitized);
			customProviders.set(id, sanitized);
		}
	}

	const selectedModel = settings && isPlainRecord(settings.selectedModel) ? settings.selectedModel : undefined;
	return new AgentV2ServerSettingsSnapshotImplementation(AGENT_V2_SERVER_SETTINGS_SNAPSHOT_CONSTRUCTION_TOKEN, {
		providerKeys,
		customProviders,
		selectedModel,
	});
}

function readSettingsFileBounded(settingsFile: string): string {
	const file = openSync(settingsFile, "r");
	const bytes = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
	let offset = 0;
	try {
		while (offset < bytes.length) {
			const count = readSync(file, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
	} finally {
		closeSync(file);
	}
	if (offset > MAX_SETTINGS_BYTES) throw new Error("Agent v2 server settings exceed the startup limit.");
	return bytes.toString("utf8", 0, offset);
}

function hasValidAgentV2SettingsShape(settings: Record<string, unknown>): boolean {
	if (settings.providerKeys !== undefined) {
		if (!isPlainRecord(settings.providerKeys)) return false;
		for (const key of Object.keys(settings.providerKeys)) {
			if (
				!isDataDescriptor(Object.getOwnPropertyDescriptor(settings.providerKeys, key)) ||
				!isProviderIdentity(key) ||
				key.startsWith("custom-provider:") ||
				typeof settings.providerKeys[key] !== "string"
			)
				return false;
		}
	}
	if (settings.customProviders !== undefined) {
		if (!isExactDataArray(settings.customProviders, 256)) return false;
		const identities = new Set<string>();
		for (let index = 0; index < settings.customProviders.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(settings.customProviders, String(index));
			if (!isDataDescriptor(descriptor) || !isExactCustomProvider(descriptor.value)) return false;
			const id = descriptor.value.id as string;
			if (identities.has(id)) return false;
			identities.add(id);
		}
	}
	return settings.selectedModel === undefined || isExactSelectedModel(settings.selectedModel);
}

function isExactCustomProvider(value: unknown): value is Record<string, unknown> {
	if (!isPlainRecord(value)) return false;
	const type = value.type;
	const autoDiscovery = type === "ollama" || type === "llama.cpp" || type === "vllm" || type === "lmstudio";
	const manual = type === "openai-completions" || type === "openai-responses" || type === "anthropic-messages";
	if (!autoDiscovery && !manual) return false;
	if (
		!hasExactDataKeys(
			value,
			manual ? ["id", "name", "type", "baseUrl", "models"] : ["id", "name", "type", "baseUrl"],
			["apiKey", "useNonStreamingToolCalls"],
		) ||
		!isProviderIdentity(value.id as string) ||
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		value.name.length > 512 ||
		typeof value.baseUrl !== "string" ||
		(value.apiKey !== undefined && typeof value.apiKey !== "string") ||
		(value.useNonStreamingToolCalls !== undefined && typeof value.useNonStreamingToolCalls !== "boolean") ||
		(manual && value.useNonStreamingToolCalls !== undefined)
	)
		return false;
	if (manual) {
		if (!isExactDataArray(value.models, 256)) return false;
		const modelIds = new Set<string>();
		for (let index = 0; index < value.models.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value.models, String(index));
			if (!isDataDescriptor(descriptor) || !isExactManualModel(descriptor.value)) return false;
			const modelId = descriptor.value.id;
			if (typeof modelId !== "string" || modelIds.has(modelId)) return false;
			modelIds.add(modelId);
		}
	}
	return true;
}

function isExactManualModel(value: unknown): value is Record<string, unknown> {
	return (
		isPlainRecord(value) &&
		hasExactDataKeys(
			value,
			["id", "name", "provider", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
			["compat", "thinkingLevelMap"],
		)
	);
}

function isExactSelectedModel(value: unknown): value is Record<string, unknown> {
	return (
		isPlainRecord(value) &&
		hasExactDataKeys(
			value,
			["id", "name", "provider", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
			["headers", "compat", "thinkingLevelMap"],
		)
	);
}

function projectCustomProvider(value: Record<string, unknown>): Record<string, unknown> {
	const projected: Record<string, unknown> = {
		id: value.id,
		name: value.name,
		type: value.type,
		baseUrl: value.baseUrl,
	};
	if (value.useNonStreamingToolCalls !== undefined)
		projected.useNonStreamingToolCalls = value.useNonStreamingToolCalls;
	if (value.models !== undefined) projected.models = value.models;
	return projected;
}

function hasExactDataKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const keys = ownKeys as string[];
	const allowed = new Set([...required, ...optional]);
	return (
		keys.length >= required.length &&
		keys.length <= required.length + optional.length &&
		required.every((key) => keys.includes(key)) &&
		keys.every((key) => allowed.has(key) && isDataDescriptor(Object.getOwnPropertyDescriptor(value, key)))
	);
}

function isExactDataArray(value: unknown, maxLength: number): value is unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		!isDataDescriptor(lengthDescriptor) ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > maxLength
	)
		return false;
	const length = lengthDescriptor.value;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1 || !keys.includes("length")) return false;
	for (let index = 0; index < length; index += 1) {
		const key = String(index);
		if (!keys.includes(key) || !isDataDescriptor(Object.getOwnPropertyDescriptor(value, key))) return false;
	}
	return true;
}

function isDataDescriptor(value: PropertyDescriptor | undefined): value is PropertyDescriptor & { value: unknown } {
	return value !== undefined && Object.hasOwn(value, "value") && value.get === undefined && value.set === undefined;
}

export function createGlobalProviderApiKeyResolver(
	snapshot: AgentV2ServerSettingsSnapshot,
): (provider: string) => string | undefined;
export function createGlobalProviderApiKeyResolver(
	config: Pick<StorageConfig, "settingsFile">,
	sources?: GlobalProviderApiKeySources,
): (provider: string) => string | undefined;
export function createGlobalProviderApiKeyResolver(
	input: AgentV2ServerSettingsSnapshot | Pick<StorageConfig, "settingsFile">,
	sources: GlobalProviderApiKeySources = DEFAULT_SOURCES,
): (provider: string) => string | undefined {
	const snapshot = isValidatedAgentV2ServerSettingsSnapshot(input)
		? input
		: loadAgentV2ServerSettingsSnapshot(input, sources);
	return function resolveGlobalProviderApiKey(provider: string): string | undefined {
		return isProviderIdentity(provider) ? snapshot.resolveApiKey(provider) : undefined;
	};
}

/** Compatibility helper for non-production callers; production composition uses one startup snapshot. */
export function readGlobalProviderApiKey(
	config: Pick<StorageConfig, "settingsFile">,
	provider: string,
	sources: GlobalProviderApiKeySources = DEFAULT_SOURCES,
): string | undefined {
	return createGlobalProviderApiKeyResolver(config, sources)(provider);
}

function boundedProviderList(getBuiltinProviders: () => readonly string[]): readonly string[] {
	try {
		const values = getBuiltinProviders();
		if (!Array.isArray(values) || values.length > 256) return [];
		return values.filter((value): value is string => typeof value === "string" && isProviderIdentity(value));
	} catch {
		return [];
	}
}

function usableKey(value: string | undefined, provider: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed === "<authenticated>") return AMBIENT_AUTH_PROVIDERS.has(provider) ? trimmed : undefined;
	if (PLACEHOLDER_KEY.test(trimmed)) return undefined;
	return trimmed;
}

function isProviderIdentity(value: string): boolean {
	try {
		return normalizeAgentV2ModelReference({ provider: value, id: "model" }).provider === value;
	} catch {
		return false;
	}
}

function isValidatedAgentV2ServerSettingsSnapshot(value: unknown): value is AgentV2ServerSettingsSnapshot {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		VALID_AGENT_V2_SERVER_SETTINGS_SNAPSHOTS.has(value as object)
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function freezePlainData(root: Record<string, unknown>): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop() as { value: unknown; depth: number };
		if (++nodes > MAX_SNAPSHOT_NODES || current.depth > MAX_SNAPSHOT_DEPTH) return false;
		if (Array.isArray(current.value)) {
			if (current.value.length > MAX_SNAPSHOT_NODES) return false;
			for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
			continue;
		}
		if (typeof current.value === "object" && current.value !== null) {
			if (!isPlainRecord(current.value)) return false;
			for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
		}
	}
	deepFreeze(root);
	return true;
}

function deepFreeze(root: object): void {
	const stack: object[] = [root];
	while (stack.length > 0) {
		const value = stack.pop() as object;
		if (Object.isFrozen(value)) continue;
		Object.freeze(value);
		for (const item of Object.values(value)) {
			if (typeof item === "object" && item !== null && !Object.isFrozen(item)) stack.push(item);
		}
	}
}
