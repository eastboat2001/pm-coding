function isPromiseLike(value) {
    return typeof value?.then === "function";
}
function withDiagnosticsDeleted(storeResult, diagnosticsDeleted) {
    if (diagnosticsDeleted === undefined)
        return { ...storeResult };
    return {
        ...storeResult,
        diagnosticsDeleted,
    };
}
function finalizeResetResult(storeResult, options, diagnostics) {
    const diagnosticsDeleted = options.includeDiagnostics ? diagnostics?.clearAgentV2Diagnostics?.() : undefined;
    if (isPromiseLike(diagnosticsDeleted)) {
        return diagnosticsDeleted.then((deleted) => withDiagnosticsDeleted(storeResult, deleted));
    }
    return withDiagnosticsDeleted(storeResult, diagnosticsDeleted);
}
export function assertAgentV2ResetConfirmation(confirmation) {
    if (confirmation !== "application-generation-agent-v2") {
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
