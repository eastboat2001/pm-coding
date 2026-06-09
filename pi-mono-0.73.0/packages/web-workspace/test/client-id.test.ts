import { describe, expect, it } from "vitest";
import { normalizeClientId, readClientIdHeader } from "../src/client-id.js";

describe("client ID validation", () => {
	it("accepts UUID values and returns the normalized lowercase ID", () => {
		expect(normalizeClientId("550E8400-E29B-41D4-A716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
		expect(normalizeClientId(" 550e8400-e29b-41d4-a716-446655440000 ")).toBe("550e8400-e29b-41d4-a716-446655440000");
	});

	it("requires a header value", () => {
		expect(() => normalizeClientId("")).toThrow("X-PI-Client-ID is required");
		expect(() => normalizeClientId(undefined)).toThrow("X-PI-Client-ID is required");
	});

	it("rejects path-like or malformed values", () => {
		expect(() => normalizeClientId("../../../other-client")).toThrow("Invalid X-PI-Client-ID");
		expect(() => normalizeClientId("550e8400-e29b-61d4-a716-446655440000")).toThrow("Invalid X-PI-Client-ID");
	});

	it("reads the client ID from request headers", () => {
		expect(
			readClientIdHeader({
				headers: {
					"x-pi-client-id": "550e8400-e29b-41d4-a716-446655440000",
				},
			}),
		).toBe("550e8400-e29b-41d4-a716-446655440000");
	});

	it("uses the first value when duplicate client id headers are present", () => {
		expect(
			readClientIdHeader({
				headers: {
					"x-pi-client-id": ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"],
				},
			}),
		).toBe("550e8400-e29b-41d4-a716-446655440000");
	});
});
