import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentV2RunEventBus, AgentV2RunEventBusPurgeResult } from "./agent-v2-run-event-bus.js";
import type { AgentV2RunQueue } from "./agent-v2-run-queue.js";
import {
	AGENT_V2_RESET_CONFIRMATION,
	type AgentV2ResetDiagnosticsAdapter,
	assertAgentV2ResetConfirmation,
} from "./agent-v2-reset.js";
import type { AgentV2ResetStore, AgentV2ResetStoreResult } from "./agent-v2-runtime-store.js";
import type { RunQueueClearResult } from "./run-queue.js";

export { AGENT_V2_RESET_CONFIRMATION };

export interface AgentV2RuntimeResetOptions {
	store: AgentV2ResetStore;
	queue?: Pick<AgentV2RunQueue, "clear">;
	eventBus?: Pick<AgentV2RunEventBus, "purge">;
	diagnostics?: AgentV2ResetDiagnosticsAdapter;
	clientsRootDir?: string;
	includeClients?: boolean;
	includeDiagnostics?: boolean;
	includeQueue?: boolean;
	includeLiveEvents?: boolean;
	includeGeneratedProjects?: boolean;
	confirmation?: string;
	now?: () => string;
}

export interface AgentV2GeneratedProjectCleanupResult {
	projectDirectoriesDeleted: number;
}

export interface AgentV2RuntimeResetResult {
	store: AgentV2ResetStoreResult;
	queue?: RunQueueClearResult;
	liveEvents?: AgentV2RunEventBusPurgeResult;
	diagnosticsDeleted?: number;
	generatedProjects?: AgentV2GeneratedProjectCleanupResult;
}

export async function resetAgentV2Runtime(
	options: AgentV2RuntimeResetOptions,
): Promise<AgentV2RuntimeResetResult> {
	assertAgentV2ResetConfirmation(options.confirmation);
	const store = await options.store.resetAgentV2RuntimeData({
		includeClients: options.includeClients,
		now: options.now,
	});
	const [queue, liveEvents, diagnostics, generatedProjects] = await Promise.all([
		options.includeQueue && options.queue ? options.queue.clear() : undefined,
		options.includeLiveEvents && options.eventBus ? options.eventBus.purge() : undefined,
		options.includeDiagnostics && options.diagnostics?.clearAgentV2Diagnostics
			? options.diagnostics.clearAgentV2Diagnostics()
			: undefined,
		options.includeGeneratedProjects && options.clientsRootDir
			? clearAgentV2GeneratedProjectWorkspaces(options.clientsRootDir)
			: undefined,
	]);
	return { store, queue, liveEvents, diagnosticsDeleted: diagnostics, generatedProjects };
}

export function clearAgentV2GeneratedProjectWorkspaces(
	clientsRootDir: string,
): AgentV2GeneratedProjectCleanupResult {
	let projectDirectoriesDeleted = 0;
	if (!isDirectory(clientsRootDir)) {
		return { projectDirectoriesDeleted };
	}

	for (const client of readdirSync(clientsRootDir, { withFileTypes: true })) {
		if (!client.isDirectory()) continue;
		const sessionsDir = join(clientsRootDir, client.name, "sessions");
		if (!isDirectory(sessionsDir)) continue;

		for (const session of readdirSync(sessionsDir, { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			const projectDir = join(sessionsDir, session.name, "project");
			if (!isDirectory(projectDir)) continue;
			rmSync(projectDir, { force: true, recursive: true });
			projectDirectoriesDeleted += 1;
		}
	}

	return { projectDirectoriesDeleted };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
