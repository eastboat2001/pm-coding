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

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REQUEST_FAILED_DETAIL = "Request failed.";
const REQUEST_TIMED_OUT_DETAIL = "Request timed out.";

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
	now?: () => number;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface AgentV2CutoverRehearsalCommandOptions {
	env?: NodeJS.ProcessEnv;
	output?: (line: string) => void;
	fetch?: CutoverFetch;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
}

type CutoverFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RunSnapshot = { runId: string; status: string };
type RequestResult = { response?: Response; detail?: string; timedOut?: boolean };
type RequestHelper = (path: string, init?: RequestInit) => Promise<RequestResult>;

export async function runAgentV2CutoverRehearsal(
	options: AgentV2CutoverRehearsalOptions,
): Promise<AgentV2CutoverRehearsalReport> {
	const checks: AgentV2CutoverCheck[] = [];
	const now = options.now ?? Date.now;
	const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
	const deadlineAt = now() + timeoutMs;
	const request = createDeadlineBoundRequest(options, deadlineAt, now);
	const sleep = options.sleep ?? defaultSleep;
	const headers = { "Content-Type": "application/json", "X-PI-Client-ID": options.clientId };
	let runId: string | undefined;
	let finalStatus: string | undefined;
	let lastEventSeq: number | undefined;

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
				sessionId: `cutover-rehearsal-${now()}`,
				title: "Production cutover rehearsal",
			},
			model: options.model,
		}),
	});
	const startedSnapshot = started.response?.ok ? await readRunSnapshot(started.response, deadlineAt, now) : undefined;
	const startedRun = startedSnapshot?.run;
	if (!startedRun) {
		checks.push(
			failedCheck(
				"v2-run-start",
				responseDetail(
					startedSnapshot?.timedOut ? { ...started, timedOut: true } : started,
					"V2 run start failed.",
				),
			),
		);
		appendSkippedChecks(checks, 2, "V2 run did not start.");
		return report(checks, runId, finalStatus, lastEventSeq);
	}
	runId = startedRun.runId;
	finalStatus = startedRun.status;
	checks.push(passedCheck("v2-run-start", "V2 run started."));

	const initialRead = await readRun(request, headers, runId, deadlineAt, now);
	if (initialRead.run) {
		finalStatus = initialRead.run.status;
		checks.push(passedCheck("v2-run-read", `V2 run read with status ${finalStatus}.`));
	} else {
		checks.push(failedCheck("v2-run-read", initialRead.detail));
	}

	const replay = initialRead.run
		? await waitForEventReplay(request, headers, runId, deadlineAt, now, pollIntervalMs, sleep, finalStatus)
		: { ok: false, detail: "V2 run could not be read.", status: finalStatus, seq: 0 };
	finalStatus = replay.status ?? finalStatus;
	lastEventSeq = replay.seq;
	checks.push(replay.ok ? passedCheck("v2-event-replay", replay.detail) : failedCheck("v2-event-replay", replay.detail));

	const cancellation = await cancelRun(request, headers, runId, deadlineAt, now, pollIntervalMs, sleep, finalStatus);
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
	return await runCutoverRehearsalFromEnvironment({ env });
}

export async function runAgentV2CutoverRehearsalCommand(
	options: AgentV2CutoverRehearsalCommandOptions = {},
): Promise<number> {
	const report = await runCutoverRehearsalFromEnvironment(options);
	(options.output ?? console.log)(JSON.stringify(report));
	return report.ok ? 0 : 1;
}

