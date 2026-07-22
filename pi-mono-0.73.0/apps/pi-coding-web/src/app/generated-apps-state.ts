import type { AgentV2RunStatus } from "@mariozechner/pi-web-workspace";
import type { BrowserDeleteSessionResult } from "../runtime/browser-records.js";
import { piClientHeaders } from "../runtime/client-id.js";
import { getBrowserAppStorage } from "../storage/browser-app-storage.js";
import { formatSessionUpdatedAt } from "../storage/session-timestamps.js";

export const GENERATED_APPS_PANEL_WIDTH_KEY = "pi-generated-apps-panel-width";
export const GENERATED_APPS_PANEL_DEFAULT_WIDTH = 360;
export const GENERATED_APPS_PANEL_MIN_WIDTH = 280;
export const GENERATED_APPS_PANEL_MAX_VIEWPORT_RATIO = 0.5;
export const SUMMARY_CACHE_TTL_MS = 15_000;

export type GeneratedAppRecord = {
	projectId: string;
	sessionId: string;
	title: string;
	status: "running" | "idle";
	mode: "static";
	previewUrl: string;
	fileCount: number;
	updatedAt: string;
	activeRunId?: string;
	runStatus?: AgentV2RunStatus;
};

type GeneratedAppsResponse = {
	projects?: unknown;
};

type BatchProjectSummaryResponse = {
	summaries?: unknown;
};

export type GeneratedAppDeleteResult = {
	projectId: string;
	sessionId: string;
	deleted: boolean;
};

type SessionProjectSummary = {
	projectId: string;
	sessionId: string;
	title: string;
	fileCount: number;
};

type LoadGeneratedAppsOptions = {
	force?: boolean;
};

export type SessionProjectSource = {
	id: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messageCount?: number;
	runStatus?: AgentV2RunStatus;
	activeRunId?: string;
	runUpdatedAt?: string;
};

export function isBrowserSessionDeletionDeferred(result: BrowserDeleteSessionResult | undefined): boolean {
	return Boolean(result && !result.deleted && (result.cancelledRuns ?? 0) > 0);
}

export async function loadGeneratedApps(
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
	options: LoadGeneratedAppsOptions = {},
): Promise<GeneratedAppRecord[]> {
	const [projects, sessions] = await Promise.all([
		loadPreviewProjects(fetchImpl, origin),
		loadBrowserSessionSources(),
	]);
	if (sessions.length === 0) return projects;
	return mergeSessionProjectRecords(sessions, projects, fetchImpl, origin, options);
}

export async function loadSessionProjectApps(
	sessions: SessionProjectSource[],
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
	options: LoadGeneratedAppsOptions = {},
): Promise<GeneratedAppRecord[]> {
	const projects = await loadPreviewProjects(fetchImpl, origin);
	return mergeSessionProjectRecords(sessions, projects, fetchImpl, origin, options);
}

async function loadPreviewProjects(fetchImpl: typeof fetch, origin: string): Promise<GeneratedAppRecord[]> {
	const endpoint = new URL("/api/pi-projects", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "GET",
		headers: { Accept: "application/json", ...piClientHeaders() },
	});
	const result = (await response.json().catch(() => ({}))) as GeneratedAppsResponse;
	if (!response.ok) {
		const message =
			typeof result === "object" && result !== null && "error" in result
				? String((result as { error: unknown }).error)
				: "";
		throw new Error(message || `Project API failed with HTTP ${response.status}`);
	}
	const projects = Array.isArray(result.projects) ? result.projects : [];
	return projects.flatMap((project) => {
		const record = toGeneratedAppRecord(project);
		return record ? [record] : [];
	});
}

async function loadBrowserSessionSources(): Promise<SessionProjectSource[]> {
	try {
		const storage = getBrowserAppStorage();
		const sessions = (await storage.sessions.getAllMetadata()) as Array<
			SessionProjectSource & { lastRunId?: string }
		>;
		return sessions.map((session) => ({
			id: session.id,
			title: session.title,
			createdAt: session.createdAt,
			lastModified: session.lastModified,
			messageCount: session.messageCount,
			...(session.runStatus ? { runStatus: session.runStatus } : {}),
			...(session.activeRunId ? { activeRunId: session.activeRunId } : {}),
			...(session.runUpdatedAt ? { runUpdatedAt: session.runUpdatedAt } : {}),
		}));
	} catch {
		return [];
	}
}

