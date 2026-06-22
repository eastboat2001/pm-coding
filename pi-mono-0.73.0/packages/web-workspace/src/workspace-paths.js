import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_MANIFEST_FILE, PROJECT_METADATA_FILE } from "./constants.js";
export function workspaceContext(config, body) {
    const clientId = requiredSafePathId(String(body.clientId || ""), "client");
    const sessionId = String(body.sessionId || "").trim();
    const title = String(body.title || "").trim();
    if (!sessionId)
        throw new Error("Field `sessionId` is required.");
    const projectId = projectSlug(sessionId, clientId);
    const projectDir = projectDirectory(config.clientsRootDir, sessionId, clientId);
    assertInside(config.clientsRootDir, projectDir);
    return { clientId, sessionId, title, projectId, projectDir };
}
export function projectDirectory(clientsRootDir, sessionId, clientId) {
    const safeClientId = requiredSafePathId(clientId, "client");
    const safeSessionId = requiredSafePathId(sessionId, "session");
    return join(clientsRootDir, safeClientId, "sessions", safeSessionId, "project");
}
export function projectSlug(sessionId, clientId) {
    const suffix = projectSlugSuffix(sessionId, clientId);
    return `project-${suffix}`;
}
export function sanitizePathComponent(value) {
    let normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
    normalized = normalized
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "");
    const reserved = new Set([
        "con",
        "prn",
        "aux",
        "nul",
        "com1",
        "com2",
        "com3",
        "com4",
        "com5",
        "com6",
        "com7",
        "com8",
        "com9",
        "lpt1",
        "lpt2",
        "lpt3",
        "lpt4",
        "lpt5",
        "lpt6",
        "lpt7",
        "lpt8",
        "lpt9",
    ]);
    if (reserved.has(normalized))
        normalized = `${normalized}-file`;
    return normalized.slice(0, 80);
}
export function safeRelativeProjectPath(filename) {
    const rawParts = filename
        .replace(/\\/g, "/")
        .split("/")
        .map((part) => part.trim());
    if (rawParts.some((part) => part === ".."))
        throw new Error("Project path component is empty.");
    const parts = rawParts.filter(Boolean).map((part) => sanitizeProjectPathComponent(part));
    if (parts.length === 0)
        throw new Error("Project filename is empty.");
    return join(...parts);
}
export function sanitizeProjectPathComponent(value) {
    if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes(":")) {
        throw new Error(`Invalid project path component: ${value}`);
    }
    const cleaned = value.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/^[-\s]+|[-\s]+$/g, "");
    if (!cleaned)
        throw new Error("Project path component is empty.");
    return cleaned;
}
export function sessionDirectory(clientsRootDir, sessionId, clientId) {
    const safeClientId = requiredSafePathId(clientId, "client");
    const safeSessionId = requiredSafePathId(sessionId, "session");
    const sessionDir = join(clientsRootDir, safeClientId, "sessions", safeSessionId);
    assertInside(clientsRootDir, sessionDir);
    return sessionDir;
}
export function deleteSessionWorkspace(clientsRootDir, sessionId, clientId) {
    const sessionDir = sessionDirectory(clientsRootDir, sessionId, clientId);
    const existed = existsSync(sessionDir);
    rmSync(sessionDir, { recursive: true, force: true });
    return existed;
}
function projectSlugSuffix(sessionId, clientId) {
    const safeSessionId = requiredSafePathId(sessionId, "session");
    const safeClientId = requiredSafePathId(clientId, "client");
    return `${safeClientId.slice(0, 8)}-${safeSessionId.slice(0, 8)}`;
}
function requiredSafePathId(value, label) {
    const safeValue = sanitizePathComponent(value);
    if (!safeValue)
        throw new Error(`Invalid ${label} id.`);
    return safeValue;
}
export function listProjectSourceFiles(root) {
    if (!existsSync(root))
        return [];
    const excludedDirs = new Set([".git", ".pi", "node_modules", ".next", ".nuxt", "dist", "build", "coverage"]);
    const excludedFiles = new Set([PROJECT_METADATA_FILE, PROJECT_MANIFEST_FILE]);
    const result = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (excludedDirs.has(entry.name))
                continue;
            result.push(...listProjectSourceFiles(path));
        }
        if (entry.isFile() && !excludedFiles.has(entry.name))
            result.push(path);
    }
    return result;
}
export function safeRelativePreviewPath(parts) {
    const cleaned = parts.filter((part) => part && part !== "." && part !== ".." && !part.includes("/") && !part.includes("\\"));
    if (cleaned.length === 0)
        return "index.html";
    return join(...cleaned);
}
export function pruneEmptyDirectories(root) {
    if (!existsSync(root) || !statSync(root).isDirectory())
        return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            pruneEmptyDirectories(path);
    }
    if (readdirSync(root).length === 0)
        rmSync(root, { force: true, recursive: true });
}
export function assertInside(root, target) {
    const resolvedRoot = resolve(root);
    const resolvedTarget = resolve(target);
    if (resolvedTarget !== resolvedRoot &&
        !resolvedTarget.startsWith(`${resolvedRoot}${resolve(root).includes("\\") ? "\\" : "/"}`)) {
        throw new Error("Resolved path escapes configured root.");
    }
}
//# sourceMappingURL=workspace-paths.js.map