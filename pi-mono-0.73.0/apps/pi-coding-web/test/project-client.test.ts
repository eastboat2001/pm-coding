import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestProjectApi } from "../src/project-tools/client.js";

describe("project client", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId), location: { origin: "http://localhost:5173" } });
	});

	it("sends X-PI-Client-ID on project API requests", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await requestProjectApi<{ ok: true }>("/api/pi-projects/workspace/file", { command: "list" });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://localhost:5173/api/pi-projects/workspace/file");
		expect(requests[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/json",
			"X-PI-Client-ID": clientId,
		});
		expect(requests[0]?.init?.method).toBe("POST");
	});
});

function createStorage(clientId: string): Storage {
	const values = new Map<string, string>([["pi.clientId", clientId]]);
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
