import { piClientHeaders } from "../runtime/client-id.js";

export async function requestProjectApi<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const endpoint = new URL(path, window.location.origin).toString();
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...piClientHeaders() },
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw new Error("请求已取消。");
		throw new Error(
			`无法连接 PI Server API：${endpoint}。原始错误：${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const result: unknown = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message =
			typeof result === "object" && result !== null && "error" in result
				? String((result as { error: unknown }).error)
				: "";
		throw new Error(message || `Project API failed with HTTP ${response.status}`);
	}
	return result as T;
}
