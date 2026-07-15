import { toWorkspaceDiagnosticEvent } from "./agent-v2-diagnostics.js";
export function createAgentV2DiagnosticProjectionAdapters(options) {
    return [workspaceDiagnosticAdapter(options), langfuseDiagnosticAdapter(options)];
}
function workspaceDiagnosticAdapter(options) {
    return {
        kind: "workspace_diagnostic",
        async deliver(intent) {
            const diagnostic = await canonicalDiagnostic(options.store, intent);
            options.diagnostics.writeProjectedEvent(intent.dedupeKey, toWorkspaceDiagnosticEvent(diagnostic));
        },
    };
}
function langfuseDiagnosticAdapter(options) {
    return {
        kind: "langfuse_diagnostic",
        async deliver(intent, signal) {
            const diagnostic = await canonicalDiagnostic(options.store, intent);
            await options.diagnostics.deliverLangfuse([toWorkspaceDiagnosticEvent(diagnostic)], signal);
        },
    };
}
async function canonicalDiagnostic(store, intent) {
    if (intent.reference.kind !== "workspace_diagnostic" && intent.reference.kind !== "langfuse_diagnostic") {
        throw new Error("Agent v2 diagnostic projection received an invalid reference");
    }
    const diagnosticId = intent.reference.diagnosticId;
    const diagnostics = await store.listAgentV2Diagnostics(intent.clientId, intent.runId);
    const diagnostic = diagnostics.find((candidate) => candidate.diagnosticId === diagnosticId);
    if (!diagnostic)
        throw new Error("Agent v2 canonical diagnostic is missing");
    return diagnostic;
}
//# sourceMappingURL=agent-v2-diagnostic-projections.js.map