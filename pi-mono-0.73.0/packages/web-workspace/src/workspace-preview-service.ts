import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { PREVIEW_PREFIX, PROJECT_METADATA_FILE } from "./constants.js";
import { readJsonFile, sendJson, writeJsonFile } from "./json.js";
import { findBuildSourceEntry, findStaticServeRoot, staticServeRootCandidates } from "./static-preview.js";
import type {
	JsonObject,
	PreviewRequestLike,
	ProjectPreviewRequest,
	ProjectPreviewResult,
	StorageConfig,
} from "./types.js";
import {
	assertInside,
	listProjectSourceFiles,
	removeSiblingProjectDirs,
	safeRelativePreviewPath,
	workspaceContext,
} from "./workspace-paths.js";

export class WorkspacePreviewService {
	constructor(private readonly config: StorageConfig) {}

	async preview(body: ProjectPreviewRequest, req: PreviewRequestLike): Promise<ProjectPreviewResult> {
		const { sessionId, title, projectId, projectDir } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId);
		const fileCount = listProjectSourceFiles(projectDir).length;
		if (fileCount === 0) throw new Error("Cannot preview an empty project workspace.");
		return await this.buildAndRecordProject(projectDir, { projectId, sessionId, title, req, fileCount });
	}

	dispose(): void {
		// Kept as a no-op for callers that previously disposed preview runtimes.
	}

	readProjectLogs(projectId: string): JsonObject {
		const metadata = this.readProjectMetadata(projectId);
		if (!metadata) return { error: "Project not found." };
		return { projectId, status: metadata.status, logs: metadata.logs || [] };
	}

	servePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
		if (!req.url) return false;
		const url = new URL(req.url, "http://localhost");
		const parts = url.pathname.slice(PREVIEW_PREFIX.length).split("/").filter(Boolean);
		const projectId = parts.shift();
		if (!projectId) return false;

		const metadata = this.readProjectMetadata(decodeURIComponent(projectId));
		if (!metadata || metadata.status !== "running") {
			sendJson(res, { error: "Preview not found." }, 404);
			return true;
		}

		if (metadata.mode && metadata.mode !== "static") {
			sendJson(res, { error: "Preview mode is no longer supported." }, 404);
			return true;
		}

		const serveRoot = String(metadata.serveRoot || "");
		if (!serveRoot || !existsSync(serveRoot)) {
			sendJson(res, { error: "Preview output is missing." }, 404);
			return true;
		}

		const requestedPath =
			parts.length > 0 ? safeRelativePreviewPath(parts.map((part) => decodeURIComponent(part))) : "index.html";
		let targetPath = resolve(serveRoot, requestedPath);
		assertInside(serveRoot, targetPath);
		if (!existsSync(targetPath) || statSync(targetPath).isDirectory()) targetPath = resolve(serveRoot, "index.html");
		if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
			sendJson(res, { error: "Preview entry file is missing." }, 404);
			return true;
		}

		res.statusCode = 200;
		res.setHeader("Content-Type", mimeType(targetPath));
		if (extname(targetPath).toLowerCase() === ".html") {
			const previewBasePath = `${PREVIEW_PREFIX}/${encodeURIComponent(decodeURIComponent(projectId))}/`;
			res.end(rewritePreviewHtml(readFileSync(targetPath, "utf8"), previewBasePath));
			return true;
		}
		createReadStream(targetPath).pipe(res);
		return true;
	}

	private async buildAndRecordProject(
		projectDir: string,
		options: { projectId: string; sessionId: string; title: string; req: PreviewRequestLike; fileCount: number },
	): Promise<ProjectPreviewResult> {
		const logs: string[] = [];
		logs.push(`Project root: ${projectDir}\n`);
		const packageJsonPath = join(projectDir, "package.json");
		let serveRoot = "";
		let status = "running";
		let previewUrl = buildPreviewUrl(this.config, options.req, options.projectId);

		try {
			const hasPackageJson = existsSync(packageJsonPath);
			if (hasPackageJson) {
				logs.push(
					"Static preview mode does not run package scripts, npm install, npm run build, or Node services.\n",
				);
			} else {
				logs.push("No package.json found; serving static files directly.\n");
			}
			const staticRoot = findStaticServeRoot(projectDir, staticServeRootCandidates(hasPackageJson));
			if (!staticRoot) {
				const buildSourceEntry = findBuildSourceEntry(projectDir, ["", "public"]);
				if (buildSourceEntry) {
					throw new Error(
						`Static preview found a build source entry at ${buildSourceEntry}. Run project_task build_static before project_task preview so PI can serve browser-ready dist/build output.`,
					);
				}
				throw new Error(
					"Static preview requires an index.html in the project root, dist, build, or public. Package scripts, npm install, npm run build, and Node services are not started.",
				);
			}
			serveRoot = staticRoot;
			logs.push(`Serving static output: ${serveRoot}\n`);
		} catch (error) {
			status = "failed";
			previewUrl = "";
			serveRoot = "";
			logs.push(error instanceof Error ? error.message : String(error));
		}

		const metadata: ProjectPreviewResult = {
			version: 1,
			projectId: options.projectId,
			sessionId: options.sessionId,
			title: options.title,
			status,
			mode: "static",
			previewUrl,
			projectRoot: projectDir,
			serveRoot,
			fileCount: options.fileCount,
			updatedAt: new Date().toISOString(),
			logs,
		};
		writeJsonFile(join(projectDir, PROJECT_METADATA_FILE), metadata);
		return metadata;
	}

	private readProjectMetadata(projectId: string): JsonObject | undefined {
		const safeProjectId = safePreviewProjectId(projectId);
		if (!safeProjectId) return undefined;
		const metadataPath = join(this.config.projectsRootDir, safeProjectId, PROJECT_METADATA_FILE);
		if (!existsSync(metadataPath)) return undefined;
		return readJsonFile(metadataPath);
	}
}

function safePreviewProjectId(value: string): string {
	const projectId = value.trim();
	if (!projectId || projectId.includes("..") || projectId.includes("/") || projectId.includes("\\")) return "";
	if (!/^[a-z0-9._-]+$/i.test(projectId)) return "";
	return projectId;
}

export function buildPreviewUrl(config: StorageConfig, req: PreviewRequestLike, projectId: string): string {
	const path = `${PREVIEW_PREFIX}/${encodeURIComponent(projectId)}/`;
	if (config.previewBaseUrl) return `${config.previewBaseUrl}${path}`;
	const host = req.headers.host || "localhost";
	const forwardedProto = req.headers["x-forwarded-proto"];
	const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "http";
	return `${protocol}://${host}${path}`;
}

function rewritePreviewHtml(html: string, previewBasePath: string): string {
	return html
		.replace(
			/\b(src|href|action)=("|')\/(?!\/|preview\/)/g,
			(_match, attribute: string, quote: string) => `${attribute}=${quote}${previewBasePath}`,
		)
		.replace(
			/\b(srcset)=("|')\/(?!\/|preview\/)/g,
			(_match, attribute: string, quote: string) => `${attribute}=${quote}${previewBasePath}`,
		);
}

function mimeType(path: string): string {
	const extension = extname(basename(path)).toLowerCase();
	const types: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".ico": "image/x-icon",
		".txt": "text/plain; charset=utf-8",
	};
	return types[extension] || "application/octet-stream";
}
