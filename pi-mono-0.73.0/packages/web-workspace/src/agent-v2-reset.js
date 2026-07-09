export const AGENT_V2_RESET_CONFIRMATION = "application-generation-agent-v2";
export function assertAgentV2ResetConfirmation(confirmation) {
    if (confirmation !== AGENT_V2_RESET_CONFIRMATION) {
        throw new Error("Refusing destructive Agent v2 reset without confirmation token");
    }
}
export function resetAgentV2RuntimeData(store, options = {}, diagnostics) {
    assertAgentV2ResetConfirmation(options.confirmation);
    const storeResult = store.resetAgentV2RuntimeData({
        includeClients: options.includeClients,
        now: options.now,
    });
    if (isPromiseLike(storeResult)) {
        return storeResult.then((result) => finalizeResetResult(result, options, diagnostics));
    }
    return finalizeResetResult(storeResult, options, diagnostics);
}
function finalizeResetResult(storeResult, options, diagnostics) {
    const diagnosticsDeleted = options.includeDiagnostics ? diagnostics?.clearAgentV2Diagnostics?.() : undefined;
    if (isPromiseLike(diagnosticsDeleted)) {
        return diagnosticsDeleted.then((deleted) => withDiagnosticsDeleted(storeResult, deleted));
    }
    return withDiagnosticsDeleted(storeResult, diagnosticsDeleted);
}
function withDiagnosticsDeleted(storeResult, diagnosticsDeleted) {
    const result = {
        ...storeResult,
        runsDeleted: storeResult.agentV2RowsDeleted.agent_v2_runs ?? 0,
    };
    if (diagnosticsDeleted === undefined)
        return result;
    return {
        ...result,
        diagnosticsDeleted,
    };
}
function isPromiseLike(value) {
    return typeof value?.then === "function";
}
//# sourceMappingURL=agent-v2-reset.js.map