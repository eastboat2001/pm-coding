import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	defaultConvertToLlm,
	getCurrentLanguage,
	IndexedDBStorageBackend,
	i18n,
	LanguageTab,
	loadAttachment,
	ModelSelector,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProvidersModelsTab,
	ProxyTab,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import "../app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { LocalSessionListDialog } from "../dialogs/LocalSessionListDialog.js";
import {
	buildCodingHandoffPrompt,
	buildPmApiUrl,
	fetchPmHandoffPayload,
	type PmHandoffPayload,
} from "../integrations/pm-handoff.js";
import { createServerProjectTools } from "../project-tools/tools.js";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/coding-system-prompt.js";
import { ConfiguredServerStorage } from "../storage/configured-server-storage.js";
import { mergeSessionMetadata } from "../storage/merged-session-index.js";
import { ServerBackedCustomProvidersStore } from "../storage/server-backed-custom-providers-store.js";
import { ServerBackedProviderKeysStore } from "../storage/server-backed-provider-keys-store.js";
import { ModelController, SELECTED_MODEL_KEY } from "./model-controller.js";
import { CURRENT_SESSION_ID_KEY, generateTitle, isDefaultNewSessionTitle, sessionTitle } from "./session-controller.js";

document.documentElement.lang = getCurrentLanguage();

const configuredStorage = new ConfiguredServerStorage();
const settings = new SettingsStore();
const sessions = new SessionsStore();
const customProviders = new ServerBackedCustomProvidersStore(configuredStorage);
const providerKeys = new ServerBackedProviderKeysStore(configuredStorage, async (providerName) => {
	const customProvider = (await customProviders.getAll()).find((provider) => provider.name === providerName);
	return customProvider?.apiKey || null;
});

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "pi-coding-web",
	version: 2,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);
const modelController = new ModelController(storage, configuredStorage);

let currentSessionId: string | undefined;
let currentSessionCreatedAt: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
const resumedInterruptedSessions = new Set<string>();

const getDisplayTitle = () => (isDefaultNewSessionTitle(currentTitle) ? i18n("New Session") : currentTitle);

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
	const resolvedTitle = sessionTitle(currentTitle, state.messages);
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
			await modelController.persistSelectedModel(model);
			if (currentSessionId) {
				await saveSession();
			}
			chatPanel.agentInterface?.requestUpdate();
			renderApp();
		})();
	});
};

const resumeInterruptedSessionIfNeeded = () => {
	if (!agent || !currentSessionId || resumedInterruptedSessions.has(currentSessionId)) return;
	if (agent.state.isStreaming) return;

	const lastMessage = agent.state.messages[agent.state.messages.length - 1];
	if (!lastMessage || lastMessage.role !== "toolResult") return;

	const sessionId = currentSessionId;
	resumedInterruptedSessions.add(sessionId);
	void agent.continue().catch((error) => {
		console.error("Failed to resume interrupted session:", error);
		resumedInterruptedSessions.delete(sessionId);
	});
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	const defaultModel = await modelController.getDefaultModel();
	agent = new Agent({
		initialState: initialState || createInitialAgentState(defaultModel),
		convertToLlm: defaultConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
		void handleAgentEvent(event);
	});

	await modelController.persistSelectedModel(agent.state.model!);

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		onBeforeSend: async () => {
			await ensureSessionIdentity();
			await modelController.persistSelectedModel(agent.state.model!);
			await saveSession();
		},
		onModelSelect: handleModelSelect,
		enableArtifacts: false,
		toolsFactory: (toolAgent) =>
			createServerProjectTools(() => ({
				sessionId: currentSessionId,
				title: sessionTitle(currentTitle, toolAgent.state.messages),
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
	await modelController.persistSelectedModel(sessionData.model);

	await createAgent({
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	renderApp();
	resumeInterruptedSessionIfNeeded();
	return true;
};

const startFreshSession = async (persistImmediately = false) => {
	currentTitle = "";
	currentSessionCreatedAt = undefined;
	await setCurrentSessionId(undefined);
	const model = await modelController.getDefaultModel();
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

			<main class="example-content flex-1 min-h-0 overflow-hidden">
				${chatPanel}
			</main>
		</div>
	`;

	render(appHtml, app);
};

export async function initApp() {
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
