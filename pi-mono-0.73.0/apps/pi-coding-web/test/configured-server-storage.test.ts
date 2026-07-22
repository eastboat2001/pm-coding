import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfiguredServerStorage } from "../src/storage/configured-server-storage.js";

describe("configured server storage", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", {
			localStorage: createStorage(clientId),
			location: { origin: "http://localhost:5173" },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends X-PI-Client-ID on configured storage settings requests", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				if (String(input).endsWith("/settings")) return jsonResponse({ version: 1, savedAt: "now" });
				throw new Error(`Unexpected URL ${String(input)}`);
			}),
		);

		const storage = new ConfiguredServerStorage();
		await storage.readSettings();
		await storage.writeSettings({ currentSessionId: "session-1" });

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.init?.headers).toMatchObject({ "X-PI-Client-ID": clientId });
		}
	});

	it("does not report a failed settings request as a missing optional record", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network unavailable");
			}),
		);

		const storage = new ConfiguredServerStorage();
		await expect(storage.readSettings()).rejects.toThrow("network unavailable");
		await expect(storage.writeSettings({ currentSessionId: "session-1" })).rejects.toThrow("network unavailable");
	});
});

function createStorage(clientId: string): Storage {
	const values = new Map<string, string>([["pi.clientId", clientId]]);
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		clear: () => values.clear(),
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}
