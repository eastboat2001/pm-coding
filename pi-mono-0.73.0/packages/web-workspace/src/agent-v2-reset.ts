import type {
	AgentV2ResetStore,
	AgentV2StoreResult,
	AgentV2ResetStoreOptions as RuntimeStoreResetOptions,
	AgentV2ResetStoreResult as RuntimeStoreResetResult,
} from "./agent-v2-runtime-store.js";

export const AGENT_V2_RESET_CONFIRMATION = "application-generation-agent-v2";

export interface AgentV2ResetOptions extends RuntimeStoreResetOptions {
	includeDiagnostics?: boolean;
	confirmation?: string;
}

export interface AgentV2ResetResult extends RuntimeStoreResetResult {
	diagnosticsDeleted?: number;
	runsDeleted: number;
}

export interface AgentV2ResetDiagnosticsAdapter {
	clearAgentV2Diagnostics?(): AgentV2StoreResult<number>;
}

type SyncResetCapableStore = AgentV2ResetStore & {
	resetAgentV2RuntimeData(options?: RuntimeStoreResetOptions): RuntimeStoreResetResult;
};

export function assertAgentV2ResetConfirmation(confirmation: string | undefined): void {
	if (confirmation !== AGENT_V2_RESET_CONFIRMATION) {
		throw new Error("Refusing destructive Agent v2 reset without confirmation token");
	}
}

/**
 * DB/log-sink reset compatibility wrapper. Use resetAgentV2Runtime for full
 * operational runtime cleanup.
 */
export function resetAgentV2RuntimeData(
	store: SyncResetCapableStore,
	options?: AgentV2ResetOptions,
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): AgentV2ResetResult;
export function resetAgentV2RuntimeData(
	store: AgentV2ResetStore,
	options?: AgentV2ResetOptions,
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): AgentV2StoreResult<AgentV2ResetResult>;
export function resetAgentV2RuntimeData(
	store: AgentV2ResetStore,
	options: AgentV2ResetOptions = {},
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): AgentV2StoreResult<AgentV2ResetResult> {
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

function finalizeResetResult(
	storeResult: RuntimeStoreResetResult,
	options: AgentV2ResetOptions,
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): AgentV2StoreResult<AgentV2ResetResult> {
	const diagnosticsDeleted = options.includeDiagnostics ? diagnostics?.clearAgentV2Diagnostics?.() : undefined;
	if (isPromiseLike(diagnosticsDeleted)) {
		return diagnosticsDeleted.then((deleted) => withDiagnosticsDeleted(storeResult, deleted));
	}
	return withDiagnosticsDeleted(storeResult, diagnosticsDeleted);
}

function withDiagnosticsDeleted(
	storeResult: RuntimeStoreResetResult,
	diagnosticsDeleted: number | undefined,
): AgentV2ResetResult {
	const result = {
		...storeResult,
		runsDeleted: storeResult.agentV2RowsDeleted.agent_v2_runs ?? 0,
	};
	if (diagnosticsDeleted === undefined) return result;
	return {
		...result,
		diagnosticsDeleted,
	};
}

function isPromiseLike<T>(value: AgentV2StoreResult<T> | undefined): value is Promise<T> {
	return typeof (value as { then?: unknown } | undefined)?.then === "function";
}
