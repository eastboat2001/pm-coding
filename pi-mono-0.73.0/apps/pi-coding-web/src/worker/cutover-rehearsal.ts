import { pathToFileURL } from "node:url";

const CHECK_NAMES = [
	"storage-health",
	"v2-run-start",
	"v2-run-read",
	"v2-event-replay",
	"v2-run-cancel",
	"retired-run-route",
	"retired-session-route",
] as const;

export interface AgentV2CutoverCheck {
	name: (typeof CHECK_NAMES)[number];
	ok: boolean;
	detail: string;
}

export interface AgentV2CutoverRehearsalReport {
	ok: boolean;
	runId?: string;
	finalStatus?: string;
	lastEventSeq?: number;
	checks: AgentV2CutoverCheck[];
}

export interface AgentV2CutoverRehearsalOptions {
	baseUrl: string;
	clientId: string;
	model: { provider: string; id: string };
	fetch?: CutoverFetch;
	sleep?: (milliseconds: number) => Promise<void>;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

type CutoverFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RunSnapshot = { runId: string; status: string };
type RequestResult = { response?: Response; detail?: string };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function runAgentV2CutoverRehearsal(
	options: AgentV2CutoverRehearsalOptions,
): Promise<AgentV2CutoverRehearsalReport> {
	const checks: AgentV2CutoverCheck[] = [];
	const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
	const sleep = options.sleep ?? defaultSleep;
	const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
	let runId: string | undefined;
	let finalStatus: string | undefined;
	let lastEventSeq: number | undefined;

	const request = async (path: string, init?: RequestInit): Promise<RequestResult> => {
		try {
			return { response: await fetchFn(new URL(path, options.baseUrl).toString(), init) };
		} catch {
			return { detail: "Request failed." };
		}
	};
	const headers = { "Content-Type": "application/json", "X-PI-Client-ID": options.clientId };

	const health = await request("/api/pi-storage/status", { headers });
	if (!health.response?.ok) {
		checks.push(failedCheck("storage-health", responseDetail(health, "Storage health check failed.")));
		appendSkippedChecks(checks, 1, "Storage health check did not pass.");
		return report(checks, runId, finalStatus, lastEventSeq);
	}
	checks.push(passedCheck("storage-health", "Storage health endpoint returned success."));

	const started = await request("/api/agent-v2/runs/start", {
		method: "POST",
		headers,
		body: JSON.stringify({
			input: {
				prompt: "Production cutover rehearsal. Do not create project files.",
				sessionId: `cutover-rehearsal-${Date.now()}`,
				title: "Production cutover rehearsal",
			},
			model: options.model,
		}),
	});
	const startedRun = started.response?.ok ? await readRunSnapshot(started.response) : undefined;
	if (!startedRun) {
		checks.push(failedCheck("v2-run-start", responseDetail(started, "V2 run start failed.")));
		appendSkippedChecks(checks, 2, "V2 run did not start.");
		return report(checks, runId, finalStatus, lastEventSeq);
	}
	runId = startedRun.runId;
	finalStatus = startedRun.status;
	checks.push(passedCheck("v2-run-start", "V2 run started."));

	const initialRead = await readRun(request, headers, runId);
	if (initialRead.run) {
		finalStatus = initialRead.run.status;
		checks.push(passedCheck("v2-run-read", `V2 run read with status ${finalStatus}.`));
	} else {
		checks.push(failedCheck("v2-run-read", initialRead.detail));
	}

	const replay = initialRead.run
		? await waitForEventReplay(request, headers, runId, timeoutMs, pollIntervalMs, sleep, finalStatus)
		: { ok: false, detail: "V2 run could not be read.", status: finalStatus, seq: 0 };
	finalStatus = replay.status ?? finalStatus;
	lastEventSeq = replay.seq;
	checks.push(replay.ok ? passedCheck("v2-event-replay", replay.detail) : failedCheck("v2-event-replay", replay.detail));

	const cancellation = await cancelRun(request, headers, runId, timeoutMs, pollIntervalMs, sleep, finalStatus);
	finalStatus = cancellation.status ?? finalStatus;
	checks.push(
		cancellation.ok ? passedCheck("v2-run-cancel", cancellation.detail) : failedCheck("v2-run-cancel", cancellation.detail),
	);

	const retiredRun = await request("/api/runs", { headers });
	checks.push(
		retiredRun.response?.status === 410
			? passedCheck("retired-run-route", "Retired run route returned 410.")
			: failedCheck("retired-run-route", responseDetail(retiredRun, "Retired run route did not return 410.")),
	);

	const retiredSession = await request("/api/pi-sessions", { headers });
	checks.push(
		retiredSession.response?.status === 410
			? passedCheck("retired-session-route", "Retired session route returned 410.")
			: failedCheck(
					"retired-session-route",
					responseDetail(retiredSession, "Retired session route did not return 410."),
				),
	);

	return report(checks, runId, finalStatus, lastEventSeq);
}

export async function runAgentV2CutoverRehearsalCli(
	env: NodeJS.ProcessEnv = process.env,
): Promise<AgentV2CutoverRehearsalReport> {
	const configurationError = requiredCutoverConfiguration(env);
	if (configurationError) return configurationFailureReport(configurationError);

	return await runAgentV2CutoverRehearsal({
		baseUrl: env.PI_CUTOVER_BASE_URL!,
		clientId: env.PI_CUTOVER_CLIENT_ID!,
		model: { provider: env.PI_CUTOVER_MODEL_PROVIDER!, id: env.PI_CUTOVER_MODEL_ID! },
		timeoutMs: environmentPositiveInteger(env.PI_CUTOVER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		pollIntervalMs: environmentPositiveInteger(env.PI_CUTOVER_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
	});
}

async function readRun(
	request: (path: string, init?: RequestInit) => Promise<RequestResult>,
	headers: Record<string, string>,
	runId: string,
): Promise<{ run?: RunSnapshot; detail: string }> {
	const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}`, { headers });
	if (!result.response?.ok) return { detail: responseDetail(result, "V2 run read failed.") };
	const run = await readRunSnapshot(result.response);
	return run ? { run, detail: "V2 run read." } : { detail: "V2 run read returned an invalid response." };
}

async function waitForEventReplay(
	request: (path: string, init?: RequestInit) => Promise<RequestResult>,
	headers: Record<string, string>,
	runId: string,
	timeoutMs: number,
	pollIntervalMs: number,
	sleep: (milliseconds: number) => Promise<void>,
	lastStatus: string | undefined,
): Promise<{ ok: boolean; detail: string; status?: string; seq: number }> {
	const startedAt = Date.now();
	let status = lastStatus;
	let seq = 0;
	while (true) {
		const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}/events?afterSeq=${seq}`, { headers });
		if (!result.response?.ok) {
			return { ok: false, detail: responseDetail(result, "V2 event replay failed."), status, seq };
		}
		const events = await readEvents(result.response);
		if (events === undefined) return { ok: false, detail: "V2 event replay returned an invalid response.", status, seq };
		for (const event of events) seq = Math.max(seq, event.seq);
		if (seq > 0) return { ok: true, detail: `Replayed events through sequence ${seq}.`, status, seq };
		if (Date.now() - startedAt >= timeoutMs) {
			return {
				ok: false,
				detail: `Timed out waiting for event replay; last status: ${status ?? "unknown"}; last event seq: ${seq}.`,
				status,
				seq,
			};
		}
		const current = await readRun(request, headers, runId);
		if (current.run) status = current.run.status;
		await sleep(pollIntervalMs);
	}
}

