import { piClientHeaders } from "../runtime/client-id.js";
import { formatSessionUpdatedAt } from "../storage/session-timestamps.js";

export const GENERATED_APPS_PANEL_WIDTH_KEY = "pi-generated-apps-panel-width";
export const GENERATED_APPS_PANEL_DEFAULT_WIDTH = 360;
export const GENERATED_APPS_PANEL_MIN_WIDTH = 280;
export const GENERATED_APPS_PANEL_MAX_VIEWPORT_RATIO = 0.5;

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
	runStatus?: string;
};

type GeneratedAppsResponse = {
	projects?: unknown;
};

type RuntimeSessionsResponse = {
	sessions?: unknown;
};

type WorkspaceFilesResponse = {
	projectId?: unknown;
	sessionId?: unknown;
	title?: unknown;
	fileCount?: unknown;
	files?: unknown;
};

export type SessionProjectSource = {
	id: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messageCount?: number;
	runStatus?: string;
	activeRunId?: string;
	runUpdatedAt?: string;
};

export async function loadGeneratedApps(
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<GeneratedAppRecord[]> {
	const [projects, sessions] = await Promise.all([
		loadPreviewProjects(fetchImpl, origin),
		loadRuntimeSessionSources(fetchImpl, origin).catch(() => []),
	]);
	if (sessions.length === 0) return projects;
	return mergeSessionProjectRecords(sessions, projects, fetchImpl, origin);
}

export async function loadSessionProjectApps(
	sessions: SessionProjectSource[],
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<GeneratedAppRecord[]> {
	const projects = await loadPreviewProjects(fetchImpl, origin);
	return mergeSessionProjectRecords(sessions, projects, fetchImpl, origin);
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

async function loadRuntimeSessionSources(fetchImpl: typeof fetch, origin: string): Promise<SessionProjectSource[]> {
	const endpoint = new URL("/api/pi-sessions", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "GET",
		headers: { Accept: "application/json", ...piClientHeaders() },
	});
	const result = (await response.json().catch(() => ({}))) as RuntimeSessionsResponse & { error?: unknown };
	if (!response.ok)
		throw new Error(result.error ? String(result.error) : `Runtime sessions API failed with HTTP ${response.status}`);
	const sessions = Array.isArray(result.sessions) ? result.sessions : [];
	return sessions.flatMap((session) => {
		const source = toRuntimeSessionProjectSource(session);
		return source ? [source] : [];
	});
}

async function mergeSessionProjectRecords(
	sessions: SessionProjectSource[],
	previewProjects: GeneratedAppRecord[],
	fetchImpl: typeof fetch,
	origin: string,
): Promise<GeneratedAppRecord[]> {
	const previewBySessionId = new Map(previewProjects.map((project) => [project.sessionId, project]));
	const records = await Promise.all(
		sessions.map(async (session) => {
			const preview = previewBySessionId.get(session.id);
			const files = await loadSessionProjectFileSummary(session, fetchImpl, origin).catch(() => undefined);
			const status: GeneratedAppRecord["status"] = isActiveRunStatus(session.runStatus) ? "running" : "idle";
			return {
				projectId: preview?.projectId || files?.projectId || fallbackProjectId(session.id),
				sessionId: session.id,
				title: session.title || preview?.title || "Untitled session",
				status,
				mode: "static" as const,
				previewUrl: preview?.previewUrl || "",
				fileCount: files?.fileCount ?? preview?.fileCount ?? 0,
				updatedAt: session.runUpdatedAt || session.lastModified || preview?.updatedAt || session.createdAt,
				...(isActiveRunStatus(session.runStatus) && session.activeRunId
					? { activeRunId: session.activeRunId }
					: {}),
				...(session.runStatus ? { runStatus: session.runStatus } : {}),
			};
		}),
	);
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

async function loadSessionProjectFileSummary(
	session: SessionProjectSource,
	fetchImpl: typeof fetch,
	origin: string,
): Promise<{ projectId: string; fileCount: number }> {
	const endpoint = new URL("/api/pi-projects/workspace/files", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json", ...piClientHeaders() },
		body: JSON.stringify({ sessionId: session.id, title: session.title || "" }),
	});
	const result = (await response.json().catch(() => ({}))) as WorkspaceFilesResponse & { error?: unknown };
	if (!response.ok)
		throw new Error(result.error ? String(result.error) : `Project files API failed with HTTP ${response.status}`);
	const files = Array.isArray(result.files) ? result.files : [];
	return {
		projectId: stringValue(result.projectId) || fallbackProjectId(session.id),
		fileCount: numberValue(result.fileCount) ?? files.length,
	};
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

export function projectSessionStatusLabel(status: string | undefined): string {
	return isActiveRunStatus(status) ? "正在执行" : "空闲";
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

export function markGeneratedAppRunCancelling(
	projects: GeneratedAppRecord[],
	projectId: string,
): GeneratedAppRecord[] {
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
		...(status ? { runStatus: status } : {}),
	};
}

function toRuntimeSessionProjectSource(value: unknown): SessionProjectSource | undefined {
	if (!isRecord(value)) return undefined;
	const id = stringValue(value.sessionId);
	const title = stringValue(value.title);
	const createdAt = stringValue(value.createdAt);
	const lastModified = stringValue(value.updatedAt);
	if (!id || !title || !createdAt || !lastModified) return undefined;
	const runStatus = stringValue(value.lastRunStatus);
	const activeRunId = isActiveRunStatus(runStatus) ? stringValue(value.lastRunId) : "";
	return {
		id,
		title,
		createdAt,
		lastModified,
		...(runStatus ? { runStatus } : {}),
		...(activeRunId ? { activeRunId } : {}),
		runUpdatedAt: lastModified,
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
