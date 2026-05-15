import { PI_CODING_HANDOFF_INSTRUCTIONS } from "../prompts/coding-system-prompt.js";

export type PmHandoffDocument = {
	kind: string;
	filename: string;
	mime_type: string;
	download_url: string;
};

export type PmHandoffPayload = {
	source: string;
	transport: string;
	session_id: string;
	title: string;
	documents_ready: boolean;
	implementation_prompt?: string;
	documents?: PmHandoffDocument[];
	expires_at?: string;
};

export function buildPmApiUrl(path: string, currentHref = window.location.href): string {
	const url = new URL(currentHref);
	const baseUrl = url.searchParams.get("pm_api_base_url");
	if (!baseUrl) throw new Error("Missing pm_api_base_url query parameter");
	return new URL(path, baseUrl).toString();
}

export async function fetchPmHandoffPayload(token: string): Promise<PmHandoffPayload> {
	const response = await fetch(buildPmApiUrl(`/api/coding-handoffs/${encodeURIComponent(token)}`));
	const data = (await response.json().catch(() => ({}))) as PmHandoffPayload & { error?: string };
	if (!response.ok) throw new Error(data.error || `Failed to resolve handoff: ${response.status}`);
	return data;
}

export function buildCodingHandoffPrompt(payload: PmHandoffPayload): string {
	const sourcePrompt = (payload.implementation_prompt || "").trim();
	if (!sourcePrompt) return PI_CODING_HANDOFF_INSTRUCTIONS;
	return `${sourcePrompt}\n\n---\n\n${PI_CODING_HANDOFF_INSTRUCTIONS}`;
}
