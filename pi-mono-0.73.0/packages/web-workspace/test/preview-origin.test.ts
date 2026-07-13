import { describe, expect, it } from "vitest";
import { buildTrustedPreviewUrl } from "../src/preview-origin.js";
import { buildPreviewUrl } from "../src/workspace-preview-service.js";

describe("trusted preview origin", () => {
	it("prefers the configured public origin", () => {
		expect(
			buildTrustedPreviewUrl(
				{ previewBaseUrl: "https://preview.example", previewInternalOrigin: "http://127.0.0.1:5173" },
				"project-a",
			),
		).toBe("https://preview.example/preview/project-a/");
	});

	it("falls back to the configured internal origin instead of request headers", () => {
		const config = { previewBaseUrl: "", previewInternalOrigin: "http://127.0.0.1:5193" };
		expect(buildTrustedPreviewUrl(config, "project-a")).toBe("http://127.0.0.1:5193/preview/project-a/");
		expect(
			buildPreviewUrl(config, { headers: { host: "attacker.example", "x-forwarded-proto": "https" } }, "project-a"),
		).toBe("http://127.0.0.1:5193/preview/project-a/");
	});
});
