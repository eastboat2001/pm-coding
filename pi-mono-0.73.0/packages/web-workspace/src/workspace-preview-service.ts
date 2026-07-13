import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { PREVIEW_PREFIX, PROJECT_METADATA_FILE } from "./constants.js";
import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { readJsonFile, sendJson, writeJsonFile } from "./json.js";
import { buildTrustedPreviewUrl, type PreviewOriginConfig } from "./preview-origin.js";
import { findBuildSourceEntry, findStaticServeRoot, staticServeRootCandidates } from "./static-preview.js";
import type {
	JsonObject,
	PreviewRequestLike,
	ProjectPreviewListResult,
	ProjectPreviewRequest,
	ProjectPreviewResult,
	ProjectPreviewSummary,
	StorageConfig,
} from "./types.js";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";
import {
	listProjectSourceFiles,
	safeRelativePreviewPath,
	sanitizePathComponent,
	workspaceContext,
} from "./workspace-paths.js";

export class WorkspacePreviewService {
	constructor(
		private readonly config: StorageConfig,
		private readonly diagnostics?: WorkspaceDiagnosticLogService,
	) {}

	async preview(body: ProjectPreviewRequest, req: PreviewRequestLike): Promise<ProjectPreviewResult> {
		const { clientId, sessionId, title, projectId, projectDir } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		const fileCount = listProjectSourceFiles(projectDir).length;
		if (fileCount === 0) throw new Error("Cannot preview an empty project workspace.");
		return await this.buildAndRecordProject(projectDir, { clientId, projectId, sessionId, title, req, fileCount });
	}

	dispose(): void {
		// Kept as a no-op for callers that previously disposed preview runtimes.
	}

	readProjectLogs(projectId: string, clientId?: string): JsonObject {
		const metadata = this.readProjectMetadata(projectId, clientId);
		if (!metadata) return { error: "Project not found." };
		return { projectId, status: metadata.status, logs: metadata.logs || [] };
	}

