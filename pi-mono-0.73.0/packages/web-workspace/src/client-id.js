const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeClientId(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("X-PI-Client-ID is required");
    }
    const normalized = value.trim().toLowerCase();
    if (!CLIENT_ID_PATTERN.test(normalized)) {
        throw new Error("Invalid X-PI-Client-ID");
    }
    return normalized;
}
export function readClientIdHeader(req) {
    const value = req.headers["x-pi-client-id"];
    return normalizeClientId(Array.isArray(value) ? value[0] : value);
}
//# sourceMappingURL=client-id.js.map