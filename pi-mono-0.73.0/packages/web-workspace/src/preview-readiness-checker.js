import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PROJECT_METADATA_FILE } from "./constants.js";
import { isObject, readJsonFile } from "./json.js";
import { workspaceContext } from "./workspace-paths.js";
const DEFAULT_PREVIEW_PROBE_TIMEOUT_MS = 5_000;
export class PreviewReadinessChecker {
    config;
    fetchImpl;
    probeTimeoutMs;
    constructor(config, options) {
        this.config = config;
        this.fetchImpl = options?.fetch ?? fetch;
        this.probeTimeoutMs = positiveTimeoutMs(options?.probeTimeoutMs, DEFAULT_PREVIEW_PROBE_TIMEOUT_MS);
    }
    async check(input) {
        const context = workspaceContext(this.config, input);
        const metadataPath = join(context.projectDir, PROJECT_METADATA_FILE);
        const metadata = this.readProjectMetadata(metadataPath);
        if (!metadata) {
            return this.notReady("missing_project_metadata", { projectId: context.projectId });
        }
        const projectId = context.projectId;
        const metadataProjectId = stringValue(metadata.projectId).trim();
        const status = stringValue(metadata.status);
        const base = { projectId, status };
        if (metadataProjectId && metadataProjectId !== projectId) {
            return this.notReady("missing_project_metadata", base, `Project metadata projectId does not match workspace projectId. metadata:${metadataProjectId}`);
        }
        if (status !== "running") {
            return this.notReady("html_error_page", base, `Project metadata status is not running. status:${status}`);
        }
        const previewUrl = stringValue(metadata.previewUrl).trim();
        if (!previewUrl) {
            return this.notReady("preview_url_missing", base);
        }
        const probeUrl = this.probeUrl(projectId, previewUrl);
        if (!probeUrl) {
            return this.notReady("preview_url_missing", { ...base, previewUrl });
        }
        const serveRoot = stringValue(metadata.serveRoot).trim();
        if (!serveRoot || !pathIsInsideRealPath(context.projectDir, serveRoot) || !pathIsDirectory(serveRoot)) {
            return this.notReady("serve_root_missing", { ...base, previewUrl });
        }
        const indexPath = join(serveRoot, "index.html");
        if (!pathIsInsideRealPath(context.projectDir, indexPath) || !pathIsFile(indexPath)) {
            return this.notReady("index_html_missing", { ...base, previewUrl });
        }
        const fileHtml = readFileSync(indexPath, "utf8");
        if (!fileHtml.trim()) {
            return this.notReady("index_html_empty", { ...base, previewUrl });
        }
        const httpResult = await this.fetchHtml(probeUrl);
        if (!httpResult.ok) {
            return this.notReady("http_not_ok", { ...base, previewUrl }, httpResult.detail);
        }
        const html = httpResult.html;
        if (looksLikeErrorPage(html)) {
            return this.notReady("html_error_page", { ...base, previewUrl });
        }
        if (!hasBasicHtmlContent(html)) {
            return this.notReady("html_no_basic_content", { ...base, previewUrl });
        }
        const missingResources = missingLocalStaticResources(html, projectId, serveRoot);
        if (missingResources.length > 0) {
            const shownResources = missingResources.slice(0, 8).join(", ");
            const extraCount = missingResources.length - 8;
            const detail = extraCount > 0
                ? `Missing static resources: ${shownResources}, and ${extraCount} more`
                : `Missing static resources: ${shownResources}`;
            return this.notReady("static_resource_missing", { ...base, previewUrl }, detail);
        }
        return {
            ready: true,
            reasonCode: "ready",
            projectId,
            previewUrl,
            status,
        };
    }
    probeUrl(projectId, previewUrl) {
        const previewBaseUrl = this.config.previewBaseUrl.trim();
        const previewPath = `/preview/${encodeURIComponent(projectId)}/`;
        if (previewBaseUrl) {
            try {
                return new URL(previewPath, previewBaseUrl).toString();
            }
            catch {
                return undefined;
            }
        }
        try {
            const parsedPreviewUrl = new URL(previewUrl);
            return parsedPreviewUrl.pathname.startsWith(previewPath) ? parsedPreviewUrl.toString() : undefined;
        }
        catch {
            return undefined;
        }
    }
    readProjectMetadata(metadataPath) {
        if (!existsSync(metadataPath))
            return undefined;
        try {
            const metadata = readJsonFile(metadataPath);
            return isObject(metadata) ? metadata : undefined;
        }
        catch {
            return undefined;
        }
    }
    async fetchHtml(previewUrl) {
        const abortController = new AbortController();
        let timedOut = false;
        let timeoutId;
        const timeout = this.probeTimeoutMs > 0
            ? new Promise((_resolve, reject) => {
                timeoutId = setTimeout(() => {
                    timedOut = true;
                    abortController.abort();
                    reject(new Error(`Preview probe timed out after ${this.probeTimeoutMs}ms`));
                }, this.probeTimeoutMs);
            })
            : undefined;
        const fetchResult = this.fetchImpl(previewUrl, { signal: abortController.signal });
        try {
            const response = await (timeout ? Promise.race([fetchResult, timeout]) : fetchResult);
            if (!response.ok) {
                return { ok: false, detail: `HTTP ${response.status}` };
            }
            return { ok: true, html: await response.text() };
        }
        catch (error) {
            if (timedOut || abortController.signal.aborted) {
                return { ok: false, detail: `Preview probe timed out after ${this.probeTimeoutMs}ms` };
            }
            return { ok: false, detail: errorMessage(error) };
        }
        finally {
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
        }
    }
    notReady(reasonCode, base, detail) {
        return {
            ready: false,
            reasonCode,
            ...(base.projectId ? { projectId: base.projectId } : {}),
            ...(base.previewUrl ? { previewUrl: base.previewUrl } : {}),
            ...(base.status ? { status: base.status } : {}),
            ...(detail ? { detail } : {}),
        };
    }
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
function positiveTimeoutMs(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function pathIsDirectory(path) {
    try {
        return existsSync(path) && statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function pathIsInsideRealPath(root, target) {
    try {
        const resolvedRoot = normalizePathForContainment(realpathSync.native(root));
        const resolvedTarget = normalizePathForContainment(realpathSync.native(target));
        const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
        return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(prefix);
    }
    catch {
        return false;
    }
}
function pathIsInsideResolvedPath(root, target) {
    const resolvedRoot = normalizePathForContainment(resolve(root));
    const resolvedTarget = normalizePathForContainment(resolve(target));
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(prefix);
}
function pathIsFile(path) {
    try {
        return existsSync(path) && statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function looksLikeErrorPage(html) {
    const text = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const markers = [
        "preview not found",
        "preview output is missing",
        "preview entry file is missing",
        "vite error",
        "internal server error",
    ];
    return markers.some((marker) => text.includes(marker));
}
function hasBasicHtmlContent(html) {
    const bodyHtml = bodyContent(html);
    if (!bodyHtml.trim())
        return false;
    const visibleText = bodyHtml
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z0-9#]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (visibleText.length > 0)
        return true;
    if (/<script\b[^>]*\bsrc\s*=/i.test(bodyHtml))
        return true;
    return /<(main|section|article|div|canvas|svg|img|iframe)\b[^>]*>/i.test(bodyHtml);
}
function missingLocalStaticResources(html, projectId, serveRoot) {
    const missing = new Set();
    for (const reference of localStaticResourceReferences(html)) {
        const resource = resolveLocalResourceReference(reference, projectId, serveRoot);
        if (!resource)
            continue;
        if (!pathIsInsideResolvedPath(serveRoot, resource.absolutePath) || !pathIsFile(resource.absolutePath)) {
            missing.add(resource.detailPath);
        }
    }
    return [...missing].sort();
}
function localStaticResourceReferences(html) {
    const references = [];
    const tagPattern = /<(script|link|img|source|video|audio|track)\b[^>]*>/gi;
    let match;
    while ((match = tagPattern.exec(html)) !== null) {
        const tag = match[0];
        const tagName = match[1]?.toLowerCase();
        if (tagName === "link") {
            const rel = attributeValue(tag, "rel")?.toLowerCase() ?? "";
            if (!/\b(stylesheet|preload|modulepreload)\b/.test(rel))
                continue;
            const href = attributeValue(tag, "href");
            if (href)
                references.push(href);
            continue;
        }
        const src = attributeValue(tag, "src");
        if (src)
            references.push(src);
    }
    return references;
}
function attributeValue(tag, attribute) {
    const pattern = attribute === "href"
        ? /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
        : attribute === "rel"
            ? /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
            : /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
    const match = pattern.exec(tag);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}
function resolveLocalResourceReference(reference, projectId, serveRoot) {
    const normalizedReference = localPathReference(reference, projectId);
    if (!normalizedReference)
        return undefined;
    const absolutePath = resolve(serveRoot, normalizedReference);
    return {
        absolutePath,
        detailPath: normalizedReference.replace(/\\/g, "/"),
    };
}
function localPathReference(reference, projectId) {
    const trimmed = reference.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
        return undefined;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed))
        return undefined;
    const withoutQueryOrHash = trimmed.split(/[?#]/, 1)[0]?.trim();
    if (!withoutQueryOrHash)
        return undefined;
    const previewPrefix = `/preview/${encodeURIComponent(projectId)}/`;
    let pathReference = withoutQueryOrHash;
    if (pathReference.startsWith(previewPrefix)) {
        pathReference = pathReference.slice(previewPrefix.length);
    }
    else if (pathReference.startsWith("/")) {
        pathReference = pathReference.slice(1);
    }
    pathReference = pathReference.replace(/^\.\/+/, "");
    if (!pathReference)
        return undefined;
    try {
        return decodeURIComponent(pathReference);
    }
    catch {
        return pathReference;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function bodyContent(html) {
    const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return match?.[1] ?? html;
}
function normalizePathForContainment(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}
//# sourceMappingURL=preview-readiness-checker.js.map