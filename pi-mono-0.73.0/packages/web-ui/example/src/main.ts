import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	LanguageTab,
	loadAttachment,
	ModelSelector,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	getCurrentLanguage,
	i18n,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, Plus, Settings } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";
import { LocalSessionListDialog } from "./dialogs/LocalSessionListDialog.js";
import { ConfiguredServerStorage } from "./storage/configured-server-storage.js";
import { mergeSessionMetadata } from "./storage/merged-session-index.js";
import { createServerProjectTools } from "./tools/server-project.js";

registerCustomMessageRenderers();
document.documentElement.lang = getCurrentLanguage();

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);
const configuredStorage = new ConfiguredServerStorage();

const DEFAULT_MODEL_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";
const CURRENT_SESSION_ID_KEY = "example.currentSessionId";
const SELECTED_MODEL_KEY = "example.selectedModel";
const DEFAULT_NEW_SESSION_TITLES = new Set(["New Session", "新建会话", "Neue Sitzung", "Sesi baharu"]);
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI coding assistant that creates runnable projects directly in a configured server workspace.

Available server project tools:
- project_file: create, rewrite, update, read, delete, and list files in the server project root.
- project_bash: run short non-interactive shell commands in the server project root.
- project_preview: install/build if needed, serve the project, and return a Preview URL.

When the user asks to create, update, run, or deploy an app/site/project:
1. Use project_file to create complete project files. Prefer multiple files when appropriate, such as index.html, style.css, script.js, package.json, src files, and README.md.
2. Use project_bash for quick validation or build commands when useful. Do not start long-running dev servers.
3. project_bash runs on the PI server OS. If a command fails, read the returned error/output, adapt to the reported environment, and retry when useful.
4. For simple static HTML/CSS/JS projects, project_bash is optional; project_preview is enough after files are ready.
5. Use project_preview after the files are ready.
6. Keep the user's language for app UI text unless the user asks otherwise.
7. Do not ask the user to choose a directory, download files, run commands, or deploy manually.