async function mergeSessionProjectRecords(
	sessions: SessionProjectSource[],
	previewProjects: GeneratedAppRecord[],
	fetchImpl: typeof fetch,
	origin: string,
	options: LoadGeneratedAppsOptions,
): Promise<GeneratedAppRecord[]> {
	const previewBySessionId = new Map(previewProjects.map((project) => [project.sessionId, project]));
	const summaries = await loadBatchSessionProjectSummaries(sessions, fetchImpl, origin, options);
	const summaryBySessionId = new Map(summaries.map((summary) => [summary.sessionId, summary]));
	const records = sessions.map((session) => {
		const preview = previewBySessionId.get(session.id);
		const files = summaryBySessionId.get(session.id);
		const status: GeneratedAppRecord["status"] = isActiveRunStatus(session.runStatus) ? "running" : "idle";
		return {
			projectId: preview?.projectId || files?.projectId || fallbackProjectId(session.id),
			sessionId: session.id,
			title: session.title || preview?.title || files?.title || "Untitled session",
			status,
			mode: "static" as const,
			previewUrl: preview?.previewUrl || "",
			fileCount: files?.fileCount ?? preview?.fileCount ?? 0,
			updatedAt: session.runUpdatedAt || session.lastModified || preview?.updatedAt || session.createdAt,
			...(isActiveRunStatus(session.runStatus) && session.activeRunId ? { activeRunId: session.activeRunId } : {}),
			...(session.runStatus ? { runStatus: session.runStatus } : {}),
		};
	});
	for (const project of previewProjects) {
		if (!sessions.some((session) => session.id === project.sessionId)) {
			records.push(project);
		}
	}
	return records.sort(
		(left, right) =>
			Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.title.localeCompare(right.title),
	);
}

const summaryCache = new Map<string, { expiresAt: number; summaries: SessionProjectSummary[] }>();

async function loadBatchSessionProjectSummaries(
	sessions: SessionProjectSource[],
	fetchImpl: typeof fetch,
	origin: string,
	options: LoadGeneratedAppsOptions,
): Promise<SessionProjectSummary[]> {
	if (sessions.length === 0) return [];
	const requestSessions = sessions.map((session) => ({ sessionId: session.id, title: session.title || "" }));
	const clientHeaders = piClientHeaders();
	const cacheSessions = sessions.map((session) => ({
		sessionId: session.id,
		title: session.title || "",
		lastModified: session.lastModified || "",
		runUpdatedAt: session.runUpdatedAt || "",
		runStatus: session.runStatus || "",
		activeRunId: session.activeRunId || "",
	}));
	const cacheKey = JSON.stringify({
		origin,
		clientId: clientHeaders["X-PI-Client-ID"] || "",
		sessions: cacheSessions,
	});
	const now = Date.now();
	const cached = summaryCache.get(cacheKey);
	if (!options.force && cached && cached.expiresAt > now) return cached.summaries;

	const endpoint = new URL("/api/pi-projects/batch-summary", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...clientHeaders },
		body: JSON.stringify({ sessions: requestSessions }),
	});
	const result = (await response.json().catch(() => ({}))) as BatchProjectSummaryResponse & { error?: unknown };
	if (!response.ok)
		throw new Error(
			result.error ? String(result.error) : `Project batch summary API failed with HTTP ${response.status}`,
		);
	const summaries = Array.isArray(result.summaries)
		? result.summaries.flatMap((summary) => {
				const record = toSessionProjectSummary(summary);
				return record ? [record] : [];
			})
		: [];
	summaryCache.set(cacheKey, { expiresAt: now + SUMMARY_CACHE_TTL_MS, summaries });
	return summaries;
}

function toSessionProjectSummary(value: unknown): SessionProjectSummary | undefined {
	if (!isRecord(value)) return undefined;
	const projectId = stringValue(value.projectId);
	const sessionId = stringValue(value.sessionId);
	const title = stringValue(value.title);
	const fileCount = numberValue(value.fileCount);
	if (!projectId || !sessionId || fileCount === undefined) return undefined;
	return { projectId, sessionId, title, fileCount };
}

export async function renameGeneratedApp(
	projectId: string,
	title: string,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<GeneratedAppRecord> {
	const endpoint = new URL(`/api/pi-projects/${encodeURIComponent(projectId)}`, origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "PUT",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...piClientHeaders() },
		body: JSON.stringify({ title }),
	});
	const result = (await response.json().catch(() => ({}))) as GeneratedAppsResponse & { error?: unknown };
	if (!response.ok)
		throw new Error(result.error ? String(result.error) : `Project API failed with HTTP ${response.status}`);
	const record = toGeneratedAppRecord(result);
	if (!record) throw new Error("Project API returned an invalid generated app record.");
	return record;
}

