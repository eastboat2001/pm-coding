import type {
	MaybePromise,
	RuntimeStore,
	ResetAgentV2RuntimeDataOptions as RuntimeStoreResetOptions,
	ResetAgentV2RuntimeDataResult as RuntimeStoreResetResult,
} from "./runtime-store.js";

export interface AgentV2ResetOptions extends RuntimeStoreResetOptions {
	includeDiagnostics?: boolean;
	confirmation?: string;
}

export interface AgentV2ResetResult extends RuntimeStoreResetResult {
	diagnosticsDeleted?: number;
}

export interface AgentV2ResetDiagnosticsAdapter {
	clearAgentV2Diagnostics?(): MaybePromise<number>;
}

type SyncResetCapableStore = RuntimeStore & {
	resetAgentV2RuntimeData(options?: RuntimeStoreResetOptions): RuntimeStoreResetResult;
};

export function assertAgentV2ResetConfirmation(confirmation: string | undefined): void {
	if (confirmation !== "application-generation-agent-v2") {
		throw new Error("Refusing destructive Agent v2 reset without confirmation token");
	}
}

export function resetAgentV2RuntimeData(
	store: SyncResetCapableStore,
	options?: AgentV2ResetOptions,
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): AgentV2ResetResult;
export function resetAgentV2RuntimeData(
	store: RuntimeStore,
	options?: AgentV2ResetOptions,
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): MaybePromise<AgentV2ResetResult>;
export function resetAgentV2RuntimeData(
	store: RuntimeStore,
	options: AgentV2ResetOptions = {},
	diagnostics?: AgentV2ResetDiagnosticsAdapter,
): MaybePromise<AgentV2ResetResult> {
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
): MaybePromise<AgentV2ResetResult> {
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
	if (diagnosticsDeleted === undefined) return { ...storeResult };
	return {
		...storeResult,
		diagnosticsDeleted,
	};
}

function isPromiseLike<T>(value: MaybePromise<T> | undefined): value is Promise<T> {
	return typeof (value as { then?: unknown } | undefined)?.then === "function";
}
