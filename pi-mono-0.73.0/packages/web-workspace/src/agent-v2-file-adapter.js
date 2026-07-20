import { createHash } from "node:crypto";
import { extname } from "node:path";
import { createAgentV2ToolFailure } from "./agent-v2-tool-governance.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";
export function createAgentV2FileAdapter(input) {
    const files = input.files ?? new WorkspaceFileService(input.config);
    const context = {
        clientId: input.context.clientId,
        sessionId: input.context.sessionId,
        title: input.context.title,
    };
    const projectRoot = files.ensureProjectWorkspace(context).projectRoot;
    const writePathGuard = WorkspacePathGuard.forProjectContent(projectRoot);
    const artifactFor = (path, content, taskId, checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`) => ({
        artifactId: `file:${normalizeV2Path(path)}`,
        kind: "source",
        path: normalizeV2Path(path),
        mediaType: mediaTypeForPath(path),
        checksum,
        version: "v2",
        sourceTaskId: taskId,
        validationStatus: "not_started",
        metadataJson: {},
    });
    const mapError = (error, path) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof WorkspacePathAuthorizationError) {
            throw new Error(JSON.stringify(createAgentV2ToolFailure({
                code: "file.path_invalid",
                message,
                retryable: false,
                path: typeof path === "string" ? normalizeV2Path(path) : undefined,
                data: {},
            })));
        }
        throw error;
    };
    const publicPath = (path) => normalizeV2Path(path);
    return {
        validateWritePath(path) {
            try {
                return publicPath(writePathGuard.authorizeNew(path).relativePath);
            }
            catch (error) {
                return mapError(error, path);
            }
        },
        listFiles() {
            const result = files.handle({ ...context, command: "list" });
            return { files: Array.isArray(result.files) ? result.files.map((path) => publicPath(String(path))) : [] };
        },
        readFile(path) {
            try {
                const result = files.readProjectFilePreview({
                    ...context,
                    filename: path,
                    maxBytes: Number.MAX_SAFE_INTEGER,
                });
                return {
                    path: publicPath(typeof result.filename === "string" ? result.filename : path),
                    content: typeof result.content === "string" ? result.content : "",
                    truncated: Boolean(result.truncated),
                    byteLength: result.size,
                    checksum: `sha256:${result.hash}`,
                };
            }
            catch (error) {
                return mapError(error, path);
            }
        },
        writeFile(write) {
            try {
                const result = files.handle({
                    ...context,
                    command: write.mode,
                    filename: write.path,
                    content: write.content,
                });
                const path = publicPath(typeof result.filename === "string" ? result.filename : write.path);
                return {
                    path,
                    action: result.action === "created" ? "created" : "updated",
                    artifact: artifactFor(path, write.content, write.taskId),
                };
            }
            catch (error) {
                return mapError(error, write.path);
            }
        },
        patchFile(patch) {
            try {
                const result = files.handle({
                    ...context,
                    command: "update",
                    filename: patch.path,
                    old_str: patch.oldText,
                    new_str: patch.newText,
                });
                const persistedPath = typeof result.filename === "string" ? result.filename : patch.path;
                const path = publicPath(persistedPath);
                const persisted = files.readProjectFilePreview({ ...context, filename: persistedPath });
                return {
                    path,
                    action: "updated",
                    artifact: artifactFor(path, persisted.content, patch.taskId, `sha256:${persisted.hash}`),
                };
            }
            catch (error) {
                return mapError(error, patch.path);
            }
        },
    };
}
function normalizeV2Path(path) {
    return path.replace(/\\/g, "/");
}
function mediaTypeForPath(path) {
    const extension = extname(path).toLowerCase();
    if (extension === ".html")
        return "text/html";
    if (extension === ".css")
        return "text/css";
    if (extension === ".js" || extension === ".mjs")
        return "text/javascript";
    if (extension === ".json")
        return "application/json";
    if (extension === ".md")
        return "text/markdown";
    return "text/plain";
}
//# sourceMappingURL=agent-v2-file-adapter.js.map