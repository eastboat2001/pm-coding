import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { PREVIEW_PREFIX, PROJECT_METADATA_FILE } from "./constants.js";
import { isObject, readJsonFile, sendJson, writeJsonFile } from "./json.js";
import { NodeServiceRuntime } from "./node-service-runtime.js";
import type {
	JsonObject,
	PreviewRequestLike,
	ProjectPreviewRequest,
	ProjectPreviewResult,
	StorageConfig,
} from "./types.js";
import { runCommand } from "./workspace-command-service.js";
import {
	assertInside,
	listProjectSourceFiles,
	removeSiblingProjectDirs,
	safeRelativePreviewPath,
	workspaceContext,
} from "./workspace-paths.js";

export class WorkspacePreviewService {
	constructor(
		private readonly config: StorageConfig,
		private readonly nodeServices = new NodeServiceRuntime(),
	) {}

	async preview(body: ProjectPreviewRequest, req: PreviewRequestLike): Promise<ProjectPreviewResult> {
		const { sessionId, title, projectId, projectDir } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId);
		const fileCount = listProjectSourceFiles(projectDir).length;
		if (fileCount === 0) throw new Error("Cannot preview an empty project workspace.");
		return await this.buildAndRecordProject(projectDir, { projectId, sessionId, title, req, fileCount });
	}

	dispose(): void {
		this.nodeServices.dispose();
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

		if (metadata.mode === "node-service") {
			const previewBasePath = `${PREVIEW_PREFIX}/${encodeURIComponent(decodeURIComponent(projectId))}/`;
			proxyNodeServicePreview(req, res, metadata, parts, url.search, previewBasePath);
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
		let serveRoot = projectDir;
		let status = "running";
		let mode: ProjectPreviewResult["mode"] = "static";
		let previewUrl = buildPreviewUrl(this.config, options.req, options.projectId);
		let startCommand: string | undefined;
		let servicePort: number | undefined;

		try {
			if (existsSync(packageJsonPath)) {
				await runCommand(this.config.projectInstallCommand, projectDir, this.config.projectInstallTimeoutMs, logs);
				const packageJson = readJsonFile(packageJsonPath);
				if (isObject(packageJson.scripts) && typeof packageJson.scripts.build === "string") {
					await runCommand(this.config.projectBuildCommand, projectDir, this.config.projectBuildTimeoutMs, logs);
				}

				const builtStaticRoot = findStaticServeRoot(projectDir, ["dist", "build"]);
				if (builtStaticRoot) {
					serveRoot = builtStaticRoot;
					logs.push(`Serving static output: ${serveRoot}\n`);
				} else {
					const command = nodeServiceStartCommand(projectDir, packageJson);
					if (command) {
						const runtime = await this.nodeServices.start(options.projectId, projectDir, command);
						mode = "node-service";
						previewUrl = buildPreviewUrl(this.config, options.req, options.projectId);
						startCommand = runtime.command;
						servicePort = runtime.port;
						logs.push(...runtime.logs);
						logs.push(`Node service proxied at: ${previewUrl}\n`);
					} else {
						const fallbackStaticRoot = findStaticServeRoot(projectDir, ["", "public"]);
						if (!fallbackStaticRoot) {
							throw new Error(
								"Project is not previewable: no static index.html, build output, or package.json start script was found.",
							);
						}
						serveRoot = fallbackStaticRoot;
						logs.push(`Serving static output: ${serveRoot}\n`);
					}
				}
			} else {
				const staticRoot = findStaticServeRoot(projectDir, [""]);
				if (!staticRoot) throw new Error("Project is not previewable: index.html is missing.");
				serveRoot = staticRoot;
				logs.push("No package.json found; serving project root without install/build.\n");
			}
		} catch (error) {
			status = "failed";
			previewUrl = "";
			logs.push(error instanceof Error ? error.message : String(error));
		}

		const metadata: ProjectPreviewResult = {
			version: 1,
			projectId: options.projectId,
			sessionId: options.sessionId,
			title: options.title,
			status,
			mode,
			previewUrl,
			projectRoot: projectDir,
			serveRoot,
			startCommand,
			servicePort,
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

function findStaticServeRoot(projectDir: string, candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		const serveRoot = candidate ? join(projectDir, candidate) : projectDir;
		const entryPath = join(serveRoot, "index.html");
		if (existsSync(entryPath) && statSync(entryPath).isFile()) return serveRoot;
	}
	return undefined;
}

function nodeServiceStartCommand(projectDir: string, packageJson: JsonObject): string | undefined {
	if (isObject(packageJson.scripts) && typeof packageJson.scripts.start === "string") return "npm start";
	const main = typeof packageJson.main === "string" ? safeNodeEntrypoint(packageJson.main) : "";
	if (main && existsSync(join(projectDir, main))) return `node ${main}`;
	for (const filename of ["server.js", "app.js", "index.js"]) {
		if (existsSync(join(projectDir, filename))) return `node ${filename}`;
	}
	return undefined;
}

function safeNodeEntrypoint(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
	if (!normalized || normalized.includes("..")) return "";
	return normalized;
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

function proxyNodeServicePreview(
	req: IncomingMessage,
	res: ServerResponse,
	metadata: JsonObject,
	parts: string[],
	search: string,
	previewBasePath: string,
): void {
	const servicePort = Number(metadata.servicePort);
	if (!Number.isInteger(servicePort) || servicePort <= 0) {
		sendJson(res, { error: "Node service preview is unavailable." }, 502);
		return;
	}

	const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${servicePort}` };
	for (const header of HOP_BY_HOP_HEADERS) delete headers[header];
	delete headers["accept-encoding"];
	const upstreamPath = nodeServiceUpstreamPath(parts, search);
	const upstream = httpRequest(
		{
			host: "127.0.0.1",
			port: servicePort,
			method: req.method,
			path: upstreamPath,
			headers,
		},
		(upstreamRes) => {
			const contentType = String(upstreamRes.headers["content-type"] || "");
			const contentEncoding = String(upstreamRes.headers["content-encoding"] || "");
			if (!contentEncoding && contentType.toLowerCase().includes("text/html")) {
				const chunks: Buffer[] = [];
				upstreamRes.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				upstreamRes.on("end", () => {
					writeProxyHeaders(res, upstreamRes.statusCode || 200, upstreamRes.headers, true);
					res.end(rewritePreviewHtml(Buffer.concat(chunks).toString("utf8"), previewBasePath));
				});
				return;
			}

			writeProxyHeaders(res, upstreamRes.statusCode || 200, upstreamRes.headers, false);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", (error) => {
		if (res.headersSent) {
			res.destroy(error);
			return;
		}
		sendJson(res, { error: "Node service preview is unavailable." }, 502);
	});
	req.pipe(upstream);
}

const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function nodeServiceUpstreamPath(parts: string[], search: string): string {
	const pathname =
		parts.length > 0 ? `/${parts.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}` : "/";
	return `${pathname}${search}`;
}

function writeProxyHeaders(
	res: ServerResponse,
	statusCode: number,
	headers: IncomingMessage["headers"],
	dropContentLength: boolean,
): void {
	res.statusCode = statusCode;
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (HOP_BY_HOP_HEADERS.includes(name.toLowerCase())) continue;
		if (dropContentLength && name.toLowerCase() === "content-length") continue;
		res.setHeader(name, value);
	}
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
