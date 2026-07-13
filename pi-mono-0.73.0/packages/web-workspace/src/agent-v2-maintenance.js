import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_V2_RESET_CONFIRMATION, assertAgentV2ResetConfirmation, } from "./agent-v2-reset.js";
export { AGENT_V2_RESET_CONFIRMATION };
export async function resetAgentV2Runtime(options) {
    assertAgentV2ResetConfirmation(options.confirmation);
    const store = await options.store.resetAgentV2RuntimeData({
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
export function clearAgentV2GeneratedProjectWorkspaces(clientsRootDir) {
    let projectDirectoriesDeleted = 0;
    if (!isDirectory(clientsRootDir)) {
        return { projectDirectoriesDeleted };
    }
    for (const client of readdirSync(clientsRootDir, { withFileTypes: true })) {
        if (!client.isDirectory())
            continue;
        const sessionsDir = join(clientsRootDir, client.name, "sessions");
        if (!isDirectory(sessionsDir))
            continue;
        for (const session of readdirSync(sessionsDir, { withFileTypes: true })) {
            if (!session.isDirectory())
                continue;
            const projectDir = join(sessionsDir, session.name, "project");
            if (!isDirectory(projectDir))
                continue;
            rmSync(projectDir, { force: true, recursive: true });
            projectDirectoriesDeleted += 1;
        }
    }
    return { projectDirectoriesDeleted };
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=agent-v2-maintenance.js.map