import type { SkillListDetails } from "./schemas.js";

const READ_REQUEST_TIMEOUT_MS = 1000;
const TOOL_REQUEST_TIMEOUT_MS = 5000;

export async function loadServerSkillList(): Promise<SkillListDetails> {
	return (
		(await requestSkillApi<SkillListDetails>("", {
			method: "GET",
			allowMissing: true,
			timeoutMs: READ_REQUEST_TIMEOUT_MS,
		})) || { skills: [], defaultSkills: [], promptSkills: [], diagnostics: [] }
	);
}

export async function requestSkillApi<T>(
	path: string,
	options: {
		method?: "GET" | "POST";
		body?: unknown;
		allowMissing?: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<T | null> {
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
