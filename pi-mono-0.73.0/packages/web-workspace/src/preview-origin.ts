export interface PreviewOriginConfig {
	previewBaseUrl: string;
	previewInternalOrigin: string;
}

export function buildTrustedPreviewUrl(config: PreviewOriginConfig, projectId: string): string {
	const origin = config.previewBaseUrl || config.previewInternalOrigin;
	return new URL(`/preview/${encodeURIComponent(projectId)}/`, origin).toString();
}

export function normalizePreviewOrigin(value: string, variableName: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${variableName} must be an HTTP(S) origin.`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(`${variableName} must be an HTTP(S) origin without credentials, path, query, or hash.`);
	}
	return parsed.origin;
}
