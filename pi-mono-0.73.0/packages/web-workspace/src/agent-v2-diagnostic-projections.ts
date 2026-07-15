import { toWorkspaceDiagnosticEvent, type WorkspaceDiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2OutboxDeliveryAdapter } from "./agent-v2-outbox-dispatcher.js";
import type { AgentV2RuntimeSnapshotStore } from "./agent-v2-runtime-store.js";

export interface AgentV2WorkspaceDiagnosticProjection {
	writeProjectedEvent(projectionKey: string, event: WorkspaceDiagnosticEvent): "projected" | "already_projected";
	deliverLangfuse(events: WorkspaceDiagnosticEvent[], signal: AbortSignal): Promise<void>;
}

export function createAgentV2DiagnosticProjectionAdapters(options: {
	store: Pick<AgentV2RuntimeSnapshotStore, "listAgentV2Diagnostics">;
	diagnostics: AgentV2WorkspaceDiagnosticProjection;
}): readonly AgentV2OutboxDeliveryAdapter[] {
	return [workspaceDiagnosticAdapter(options), langfuseDiagnosticAdapter(options)];
}

function workspaceDiagnosticAdapter(options: {
	store: Pick<AgentV2RuntimeSnapshotStore, "listAgentV2Diagnostics">;
	diagnostics: AgentV2WorkspaceDiagnosticProjection;
}): AgentV2OutboxDeliveryAdapter<"workspace_diagnostic"> {
	return {
		kind: "workspace_diagnostic",
		async deliver(intent): Promise<void> {
			const diagnostic = await canonicalDiagnostic(options.store, intent);
			options.diagnostics.writeProjectedEvent(intent.dedupeKey, toWorkspaceDiagnosticEvent(diagnostic));
		},
	};
}

function langfuseDiagnosticAdapter(options: {
	store: Pick<AgentV2RuntimeSnapshotStore, "listAgentV2Diagnostics">;
	diagnostics: AgentV2WorkspaceDiagnosticProjection;
}): AgentV2OutboxDeliveryAdapter<"langfuse_diagnostic"> {
	return {
		kind: "langfuse_diagnostic",
		async deliver(intent, signal): Promise<void> {
			const diagnostic = await canonicalDiagnostic(options.store, intent);
			await options.diagnostics.deliverLangfuse([toWorkspaceDiagnosticEvent(diagnostic)], signal);
		},
	};
}

async function canonicalDiagnostic(
	store: Pick<AgentV2RuntimeSnapshotStore, "listAgentV2Diagnostics">,
	intent: Parameters<AgentV2OutboxDeliveryAdapter["deliver"]>[0],
) {
	if (intent.reference.kind !== "workspace_diagnostic" && intent.reference.kind !== "langfuse_diagnostic") {
		throw new Error("Agent v2 diagnostic projection received an invalid reference");
	}
	const diagnosticId = intent.reference.diagnosticId;
	const diagnostics = await store.listAgentV2Diagnostics(intent.clientId, intent.runId);
	const diagnostic = diagnostics.find((candidate) => candidate.diagnosticId === diagnosticId);
	if (!diagnostic) throw new Error("Agent v2 canonical diagnostic is missing");
	return diagnostic;
}
