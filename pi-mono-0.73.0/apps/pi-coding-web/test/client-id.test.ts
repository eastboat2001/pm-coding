import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreatePiClientId, piClientHeaders } from "../src/runtime/client-id.js";

describe("client id runtime helper", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("creates a UUID and reuses it from storage", () => {
		const storage = createStorage();

		const first = getOrCreatePiClientId(storage);
		const second = getOrCreatePiClientId(storage);

		expect(first).toMatch(UUID_V4_PATTERN);
		expect(second).toBe(first);
		expect(storage.getItem("pi.clientId")).toBe(first);
	});

	it("normalizes a mixed-case stored client id and persists lowercase", () => {
		const storage = createStorage("550E8400-E29B-41D4-A716-446655440000");

		const clientId = getOrCreatePiClientId(storage);

		expect(clientId).toBe("550e8400-e29b-41d4-a716-446655440000");
		expect(storage.getItem("pi.clientId")).toBe(clientId);
	});

	it("is safe for browser usage with default window.localStorage", () => {
		const storage = createStorage();
		vi.stubGlobal("window", { localStorage: storage });

		const headers = piClientHeaders();

		expect(headers["X-PI-Client-ID"]).toMatch(UUID_V4_PATTERN);
		expect(storage.getItem("pi.clientId")).toBe(headers["X-PI-Client-ID"]);
	});
});

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createStorage(initialClientId?: string): Storage {
	const values = new Map<string, string>();
	if (initialClientId) values.set("pi.clientId", initialClientId);
	return {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		key(index) {
			return Array.from(values.keys())[index] ?? null;
		},
		removeItem(key) {
			values.delete(key);
		},
		setItem(key, value) {
			values.set(key, value);
		},
	};
}
