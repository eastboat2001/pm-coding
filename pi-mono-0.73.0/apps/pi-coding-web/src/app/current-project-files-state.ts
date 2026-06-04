export const CURRENT_PROJECT_FILES_PANEL_WIDTH_KEY = "pi-current-project-files-panel-width";
export const CURRENT_PROJECT_FILES_PANEL_DEFAULT_WIDTH = 380;
export const CURRENT_PROJECT_FILES_PANEL_MIN_WIDTH = 300;
export const CURRENT_PROJECT_FILES_PANEL_MAX_VIEWPORT_RATIO = 0.52;
export const CURRENT_PROJECT_FILE_PREVIEW_DRAWER_WIDTH_KEY = "pi-current-project-file-preview-drawer-width";
export const CURRENT_PROJECT_FILE_PREVIEW_DRAWER_DEFAULT_WIDTH = 420;
export const CURRENT_PROJECT_FILE_PREVIEW_DRAWER_MIN_WIDTH = 320;
export const CURRENT_PROJECT_FILE_PREVIEW_DRAWER_MAX_VIEWPORT_RATIO = 0.55;

export type CurrentProjectFileContext = {
	sessionId: string;
	title?: string;
};

export type CurrentProjectFilesResult = {
	projectId: string;
	sessionId: string;
	title: string;
	files: string[];
	fileCount: number;
};

export type CurrentProjectFilePreviewRequest = CurrentProjectFileContext & {
	filename: string;
};

export type CurrentProjectFileSaveRequest = CurrentProjectFilePreviewRequest & {
	content: string;
	baseHash: string;
};

export type CurrentProjectFilePreview = {
	filename: string;
	content: string;
	size: number;
	language: string;
	binary: boolean;
	truncated: boolean;
	hash: string;
};

export type CurrentProjectFileTreeNode = {
	type: "directory" | "file";
	name: string;
	path: string;
	fileCount: number;
	children: CurrentProjectFileTreeNode[];
	extension?: string;
};

type FilesResponse = {
	error?: unknown;
	projectId?: unknown;
	sessionId?: unknown;
	title?: unknown;
	files?: unknown;
	fileCount?: unknown;
};

type PreviewResponse = {
	error?: unknown;
	filename?: unknown;
	content?: unknown;
	size?: unknown;
	language?: unknown;
	binary?: unknown;
	truncated?: unknown;
	hash?: unknown;
};

export async function loadCurrentProjectFiles(
	context: CurrentProjectFileContext,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<CurrentProjectFilesResult> {
	const endpoint = new URL("/api/pi-projects/workspace/files", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId: context.sessionId, title: context.title || "" }),
	});
	const result = (await response.json().catch(() => ({}))) as FilesResponse;
	if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
	return toCurrentProjectFilesResult(result);
}

export async function loadCurrentProjectFilePreview(
	request: CurrentProjectFilePreviewRequest,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<CurrentProjectFilePreview> {
	const endpoint = new URL("/api/pi-projects/workspace/file-preview", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionId: request.sessionId,
			title: request.title || "",
			filename: request.filename,
		}),
	});
	const result = (await response.json().catch(() => ({}))) as PreviewResponse;
	if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
	return toCurrentProjectFilePreview(result);
}

export async function saveCurrentProjectFile(
	request: CurrentProjectFileSaveRequest,
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
	origin = globalThis.location?.origin || "http://localhost",
): Promise<CurrentProjectFilePreview> {
	const endpoint = new URL("/api/pi-projects/workspace/file-save", origin).toString();
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionId: request.sessionId,
			title: request.title || "",
			filename: request.filename,
			content: request.content,
			baseHash: request.baseHash,
		}),
	});
	const result = (await response.json().catch(() => ({}))) as PreviewResponse;
	if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
	return toCurrentProjectFilePreview(result);
}

export function buildCurrentProjectFileTree(files: string[], projectName: string): CurrentProjectFileTreeNode {
	const root = createDirectoryNode(projectName || "Current Project", "");
	for (const file of normalizeProjectFiles(files)) {
		const parts = file.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		let current = root;
		current.fileCount += 1;
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			const path = parts.slice(0, index + 1).join("/");
			const isFile = index === parts.length - 1;
			if (isFile) {
				current.children.push({
					type: "file",
					name: part,
					path,
					fileCount: 1,
					children: [],
					extension: fileExtension(part),
				});
			} else {
				let directory = current.children.find((child) => child.type === "directory" && child.name === part) as
					| CurrentProjectFileTreeNode
					| undefined;
				if (!directory) {
					directory = createDirectoryNode(part, path);
					current.children.push(directory);
				}
				directory.fileCount += 1;
				current = directory;
			}
		}
	}
	sortProjectFileTree(root);
	return root;
}

export function filterCurrentProjectFiles(files: string[], query: string): string[] {
	const needle = normalizeSearchText(query);
	if (!needle) return files;
	return files.filter((file) => normalizeSearchText(file).includes(needle));
}

