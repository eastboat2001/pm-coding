import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";
export function staticServeRootCandidates(hasPackageJson) {
    return hasPackageJson ? ["dist", "build", "public", ""] : ["", "dist", "build", "public"];
}
export function findStaticServeRoot(projectDir, candidates) {
    const guard = WorkspacePathGuard.forProjectContent(projectDir);
    for (const candidate of candidates) {
        let serveRoot;
        let entryPath;
        try {
            serveRoot = candidate
                ? guard.authorizeExisting(candidate, "directory").absolutePath
                : guard.authorizeAbsoluteExisting(projectDir, "directory").absolutePath;
            entryPath = guard.authorizeExisting(candidate ? join(candidate, "index.html") : "index.html", "file").absolutePath;
        }
        catch (error) {
            if (error instanceof WorkspacePathAuthorizationError)
                continue;
            throw error;
        }
        if (indexHtmlRequiresBuild(entryPath))
            continue;
        return serveRoot;
    }
    return undefined;
}
export function findBuildSourceEntry(projectDir, candidates) {
    const guard = WorkspacePathGuard.forProjectContent(projectDir);
    for (const candidate of candidates) {
        try {
            const entryPath = guard.authorizeExisting(candidate ? join(candidate, "index.html") : "index.html", "file").absolutePath;
            if (indexHtmlRequiresBuild(entryPath))
                return entryPath;
        }
        catch (error) {
            if (error instanceof WorkspacePathAuthorizationError)
                continue;
            throw error;
        }
    }
    return undefined;
}
function indexHtmlRequiresBuild(entryPath) {
    const html = readFileSync(entryPath, "utf8");
    for (const source of moduleScriptSources(html)) {
        const normalized = source.split(/[?#]/, 1)[0].toLowerCase();
        if (normalized.endsWith(".ts") || normalized.endsWith(".tsx") || normalized.endsWith(".jsx"))
            return true;
    }
    return false;
}
function moduleScriptSources(html) {
    const sources = [];
    const scriptPattern = /<script\b[^>]*\btype=(["'])module\1[^>]*>/gi;
    for (const match of html.matchAll(scriptPattern)) {
        const tag = match[0];
        const sourceMatch = tag.match(/\bsrc=(["'])([^"']+)\1/i);
        if (sourceMatch?.[2])
            sources.push(sourceMatch[2]);
    }
    return sources;
}
//# sourceMappingURL=static-preview.js.map