async function runCutoverRehearsalFromEnvironment(
	options: AgentV2CutoverRehearsalCommandOptions,
): Promise<AgentV2CutoverRehearsalReport> {
	const env = options.env ?? process.env;
	const configurationError = requiredCutoverConfiguration(env);
	if (configurationError) return configurationFailureReport(configurationError);
	try {
		return await runAgentV2CutoverRehearsal({
			baseUrl: env.PI_CUTOVER_BASE_URL!,
			clientId: env.PI_CUTOVER_CLIENT_ID!,
			model: { provider: env.PI_CUTOVER_MODEL_PROVIDER!, id: env.PI_CUTOVER_MODEL_ID! },
			timeoutMs: environmentPositiveInteger(env.PI_CUTOVER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
			pollIntervalMs: environmentPositiveInteger(env.PI_CUTOVER_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
			fetch: options.fetch,
			sleep: options.sleep,
			now: options.now,
		});
	} catch {
		return { ok: false, checks: [failedCheck("storage-health", "Cutover rehearsal failed.")] };
	}
}

function createDeadlineBoundRequest(
	options: AgentV2CutoverRehearsalOptions,
	deadlineAt: number,
	now: () => number,
): RequestHelper {
	const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
	return async (path, init) => {
		const remainingMs = deadlineAt - now();
		if (remainingMs <= 0) return timedOutRequest();

		const controller = new AbortController();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const fetchResult: Promise<RequestResult> = Promise.resolve()
			.then(async () => await fetchFn(new URL(path, options.baseUrl).toString(), { ...init, signal: controller.signal }))
			.then((response): RequestResult => ({ response }), (): RequestResult => ({ detail: REQUEST_FAILED_DETAIL }));
		const timeoutResult = new Promise<RequestResult>((resolve) => {
			timeoutId = setTimeout(() => {
				controller.abort();
				resolve(timedOutRequest());
			}, remainingMs);
		});
		try {
			return await Promise.race([fetchResult, timeoutResult]);
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
		}
	};
}

async function readRun(
	request: RequestHelper,
	headers: Record<string, string>,
	runId: string,
	deadlineAt: number,
	now: () => number,
): Promise<{ run?: RunSnapshot; detail: string }> {
	const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}`, { headers });
	if (!result.response?.ok) return { detail: responseDetail(result, "V2 run read failed.") };
	const snapshot = await readRunSnapshot(result.response, deadlineAt, now);
	if (snapshot.timedOut) return { detail: REQUEST_TIMED_OUT_DETAIL };
	return snapshot.run
		? { run: snapshot.run, detail: "V2 run read." }
		: { detail: "V2 run read returned an invalid response." };
}

async function waitForEventReplay(
	request: RequestHelper,
	headers: Record<string, string>,
	runId: string,
	deadlineAt: number,
	now: () => number,
	pollIntervalMs: number,
	sleep: (milliseconds: number) => Promise<void>,
	lastStatus: string | undefined,
): Promise<{ ok: boolean; detail: string; status?: string; seq: number }> {
	let status = lastStatus;
	let seq = 0;
	while (true) {
		if (remainingMs(deadlineAt, now) <= 0) return eventReplayTimeout(status, seq);
		const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}/events?afterSeq=${seq}`, { headers });
		if (result.timedOut) return eventReplayTimeout(status, seq);
		if (!result.response?.ok) return { ok: false, detail: responseDetail(result, "V2 event replay failed."), status, seq };
		const replay = await readEvents(result.response, deadlineAt, now);
		if (replay.timedOut) return eventReplayTimeout(status, seq);
		if (replay.events === undefined)
			return { ok: false, detail: "V2 event replay returned an invalid response.", status, seq };
		for (const event of replay.events) seq = Math.max(seq, event.seq);
		if (seq > 0) return { ok: true, detail: `Replayed events through sequence ${seq}.`, status, seq };

		const current = await readRun(request, headers, runId, deadlineAt, now);
		if (current.run) status = current.run.status;
		if (!(await sleepWithinDeadline(sleep, deadlineAt, now, pollIntervalMs))) return eventReplayTimeout(status, seq);
	}
}

