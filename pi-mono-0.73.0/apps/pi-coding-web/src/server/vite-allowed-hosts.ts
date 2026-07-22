interface PreviewOriginEnvironment {
	readonly PI_PREVIEW_BASE_URL?: string;
	readonly PI_PREVIEW_INTERNAL_ORIGIN?: string;
}

export function configuredViteAllowedHosts(environment: PreviewOriginEnvironment = process.env): string[] {
	const hosts = [
		httpOriginHostname(environment.PI_PREVIEW_INTERNAL_ORIGIN),
		httpOriginHostname(environment.PI_PREVIEW_BASE_URL),
	].filter((host): host is string => host !== undefined);
	return [...new Set(hosts)];
}

function httpOriginHostname(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.hostname || undefined;
	} catch {
		return undefined;
	}
}
