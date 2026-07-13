import { EphemeralContainerBuildRunner, } from "./ephemeral-container-build-runner.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";
export function createWorkspaceTaskService(config, adapters = {}) {
    const previews = adapters.previews ?? new WorkspacePreviewService(config, adapters.diagnostics);
    const buildRunner = adapters.buildRunner ??
        new EphemeralContainerBuildRunner({
            ...adapters.containerBuildRunnerOptions,
            config: config.containerBuild,
        });
    return new WorkspaceTaskService(config, buildRunner, previews, adapters.diagnostics);
}
//# sourceMappingURL=workspace-task-factory.js.map