export async function deleteGeneratedApp(
	project: Pick<GeneratedAppRecord, "projectId" | "sessionId">,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<GeneratedAppDeleteResult> {
	const endpoint = new URL(`/api/pi-projects/${encodeURIComponent(project.projectId)}`, origin);
	endpoint.searchParams.set("sessionId", project.sessionId);
	const response = await fetchImpl(endpoint.toString(), {
		method: "DELETE",
		headers: { Accept: "application/json", ...piClientHeaders() },
	});
	const result = (await response.json().catch(() => ({}))) as Partial<GeneratedAppDeleteResult> & { error?: unknown };
	if (!response.ok) {
		throw new Error(result.error ? String(result.error) : `Project API failed with HTTP ${response.status}`);
	}
	if (
		result.projectId !== project.projectId ||
		result.sessionId !== project.sessionId ||
		typeof result.deleted !== "boolean"
	) {
		throw new Error("Project API returned an invalid delete result.");
	}
	return result as GeneratedAppDeleteResult;
}

export function clampGeneratedAppsPanelWidth(width: number, viewportWidth: number): number {
	const maxWidth = Math.max(
		GENERATED_APPS_PANEL_MIN_WIDTH,
		Math.floor(viewportWidth * GENERATED_APPS_PANEL_MAX_VIEWPORT_RATIO),
	);
	return Math.min(Math.max(Math.round(width), GENERATED_APPS_PANEL_MIN_WIDTH), maxWidth);
}

export function filterGeneratedApps(projects: GeneratedAppRecord[], query: string): GeneratedAppRecord[] {
	const needle = normalizeSearchText(query);
	if (!needle) return projects;
	return projects.filter((project) =>
		[project.title, project.projectId, project.previewUrl].some((value) =>
			normalizeSearchText(value).includes(needle),
		),
	);
}

export function formatGeneratedAppUpdatedAt(value: string, now = new Date()): string {
	return formatSessionUpdatedAt(value, now);
}

export function projectSessionStatusLabel(status: AgentV2RunStatus | "idle" | undefined): string {
	switch (status) {
		case "queued":
		case "running":
			return "正在执行";
		case "cancelling":
			return "正在取消";
		case "cancelled":
			return "已取消";
		case "interrupted":
			return "已中断";
		case "failed":
			return "失败";
		default:
			return "空闲";
	}
}

export async function cancelGeneratedAppRunWithRollback(
	projects: GeneratedAppRecord[],
	project: Pick<GeneratedAppRecord, "projectId" | "activeRunId">,
	cancelRun: (runId: string) => Promise<unknown> | unknown,
	updateProjects: (projects: GeneratedAppRecord[]) => void,
): Promise<void> {
	if (!project.activeRunId) return;
	const previousProjects = projects;
	updateProjects(markGeneratedAppRunCancelling(previousProjects, project.projectId));
	try {
		await cancelRun(project.activeRunId);
	} catch (error) {
		updateProjects(previousProjects);
		throw error;
	}
}

export function markGeneratedAppRunCancelling(projects: GeneratedAppRecord[], projectId: string): GeneratedAppRecord[] {
	return projects.map((candidate) =>
		candidate.projectId === projectId
			? { ...candidate, status: "running" as const, runStatus: "cancelling" }
			: candidate,
	);
}

export function readGeneratedAppsPanelWidth(
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const stored = Number(storage.getItem(GENERATED_APPS_PANEL_WIDTH_KEY));
	const value = Number.isFinite(stored) && stored > 0 ? stored : GENERATED_APPS_PANEL_DEFAULT_WIDTH;
	return clampGeneratedAppsPanelWidth(value, viewportWidth);
}

export function writeGeneratedAppsPanelWidth(
	width: number,
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const nextWidth = clampGeneratedAppsPanelWidth(width, viewportWidth);
	storage.setItem(GENERATED_APPS_PANEL_WIDTH_KEY, String(nextWidth));
	return nextWidth;
}

function toGeneratedAppRecord(value: unknown): GeneratedAppRecord | undefined {
	if (!isRecord(value)) return undefined;
	const projectId = stringValue(value.projectId);
	const sessionId = stringValue(value.sessionId);
	const title = stringValue(value.title);
	const status = stringValue(value.status);
	const previewUrl = stringValue(value.previewUrl);
	const updatedAt = stringValue(value.updatedAt);
	const fileCount = numberValue(value.fileCount);
	if (
		!projectId ||
		!sessionId ||
		!title ||
		!status ||
		value.mode !== "static" ||
		!updatedAt ||
		fileCount === undefined
	) {
		return undefined;
	}
	return {
		projectId,
		sessionId,
		title,
		status: "idle",
		mode: "static",
		previewUrl,
		fileCount,
		updatedAt,
	};
}

function isActiveRunStatus(status: string | undefined): boolean {
	return status === "queued" || status === "running" || status === "cancelling";
}

function fallbackProjectId(sessionId: string): string {
	return `project-${sessionId}`.replace(/[^a-z0-9._-]/gi, "-").replace(/-+/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
