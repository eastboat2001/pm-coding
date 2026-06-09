import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clampGeneratedAppsPanelWidth,
	filterGeneratedApps,
	loadGeneratedApps,
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

		expect(calls).toEqual([
			{
				url: "http://localhost:5173/api/pi-projects",
				init: { method: "GET", headers: { Accept: "application/json", "X-PI-Client-ID": clientId } },
			},
		]);
		expect(projects).toHaveLength(1);
		expect(projects[0].title).toBe("Personal Intro App");
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
