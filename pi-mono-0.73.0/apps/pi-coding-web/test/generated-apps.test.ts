import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelGeneratedAppRunWithRollback,
	clampGeneratedAppsPanelWidth,
	deleteGeneratedApp,
	filterGeneratedApps,
	formatGeneratedAppUpdatedAt,
	type GeneratedAppRecord,
	isBrowserSessionDeletionDeferred,
	loadGeneratedApps,
	loadSessionProjectApps,
	markGeneratedAppRunCancelling,
	projectSessionStatusLabel,
	renameGeneratedApp,
} from "../src/app/generated-apps-state.js";

describe("generated apps state", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.stubGlobal("window", { localStorage: createStorage(clientId) });
	});

	it("loads generated apps from the server projects endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					projects: [
						{
							projectId: "personal-intro-session",
							sessionId: "session-1",
							title: "Personal Intro App",
							status: "running",
							mode: "static",
							previewUrl: "http://localhost:5173/preview/personal-intro-session/",
							fileCount: 3,
							updatedAt: "2026-05-29T10:00:00.000Z",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const projects = await loadGeneratedApps(fetchImpl, "http://localhost:5173");

		expect(calls[0]).toEqual({
			url: "http://localhost:5173/api/pi-projects",
			init: { method: "GET", headers: { Accept: "application/json", "X-PI-Client-ID": clientId } },
		});
		expect(projects).toHaveLength(1);
		expect(projects[0].title).toBe("Personal Intro App");
	});

	it("does not treat preview service running status as an active runtime run", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/api/pi-projects")) {
				return jsonResponse({
					projects: [
						{
							projectId: "preview-only",
							sessionId: "preview-session",
							title: "Preview Only",
							status: "running",
							mode: "static",
							previewUrl: "http://localhost:5173/preview/preview-only/",
							fileCount: 1,
							updatedAt: "2026-06-12T06:40:00.000Z",
						},
					],
				});
			}
			return jsonResponse({}, 404);
		};

		const projects = await loadGeneratedApps(fetchImpl, "http://localhost:5173");

		expect(projects[0]).toMatchObject({
			projectId: "preview-only",
			status: "idle",
		});
		expect(projects[0].runStatus).toBeUndefined();
	});

	it("loads browser session metadata as app panel records through batch project summaries", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/api/pi-projects")) {
				return jsonResponse({
					projects: [
						{
							projectId: "preview-session-2",
							sessionId: "session-2",
							title: "Preview App",
							status: "running",
							mode: "static",
							previewUrl: "http://localhost:5173/preview/preview-session-2/",
							fileCount: 4,
							updatedAt: "2026-06-12T06:40:00.000Z",
						},
					],
				});
			}
			if (url.endsWith("/api/pi-projects/batch-summary")) {
				const body = JSON.parse(String(init?.body || "{}")) as { sessions?: Array<{ sessionId: string }> };
				return jsonResponse({
					summaries: (body.sessions || []).map((session) => ({
						projectId: session.sessionId === "session-1" ? "plain-chat-session-1" : "preview-session-2",
						sessionId: session.sessionId,
						title: session.sessionId === "session-1" ? "Plain Chat" : "Preview App",
						fileCount: session.sessionId === "session-1" ? 0 : 4,
					})),
				});
			}
			return jsonResponse({}, 404);
		};

		const projects = await loadSessionProjectApps(
			[
				{
					id: "session-1",
					title: "Plain Chat",
					createdAt: "2026-06-12T06:30:00.000Z",
					lastModified: "2026-06-12T06:31:00.000Z",
					runStatus: "succeeded",
				},
				{
					id: "session-2",
					title: "Preview App",
					createdAt: "2026-06-12T06:35:00.000Z",
					lastModified: "2026-06-12T06:41:00.000Z",
					runStatus: "running",
					activeRunId: "run-2",
					runUpdatedAt: "2026-06-12T06:41:00.000Z",
				},
			],
			fetchImpl,
			"http://localhost:5173",
		);

		expect(projects.map((project) => project.sessionId)).toEqual(["session-2", "session-1"]);
		expect(projects[0]).toMatchObject({
			sessionId: "session-2",
			previewUrl: "http://localhost:5173/preview/preview-session-2/",
			fileCount: 4,
			status: "running",
			activeRunId: "run-2",
		});
		expect(projects[1]).toMatchObject({
			sessionId: "session-1",
			title: "Plain Chat",
			previewUrl: "",
			fileCount: 0,
			status: "idle",
		});
		const batchCall = calls.find((call) => call.url.endsWith("/api/pi-projects/batch-summary"));
		expect(batchCall).toMatchObject({
			url: "http://localhost:5173/api/pi-projects/batch-summary",
			init: {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-PI-Client-ID": clientId,
				},
			},
		});
		expect(JSON.parse(String(batchCall?.init?.body || "{}"))).toEqual({
			sessions: [
				{ sessionId: "session-1", title: "Plain Chat" },
				{ sessionId: "session-2", title: "Preview App" },
			],
		});
		expect(calls.map((call) => `${call.init?.method || "GET"} ${call.url}`)).not.toContain(
			"GET http://localhost:5173/api/pi-sessions",
		);
		expect(calls.some((call) => call.url.endsWith("/api/pi-projects/workspace/files"))).toBe(false);
	});

	it("does not keep the legacy session list route in the generated apps source", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../src/app/generated-apps-state.ts", import.meta.url), "utf8"),
		);
		expect(source).not.toContain("/api/pi-sessions");
	});

	it("merges browser-only sessions into app panel records", async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/pi-projects")) return jsonResponse({ projects: [] });
			if (url.endsWith("/api/pi-projects/batch-summary")) {
				const body = JSON.parse(String(init?.body || "{}")) as { sessions?: Array<{ sessionId: string }> };
				return jsonResponse({
					summaries: (body.sessions || []).map((session) => ({
						projectId: "browser-only-session",
						sessionId: session.sessionId,
						title: "Browser Only",
						fileCount: 0,
					})),
				});
			}
			return jsonResponse({}, 404);
		};

		const projects = await loadSessionProjectApps(
			[
				{
					id: "session-browser",
					title: "Browser Only",
					createdAt: "2026-06-12T06:00:00.000Z",
					lastModified: "2026-06-12T06:10:00.000Z",
					messageCount: 1,
				},
			],
			fetchImpl,
			"http://localhost:5173",
		);

		expect(projects).toEqual([
			expect.objectContaining({
				projectId: "browser-only-session",
				sessionId: "session-browser",
				title: "Browser Only",
				previewUrl: "",
				fileCount: 0,
				status: "idle",
			}),
		]);
	});

	it("reuses identical batch summaries inside the short TTL and bypasses cache on force refresh", async () => {
		vi.useFakeTimers();
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		let batchCount = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/api/pi-projects")) return jsonResponse({ projects: [] });
			if (url.endsWith("/api/pi-projects/batch-summary")) {
				batchCount += 1;
				const body = JSON.parse(String(init?.body || "{}")) as { sessions?: Array<{ sessionId: string }> };
				return jsonResponse({
					summaries: (body.sessions || []).map((session) => ({
						projectId: `${session.sessionId}-project-${batchCount}`,
						sessionId: session.sessionId,
						title: "Cached Session",
						fileCount: batchCount,
					})),
				});
			}
			return jsonResponse({}, 404);
		};
		const sessions = [
			{
				id: "session-cache",
				title: "Cached Session",
				createdAt: "2026-06-12T06:00:00.000Z",
				lastModified: "2026-06-12T06:10:00.000Z",
			},
		];

		const first = await loadSessionProjectApps(sessions, fetchImpl, "http://localhost:5173");
		const second = await loadSessionProjectApps(sessions, fetchImpl, "http://localhost:5173");
		const forced = await loadSessionProjectApps(sessions, fetchImpl, "http://localhost:5173", { force: true });
		vi.advanceTimersByTime(15_001);
		const afterTtl = await loadSessionProjectApps(sessions, fetchImpl, "http://localhost:5173");

		expect(first[0].projectId).toBe("session-cache-project-1");
		expect(second[0].projectId).toBe("session-cache-project-1");
		expect(forced[0].projectId).toBe("session-cache-project-2");
		expect(afterTtl[0].projectId).toBe("session-cache-project-3");
		expect(calls.filter((call) => call.url.endsWith("/api/pi-projects/batch-summary"))).toHaveLength(3);
	});

	it("invalidates batch summary cache when a session run update token changes inside the TTL", async () => {
		vi.useFakeTimers();
		let batchCount = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/pi-projects")) return jsonResponse({ projects: [] });
			if (url.endsWith("/api/pi-projects/batch-summary")) {
				batchCount += 1;
				const body = JSON.parse(String(init?.body || "{}")) as { sessions?: Array<{ sessionId: string }> };
				return jsonResponse({
					summaries: (body.sessions || []).map((session) => ({
						projectId: `${session.sessionId}-project-${batchCount}`,
						sessionId: session.sessionId,
						title: "Run Token Session",
						fileCount: batchCount,
					})),
				});
			}
			return jsonResponse({}, 404);
		};
		const runningSession = {
			id: "session-run-token",
			title: "Run Token Session",
			createdAt: "2026-06-12T06:00:00.000Z",
			lastModified: "2026-06-12T06:10:00.000Z",
			runStatus: "running",
			activeRunId: "run-1",
			runUpdatedAt: "2026-06-12T06:11:00.000Z",
		};

		const first = await loadSessionProjectApps([runningSession], fetchImpl, "http://localhost:5173");
		const cached = await loadSessionProjectApps([runningSession], fetchImpl, "http://localhost:5173");
		const completed = await loadSessionProjectApps(
			[
				{
					...runningSession,
					runStatus: "succeeded",
					runUpdatedAt: "2026-06-12T06:12:00.000Z",
				},
			],
			fetchImpl,
			"http://localhost:5173",
		);

		expect(first[0].fileCount).toBe(1);
		expect(cached[0].fileCount).toBe(1);
		expect(completed[0].fileCount).toBe(2);
		expect(batchCount).toBe(2);
	});

	it("queues a force refresh requested while the generated apps panel is already loading", async () => {
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("customElements", {
			define: vi.fn(),
			get: vi.fn(),
		});
		const { GeneratedAppsPanel } = await import("../src/app/GeneratedAppsPanel.js");
		const panel = new GeneratedAppsPanel();
		let resolveInitialLoad: (projects: []) => void = () => undefined;
		const initialLoad = new Promise<[]>((resolve) => {
			resolveInitialLoad = resolve;
		});
		const loadProjects = vi
			.fn<(options?: { force?: boolean }) => Promise<[]>>()
			.mockReturnValueOnce(initialLoad)
			.mockResolvedValueOnce([]);
		panel.loadProjects = loadProjects;

		const initialRefresh = panel.refresh();
		await Promise.resolve();
		void panel.refresh({ force: true });
		resolveInitialLoad([]);
		await initialRefresh;

		expect(loadProjects).toHaveBeenCalledTimes(2);
		expect(loadProjects.mock.calls.map(([options]) => options)).toEqual([{}, { force: true }]);
	});

	it("clamps the generated apps panel width to readable desktop bounds", () => {
		expect(clampGeneratedAppsPanelWidth(120, 1600)).toBe(280);
		expect(clampGeneratedAppsPanelWidth(420, 1600)).toBe(420);
		expect(clampGeneratedAppsPanelWidth(1200, 1000)).toBe(500);
	});

	it("filters generated apps by app name and preview metadata", () => {
		const projects = [
			createProject("personal-intro-app", "Personal Intro App"),
			createProject("resume-builder", "AI Resume Builder"),
			createProject("skill-dashboard", "Skill Dashboard"),
		];

		expect(filterGeneratedApps(projects, "resume")).toEqual([projects[1]]);
		expect(filterGeneratedApps(projects, "SKILL")).toEqual([projects[2]]);
		expect(filterGeneratedApps(projects, "localhost/preview/personal")).toEqual([projects[0]]);
		expect(filterGeneratedApps(projects, "   ")).toEqual(projects);
	});

	it("filters generated apps while ignoring whitespace differences", () => {
		const projects = [
			createProject("ai-safety-app", "AI 安全应用"),
			createProject("ai-chat-app", "AI 对话应用"),
		];

		expect(filterGeneratedApps(projects, "AI安全")).toEqual([projects[0]]);
		expect(filterGeneratedApps(projects, "AI 安全")).toEqual([projects[0]]);
	});

	it("renames a generated app through the server projects endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify(createProject("ai-safety-app", "AI Safety Center")), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const project = await renameGeneratedApp("ai-safety-app", "AI Safety Center", fetchImpl, "http://localhost:5173");

		expect(calls).toEqual([
			{
				url: "http://localhost:5173/api/pi-projects/ai-safety-app",
				init: {
					method: "PUT",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"X-PI-Client-ID": clientId,
					},
					body: JSON.stringify({ title: "AI Safety Center" }),
				},
			},
		]);
		expect(project.title).toBe("AI Safety Center");
	});

	it("deletes a generated app through the server before local session cleanup", async () => {
		const project = createProject("ai-safety-app", "AI Safety Center");
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return jsonResponse({ projectId: project.projectId, sessionId: project.sessionId, deleted: true });
		};

		const result = await deleteGeneratedApp(project, fetchImpl, "http://localhost:5173");

		expect(calls).toEqual([
			{
				url: `http://localhost:5173/api/pi-projects/${project.projectId}?sessionId=${project.sessionId}`,
				init: {
					method: "DELETE",
					headers: { Accept: "application/json", "X-PI-Client-ID": clientId },
				},
			},
		]);
		expect(result).toEqual({ projectId: project.projectId, sessionId: project.sessionId, deleted: true });
	});

	it("keeps the card and local session when server project deletion fails", async () => {
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("customElements", {
			define: vi.fn(),
			get: vi.fn(),
		});
		const { GeneratedAppsPanel } = await import("../src/app/GeneratedAppsPanel.js");
		const project = createProject("delete-failure", "Delete Failure");
		const panel = new GeneratedAppsPanel() as GeneratedAppsPanel & {
			projects: GeneratedAppRecord[];
			deleteError: string;
			confirmDelete(project: GeneratedAppRecord): Promise<void>;
		};
		panel.projects = [project];
		panel.deleteProject = vi.fn(async () => {
			throw new Error("server delete failed");
		});
		panel.deleteSession = vi.fn(async () => undefined);

		await panel.confirmDelete(project);

		expect(panel.deleteProject).toHaveBeenCalledWith(project);
		expect(panel.deleteSession).not.toHaveBeenCalled();
		expect(panel.projects).toEqual([project]);
		expect(panel.deleteError).toBe("server delete failed");
	});

	it("formats app card timestamps like the session list", () => {
		const now = new Date("2026-06-12T08:49:00.000Z");

		expect(formatGeneratedAppUpdatedAt("2026-06-12T06:49:00.000Z", now)).toBe("今天 14:49");
		expect(formatGeneratedAppUpdatedAt("2026-06-11T13:10:00.000Z", now)).toBe("昨天 21:10");
		expect(formatGeneratedAppUpdatedAt("2026-06-10T01:32:00.000Z", now)).toBe("2026/06/10 09:32");
	});

	it("labels generated app run states distinctly", () => {
		expect(projectSessionStatusLabel("running")).toBe("正在执行");
		expect(projectSessionStatusLabel("queued")).toBe("正在执行");
		expect(projectSessionStatusLabel("cancelling")).toBe("正在取消");
		expect(projectSessionStatusLabel("cancelled")).toBe("已取消");
		expect(projectSessionStatusLabel("interrupted")).toBe("已中断");
		expect(projectSessionStatusLabel("failed")).toBe("失败");
		expect(projectSessionStatusLabel("succeeded")).toBe("空闲");
		expect(projectSessionStatusLabel(undefined)).toBe("空闲");
	});

	it("defers local session cleanup only when force delete cancelled active runs", () => {
		expect(
			isBrowserSessionDeletionDeferred({
				deleted: false,
				sessionId: "session-active",
				cancelledRuns: 1,
			}),
		).toBe(true);
		expect(isBrowserSessionDeletionDeferred({ deleted: false, sessionId: "session-orphan" })).toBe(false);
		expect(
			isBrowserSessionDeletionDeferred({
				deleted: true,
				sessionId: "session-deleted",
				cancelledRuns: 1,
			}),
		).toBe(false);
		expect(isBrowserSessionDeletionDeferred(undefined)).toBe(false);
	});

	it("marks a generated app run as cancelling without changing other cards", () => {
		const projects = [
			{ ...createProject("active-app", "Active App"), status: "running" as const, runStatus: "running" },
			{ ...createProject("idle-app", "Idle App"), status: "idle" as const, runStatus: "succeeded" },
		];

		const nextProjects = markGeneratedAppRunCancelling(projects, "active-app");

		expect(nextProjects[0]).toMatchObject({ projectId: "active-app", status: "running", runStatus: "cancelling" });
		expect(nextProjects[1]).toBe(projects[1]);
	});

	it("force refreshes generated apps after stopping a run", async () => {
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("customElements", {
			define: vi.fn(),
			get: vi.fn(),
		});
		const { GeneratedAppsPanel } = await import("../src/app/GeneratedAppsPanel.js");
		const panel = new GeneratedAppsPanel() as GeneratedAppsPanel & {
			projects: GeneratedAppRecord[];
			stopRun(project: GeneratedAppRecord): Promise<void>;
		};
		const runningProject: GeneratedAppRecord = {
			...createProject("active-app", "Active App"),
			status: "running",
			runStatus: "running",
			activeRunId: "run-1",
		};
		const refreshedProject: GeneratedAppRecord = {
			...runningProject,
			status: "idle",
			runStatus: "cancelled",
		};
		const cancelRun = vi.fn(async () => undefined);
		const loadProjects = vi.fn(async () => [refreshedProject]);
		panel.projects = [runningProject];
		panel.cancelRun = cancelRun;
		panel.loadProjects = loadProjects;

		await panel.stopRun(runningProject);

		expect(cancelRun).toHaveBeenCalledWith("run-1");
		expect(loadProjects).toHaveBeenCalledWith({ force: true });
		expect(panel.projects).toEqual([refreshedProject]);
	});

	it("rolls back generated app cancelling state when cancelling the run fails", async () => {
		const projects = [
			{
				...createProject("active-app", "Active App"),
				status: "running" as const,
				runStatus: "running",
				activeRunId: "run-1",
			},
		];
		const updates: typeof projects[] = [];
		const cancelRun = vi.fn(async () => {
			throw new Error("cancel failed");
		});

		await expect(
			cancelGeneratedAppRunWithRollback(projects, projects[0], cancelRun, (nextProjects) => {
				updates.push(nextProjects as typeof projects);
			}),
		).rejects.toThrow("cancel failed");

		expect(cancelRun).toHaveBeenCalledWith("run-1");
		expect(updates).toHaveLength(2);
		expect(updates[0][0]).toMatchObject({ status: "running", runStatus: "cancelling" });
		expect(updates[1]).toBe(projects);
	});
});

function createProject(projectId: string, title: string) {
	return {
		projectId,
		sessionId: `${projectId}-session`,
		title,
		status: "running",
		mode: "static" as const,
		previewUrl: `http://localhost/preview/${projectId}/`,
		fileCount: 1,
		updatedAt: "2026-05-29T10:00:00.000Z",
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function createStorage(clientId: string): Storage {
	const values = new Map<string, string>([["pi.clientId", clientId]]);
	return {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		key(index) {
			return Array.from(values.keys())[index] ?? null;
		},
		removeItem(key) {
			values.delete(key);
		},
		setItem(key, value) {
			values.set(key, value);
		},
	};
}
