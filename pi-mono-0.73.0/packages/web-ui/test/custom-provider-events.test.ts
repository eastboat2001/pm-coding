import { describe, expect, it } from "vitest";
import {
	CUSTOM_PROVIDER_SAVED_EVENT,
	dispatchCustomProviderSavedEvent,
} from "../src/dialogs/custom-provider-events.js";
import type { CustomProvider } from "../src/storage/stores/custom-providers-store.js";

describe("custom provider events", () => {
	it("dispatches the saved provider so host apps can refresh active model state", () => {
		const target = new EventTarget();
		const provider: CustomProvider = {
			id: "provider-a",
			name: "Local",
			type: "openai-completions",
			baseUrl: "https://example.test/v1",
		};
		let detail: { provider: CustomProvider } | undefined;
		target.addEventListener(CUSTOM_PROVIDER_SAVED_EVENT, (event) => {
			detail = (event as CustomEvent<{ provider: CustomProvider }>).detail;
		});

		dispatchCustomProviderSavedEvent(provider, target);

		expect(detail).toEqual({ provider });
	});
});
