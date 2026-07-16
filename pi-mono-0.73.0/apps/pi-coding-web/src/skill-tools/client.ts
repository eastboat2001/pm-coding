import type { SkillListDetails } from "./schemas.js";

const READ_REQUEST_TIMEOUT_MS = 1000;
const TOOL_REQUEST_TIMEOUT_MS = 5000;

type SkillApiRequestOptions = {
	method?: "GET" | "POST";
	body?: unknown;
	allowMissing?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export async function loadServerSkillList(): Promise<SkillListDetails> {
	try {
		return await requestSkillApi<SkillListDetails>("", {
			method: "GET",
			timeoutMs: READ_REQUEST_TIMEOUT_MS,
		});
	} catch (error) {
		return {
			skills: [],
			diagnostics: [
				{
					type: "error",
					path: "/api/pi-skills",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

export function requestSkillApi<T>(
	path: string,
	options: SkillApiRequestOptions & { allowMissing: true },
): Promise<T | null>;
export function requestSkillApi<T>(
	path: string,
	options?: SkillApiRequestOptions & { allowMissing?: false | undefined },
): Promise<T>;
export async function requestSkillApi<T>(path: string, options: SkillApiRequestOptions = {}): Promise<T | null> {
	const endpoint = new URL(`/api/pi-skills${path}`, window.location.origin).toString();
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? TOOL_REQUEST_TIMEOUT_MS);
	const signal = mergeAbortSignals(timeoutController.signal, options.signal);
	try {
		const response = await fetch(endpoint, {
			method: options.method || "POST",
			headers: options.body ? { "Content-Type": "application/json" } : undefined,
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal,
		});
		if (options.allowMissing && response.status === 404) return null;
		const data = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) throw new Error(data.error || `Skill API failed with HTTP ${response.status}`);
		return data;
	} catch (error) {
		if (options.allowMissing) return null;
		if (error instanceof DOMException && error.name === "AbortError") throw new Error("请求已取消。");
		throw new Error(
			`无法连接 PI Skill API：${endpoint}。原始错误：${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeoutId);
	}
}

function mergeAbortSignals(timeoutSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
	if (!callerSignal) return timeoutSignal;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (timeoutSignal.aborted || callerSignal.aborted) {
		controller.abort();
		return controller.signal;
	}
	timeoutSignal.addEventListener("abort", abort, { once: true });
	callerSignal.addEventListener("abort", abort, { once: true });
	return controller.signal;
}
