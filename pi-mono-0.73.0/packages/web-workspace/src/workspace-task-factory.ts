import type { BuildRunner } from "./build-runner.js";
import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import {
	EphemeralContainerBuildRunner,
	type EphemeralContainerBuildRunnerOptions,
} from "./ephemeral-container-build-runner.js";
import type { StorageConfig } from "./types.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

export interface WorkspaceTaskServiceAdapters {
	buildRunner?: BuildRunner;
	containerBuildRunnerOptions?: Omit<EphemeralContainerBuildRunnerOptions, "config">;
	previews?: WorkspacePreviewService;
	diagnostics?: WorkspaceDiagnosticLogService;
}

export function createWorkspaceTaskService(
	config: StorageConfig,
	adapters: WorkspaceTaskServiceAdapters = {},
): WorkspaceTaskService {
	const previews = adapters.previews ?? new WorkspacePreviewService(config, adapters.diagnostics);
	const buildRunner =
		adapters.buildRunner ??
		new EphemeralContainerBuildRunner({
			...adapters.containerBuildRunnerOptions,
			config: config.containerBuild,
		});
	return new WorkspaceTaskService(config, buildRunner, previews, adapters.diagnostics);
}
