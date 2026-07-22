import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listProjectSourceFiles } from "./workspace-paths.js";
const SOURCE_ENTRY = /^src\/(?:.*\/)?(?:main|index|app)\.[cm]?[jt]sx?$/i;
const COMPONENT_SOURCE = /^src\/.*\.[jt]sx$/i;
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_SOURCE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i;
const MODULE_IMPORT = /(?:\bfrom\s*|\bimport\s*\()(["'])([^"']+)\1/g;
export const PROJECT_ENTRY_CONFLICT_PREFIX = "Build project entry conflict:";
export const PROJECT_MANIFEST_MISSING_PREFIX = "Build project manifest missing:";
export function assessProjectEntryConsistency(projectDir) {
    const indexPath = join(projectDir, "index.html");
    if (!existsSync(indexPath))
        return validAssessment();
    const sourceEntries = listProjectSourceFiles(projectDir)
        .map((path) => relative(projectDir, path).replaceAll("\\", "/"))
        .filter((path) => SOURCE_ENTRY.test(path) || COMPONENT_SOURCE.test(path))
        .sort();
    const html = readFileSync(indexPath, "utf8");
    const referencedSources = referencedSourcePaths(html);
    const referencesSourceImplementation = referencedSources.some((path) => path.startsWith("src/"));
    if (sourceEntries.length > 0 && !referencesSourceImplementation && hasSubstantialInlineApplication(html)) {
        return entryConflictAssessment(sourceEntries);
    }
    if (!existsSync(join(projectDir, "package.json"))) {
        const buildSource = referencedSources.find((path) => /\.(?:ts|tsx|jsx)$/i.test(path)) ??
            sourceEntries.find((path) => /\.(?:ts|tsx|jsx)$/i.test(path));
        if (buildSource) {
            return {
                valid: false,
                errors: [
                    `${PROJECT_MANIFEST_MISSING_PREFIX} project contains build source ${buildSource}, but package.json is missing. Add a complete build manifest and lockfile, or convert the project to a dependency-free browser application.`,
                ],
                sourceEntries,
            };
        }
        return validAssessment(sourceEntries);
    }
    if (sourceEntries.length === 0)
        return validAssessment();
    if (referencesSourceImplementation)
        return validAssessment(sourceEntries);
    if (!hasSubstantialInlineApplication(html))
        return validAssessment(sourceEntries);
    return entryConflictAssessment(sourceEntries);
}
function entryConflictAssessment(sourceEntries) {
    const displayedEntries = sourceEntries.slice(0, 8);
    const suffix = sourceEntries.length > displayedEntries.length
        ? `, and ${sourceEntries.length - displayedEntries.length} more`
        : "";
    return {
        valid: false,
        errors: [
            `${PROJECT_ENTRY_CONFLICT_PREFIX} root index.html contains a standalone inline application while source implementation entries are unreferenced: ${displayedEntries.join(", ")}${suffix}. Keep one authoritative implementation and make preview output originate from that implementation's build.`,
        ],
        sourceEntries,
    };
}
export function isProjectEntryConflictMessage(message) {
    return message.trim().startsWith(PROJECT_ENTRY_CONFLICT_PREFIX);
}
export function isProjectManifestMissingMessage(message) {
    const normalized = message.trim();
    return (normalized.startsWith(PROJECT_MANIFEST_MISSING_PREFIX) || normalized === "build_static requires package.json.");
}
function validAssessment(sourceEntries = []) {
    return { valid: true, errors: [], sourceEntries };
}
function referencedSourcePaths(html) {
    const references = [];
    for (const match of html.matchAll(SCRIPT_TAG)) {
        const attributes = match[1] ?? "";
        const content = match[2] ?? "";
        const sourceMatch = SCRIPT_SOURCE.exec(attributes);
        const source = sourceMatch?.[1] ?? sourceMatch?.[2] ?? sourceMatch?.[3];
        if (source)
            references.push(normalizeLocalReference(source));
        if (/\btype\s*=\s*(["'])module\1/i.test(attributes)) {
            for (const importMatch of content.matchAll(MODULE_IMPORT)) {
                if (importMatch[2])
                    references.push(normalizeLocalReference(importMatch[2]));
            }
        }
    }
    return references.filter(Boolean);
}
function normalizeLocalReference(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed))
        return "";
    const path = trimmed
        .split(/[?#]/, 1)[0]
        ?.replace(/^\/+/, "")
        .replace(/^\.\/+/, "") ?? "";
    try {
        return decodeURIComponent(path).replaceAll("\\", "/");
    }
    catch {
        return path.replaceAll("\\", "/");
    }
}
function hasSubstantialInlineApplication(html) {
    const inlineStyleLength = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].reduce((total, match) => total + (match[1]?.trim().length ?? 0), 0);
    let inlineScriptLength = 0;
    for (const match of html.matchAll(SCRIPT_TAG)) {
        if (!SCRIPT_SOURCE.test(match[1] ?? ""))
            inlineScriptLength += match[2]?.trim().length ?? 0;
    }
    const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? "";
    const bodyElementCount = [...body.matchAll(/<[a-z][a-z0-9-]*\b/gi)].length;
    return inlineStyleLength >= 512 || inlineScriptLength >= 512 || (body.length >= 2_000 && bodyElementCount >= 16);
}
//# sourceMappingURL=project-entry-consistency.js.map