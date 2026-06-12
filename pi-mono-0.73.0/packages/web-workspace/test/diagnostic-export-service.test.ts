import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticExportService } from "../src/diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";

describe("WorkspaceDiagnosticExportService", () => {
	let diagnostics: WorkspaceDiagnosticLogService;
	let dir: string;
	let runtimeDb: RuntimeDbStore;
	let sessions: WorkspaceSessionService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-diagnostic-export-"));
		const config = { ...loadStorageConfig(dir), logStdoutEnabled: false };
		runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
		runtimeDb.ensureSchema();
		diagnostics = new WorkspaceDiagnosticLogService(config);
		sessions = new WorkspaceSessionService(config);
		sessions.ensureDirs();
	});

	afterEach(() => {
		diagnostics.close();
		runtimeDb.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("exports runtime and diagnostic data for a session without extra export-layer redaction", () => {
		sessions.writeSettings(
			{
				providerKeys: { "custom-provider:test": "server-key" },
				customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
			},
			"client-a",
		);
		runtimeDb.createSession({
			clientId: "client-a",
			sessionId: "session-1",
			title: "Token limit repro",
			model: { id: "mimo-v2.5", provider: "custom-provider:test", maxTokens: 512 },
			thinkingLevel: "off",
			createdAt: "2026-06-12T00:00:00.000Z",
		});
		runtimeDb.appendMessage({
			clientId: "client-a",
			sessionId: "session-1",
			role: "user",
			payload: { content: "count forever" },
			createdAt: "2026-06-12T00:00:01.000Z",
		});
		runtimeDb.createRun({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			model: { id: "mimo-v2.5", provider: "custom-provider:test", maxTokens: 512 },
			thinkingLevel: "off",
			createdAt: "2026-06-12T00:00:02.000Z",
		});
		runtimeDb.appendRunEvent({
			clientId: "client-a",
			sessionId: "session-1",
			runId: "run-1",
			type: "message_end",
			payload: { message: { stopReason: "length", usage: { output: 512 } } },
			createdAt: "2026-06-12T00:00:03.000Z",
		});
		diagnostics.writeEvents({
			events: [
				{
					clientId: "client-a",
					sessionId: "session-1",
					category: "provider",
					eventType: "provider.payload",
					provider: "custom-provider:test",
					model: "mimo-v2.5",
					data: { max_completion_tokens: 512 },
				},
				{
					clientId: "client-a",
					sessionId: "session-1",
					category: "model",
					eventType: "model.stream.summary",
					data: { stopReason: "length", textDeltaCount: 600 },
				},
			],
		});

		const service = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
		const exported = service.export({ clientId: "client-a", sessionId: "session-1" });

		expect(exported.query).toMatchObject({ clientId: "client-a", sessionId: "session-1" });
		expect(exported.runtime).toMatchObject({
			session: { sessionId: "session-1", title: "Token limit repro" },
			messages: [{ role: "user", payload: { content: "count forever" } }],
			runs: [{ runId: "run-1", sessionId: "session-1" }],
		});
		expect(exported.runtime.runEventsByRunId).toMatchObject({
			"run-1": [{ type: "message_end", payload: { message: { stopReason: "length", usage: { output: 512 } } } }],
		});
		expect(exported.diagnostics).toMatchObject({
			total: 2,
			exported: 2,
			truncated: false,
			events: [
				{ eventType: "provider.payload", data: { max_completion_tokens: 512 } },
				{ eventType: "model.stream.summary", data: { stopReason: "length", textDeltaCount: 600 } },
			],
		});
		expect(exported.settings).toMatchObject({
			providerKeys: { "custom-provider:test": "server-key" },
			customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
		});
	});
});