async function cancelRun(
	request: (path: string, init?: RequestInit) => Promise<RequestResult>,
	headers: Record<string, string>,
	runId: string,
	timeoutMs: number,
	pollIntervalMs: number,
	sleep: (milliseconds: number) => Promise<void>,
	lastStatus: string | undefined,
): Promise<{ ok: boolean; detail: string; status?: string }> {
	const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers });
	if (!result.response?.ok) return { ok: false, detail: responseDetail(result, "V2 run cancel failed."), status: lastStatus };

	const startedAt = Date.now();
	let status = (await readRunSnapshot(result.response))?.status ?? lastStatus;
	while (true) {
		const current = await readRun(request, headers, runId);
		if (current.run) status = current.run.status;
		if (status === "cancelled") return { ok: true, detail: "V2 run cancelled.", status };
		if (Date.now() - startedAt >= timeoutMs) {
			return { ok: false, detail: `Timed out waiting for cancellation; last status: ${status ?? "unknown"}.`, status };
		}
		await sleep(pollIntervalMs);
	}
}

async function readRunSnapshot(response: Response): Promise<RunSnapshot | undefined> {
	const value = await readJson(response);
	if (!isRecord(value) || typeof value.runId !== "string" || typeof value.status !== "string") return undefined;
	return { runId: value.runId, status: value.status };
}

async function readEvents(response: Response): Promise<Array<{ seq: number }> | undefined> {
	const value = await readJson(response);
	if (!isRecord(value) || !Array.isArray(value.events)) return undefined;
	const events: Array<{ seq: number }> = [];
	for (const event of value.events) {
		if (!isRecord(event) || typeof event.seq !== "number") return undefined;
		events.push({ seq: event.seq });
	}
	return events;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function responseDetail(result: RequestResult, fallback: string): string {
	if (result.response) return `${fallback} HTTP ${result.response.status}.`;
	return result.detail ?? fallback;
}

function report(
	checks: AgentV2CutoverCheck[],
	runId: string | undefined,
	finalStatus: string | undefined,
	lastEventSeq: number | undefined,
): AgentV2CutoverRehearsalReport {
	return { ok: checks.every((check) => check.ok), runId, finalStatus, lastEventSeq, checks };
}

function passedCheck(name: AgentV2CutoverCheck["name"], detail: string): AgentV2CutoverCheck {
	return { name, ok: true, detail };
}

function failedCheck(name: AgentV2CutoverCheck["name"], detail: string): AgentV2CutoverCheck {
	return { name, ok: false, detail };
}

function appendSkippedChecks(checks: AgentV2CutoverCheck[], startIndex: number, reason: string): void {
	for (const name of CHECK_NAMES.slice(startIndex)) checks.push(failedCheck(name, `Skipped: ${reason}`));
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function environmentPositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function requiredCutoverConfiguration(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of [
		"PI_CUTOVER_BASE_URL",
		"PI_CUTOVER_CLIENT_ID",
		"PI_CUTOVER_MODEL_PROVIDER",
		"PI_CUTOVER_MODEL_ID",
	]) {
		if (!env[name]?.trim()) return `${name} is required.`;
	}
	return undefined;
}

function configurationFailureReport(detail: string): AgentV2CutoverRehearsalReport {
	return { ok: false, checks: [{ name: "storage-health", ok: false, detail: `Configuration error: ${detail}` }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (isDirectEntry()) {
	void runAgentV2CutoverRehearsalCli().then((result) => {
		console.log(JSON.stringify(result));
		process.exitCode = result.ok ? 0 : 1;
	});
}

function isDirectEntry(): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}
