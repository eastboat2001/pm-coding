import { isIP } from "node:net";

export interface ExactRegistryOrigin {
	origin: string;
	hostname: string;
	port: number;
}

export function parseExactRegistryOrigin(value: string): ExactRegistryOrigin | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (
		url.protocol !== "https:" ||
		url.origin !== value ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.username ||
		url.password ||
		!isCanonicalDnsHostname(url.hostname)
	) {
		return undefined;
	}
	const port = url.port ? Number(url.port) : 443;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return { origin: url.origin, hostname: url.hostname, port };
}

function isCanonicalDnsHostname(hostname: string): boolean {
	if (hostname.length === 0 || hostname.length > 253 || isIP(hostname) !== 0) return false;
	const labels = hostname.split(".");
	return labels.every(
		(label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
	);
}