After the tool returns, summarize the result briefly and include the Preview URL.`;

const PI_CODING_HANDOFF_INSTRUCTIONS = `平台执行要求：
1. PM 携带的实现提示词、PRD 文档、设计文档是需求主依据；以下内容只补充 PI 平台的执行方式，不改变或扩大 PM 的产品范围。
2. 根据 PM 文档要求选择最小可运行实现；如果 PM 文档描述的是静态页面或 Node 前端项目，不要额外引入后端、数据库或常驻服务。
3. 你必须使用 project_file 工具生成完整项目文件，不要只输出说明文档或零散代码片段。
4. 需要验证或构建时，使用 project_bash 执行短命令；不要启动长期运行的 dev server。
5. project_bash 运行在 PI 服务器操作系统上。如果命令失败，读取工具返回的错误和输出，根据返回的运行环境自行调整命令并在需要时重试。
6. 对纯静态 HTML/CSS/JS 项目，文件完成后可以直接调用 project_preview；对 Vite/React/Vue 等 Node 前端项目，优先构建后预览 dist。
7. 项目文件准备完成后，必须调用 project_preview 发布项目并返回 Preview URL。
8. 必须保留 PM 携带的实现提示词原文语义和语言，不要翻译、替换或重新改写需求。
9. 不要要求用户手动选择目录、下载文件、运行 npm install、运行 npm run dev 或手动部署。
10. 最终回复必须包含工具返回的 Preview URL，并简要说明项目已生成和发布。`;

let currentSessionId: string | undefined;
let currentSessionCreatedAt: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;

type PmHandoffDocument = {
	kind: string;
	filename: string;
	mime_type: string;
	download_url: string;
};

type PmHandoffPayload = {
	source: string;
	transport: string;
	session_id: string;
	title: string;
	documents_ready: boolean;
	implementation_prompt?: string;
	documents?: PmHandoffDocument[];
	expires_at?: string;
};

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const isDefaultNewSessionTitle = (title?: string) => !title || DEFAULT_NEW_SESSION_TITLES.has(title.trim());

const getDisplayTitle = () => isDefaultNewSessionTitle(currentTitle) ? i18n("New Session") : currentTitle;

const updateUrl = (sessionId?: string) => {
	const url = new URL(window.location.href);
	url.searchParams.delete("handoff_token");
	url.searchParams.delete("pm_api_base_url");
	if (sessionId) {
		url.searchParams.set("session", sessionId);
	} else {
		url.searchParams.delete("session");
	}
	window.history.replaceState({}, "", url);
};

const buildPmApiUrl = (path: string) => {
	const url = new URL(window.location.href);
	const baseUrl = url.searchParams.get("pm_api_base_url");
	if (!baseUrl) {
		throw new Error("Missing pm_api_base_url query parameter");
	}
	return new URL(path, baseUrl).toString();
};

const fetchPmHandoffPayload = async (token: string): Promise<PmHandoffPayload> => {
	const response = await fetch(buildPmApiUrl(`/api/coding-handoffs/${encodeURIComponent(token)}`));
	const data = (await response.json().catch(() => ({}))) as PmHandoffPayload & { error?: string };
	if (!response.ok) {
		throw new Error(data.error || `Failed to resolve handoff: ${response.status}`);
	}
	return data;
};

const buildCodingHandoffPrompt = (payload: PmHandoffPayload): string => {
	const sourcePrompt = (payload.implementation_prompt || "").trim();
	if (!sourcePrompt) return PI_CODING_HANDOFF_INSTRUCTIONS;
	return `${sourcePrompt}\n\n---\n\n${PI_CODING_HANDOFF_INSTRUCTIONS}`;
};

const getSessionTitle = (messages: AgentMessage[]): string =>
	(!isDefaultNewSessionTitle(currentTitle) ? currentTitle : "") || generateTitle(messages) || i18n("New Session");

const getDefaultModel = async (): Promise<Model<any>> => {
	const storedModel = await storage.settings.get<Model<any>>(SELECTED_MODEL_KEY);
	if (storedModel && typeof storedModel === "object" && storedModel.id && storedModel.provider) {
		return storedModel;
	}
	const configuredSettings = await configuredStorage.readSettings();
	if (configuredSettings?.selectedModel && typeof configuredSettings.selectedModel === "object") {
		return configuredSettings.selectedModel;
	}
	return getModel(DEFAULT_MODEL_PROVIDER, DEFAULT_MODEL_ID);
};

const persistSelectedModel = async (model: Model<any>) => {
	await storage.settings.set(SELECTED_MODEL_KEY, model);
	await configuredStorage.writeSettings({ selectedModel: model });
};

const setCurrentSessionId = async (sessionId: string | undefined) => {
	currentSessionId = sessionId;
	if (sessionId) {
		await storage.settings.set(CURRENT_SESSION_ID_KEY, sessionId);
	} else {
		await storage.settings.delete(CURRENT_SESSION_ID_KEY);
	}
	await configuredStorage.writeSettings({ currentSessionId: sessionId ?? null });
	updateUrl(sessionId);
};

const ensureSessionIdentity = async () => {
	if (currentSessionId) return;
	currentSessionCreatedAt = new Date().toISOString();
	await setCurrentSessionId(crypto.randomUUID());
};

const createInitialAgentState = (model: Model<any>): Partial<AgentState> => ({
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	model,
	thinkingLevel: "off",
	messages: [],
	tools: [],
});

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent) return;

	const state = agent.state;
	const createdAt = currentSessionCreatedAt || new Date().toISOString();
	currentSessionCreatedAt = createdAt;
	const resolvedTitle = getSessionTitle(state.messages);
	const lastModified = new Date().toISOString();

	try {
		const sessionData = {
			id: currentSessionId,
			title: resolvedTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt,
			lastModified,
		};

		const metadata = {
			id: currentSessionId,
			title: resolvedTitle,
			createdAt,
			lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
		await configuredStorage.writeSession(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const loadConfiguredSession = async (sessionId: string): Promise<boolean> => {
	const configuredRecord = await configuredStorage.readSession(sessionId);
	if (!configuredRecord) {
		return false;
	}
	await storage.sessions.save(configuredRecord.data, configuredRecord.metadata);
	await loadSession(sessionId);
	return true;
};

const loadMergedSession = async (sessionId: string): Promise<boolean> => {
	const browserSession = await storage.sessions.get(sessionId);
	const configuredSession = await configuredStorage.readSession(sessionId);
	if (browserSession && configuredSession) {
		if (configuredSession.data.lastModified > browserSession.lastModified) {
			await storage.sessions.save(configuredSession.data, configuredSession.metadata);
		}
		return await loadSession(sessionId);
	}
	if (browserSession) {
		return await loadSession(sessionId);
	}
	if (configuredSession) {
		return await loadConfiguredSession(sessionId);
	}
	return false;
};

const getMergedSessions = async () => {
	const browserSessions = await storage.sessions.getAllMetadata();
	const configuredSessions = await configuredStorage.listSessionMetadata();
	return mergeSessionMetadata(browserSessions, configuredSessions);
};

const deleteMergedSession = async (sessionId: string) => {
	await storage.sessions.deleteSession(sessionId);
	await configuredStorage.deleteSession(sessionId);
};

const handleAgentEvent = async (event: AgentEvent) => {
	switch (event.type) {
		case "message_end":
		case "agent_end": {
			const generatedTitle = generateTitle(agent.state.messages);
			if (isDefaultNewSessionTitle(currentTitle) && generatedTitle) {
				currentTitle = generatedTitle;
			}
			if (currentSessionId) {
				await saveSession();
			}
			renderApp();
			break;
		}
	}
};

const handleModelSelect = () => {
	ModelSelector.open(agent.state.model ?? null, (model) => {
		agent.state.model = model;
		void (async () => {
			await persistSelectedModel(model);
			if (currentSessionId) {
				await saveSession();
			}
			chatPanel.agentInterface?.requestUpdate();
			renderApp();
		})();
	});
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	const defaultModel = await getDefaultModel();
	agent = new Agent({
		initialState: initialState || createInitialAgentState(defaultModel),
		convertToLlm: customConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
		void handleAgentEvent(event);
	});

	await persistSelectedModel(agent.state.model!);

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		onBeforeSend: async () => {
			await ensureSessionIdentity();
			await persistSelectedModel(agent.state.model!);
			await saveSession();
		},
		onModelSelect: handleModelSelect,
		enableArtifacts: false,
		toolsFactory: (toolAgent) =>
			createServerProjectTools(() => ({
				sessionId: currentSessionId,
				title: getSessionTitle(toolAgent.state.messages),
			})),
	});
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	await setCurrentSessionId(sessionId);
	currentSessionCreatedAt = sessionData.createdAt;
	currentTitle = isDefaultNewSessionTitle(sessionData.title) ? "" : sessionData.title || "";
	await persistSelectedModel(sessionData.model);

	await createAgent({
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	renderApp();
	return true;
};

const startFreshSession = async (persistImmediately = false) => {
	currentTitle = "";
	currentSessionCreatedAt = undefined;
	await setCurrentSessionId(undefined);
	const model = await getDefaultModel();
	await createAgent(createInitialAgentState(model));
	if (persistImmediately) {
		await ensureSessionIdentity();
		await saveSession();
	}
	renderApp();
};

const bootstrapHandoffSession = async (payload: PmHandoffPayload) => {
	const attachments = await Promise.all(
		(payload.documents || []).map((document) =>
			loadAttachment(buildPmApiUrl(document.download_url), document.filename),
		),
	);
	await startFreshSession(true);
	if (payload.title) {
		currentTitle = payload.title;
	}
	chatPanel.agentInterface?.setInput(buildCodingHandoffPrompt(payload), attachments);
	if (currentSessionId) {
		await saveSession();
	}
	renderApp();
};

const restoreInitialSession = async () => {
	const urlParams = new URLSearchParams(window.location.search);
	const handoffToken = urlParams.get("handoff_token");
	if (handoffToken) {
		const payload = await fetchPmHandoffPayload(handoffToken);
		if (!payload.documents_ready) {
			throw new Error("PM handoff documents are not ready");
		}
		await bootstrapHandoffSession(payload);
		return;
	}

	const sessionIdFromUrl = urlParams.get("session");
	if (sessionIdFromUrl) {
		const loaded = await loadMergedSession(sessionIdFromUrl);
		if (loaded) return;
	}

	const storedCurrentSessionId = await storage.settings.get<string>(CURRENT_SESSION_ID_KEY);
	if (storedCurrentSessionId) {
		const loaded = await loadMergedSession(storedCurrentSessionId);
		if (loaded) return;
		await setCurrentSessionId(undefined);
	}

	const configuredSettings = await configuredStorage.readSettings();
	if (configuredSettings?.selectedModel) {
		await storage.settings.set(SELECTED_MODEL_KEY, configuredSettings.selectedModel);
	}
	if (configuredSettings?.currentSessionId) {
		const loaded = await loadMergedSession(configuredSettings.currentSessionId);
		if (loaded) return;
	}

	const latestSessionId = await storage.sessions.getLatestSessionId();
	if (latestSessionId) {
		const loaded = await loadMergedSession(latestSessionId);
		if (loaded) return;
	}

	const mergedSessions = await getMergedSessions();
	if (mergedSessions.length > 0) {
		const loaded = await loadMergedSession(mergedSessions[0].id);
		if (loaded) return;
	}

	await startFreshSession(false);
};

const newSession = async () => {
	await startFreshSession(true);
};

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="example-shell w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<div class="example-header flex items-center justify-between border-b border-border shrink-0">
				<div class="example-header__brand-row flex items-center gap-3 px-4 py-3 min-w-0">
					<div class="example-header__logo" aria-label=${i18n("AITC platform logo")}>
						<span class="example-header__logo-segment example-header__logo-segment--ats">AT&amp;S</span>
						<span class="example-header__logo-segment example-header__logo-segment--aitc">AITC</span>
					</div>
					<div class="example-header__session flex items-center gap-2 min-w-0">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							LocalSessionListDialog.open(
								getMergedSessions,
								async (sessionId) => {
									await loadMergedSession(sessionId);
								},
								(deletedSessionId) => {
									void (async () => {
										await deleteMergedSession(deletedSessionId);
										if (deletedSessionId === currentSessionId) {
											await setCurrentSessionId(undefined);
											const mergedSessions = await getMergedSessions();
											if (mergedSessions.length > 0) {
												const loaded = await loadMergedSession(mergedSessions[0].id);
												if (loaded) return;
											}
											await startFreshSession(true);
										}
									})();
								},
							);
						},
						title: i18n("Sessions"),
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: () => {
							void newSession();
						},
						title: i18n("New Session"),
					})}

					${
						getDisplayTitle()
							? isEditingTitle
								? html`<div class="flex items-center gap-2 min-w-0">
									${Input({
										type: "text",
										value: getDisplayTitle(),
										className: "text-sm w-64 max-w-full",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
												await saveSession();
											}
											isEditingTitle = false;
											renderApp();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
													await saveSession();
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="example-header__title-button px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors min-w-0"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = app?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title=${i18n("Click to edit title")}
								>
									${getDisplayTitle()}
								</button>`
							: html`<span class="example-header__title text-base font-semibold text-foreground">${i18n("AI Coding Platform")}</span>`
					}
					</div>
				</div>
				<div class="example-header__actions flex items-center gap-1 px-2 py-2 shrink-0">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Bell, "sm"),
						onClick: () => {
							if (agent) {
								agent.steer(
									createSystemNotification(
										"This is a custom message! It appears in the UI but is never sent to the LLM.",
									),
								);
							}
						},
						title: i18n("Demo: Add Custom Notification"),
					})}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => {
							SettingsDialog.open([new LanguageTab(), new ProvidersModelsTab(), new ProxyTab()]);
						},
						title: i18n("Settings"),
					})}
				</div>
			</div>

			${chatPanel}
		</div>
	`;

	render(appHtml, app);
};

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">${i18n("Loading...")}</div>
			</div>
		`,
		app,
	);

	chatPanel = new ChatPanel();
	await restoreInitialSession();
	renderApp();
}

initApp();
