import type { CustomProvider } from "../storage/stores/custom-providers-store.js";

export const CUSTOM_PROVIDER_SAVED_EVENT = "pi-custom-provider-saved";

export type CustomProviderSavedEvent = CustomEvent<{
	provider: CustomProvider;
}>;

export function dispatchCustomProviderSavedEvent(provider: CustomProvider, target: EventTarget = window): void {
	target.dispatchEvent(new CustomEvent(CUSTOM_PROVIDER_SAVED_EVENT, { detail: { provider } }));
}
