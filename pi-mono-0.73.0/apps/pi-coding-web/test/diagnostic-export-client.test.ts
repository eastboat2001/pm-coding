import type { RuntimeSessionRecord } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import {
	buildDiagnosticExportEndpoint,
	diagnosticExportDownloadName,
	diagnosticSessionTitle,
} from "../src/diagnostics/diagnostic-export-client.js";

describe("diagnostic export client helpers", () => {
	it("builds a session export endpoint from a selected runtime session", () => {
		const endpoint = buildDiagnosticExportEndpoint({
			sessionId: "session/with spaces",
			clientId: "client-1",
			maxDiagnosticEvents: 200000,
		});

		expect(endpoint).toBe(
			"/api/pi-logs/export?sessionId=session%2Fwith+spaces&clientId=client-1&format=archive&maxDiagnosticEvents=200000",
		);
	});

	it("uses readable labels and filesystem-safe download names for selected sessions", () => {
		const session: RuntimeSessionRecord = {
			sessionId: "session:/one",
			clientId: "client-a",
			title: "Token limit repro",
			model: { id: "mimo-v2.5" },
			thinkingLevel: "off",
			createdAt: "2026-06-12T00:00:00.000Z",
			updatedAt: "2026-06-12T00:05:00.000Z",
		};

		expect(diagnosticSessionTitle(session)).toBe("Token limit repro");
		expect(diagnosticExportDownloadName(session)).toMatch(/^pi-diagnostics-Token_limit_repro-session_one-/);
		expect(diagnosticExportDownloadName(session)).toMatch(/\.zip$/);
	});
});
