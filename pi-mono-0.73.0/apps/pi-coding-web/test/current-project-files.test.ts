import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCurrentProjectFileTree,
	clampCurrentProjectFilePreviewDrawerWidth,
	clampCurrentProjectFilesPanelWidth,
	filterCurrentProjectFiles,
	loadCurrentProjectFilePreview,
	loadCurrentProjectFiles,
	monacoLanguageForProjectFile,
	saveCurrentProjectFile,
} from "../src/app/current-project-files-state.js";

describe("current project files state", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId) });
	});

	it("loads current session files from the readonly workspace endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					projectId: "demo-app-session-",
					sessionId: "session-123",
					title: "Demo App",
					files: ["src/main.ts", "src/components/App.vue"],
					fileCount: 2,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await loadCurrentProjectFiles(
			{ sessionId: "session-123", title: "Demo App" },
			fetchImpl,
			"http://localhost:5173",
		);

		expect(calls).toEqual([
			{
				url: "http://localhost:5173/api/pi-projects/workspace/files",
				init: {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"X-PI-Client-ID": clientId,
					},
					body: JSON.stringify({ sessionId: "session-123", title: "Demo App" }),
				},
			},
		]);
		expect(result.files).toEqual(["src/main.ts", "src/components/App.vue"]);
		expect(result.fileCount).toBe(2);
	});

	it("loads a current session file preview from the readonly workspace endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					filename: "src/main.ts",
					content: "export const answer = 42;\n",
					size: 26,
					language: "typescript",
					binary: false,
					truncated: false,
					hash: "a".repeat(64),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await loadCurrentProjectFilePreview(
			{ sessionId: "session-123", title: "Demo App", filename: "src/main.ts" },
			fetchImpl,
			"http://localhost:5173",
		);

		expect(calls[0]).toEqual({
			url: "http://localhost:5173/api/pi-projects/workspace/file-preview",
			init: {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-PI-Client-ID": clientId,
				},
				body: JSON.stringify({ sessionId: "session-123", title: "Demo App", filename: "src/main.ts" }),
			},
		});
		expect(result.content).toBe("export const answer = 42;\n");
		expect(result.language).toBe("typescript");
		expect(result.hash).toBe("a".repeat(64));
	});

	it("saves a current session file through the hash-protected workspace endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					action: "saved",
					filename: "src/main.ts",
					content: "export const answer = 43;\n",
					size: 26,
					language: "typescript",
					binary: false,
					truncated: false,
					hash: "b".repeat(64),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await saveCurrentProjectFile(
			{
				sessionId: "session-123",
				title: "Demo App",
				filename: "src/main.ts",
				content: "export const answer = 43;\n",
				baseHash: "a".repeat(64),
			},
			fetchImpl,
			"http://localhost:5173",
		);

		expect(calls[0]).toEqual({
			url: "http://localhost:5173/api/pi-projects/workspace/file-save",
			init: {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-PI-Client-ID": clientId,
				},
				body: JSON.stringify({
					sessionId: "session-123",
					title: "Demo App",
					filename: "src/main.ts",
					content: "export const answer = 43;\n",
					baseHash: "a".repeat(64),
				}),
			},
		});
		expect(result.content).toBe("export const answer = 43;\n");
		expect(result.hash).toBe("b".repeat(64));
	});

	it("builds a directory-first project file tree with file counts", () => {
		const tree = buildCurrentProjectFileTree(
			["README.md", "src/main.ts", "src/components/App.vue", "src/styles/app.css"],
			"Demo App",
		);

		expect(tree.name).toBe("Demo App");
		expect(tree.fileCount).toBe(4);
		expect(tree.children.map((node) => node.name)).toEqual(["src", "README.md"]);
		expect(tree.children[0]).toMatchObject({ type: "directory", name: "src", fileCount: 3 });
		expect(tree.children[0].children.map((node) => node.name)).toEqual(["components", "styles", "main.ts"]);
	});

	it("builds a root project node for an empty session workspace", () => {
		const tree = buildCurrentProjectFileTree([], "Plain Chat");

		expect(tree).toMatchObject({
			type: "directory",
			name: "Plain Chat",
			path: "",
			fileCount: 0,
			children: [],
		});
	});

	it("filters files while ignoring whitespace and separators", () => {
		const files = ["src/components/AISafetyPanel.tsx", "src/pages/Profile.tsx", "README.md"];

		expect(filterCurrentProjectFiles(files, "AI Safety")).toEqual(["src/components/AISafetyPanel.tsx"]);
		expect(filterCurrentProjectFiles(files, "AISafety")).toEqual(["src/components/AISafetyPanel.tsx"]);
		expect(filterCurrentProjectFiles(files, "components ai")).toEqual(["src/components/AISafetyPanel.tsx"]);
		expect(filterCurrentProjectFiles(files, "   ")).toEqual(files);
	});

	it("clamps the current project files panel width to readable desktop bounds", () => {
		expect(clampCurrentProjectFilesPanelWidth(120, 1600)).toBe(300);
		expect(clampCurrentProjectFilesPanelWidth(440, 1600)).toBe(440);
		expect(clampCurrentProjectFilesPanelWidth(1200, 1000)).toBe(520);
	});

	it("clamps the current project file preview drawer width to readable desktop bounds", () => {
		expect(clampCurrentProjectFilePreviewDrawerWidth(120, 1600)).toBe(320);
		expect(clampCurrentProjectFilePreviewDrawerWidth(560, 1600)).toBe(560);
		expect(clampCurrentProjectFilePreviewDrawerWidth(1200, 1000)).toBe(550);
	});

	it("maps project files to bundled Monaco language ids", () => {
		expect(monacoLanguageForProjectFile("src/main.tsx", "typescript")).toBe("typescript");
		expect(monacoLanguageForProjectFile("src/App.vue", "vue")).toBe("html");
		expect(monacoLanguageForProjectFile("package.json", "json")).toBe("json");
		expect(monacoLanguageForProjectFile("README.md", "markdown")).toBe("markdown");
		expect(monacoLanguageForProjectFile("assets/logo.unknown", "unknown")).toBe("plaintext");
	});
});

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