export function monacoLanguageForProjectFile(filename: string, serverLanguage = ""): string {
	const extension = fileExtension(filename).toLowerCase();
	const normalizedLanguage = serverLanguage.trim().toLowerCase();
	const byExtension: Record<string, string> = {
		cjs: "javascript",
		css: "css",
		html: "html",
		js: "javascript",
		json: "json",
		jsx: "javascript",
		md: "markdown",
		mjs: "javascript",
		scss: "scss",
		ts: "typescript",
		tsx: "typescript",
		txt: "plaintext",
		vue: "html",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
	};
	const byServerLanguage: Record<string, string> = {
		css: "css",
		html: "html",
		javascript: "javascript",
		json: "json",
		markdown: "markdown",
		text: "plaintext",
		typescript: "typescript",
		vue: "html",
		xml: "xml",
		yaml: "yaml",
	};
	return byExtension[extension] || byServerLanguage[normalizedLanguage] || "plaintext";
}

export function clampCurrentProjectFilesPanelWidth(width: number, viewportWidth: number): number {
	const maxWidth = Math.max(
		CURRENT_PROJECT_FILES_PANEL_MIN_WIDTH,
		Math.floor(viewportWidth * CURRENT_PROJECT_FILES_PANEL_MAX_VIEWPORT_RATIO),
	);
	return Math.min(Math.max(Math.round(width), CURRENT_PROJECT_FILES_PANEL_MIN_WIDTH), maxWidth);
}

export function clampCurrentProjectFilePreviewDrawerWidth(width: number, viewportWidth: number): number {
	const maxWidth = Math.max(
		CURRENT_PROJECT_FILE_PREVIEW_DRAWER_MIN_WIDTH,
		Math.floor(viewportWidth * CURRENT_PROJECT_FILE_PREVIEW_DRAWER_MAX_VIEWPORT_RATIO),
	);
	return Math.min(Math.max(Math.round(width), CURRENT_PROJECT_FILE_PREVIEW_DRAWER_MIN_WIDTH), maxWidth);
}

export function readCurrentProjectFilesPanelWidth(
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const stored = Number(storage.getItem(CURRENT_PROJECT_FILES_PANEL_WIDTH_KEY));
	const value = Number.isFinite(stored) && stored > 0 ? stored : CURRENT_PROJECT_FILES_PANEL_DEFAULT_WIDTH;
	return clampCurrentProjectFilesPanelWidth(value, viewportWidth);
}

export function writeCurrentProjectFilesPanelWidth(
	width: number,
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const nextWidth = clampCurrentProjectFilesPanelWidth(width, viewportWidth);
	storage.setItem(CURRENT_PROJECT_FILES_PANEL_WIDTH_KEY, String(nextWidth));
	return nextWidth;
}

export function readCurrentProjectFilePreviewDrawerWidth(
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const stored = Number(storage.getItem(CURRENT_PROJECT_FILE_PREVIEW_DRAWER_WIDTH_KEY));
	const value = Number.isFinite(stored) && stored > 0 ? stored : CURRENT_PROJECT_FILE_PREVIEW_DRAWER_DEFAULT_WIDTH;
	return clampCurrentProjectFilePreviewDrawerWidth(value, viewportWidth);
}

export function writeCurrentProjectFilePreviewDrawerWidth(
	width: number,
	storage: Storage = globalThis.localStorage,
	viewportWidth = globalThis.innerWidth || 1280,
): number {
	const nextWidth = clampCurrentProjectFilePreviewDrawerWidth(width, viewportWidth);
	storage.setItem(CURRENT_PROJECT_FILE_PREVIEW_DRAWER_WIDTH_KEY, String(nextWidth));
	return nextWidth;
}

function createDirectoryNode(name: string, path: string): CurrentProjectFileTreeNode {
	return { type: "directory", name, path, fileCount: 0, children: [] };
}

function sortProjectFileTree(node: CurrentProjectFileTreeNode): void {
	node.children.sort((left, right) => {
		if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
		return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
	});
	for (const child of node.children) sortProjectFileTree(child);
}

function normalizeProjectFiles(files: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const file of files) {
		const value = String(file || "")
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

function fileExtension(filename: string): string {
	const match = filename.match(/\.([^.]+)$/);
	return match ? match[1].toUpperCase() : "";
}

function toCurrentProjectFilesResult(value: FilesResponse): CurrentProjectFilesResult {
	const files = Array.isArray(value.files) ? value.files.map((file) => String(file).replace(/\\/g, "/")) : [];
	return {
		projectId: stringValue(value.projectId),
		sessionId: stringValue(value.sessionId),
		title: stringValue(value.title),
		files,
		fileCount: numberValue(value.fileCount) ?? files.length,
	};
}

function toCurrentProjectFilePreview(value: PreviewResponse): CurrentProjectFilePreview {
	return {
		filename: stringValue(value.filename),
		content: stringValue(value.content),
		size: numberValue(value.size) ?? 0,
		language: stringValue(value.language) || "text",
		binary: value.binary === true,
		truncated: value.truncated === true,
		hash: stringValue(value.hash),
	};
}

function apiErrorMessage(result: { error?: unknown }, status: number): string {
	return result.error ? String(result.error) : `Project files API failed with HTTP ${status}`;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s/_\\.-]+/g, "");
}
