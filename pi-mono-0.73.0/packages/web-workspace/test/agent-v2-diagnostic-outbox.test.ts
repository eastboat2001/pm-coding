import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2DiagnosticProjectionAdapters } from "../src/agent-v2-diagnostic-projections.js";
import type { AgentV2DiagnosticEvent, WorkspaceDiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import { AgentV2OutboxDispatcher } from "../src/agent-v2-outbox-dispatcher.js";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];
const diagnostics: WorkspaceDiagnosticLogService[] = [];

afterEach(() => {
	for (const item of diagnostics.splice(0)) item.close();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent v2 diagnostic outbox projections", () => {
	it("canonicalizes raw input before the atomic DB/event/outbox commit and deduplicates workspace replay", async () => {
		const { store, workspace } = harness();
		const result = store.commitAgentV2Diagnostic({
			diagnostic: rawDiagnostic(),
			emitRunEvent: true,
		});
		const persisted = store.listAgentV2Diagnostics("client-a", "run-a")[0];
		const durableJson = JSON.stringify({ persisted, event: result.event });
		expect(durableJson).not.toContain("raw-secret");
		expect(result.event?.payload).toEqual({ diagnosticId: "diag-a" });
		expect(result.outboxIntentIds).toHaveLength(3);

		const adapters = createAgentV2DiagnosticProjectionAdapters({ store, diagnostics: workspace });
		const leased = store.leaseAgentV2Outbox({
			ownerId: "projector-a",
			kinds: ["workspace_diagnostic", "langfuse_diagnostic"],
			limit: 10,
			now: "2026-07-15T00:00:01.000Z",
			leaseTtlMs: 1000,
		});
		const workspaceIntent = leased.find((intent) => intent.reference.kind === "workspace_diagnostic");
		if (!workspaceIntent) throw new Error("expected workspace intent");
		const adapter = adapters.find((candidate) => candidate.kind === "workspace_diagnostic");
		if (!adapter) throw new Error("expected workspace adapter");
		await adapter.deliver(workspaceIntent as never, new AbortController().signal);
		await adapter.deliver(workspaceIntent as never, new AbortController().signal);
		const projected = workspace.queryEvents({ eventType: "provider.failed" }).events;
		expect(projected).toHaveLength(1);
		expect(JSON.stringify(projected)).not.toContain("raw-secret");
	});

	it("isolates workspace failure from Langfuse delivery and stores only fixed dead-letter taxonomy", async () => {
		const { store, dbFile } = harness();
		store.commitAgentV2Diagnostic({ diagnostic: rawDiagnostic(), emitRunEvent: false });
		let langfuseDeliveries = 0;
		const projection = {
			writeProjectedEvent(): "projected" {
				throw new Error("workspace raw-secret failure");
			},
			async deliverLangfuse(_events: WorkspaceDiagnosticEvent[], _signal: AbortSignal): Promise<void> {
				langfuseDeliveries += 1;
			},
		};
		const dispatcher = new AgentV2OutboxDispatcher({
			store,
			adapters: createAgentV2DiagnosticProjectionAdapters({ store, diagnostics: projection }),
			now: sequence("2026-07-15T00:00:01.000Z", "2026-07-15T00:00:01.100Z"),
			retryDelayMs: 1,
		});
		const result = await dispatcher.dispatchAvailable({ ownerId: "projector-a", limit: 10, maxAttempts: 1 });
		expect(result).toMatchObject({ delivered: 1, deadLettered: 1 });
		expect(langfuseDeliveries).toBe(1);
		const leased = store.leaseAgentV2Outbox({
			ownerId: "projector-b",
			kinds: ["workspace_diagnostic"],
			limit: 10,
			now: "2026-07-15T00:00:02.000Z",
			leaseTtlMs: 1000,
		});
		expect(leased).toEqual([]);
		const db = new DatabaseSync(dbFile);
		const deadLetter = db
			.prepare("SELECT last_error_code, last_error_message FROM agent_v2_outbox WHERE kind='workspace_diagnostic'")
			.get() as { last_error_code: string; last_error_message: string };
		db.close();
		expect(deadLetter).toEqual({
			last_error_code: "agent_v2.outbox_delivery_failed",
			last_error_message: "Agent v2 outbox delivery failed",
		});
		expect(JSON.stringify(deadLetter)).not.toContain("raw-secret");
		const dbJson = JSON.stringify(store.listAgentV2Diagnostics("client-a", "run-a"));
		expect(dbJson).not.toContain("raw-secret");
	});
});

function harness(): { store: RuntimeDbStore; workspace: WorkspaceDiagnosticLogService; dbFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-diagnostic-outbox-"));
	roots.push(root);
	const dbFile = join(root, "runtime.db");
	const store = new RuntimeDbStore(dbFile);
	stores.push(store);
	store.ensureAgentV2Schema();
	store.createAgentV2Run({
		clientId: "client-a",
		runId: "run-a",
		input: { objective: "test" },
		model: { provider: "test", model: "test" },
		createdAt: "2026-07-15T00:00:00.000Z",
		updatedAt: "2026-07-15T00:00:00.000Z",
	});
	const workspace = new WorkspaceDiagnosticLogService({
		...loadStorageConfig(root),
		logsDbFile: join(root, "diagnostics.db"),
		logStdoutEnabled: false,
		langfuseEnabled: false,
	});
	diagnostics.push(workspace);
	return { store, workspace, dbFile };
}

function rawDiagnostic(): AgentV2DiagnosticEvent {
	return {
		diagnosticId: "diag-a",
		clientId: "client-a",
		runId: "run-a",
		severity: "error",
		category: "model",
		code: "provider.failed",
		message: "provider failed token=raw-secret",
		data: { authorization: "Bearer raw-secret", url: "https://u:p@test/?token=raw-secret" },
		createdAt: "2026-07-15T00:00:00.500Z",
	};
}

function sequence(...values: string[]): () => string {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)]!;
}