	listProjects(req?: PreviewRequestLike, clientId?: string): ProjectPreviewListResult {
		const projects: ProjectPreviewSummary[] = [];
		for (const { metadata } of this.listProjectMetadata(clientId)) {
			try {
				const summary = projectPreviewSummary(metadata);
				if (clientId && summary?.clientId !== clientId) continue;
				if (summary && req && summary.status === "running") {
					summary.previewUrl = buildPreviewUrl(this.config, req, summary.projectId);
				}
				if (summary) projects.push(summary);
			} catch {
				// Ignore partial or corrupt generated project records.
			}
		}
		projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.title.localeCompare(b.title));
		return { projects };
	}

	renameProject(projectId: string, title: string, req?: PreviewRequestLike, clientId?: string): ProjectPreviewSummary {
		const safeProjectId = safePreviewProjectId(projectId);
		if (!safeProjectId) throw new Error("Invalid project id.");
		const nextTitle = normalizeProjectTitle(title);
		if (!nextTitle) throw new Error("App name is required.");
		if (nextTitle.length > 160) throw new Error("App name must be 160 characters or fewer.");
		const record = this.findProjectMetadata(safeProjectId, clientId);
		if (!record) throw new Error("Project not found.");
		if (!projectPreviewSummary(record.metadata)) throw new Error("Project metadata is invalid.");
		const nextMetadata: JsonObject = { ...record.metadata, title: nextTitle };
		writeJsonFile(record.metadataPath, nextMetadata);
		const summary = projectPreviewSummary(nextMetadata);
		if (!summary) throw new Error("Project metadata is invalid.");
		if (req && summary.status === "running")
			summary.previewUrl = buildPreviewUrl(this.config, req, summary.projectId);
		return summary;
	}

	servePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
		if (!req.url) return false;
		const url = new URL(req.url, "http://localhost");
		const parts = url.pathname.slice(PREVIEW_PREFIX.length).split("/").filter(Boolean);
		const projectId = parts.shift();
		if (!projectId) return false;

		const record = this.findProjectMetadata(decodeURIComponent(projectId));
		const metadata = record?.metadata;
		if (!record || !metadata || metadata.status !== "running") {
			sendJson(res, { error: "Preview not found." }, 404);
			return true;
		}

		if (metadata.mode && metadata.mode !== "static") {
			sendJson(res, { error: "Preview mode is no longer supported." }, 404);
			return true;
		}

		const configuredServeRoot = String(metadata.serveRoot || "");
		if (!configuredServeRoot) {
			sendJson(res, { error: "Preview output is missing." }, 404);
			return true;
		}
		let serveRoot: string;
		try {
			serveRoot = WorkspacePathGuard.forProjectContent(dirname(record.metadataPath)).authorizeAbsoluteExisting(
				configuredServeRoot,
				"directory",
			).absolutePath;
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			sendJson(res, { error: "Preview output is missing." }, 404);
			return true;
		}

		const requestedPath =
			parts.length > 0 ? safeRelativePreviewPath(parts.map((part) => decodeURIComponent(part))) : "index.html";
		const guard = WorkspacePathGuard.forProjectContent(serveRoot);
		let targetPath: string;
		try {
			targetPath = guard.authorizeExisting(requestedPath, "file").absolutePath;
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			if (error.code !== "path_missing") {
				sendJson(res, { error: "Preview not found." }, 404);
				return true;
			}
			try {
				targetPath = guard.authorizeExisting("index.html", "file").absolutePath;
			} catch (fallbackError) {
				if (!(fallbackError instanceof WorkspacePathAuthorizationError)) throw fallbackError;
				sendJson(res, { error: "Preview entry file is missing." }, 404);
				return true;
			}
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
		options: {
			clientId: string;
			projectId: string;
			sessionId: string;
			title: string;
			req: PreviewRequestLike;
			fileCount: number;
		},
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
			...(options.clientId ? { clientId: options.clientId } : {}),
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
		this.writeProjectLogEvent("project.preview.logs", metadata.clientId, metadata.sessionId, metadata.projectId, {
			status,
			title: metadata.title,
			logs,
			serveRoot,
			fileCount: metadata.fileCount,
		});
		return metadata;
	}

	private readProjectMetadata(projectId: string, clientId?: string): JsonObject | undefined {
		return this.findProjectMetadata(projectId, clientId)?.metadata;
	}

	private findProjectMetadata(
		projectId: string,
		clientId?: string,
	): { metadata: JsonObject; metadataPath: string } | undefined {
		const safeProjectId = safePreviewProjectId(projectId);
		if (!safeProjectId) return undefined;
		return this.listProjectMetadata(clientId).find((record) => record.metadata.projectId === safeProjectId);
	}

	private listProjectMetadata(clientId?: string): Array<{ metadata: JsonObject; metadataPath: string }> {
		const clientsRoot = this.config.clientsRootDir;
		if (!existsSync(clientsRoot)) return [];
		const clientNames = clientId
			? [sanitizePathComponent(clientId)].filter(Boolean)
			: clientDirectoryNames(clientsRoot);
		const records: Array<{ metadata: JsonObject; metadataPath: string }> = [];
		for (const clientName of clientNames) {
			const sessionsRoot = join(clientsRoot, clientName, "sessions");
			if (!existsSync(sessionsRoot)) continue;
			for (const sessionEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
				if (!sessionEntry.isDirectory()) continue;
				const metadataPath = join(sessionsRoot, sessionEntry.name, "project", PROJECT_METADATA_FILE);
				if (!existsSync(metadataPath)) continue;
				try {
					const metadata = readJsonFile(metadataPath);
					if (clientId && metadata.clientId !== clientId) continue;
					records.push({ metadata, metadataPath });
				} catch {
					// Ignore partial or corrupt generated project records.
				}
			}
		}
		return records;
	}

	private writeProjectLogEvent(
		eventType: string,
		clientId: string | undefined,
		sessionId: string,
		projectId: string,
		data: JsonObject,
	): void {
		this.diagnostics?.writeEvents({
			events: [
				{
					clientId,
					level: data.status === "failed" ? "error" : "info",
					category: "project",
					eventType,
					sessionId,
					traceId: sessionId,
					spanId: projectId,
					data: { projectId, ...data },
				},
			],
		});
	}
}

function projectPreviewSummary(metadata: JsonObject): ProjectPreviewSummary | undefined {
	const projectId = stringValue(metadata.projectId);
	if (!projectId || safePreviewProjectId(projectId) !== projectId) return undefined;
	const clientId = stringValue(metadata.clientId);
	const sessionId = stringValue(metadata.sessionId);
	const title = stringValue(metadata.title);
	const status = stringValue(metadata.status);
	const updatedAt = stringValue(metadata.updatedAt);
	const fileCount = numberValue(metadata.fileCount);
	if (!sessionId || !title || !status || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) return undefined;
	if (metadata.mode !== "static" || fileCount === undefined) return undefined;
	return {
		projectId,
		...(clientId ? { clientId } : {}),
		sessionId,
		title,
		status,
		mode: "static",
		previewUrl: stringValue(metadata.previewUrl),
		fileCount,
		updatedAt,
	};
}

function safePreviewProjectId(value: string): string {
	const projectId = value.trim();
	if (!projectId || projectId.includes("..") || projectId.includes("/") || projectId.includes("\\")) return "";
	if (!/^[a-z0-9._-]+$/i.test(projectId)) return "";
	return projectId;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clientDirectoryNames(clientsRoot: string): string[] {
	return readdirSync(clientsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function normalizeProjectTitle(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function buildPreviewUrl(config: PreviewOriginConfig, _req: PreviewRequestLike, projectId: string): string {
	return buildTrustedPreviewUrl(config, projectId);
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
