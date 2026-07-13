export function buildTrustedPreviewUrl(config, projectId) {
    const origin = config.previewBaseUrl || config.previewInternalOrigin;
    return new URL(`/preview/${encodeURIComponent(projectId)}/`, origin).toString();
}
export function normalizePreviewOrigin(value, variableName) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`${variableName} must be an HTTP(S) origin.`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash) {
        throw new Error(`${variableName} must be an HTTP(S) origin without credentials, path, query, or hash.`);
    }
    return parsed.origin;
}
//# sourceMappingURL=preview-origin.js.map