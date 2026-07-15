import { describe, expect, it } from "vitest";
import { createAgentV2DiagnosticEvent, toWorkspaceDiagnosticEvent } from "../src/agent-v2-diagnostics.js";

const createdAt = "2026-07-07T00:00:00.000Z";

describe("agent v2 diagnostics", () => {
	it("rejects unknown diagnostic categories", () => {
		expect(() =>
			createAgentV2DiagnosticEvent({
				diagnosticId: "diag-unknown",
				clientId: "client-a",
				runId: "run-1",
				severity: "info",
				category: "legacy" as never,
				code: "legacy_event",
				message: "legacy diagnostic",
				data: {},
				createdAt,
			}),
		).toThrow("Invalid Agent v2 diagnostic category: legacy");
	});

	it("creates a complete diagnostic event with required fields", () => {
		const event = createAgentV2DiagnosticEvent({
			diagnosticId: "diag-1",
			clientId: "client-a",
			runId: "run-1",
			severity: "warn",
			category: "validation",
			code: "schema_check_failed",
			phase: "validation",
			taskId: "task-1",
			message: "Schema check failed",
			data: {},
			createdAt,
		});

		expect(event).toMatchObject({
			diagnosticId: "diag-1",
			clientId: "client-a",
			runId: "run-1",
			severity: "warn",
			category: "validation",
			code: "schema_check_failed",
			phase: "validation",
			taskId: "task-1",
			message: "Schema check failed",
			createdAt,
		});
	});

	it("preserves validation and repair semantics when converting to workspace diagnostics", () => {
		const validation = createAgentV2DiagnosticEvent({
			diagnosticId: "diag-validation",
			clientId: "client-a",
			runId: "run-1",
			severity: "info",
			category: "validation",
			code: "schema_check_failed",
			phase: "validation",
			taskId: "task-1",
			message: "Schema check failed",
			data: {
				payload: "ok",
			},
			createdAt,
		});

		const repair = createAgentV2DiagnosticEvent({
			diagnosticId: "diag-repair",
			clientId: "client-a",
			runId: "run-1",
			severity: "warn",
			category: "repair",
			code: "patch_applied",
			phase: "repair",
			taskId: "task-1",
			message: "Patch applied",
			data: {
				apiKey: "secret-token",
				note: "x".repeat(5000),
			},
			createdAt,
		});

		expect(toWorkspaceDiagnosticEvent(validation)).toMatchObject({
			level: "info",
			category: "agent",
			eventType: validation.code,
			data: {
				runId: "run-1",
				agentV2Category: "agent_v2.validation",
				code: "schema_check_failed",
				message: "Schema check failed",
				payload: "ok",
			},
		});

		const exportedRepair = toWorkspaceDiagnosticEvent(repair);
		expect(exportedRepair).toMatchObject({
			level: "warn",
			category: "agent",
			eventType: repair.code,
			data: {
				runId: "run-1",
				agentV2Category: "agent_v2.repair",
				code: "patch_applied",
				message: "Patch applied",
				apiKey: "[redacted]",
			},
		});
		expect(String(exportedRepair.data.note)).toContain("[truncated");
	});

	it("sanitizes the canonical event before it can reach durable storage", () => {
		const cause = new Error("upstream bearer cause-secret");
		const failure = new Error("request failed api_key=error-secret", { cause });
		const cyclic: Record<string, unknown> = { token: "nested-secret" };
		cyclic.self = cyclic;
		const event = createAgentV2DiagnosticEvent({
			diagnosticId: "diag-sanitized",
			clientId: "client-a",
			runId: "run-1",
			severity: "error",
			category: "model",
			code: "provider.failed",
			message:
				"POST https://alice:password@provider.test/v1/chat?api_key=url-secret Authorization: Bearer message-secret",
			data: {
				headers: { authorization: "Bearer header-secret", cookie: "sid=cookie-secret" },
				requestUrl: "https://bob:password@provider.test/v1?q=query-secret",
				values: ["token=array-secret", { refresh_token: "refresh-secret" }],
				failure,
				stdout: "stdout-secret",
				stderr: "stderr-secret",
				providerPayload: { messages: [{ content: "provider-secret" }] },
				cyclic,
			},
			createdAt,
		});

		const serialized = JSON.stringify(event);
		for (const secret of [
			"password",
			"url-secret",
			"message-secret",
			"header-secret",
			"cookie-secret",
			"query-secret",
			"array-secret",
			"refresh-secret",
			"error-secret",
			"cause-secret",
			"stdout-secret",
			"stderr-secret",
			"provider-secret",
			"nested-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(event.message).toContain("[redacted]");
		expect(event.data).toMatchObject({
			headers: "[redacted]",
			stdout: "[redacted]",
			stderr: "[redacted]",
			providerPayload: "[redacted]",
		});
		expect(JSON.stringify(event.data.failure)).toContain("[redacted]");
		expect(JSON.stringify(event.data.cyclic)).toContain("[circular]");
	});

	it("redacts camelCase sensitive keys and common provider credentials in free text", () => {
		const event = createAgentV2DiagnosticEvent({
			diagnosticId: "diag-provider-secrets",
			clientId: "client-a",
			runId: "run-1",
			severity: "error",
			category: "model",
			code: "provider.failed",
			message:
				"OpenAI sk-proj-messageSecret123456789 Anthropic sk-ant-messageSecret123456789 Basic QmFzaWNNZXNzYWdlU2VjcmV0MTIzNDU2",
			data: {
				sessionToken: "sessionSecret",
				authHeader: "authSecret",
				authorizationHeader: "authorizationSecret",
				requestHeaders: { accept: "application/json", "x-api-key": "headerSecret" },
				cookieHeaders: { cookie: "cookieSecret" },
				providerApiKey: "providerKeySecret",
				provider_api_key: "providerSnakeSecret",
				providerAuth: "providerAuthSecret",
				note: "GitHub ghp_noteSecret12345678901234567890 HuggingFace hf_noteSecret123456789",
				failure: new Error(
					"Google AIzaErrorSecret12345678901234567890 Slack xoxb-errorSecret12345678901234567890 token: errorTokenSecret",
				),
				tokenCount: 42,
				description: "ordinary sk-example and Basic concepts remain readable",
			},
			createdAt,
		});

		const serialized = JSON.stringify(event);
		for (const secret of [
			"messageSecret",
			"QmFzaWNNZXNzYWdlU2VjcmV0MTIzNDU2",
			"sessionSecret",
			"authSecret",
			"authorizationSecret",
			"headerSecret",
			"cookieSecret",
			"providerKeySecret",
			"providerSnakeSecret",
			"providerAuthSecret",
			"noteSecret",
			"ErrorSecret",
			"errorSecret",
			"errorTokenSecret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(event.data.tokenCount).toBe(42);
		expect(event.data.description).toBe("ordinary sk-example and Basic concepts remain readable");
	});
});
