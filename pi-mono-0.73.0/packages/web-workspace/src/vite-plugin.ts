import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Connect, Plugin } from "vite";
import { loadStorageConfig } from "./config.js";
import { API_PREFIX, PREVIEW_PREFIX, PROJECTS_API_PREFIX } from "./constants.js";
import { isObject, readJsonBody, sendJson } from "./json.js";
import type { ProjectFileRequest, StorageConfig } from "./types.js";
import { WorkspaceCommandService } from "./workspace-command-service.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceSessionService } from "./workspace-session-service.js";

export function configuredStoragePlugin(configFile?: string): Plugin {
	const rootDir = process.cwd();
	const config = loadStorageConfig(rootDir, configFile);
	const sessions = new WorkspaceSessionService(config);
	const files = new WorkspaceFileService(config);
	const commands = new WorkspaceCommandService(config);
	const previews = new WorkspacePreviewService(config);

	const ensureStorageDirs = () => {
		sessions.ensureDirs();
		mkdirSync(dirname(config.settingsFile), { recursive: true });
	};

	const handler: Connect.NextHandleFunction = async (req, res, next) => {
		if (req.url?.startsWith(PREVIEW_PREFIX)) {
			try {
				ensureStorageDirs();
				if (previews.servePreviewRequest(req, res)) return;
			} catch (error) {
				sendJson(res, { error: errorMessage(error) }, 500);
				return;
			}
		}

		if (!req.url?.startsWith(API_PREFIX) && !req.url?.startsWith(PROJECTS_API_PREFIX)) {
			next();
			return;
		}

		try {
			ensureStorageDirs();
			const url = new URL(req.url, "http://localhost");
			const isProjectsApi = url.pathname.startsWith(PROJECTS_API_PREFIX);
			const route = url.pathname.slice(isProjectsApi ? PROJECTS_API_PREFIX.length : API_PREFIX.length) || "/";
			const method = req.method || "GET";

			if (isProjectsApi) {
				await handleProjectsApi(method, route, req, res, files, commands, previews);
				return;
			}

			await handleStorageApi(method, route, req, res, config, sessions);
		} catch (error) {
			sendJson(res, { error: errorMessage(error) }, 500);
		}
	};

	return {
		name: "pi-web-ui-configured-storage",
		configureServer(server) {
			server.middlewares.use(handler);
		},
		configurePreviewServer(server) {
			server.middlewares.use(handler);
		},
	};
}

async function handleProjectsApi(
	method: string,
	route: string,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	files: WorkspaceFileService,
	commands: WorkspaceCommandService,
	previews: WorkspacePreviewService,
): Promise<void> {
	if (method === "POST" && route === "/workspace/file") {
		const body = await readJsonBody(req);
		sendJson(res, files.handle(body as unknown as ProjectFileRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/bash") {
		const body = await readJsonBody(req);
		sendJson(
			res,
			await commands.run({ ...body, command: String(body.command || ""), sessionId: String(body.sessionId || "") }),
		);
		return;
	}
	if (method === "POST" && route === "/workspace/preview") {
		const body = await readJsonBody(req);
		sendJson(res, await previews.preview({ ...body, sessionId: String(body.sessionId || "") }, req));
		return;
	}
	const logsMatch = route.match(/^\/([^/]+)\/logs$/);
	if (method === "GET" && logsMatch) {
		sendJson(res, previews.readProjectLogs(decodeURIComponent(logsMatch[1])));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

async function handleStorageApi(
	method: string,
	route: string,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	config: StorageConfig,
	sessions: WorkspaceSessionService,
): Promise<void> {
	if (method === "GET" && route === "/status") {
		sendJson(res, {
			configured: true,
			sessionsDir: config.sessionsDir,
			settingsFile: config.settingsFile,
			projectsRootDir: config.projectsRootDir,
			previewBaseUrl: config.previewBaseUrl,
			serverSessionSyncEnabled: config.serverSessionSyncEnabled,
			defaultModelProvider: config.defaultModelProvider,
			defaultModelId: config.defaultModelId,
		});
		return;
	}
	if (method === "GET" && route === "/sessions") {
		sendJson(res, { sessions: sessions.listSessions() });
		return;
	}

	const sessionMatch = route.match(/^\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const sessionId = decodeURIComponent(sessionMatch[1]);
		if (method === "GET") {
			const record = sessions.readSession(sessionId);
			sendJson(res, record || { error: "Session not found." }, record ? 200 : 404);
			return;
		}
		if (method === "PUT") {
			const body = await readJsonBody(req);
			if (!isObject(body.data) || !isObject(body.metadata))
				throw new Error("Fields `data` and `metadata` are required.");
			sendJson(res, sessions.writeSession(sessionId, body.data, body.metadata));
			return;
		}
		if (method === "DELETE") {
			sendJson(res, { deleted: sessions.deleteSession(sessionId) });
			return;
		}
	}

	if (route === "/settings") {
		if (method === "GET") {
			const settings = sessions.readSettings();
			sendJson(res, settings || { error: "Settings not found." }, settings ? 200 : 404);
			return;
		}
		if (method === "PUT") {
			const body = await readJsonBody(req);
			sendJson(res, sessions.writeSettings(body));
			return;
		}
	}

	sendJson(res, { error: "Not found." }, 404);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
