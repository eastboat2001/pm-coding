import { isIP } from "node:net";
export function parseExactRegistryOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== "https:" ||
        url.origin !== value ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !isCanonicalDnsHostname(url.hostname)) {
        return undefined;
    }
    const port = url.port ? Number(url.port) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
        return undefined;
    return { origin: url.origin, hostname: url.hostname, port };
}
function isCanonicalDnsHostname(hostname) {
    if (hostname.length === 0 || hostname.length > 253 || isIP(hostname) !== 0)
        return false;
    const labels = hostname.split(".");
    return labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
//# sourceMappingURL=registry-origin.js.map