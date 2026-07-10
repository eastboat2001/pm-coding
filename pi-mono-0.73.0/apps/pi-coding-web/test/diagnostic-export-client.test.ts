import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionRecord } from "../src/runtime/browser-records.js";
import {
	buildDiagnosticExportEndpoint,
	diagnosticExportDownloadName,
	diagnosticSessionTitle,
	downloadDiagnosticSessionExport,
} from "../src/diagnostics/diagnostic-export-client.js";

const clientId = "550e8400-e29b-41d4-a716-446655440000";

describe("diagnostic export client helpers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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
		const session: BrowserSessionRecord = {
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

	it("downloads v2 diagnostics by run id when browser metadata has a last run id", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal("window", {
			localStorage: createStorage(clientId),
			location: { origin: "http://localhost:5173" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return new Response(null, { status: 200 });
			}),
		);
		vi.stubGlobal("document", createDocumentStub());

		await downloadDiagnosticSessionExport(createSession({ sessionId: "session-a", lastRunId: "run-a" }));

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			`http://localhost:5173/api/pi-logs/export?runId=run-a&clientId=${clientId}&format=archive&maxDiagnosticEvents=200000`,
		);
		expect(requests[0].init).toMatchObject({
			method: "HEAD",
			headers: { "X-PI-Client-ID": clientId },
		});
	});

	it("falls back to session metadata when there is no v2 run id", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal("window", {
			localStorage: createStorage(clientId),
			location: { origin: "http://localhost:5173" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return new Response(null, { status: 200 });
			}),
		);
		vi.stubGlobal("document", createDocumentStub());

		await downloadDiagnosticSessionExport(createSession({ sessionId: "session-a" }));

		expect(requests[0].url).toBe(
			`http://localhost:5173/api/pi-logs/export?sessionId=session-a&clientId=${clientId}&format=archive&maxDiagnosticEvents=200000`,
		);
	});
});

function createSession(overrides: Partial<BrowserSessionRecord> = {}): BrowserSessionRecord {
	return {
		sessionId: "session-a",
		clientId: "client-a",
		title: "Session A",
		model: {},
		thinkingLevel: "off",
		createdAt: "2026-06-12T00:00:00.000Z",
		updatedAt: "2026-06-12T00:05:00.000Z",
		...overrides,
	};
}

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

function createDocumentStub(): Pick<Document, "body" | "createElement"> {
	return {
		body: {
			appendChild: vi.fn(),
		} as unknown as Document["body"],
		createElement: vi.fn(() => ({
			click: vi.fn(),
			remove: vi.fn(),
			style: {},
		})),
	};
}
