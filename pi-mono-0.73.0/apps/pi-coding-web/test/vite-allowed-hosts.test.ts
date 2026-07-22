import { describe, expect, it } from "vitest";
import { configuredViteAllowedHosts } from "../src/server/vite-allowed-hosts.js";

describe("configured Vite allowed hosts", () => {
	it("allows the exact Compose service host and browser-facing host", () => {
		expect(
			configuredViteAllowedHosts({
				PI_PREVIEW_INTERNAL_ORIGIN: "http://pi-coding-web:5173",
				PI_PREVIEW_BASE_URL: "https://pi.internal.example/apps/",
			}),
		).toEqual(["pi-coding-web", "pi.internal.example"]);
	});

	it("deduplicates hosts and ignores invalid or non-http values without opening the allowlist", () => {
		expect(
			configuredViteAllowedHosts({
				PI_PREVIEW_INTERNAL_ORIGIN: "http://pi-coding-web:5173",
				PI_PREVIEW_BASE_URL: "https://pi-coding-web",
			}),
		).toEqual(["pi-coding-web"]);
		expect(
			configuredViteAllowedHosts({
				PI_PREVIEW_INTERNAL_ORIGIN: "not a URL",
				PI_PREVIEW_BASE_URL: "file:///app/index.html",
			}),
		).toEqual([]);
	});
});
