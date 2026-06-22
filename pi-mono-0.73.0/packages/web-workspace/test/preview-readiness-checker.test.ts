import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_METADATA_FILE } from "../src/constants.js";
import { PreviewReadinessChecker } from "../src/preview-readiness-checker.js";
import type { StorageConfig } from "../src/types.js";

describe("PreviewReadinessChecker", () => {
	const input = { clientId: "client-a", sessionId: "session-1", title: "Preview" };
	const previewUrl = "http://localhost:5173/preview/project-client-a-session-/";
	const readyHtml = "<!doctype html><html><head><title>Ready</title></head><body><h1>Ready</h1></body></html>";

	let dir: string;
	let config: StorageConfig;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-preview-readiness-"));
		config = testConfig(dir);
	});

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true });
	});

	it("reports missing metadata", async () => {
		const checker = new PreviewReadinessChecker(config, { fetch: successFetch("<html><body>OK</body></html>") });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("missing_project_metadata");
	});

	it("reports failed metadata status without treating metadata as missing", async () => {
		writeProject({ status: "failed" });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch("<html><body>OK</body></html>") });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_error_page");
		expect(result.reasonCode).not.toBe("missing_project_metadata");
		expect(result.status).toBe("failed");
		expect(result.detail).toContain("status:failed");
	});

	it("reports preview_url_missing when running metadata has no preview URL", async () => {
		writeProject({ indexHtml: readyHtml, previewUrl: "" });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch(readyHtml) });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("preview_url_missing");
		expect(result.status).toBe("running");
	});

	it("uses configured preview base for probing while returning metadata preview URL", async () => {
		const publicPreviewUrl = "https://public.example/previews/project-client-a-session-";
		const probeCalls: string[] = [];
		config.previewBaseUrl = "http://127.0.0.1:5193";
		writeProject({ indexHtml: readyHtml, previewUrl: publicPreviewUrl });

		const checker = new PreviewReadinessChecker(config, {
			fetch: async (url) => {
				probeCalls.push(String(url));
				return {
					ok: true,
					status: 200,
					text: async () => readyHtml,
				} as Response;
			},
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(true);
		expect(result.previewUrl).toBe(publicPreviewUrl);
		expect(probeCalls).toEqual(["http://127.0.0.1:5193/preview/project-client-a-session-/"]);
	});

	it("does not fetch metadata preview URLs outside the project preview path when no preview base is configured", async () => {
		let fetched = false;
		writeProject({ indexHtml: readyHtml, previewUrl: "http://localhost:5173/admin/project-client-a-session-/" });

		const checker = new PreviewReadinessChecker(config, {
			fetch: async () => {
				fetched = true;
				return {
					ok: true,
					status: 200,
					text: async () => readyHtml,
				} as Response;
			},
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("preview_url_missing");
		expect(fetched).toBe(false);
	});

	it("does not trust metadata for a different project id", async () => {
		let fetched = false;
		writeProject({
			indexHtml: readyHtml,
			projectId: "project-other-client-session",
			previewUrl: "http://localhost:5173/preview/project-other-client-session/",
		});

		const checker = new PreviewReadinessChecker(config, {
			fetch: async () => {
				fetched = true;
				return {
					ok: true,
					status: 200,
					text: async () => readyHtml,
				} as Response;
			},
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("missing_project_metadata");
		expect(fetched).toBe(false);
	});

	it("reports serve_root_missing when metadata serve root is absent", async () => {
		writeProject({ indexHtml: readyHtml, serveRoot: join(dir, "missing-serve-root") });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch(readyHtml) });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("serve_root_missing");
		expect(result.previewUrl).toBe(previewUrl);
	});

	it("reports serve_root_missing when metadata serve root escapes the project directory", async () => {
		const outsideServeRoot = join(dir, "outside-serve-root");
		mkdirSync(outsideServeRoot, { recursive: true });
		writeFileSync(join(outsideServeRoot, "index.html"), readyHtml, "utf8");
		writeProject({ indexHtml: readyHtml, serveRoot: outsideServeRoot });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch(readyHtml) });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("serve_root_missing");
		expect(result.previewUrl).toBe(previewUrl);
	});

	it("reports index_html_missing when serve root has no index.html", async () => {
		writeProject();

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch(readyHtml) });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("index_html_missing");
		expect(result.previewUrl).toBe(previewUrl);
	});

	it("requires a non-empty index.html and basic HTML content", async () => {
		writeProject({ indexHtml: "" });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch("") });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("index_html_empty");
	});

	it("reports http_not_ok when preview URL returns non-2xx", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, { fetch: responseFetch("Not found", 404) });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("http_not_ok");
		expect(result.detail).toBe("HTTP 404");
	});

	it("reports http_not_ok when preview URL probe times out", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, {
			fetch: () => new Promise<Response>(() => {}),
			probeTimeoutMs: 5,
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("http_not_ok");
		expect(result.detail).toContain("timed out");
	});

	it("reports html_error_page when fetched HTML is a preview error page", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, {
			fetch: successFetch("<!doctype html><html><body><h1>Preview not found</h1></body></html>"),
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_error_page");
	});

	it("reports html_no_basic_content when fetched HTML has no basic page content", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, {
			fetch: successFetch(
				"<!doctype html><html><head><script>console.log('boot')</script><style>body{}</style></head></html>",
			),
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_no_basic_content");
	});

	it("reports html_no_basic_content when HTTP 2xx has an empty body even if local index has content", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch("   ") });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_no_basic_content");
	});

	it("reports html_no_basic_content when fetched HTML only has an empty body", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch("<html><body></body></html>") });
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_no_basic_content");
	});

	it("reports html_no_basic_content when fetched HTML has a title and scripts but an empty body", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, {
			fetch: successFetch(
				'<!doctype html><html><head><title>Ready</title><script src="/assets/app.js"></script></head><body></body></html>',
			),
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("html_no_basic_content");
	});

	it("reports static_resource_missing when referenced local assets are absent", async () => {
		writeProject({
			indexHtml:
				'<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body><h1>Ready</h1><script src="/assets/app.js"></script></body></html>',
		});

		const checker = new PreviewReadinessChecker(config, {
			fetch: successFetch(
				'<!doctype html><html><head><link rel="stylesheet" href="/preview/project-client-a-session-/css/app.css"></head><body><h1>Ready</h1><script src="/preview/project-client-a-session-/assets/app.js"></script></body></html>',
			),
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(false);
		expect(result.reasonCode).toBe("static_resource_missing");
		expect(result.detail).toContain("css/app.css");
		expect(result.detail).toContain("assets/app.js");
	});

	it("accepts referenced local static assets that exist", async () => {
		const projectDir = writeProject({
			indexHtml:
				'<!doctype html><html><head><link rel="stylesheet" href="css/app.css"></head><body><h1>Ready</h1><script src="/assets/app.js"></script></body></html>',
		});
		mkdirSync(join(projectDir, "css"), { recursive: true });
		mkdirSync(join(projectDir, "assets"), { recursive: true });
		writeFileSync(join(projectDir, "css", "app.css"), "body { color: black; }", "utf8");
		writeFileSync(join(projectDir, "assets", "app.js"), "console.log('ready');", "utf8");

		const checker = new PreviewReadinessChecker(config, {
			fetch: successFetch(
				'<!doctype html><html><head><link rel="stylesheet" href="/preview/project-client-a-session-/css/app.css"></head><body><h1>Ready</h1><script src="/preview/project-client-a-session-/assets/app.js"></script></body></html>',
			),
		});
		const result = await checker.check(input);

		expect(result.ready).toBe(true);
		expect(result.reasonCode).toBe("ready");
	});

	it("accepts a running preview with metadata, index.html, HTTP 2xx, and basic content", async () => {
		writeProject({ indexHtml: readyHtml });

		const checker = new PreviewReadinessChecker(config, { fetch: successFetch(readyHtml) });
		const result = await checker.check(input);

		expect(result.ready).toBe(true);
		expect(result.reasonCode).toBe("ready");
		expect(result.previewUrl).toBe(previewUrl);
	});

	function writeProject(
		options: {
			indexHtml?: string;
			previewUrl?: string;
			projectId?: string;
			serveRoot?: string;
			status?: string;
		} = {},
	): string {
		const projectDir = projectRoot(input.clientId, input.sessionId);
		const resolvedPreviewUrl = options.previewUrl ?? previewUrl;
		const resolvedServeRoot = options.serveRoot ?? projectDir;
		mkdirSync(projectDir, { recursive: true });
		if (options.indexHtml !== undefined) {
			writeFileSync(join(projectDir, "index.html"), options.indexHtml, "utf8");
		}
		writeMetadata(projectDir, {
			projectId: options.projectId ?? "project-client-a-session-",
			clientId: input.clientId,
			sessionId: input.sessionId,
			title: input.title,
			status: options.status ?? "running",
			mode: "static",
			previewUrl: resolvedPreviewUrl,
			projectRoot: projectDir,
			serveRoot: resolvedServeRoot,
			fileCount: 1,
			updatedAt: "2026-06-16T00:00:00.000Z",
			logs: [],
		});
		return projectDir;
	}

	function projectRoot(clientId: string, sessionId: string): string {
		return join(config.clientsRootDir, clientId, "sessions", sessionId, "project");
	}

	function writeMetadata(projectDir: string, metadata: Record<string, unknown>): void {
		writeFileSync(join(projectDir, PROJECT_METADATA_FILE), JSON.stringify(metadata), "utf8");
	}

	function successFetch(body: string): typeof fetch {
		return responseFetch(body, 200);
	}

	function responseFetch(body: string, status: number): typeof fetch {
		return async () =>
			({
				ok: status >= 200 && status < 300,
				status,
				text: async () => body,
			}) as Response;
	}

	function testConfig(root: string): StorageConfig {
		return {
			settingsFile: join(root, "settings.json"),
			clientsRootDir: join(root, "clients"),
			skillsDir: join(root, "skills"),
			defaultSkillsDir: join(root, "default-skills"),
			runtimeDbFile: join(root, "runtime.sqlite"),
			redisUrl: "redis://127.0.0.1:6379",
			runsEnabled: true,
			workerId: "worker-1",
			workerConcurrency: 1,
			runQueueName: "pi:runs",
			runEventRetentionDays: 30,
			clientIdRequired: true,
			previewBaseUrl: "",
			projectInstallCommand: "",
			projectBuildCommand: "",
			projectInstallTimeoutMs: 1000,
			projectBuildTimeoutMs: 1000,
			defaultModelProvider: "",
			defaultModelId: "",
			handoffDefaultThinkingLevel: "high",
			envFile: "",
			envFileExists: false,
			logsDbFile: join(root, "logs.sqlite"),
			loggingEnabled: false,
			logStdoutEnabled: false,
			rawProviderLoggingEnabled: false,
			rawProviderLogMaxChars: 12000,
			promptSnapshotLoggingEnabled: false,
			promptSnapshotMaxChars: 20000,
			modelOutputSnapshotLoggingEnabled: false,
			modelOutputSnapshotMaxChars: 20000,
			modelStreamIdleTimeoutMs: 60000,
			logRetentionDays: 30,
			logMaxEvents: 50000,
			logCleanupIntervalMs: 3600000,
			logVacuumIntervalMs: 86400000,
			langfuseEnabled: false,
			langfuseHost: "",
			langfusePublicKey: "",
			langfuseSecretKey: "",
			langfuseOtelEndpoint: "",
			langfuseFlushIntervalMs: 5000,
			langfuseBatchSize: 50,
			langfuseExportPromptSnapshots: false,
			langfuseExportRawChunks: false,
			langfuseExportModelOutputSnapshots: false,
			otelServiceName: "pi-coding-web",
			otelDeploymentEnvironment: "",
		};
	}
});