async function cancelRun(
	request: RequestHelper,
	headers: Record<string, string>,
	runId: string,
	deadlineAt: number,
	now: () => number,
	pollIntervalMs: number,
	sleep: (milliseconds: number) => Promise<void>,
	lastStatus: string | undefined,
): Promise<{ ok: boolean; detail: string; status?: string }> {
	const result = await request(`/api/agent-v2/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers });
	if (!result.response?.ok) return { ok: false, detail: responseDetail(result, "V2 run cancel failed."), status: lastStatus };

	const cancellationSnapshot = await readRunSnapshot(result.response, deadlineAt, now);
	if (cancellationSnapshot.timedOut) return cancellationTimeout(lastStatus);
	let status = cancellationSnapshot.run?.status ?? lastStatus;
	while (true) {
		if (remainingMs(deadlineAt, now) <= 0) return cancellationTimeout(status);
		const current = await readRun(request, headers, runId, deadlineAt, now);
		if (current.run) status = current.run.status;
		if (status === "cancelled") return { ok: true, detail: "V2 run cancelled.", status };
		if (!(await sleepWithinDeadline(sleep, deadlineAt, now, pollIntervalMs))) return cancellationTimeout(status);
	}
}

async function sleepWithinDeadline(
	sleep: (milliseconds: number) => Promise<void>,
	deadlineAt: number,
	now: () => number,
	pollIntervalMs: number,
): Promise<boolean> {
	const remaining = remainingMs(deadlineAt, now);
	if (remaining <= 0) return false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const sleepResult = Promise.resolve()
		.then(async () => await sleep(Math.min(pollIntervalMs, remaining)))
		.then(() => true, () => false);
	const deadlineResult = new Promise<boolean>((resolve) => {
		timeoutId = setTimeout(() => resolve(false), remaining);
	});
	try {
		return await Promise.race([sleepResult, deadlineResult]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function readRunSnapshot(
	response: Response,
	deadlineAt: number,
	now: () => number,
): Promise<{ run?: RunSnapshot; timedOut?: boolean }> {
	const result = await readJson(response, deadlineAt, now);
	if (result.timedOut) return { timedOut: true };
	const value = result.value;
	if (!isRecord(value) || typeof value.runId !== "string" || typeof value.status !== "string") return {};
	return { run: { runId: value.runId, status: value.status } };
}

async function readEvents(
	response: Response,
	deadlineAt: number,
	now: () => number,
): Promise<{ events?: Array<{ seq: number }>; timedOut?: boolean }> {
	const result = await readJson(response, deadlineAt, now);
	if (result.timedOut) return { timedOut: true };
	const value = result.value;
	if (!isRecord(value) || !Array.isArray(value.events)) return {};
	const events: Array<{ seq: number }> = [];
	for (const event of value.events) {
		if (!isRecord(event) || typeof event.seq !== "number") return {};
		events.push({ seq: event.seq });
	}
	return { events };
}

async function readJson(
	response: Response,
	deadlineAt: number,
	now: () => number,
): Promise<{ value?: unknown; timedOut?: boolean }> {
	const remaining = remainingMs(deadlineAt, now);
	if (remaining <= 0) return { timedOut: true };
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const valueResult = Promise.resolve()
		.then(async () => await response.json())
		.then((value) => ({ value }), () => ({}));
	const timeoutResult = new Promise<{ timedOut: true }>((resolve) => {
		timeoutId = setTimeout(() => resolve({ timedOut: true }), remaining);
	});
	try {
		return await Promise.race([valueResult, timeoutResult]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

function eventReplayTimeout(status: string | undefined, seq: number) {
	return {
		ok: false,
		detail: `Timed out waiting for event replay; last status: ${status ?? "unknown"}; last event seq: ${seq}.`,
		status,
		seq,
	};
}

function cancellationTimeout(status: string | undefined) {
	return { ok: false, detail: `Timed out waiting for cancellation; last status: ${status ?? "unknown"}.`, status };
}

function timedOutRequest(): RequestResult {
	return { detail: REQUEST_TIMED_OUT_DETAIL, timedOut: true };
}

function responseDetail(result: RequestResult, fallback: string): string {
	if (result.timedOut) return REQUEST_TIMED_OUT_DETAIL;
	if (result.response) return `${fallback} HTTP ${result.response.status}.`;
	return result.detail ?? fallback;
}

function remainingMs(deadlineAt: number, now: () => number): number {
	return deadlineAt - now();
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
	return { ok: false, checks: [failedCheck("storage-health", `Configuration error: ${detail}`)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (isDirectEntry()) {
	void runAgentV2CutoverRehearsalCommand().then((exitCode) => {
		process.exitCode = exitCode;
	});
}

function isDirectEntry(): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}
