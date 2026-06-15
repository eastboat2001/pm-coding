import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelGeneratedAppRunWithRollback,
	clampGeneratedAppsPanelWidth,
	filterGeneratedApps,
	formatGeneratedAppUpdatedAt,
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

	it("loads runtime sessions as app panel records even without preview URLs", async () => {
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push(`${init?.method || "GET"} ${url}`);
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
			if (url.endsWith("/api/pi-sessions")) {
				return jsonResponse({
					sessions: [
						{
							sessionId: "session-1",
							title: "Plain Chat",
							createdAt: "2026-06-12T06:30:00.000Z",
							updatedAt: "2026-06-12T06:31:00.000Z",
							lastRunStatus: "completed",
							lastRunId: "run-1",
						},
						{
							sessionId: "session-2",
							title: "Preview App",
							createdAt: "2026-06-12T06:35:00.000Z",
							updatedAt: "2026-06-12T06:41:00.000Z",
							lastRunStatus: "running",
							lastRunId: "run-2",
						},
					],
				});
			}
			if (url.endsWith("/api/pi-projects/workspace/files")) {
				const body = JSON.parse(String(init?.body || "{}")) as { sessionId: string };
				return jsonResponse({
					projectId: body.sessionId === "session-1" ? "plain-chat-session-1" : "preview-session-2",
					sessionId: body.sessionId,
					title: body.sessionId === "session-1" ? "Plain Chat" : "Preview App",
					files: body.sessionId === "session-1" ? [] : ["index.html", "style.css", "app.js", "README.md"],
					fileCount: body.sessionId === "session-1" ? 0 : 4,
				});
			}
			return jsonResponse({}, 404);
		};

		const projects = await loadGeneratedApps(fetchImpl, "http://localhost:5173");

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
		expect(calls).toContain("GET http://localhost:5173/api/pi-sessions");
	});

	it("merges browser-only sessions into app panel records", async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/pi-projects")) return jsonResponse({ projects: [] });
			if (url.endsWith("/api/pi-projects/workspace/files")) {
				const body = JSON.parse(String(init?.body || "{}")) as { sessionId: string };
				return jsonResponse({
					projectId: "browser-only-session",
					sessionId: body.sessionId,
					title: "Browser Only",
					files: [],
					fileCount: 0,
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

	it("formats app card timestamps like the session list", () => {
		const now = new Date("2026-06-12T08:49:00.000Z");

		expect(formatGeneratedAppUpdatedAt("2026-06-12T06:49:00.000Z", now)).toBe("今天 14:49");
		expect(formatGeneratedAppUpdatedAt("2026-06-11T13:10:00.000Z", now)).toBe("昨天 21:10");
		expect(formatGeneratedAppUpdatedAt("2026-06-10T01:32:00.000Z", now)).toBe("2026/06/10 09:32");
	});

	it("uses two session execution status labels", () => {
		expect(projectSessionStatusLabel("running")).toBe("正在执行");
		expect(projectSessionStatusLabel("queued")).toBe("正在执行");
		expect(projectSessionStatusLabel("cancelling")).toBe("正在执行");
		expect(projectSessionStatusLabel("completed")).toBe("空闲");
		expect(projectSessionStatusLabel(undefined)).toBe("空闲");
	});

	it("marks a generated app run as cancelling without changing other cards", () => {
		const projects = [
			{ ...createProject("active-app", "Active App"), status: "running" as const, runStatus: "running" },
			{ ...createProject("idle-app", "Idle App"), status: "idle" as const, runStatus: "completed" },
		];

		const nextProjects = markGeneratedAppRunCancelling(projects, "active-app");

		expect(nextProjects[0]).toMatchObject({ projectId: "active-app", status: "running", runStatus: "cancelling" });
		expect(nextProjects[1]).toBe(projects[1]);
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
