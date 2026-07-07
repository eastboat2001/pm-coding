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
});
