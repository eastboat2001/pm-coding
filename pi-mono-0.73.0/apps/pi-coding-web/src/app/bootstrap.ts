import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	createStreamFn,
	defaultConvertToLlm,
	getCurrentLanguage,
	IndexedDBStorageBackend,
	i18n,
	LANGUAGE_CHANGE_EVENT,
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
	setLanguage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Folder, History, PanelsTopLeft, Plus, Settings } from "lucide";
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
import { compactProjectToolHistory } from "../project-tools/history.js";
import { createServerProjectTools } from "../project-tools/tools.js";
import { buildCodingSystemPrompt } from "../prompts/coding-system-prompt.js";
import { loadServerSkillList } from "../skill-tools/client.js";
import { enqueueDefaultSkillLoadMessages } from "../skill-tools/default-skill-message.js";
import { SkillStatusTab } from "../skill-tools/SkillStatusTab.js";
import type { SkillListDetails, SkillSummary } from "../skill-tools/schemas.js";
import { expandSkillCommandsInMessages, getLatestRequiredSkillNames } from "../skill-tools/skill-command.js";
import { createServerSkillTools } from "../skill-tools/tools.js";
import { ConfiguredServerStorage } from "../storage/configured-server-storage.js";
import type { MergedSessionEntry } from "../storage/merged-session-index.js";
import { ServerBackedCustomProvidersStore } from "../storage/server-backed-custom-providers-store.js";
import { ServerBackedProviderKeysStore } from "../storage/server-backed-provider-keys-store.js";
import "./GeneratedAppsPanel.js";
import type { GeneratedAppsPanel } from "./GeneratedAppsPanel.js";
import {
	clampGeneratedAppsPanelWidth,
	GENERATED_APPS_PANEL_DEFAULT_WIDTH,
	readGeneratedAppsPanelWidth,
	writeGeneratedAppsPanelWidth,
} from "./generated-apps-state.js";
import { ModelController, SELECTED_MODEL_KEY } from "./model-controller.js";
import { CURRENT_SESSION_ID_KEY, generateTitle, isDefaultNewSessionTitle, sessionTitle } from "./session-controller.js";

const piRuntimeConfig = {
	serverSessionSyncEnabled: false,
	handoffDefaultThinkingLevel: "high" as ThinkingLevel,
	selectableSkills: [] as SkillSummary[],
	globalSkills: [] as SkillSummary[],
	defaultSkills: [] as SkillSummary[],
	skillDiagnostics: [] as SkillDiagnostic[],
	skillSlashSuggestions: [] as SkillSlashSuggestion[],
};

type SkillSlashSuggestion = {
	id: string;
	label: string;
	detail?: string;
	trigger: string;
	insertText: string;
	keepOpen?: boolean;
	emptyLabel?: string;
	emptyDetail?: string;
};

type SkillDiagnostic = SkillListDetails["diagnostics"][number];

type SlashSuggestionHost = {
	slashSuggestions: SkillSlashSuggestion[];
	requestUpdate?: () => void;
};

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

const getProviderApiKey = async (provider: string): Promise<string | undefined> => {
	return (await storage.providerKeys.get(provider)) ?? undefined;
};

const getProxyUrl = async (): Promise<string | undefined> => {
	const enabled = await storage.settings.get<boolean>("proxy.enabled");
	return enabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
};

const loadPiRuntimeConfig = async () => {
	const [status, skillList] = await Promise.all([configuredStorage.getStatus(), loadServerSkillList()]);
	const selectableSkills = Array.isArray(skillList.skills) ? skillList.skills : [];
	const promptSkills = Array.isArray(skillList.promptSkills) ? skillList.promptSkills : [];
	const defaultSkills = Array.isArray(skillList.defaultSkills) ? skillList.defaultSkills : [];
	const diagnostics = Array.isArray(skillList.diagnostics) ? skillList.diagnostics : [];
	piRuntimeConfig.serverSessionSyncEnabled = status?.serverSessionSyncEnabled === true;
	piRuntimeConfig.handoffDefaultThinkingLevel = normalizeThinkingLevel(status?.handoffDefaultThinkingLevel);
	piRuntimeConfig.selectableSkills = selectableSkills;
	piRuntimeConfig.globalSkills = promptSkills;
	piRuntimeConfig.defaultSkills = defaultSkills;
	piRuntimeConfig.skillDiagnostics = diagnostics;
	piRuntimeConfig.skillSlashSuggestions = [
		createSkillSlashCommand(skillApiErrorDetail(diagnostics)),
		...selectableSkills.map(skillToSlashSuggestion),
	];
};

const syncRuntimeConfigAfterRender = async () => {
	await loadPiRuntimeConfig();
	if (agent) {
		agent.state.systemPrompt = buildCurrentSystemPrompt();
	}
	applySkillSlashSuggestions();
	if (isServerSessionSyncEnabled() && currentSessionId) {
		await configuredStorage.writeSettings({ currentSessionId });
	}
};

const isServerSessionSyncEnabled = () => piRuntimeConfig.serverSessionSyncEnabled;

const normalizeThinkingLevel = (value?: string): ThinkingLevel => {
	const normalized = String(value || "")
		.trim()
		.toLowerCase();
	if (
		normalized === "off" ||
		normalized === "minimal" ||
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high" ||
		normalized === "xhigh"
	) {
		return normalized;
	}
	return "high";
};

let currentSessionId: string | undefined;
let currentSessionCreatedAt: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
const resumedInterruptedSessions = new Set<string>();
let activeSidebarPanel: "apps" | null = null;
let generatedAppsPanelWidth = safeReadGeneratedAppsPanelWidth();

const getDisplayTitle = () => (isDefaultNewSessionTitle(currentTitle) ? i18n("New Session") : currentTitle);

function safeReadGeneratedAppsPanelWidth(): number {
	try {
		return readGeneratedAppsPanelWidth();
	} catch {
		return GENERATED_APPS_PANEL_DEFAULT_WIDTH;
	}
}

function safeWriteGeneratedAppsPanelWidth(width: number): number {
	try {
		return writeGeneratedAppsPanelWidth(width);
	} catch {
		return clampGeneratedAppsPanelWidth(width, window.innerWidth);
	}
}

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
	if (isServerSessionSyncEnabled()) {
		await configuredStorage.writeSettings({ currentSessionId: sessionId ?? null });
	}
	updateUrl(sessionId);
};

const ensureSessionIdentity = async () => {
	if (currentSessionId) return;
	currentSessionCreatedAt = new Date().toISOString();
	await setCurrentSessionId(crypto.randomUUID());
};

const buildCurrentSystemPrompt = () => buildCodingSystemPrompt(piRuntimeConfig.globalSkills);

const DEFAULT_SKILL_EMPTY_DETAIL = "请在服务端 skillsDir 下添加 data/skills/<skill-name>/SKILL.md。";

const createSkillSlashCommand = (emptyDetail = DEFAULT_SKILL_EMPTY_DETAIL): SkillSlashSuggestion => ({
	id: "command:skill",
	label: "skill",
	detail: "选择服务端全局 skill",
	trigger: "/",
	insertText: "/skill",
	keepOpen: true,
	emptyLabel: "没有可用 skill",
	emptyDetail,
});

const skillApiErrorDetail = (diagnostics: SkillDiagnostic[]): string | undefined =>
	diagnostics.find((diagnostic) => diagnostic.type === "error" && diagnostic.path === "/api/pi-skills")?.message;

const skillToSlashSuggestion = (skill: SkillSummary): SkillSlashSuggestion => ({
	id: `skill:${skill.name}`,
	label: skill.interface?.displayName || skill.name,
	detail: skill.interface?.shortDescription || skill.description,
	trigger: "/skill",
	insertText: `/skill:${skill.name} `,
});

const applySkillSlashSuggestions = () => {
	const agentInterface = chatPanel?.agentInterface as unknown as SlashSuggestionHost | undefined;
	if (!agentInterface) return;
	agentInterface.slashSuggestions = piRuntimeConfig.skillSlashSuggestions;
	agentInterface.requestUpdate?.();
};

const createInitialAgentState = (model?: Model<any>): Partial<AgentState> => ({
	systemPrompt: buildCurrentSystemPrompt(),
	...(model ? { model } : {}),
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
		if (isServerSessionSyncEnabled()) {
			await configuredStorage.writeSession(sessionData, metadata);
		}
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const getBrowserSessions = async (): Promise<MergedSessionEntry[]> => {
	const browserSessions = await storage.sessions.getAllMetadata();
	return browserSessions
		.map((session) => ({
			...session,
			browser: session,
			preferredSource: "browser" as const,
		}))
		.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
};

const deleteBrowserSession = async (sessionId: string) => {
	await storage.sessions.deleteSession(sessionId);
	if (isServerSessionSyncEnabled()) {
		await configuredStorage.deleteSession(sessionId);
	}
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
			if (event.type === "agent_end" && activeSidebarPanel === "apps") {
				refreshGeneratedAppsPanel();
			}
			break;
		}
	}
};

function toggleGeneratedAppsPanel(): void {
	activeSidebarPanel = activeSidebarPanel === "apps" ? null : "apps";
	renderApp();
}

function refreshGeneratedAppsPanel(): void {
	requestAnimationFrame(() => {
		const panel = document.querySelector("pi-generated-apps-panel") as GeneratedAppsPanel | null;
		void panel?.refresh();
	});
}

function startGeneratedAppsPanelResize(event: PointerEvent): void {
	if (activeSidebarPanel !== "apps") return;
	event.preventDefault();
	const startX = event.clientX;
	const startWidth = generatedAppsPanelWidth;
	document.body.classList.add("app-is-resizing-generated-apps");

	const updateWidth = (moveEvent: PointerEvent) => {
		generatedAppsPanelWidth = clampGeneratedAppsPanelWidth(
			startWidth + moveEvent.clientX - startX,
			window.innerWidth,
		);
		renderApp();
	};
	const finishResize = () => {
		window.removeEventListener("pointermove", updateWidth);
		window.removeEventListener("pointerup", finishResize);
		window.removeEventListener("pointercancel", finishResize);
		document.body.classList.remove("app-is-resizing-generated-apps");
		generatedAppsPanelWidth = safeWriteGeneratedAppsPanelWidth(generatedAppsPanelWidth);
		renderApp();
	};

	window.addEventListener("pointermove", updateWidth);
	window.addEventListener("pointerup", finishResize, { once: true });
	window.addEventListener("pointercancel", finishResize, { once: true });
}

const handleModelSelect = () => {
	ModelSelector.open(
		agent.state.model ?? null,
		(model) => {
			agent.state.model = model;
			void (async () => {
				await modelController.persistSelectedModel(model);
				if (currentSessionId) {
					await saveSession();
				}
				chatPanel.agentInterface?.requestUpdate();
				renderApp();
			})();
		},
		undefined,
		false,
	);
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
	const resolvedInitialState = initialState || createInitialAgentState(defaultModel);
	agent = new Agent({
		initialState: { ...resolvedInitialState, systemPrompt: buildCurrentSystemPrompt() },
		convertToLlm: defaultConvertToLlm,
		transformContext: async (messages) =>
			compactProjectToolHistory(
				await expandSkillCommandsInMessages(messages, {
					defaultSkillNames: piRuntimeConfig.defaultSkills.map((skill) => skill.name),
				}),
			),
		streamFn: createStreamFn(getProxyUrl),
		getApiKey: getProviderApiKey,
	});
	(agent as Agent & { repairToolCalls: boolean }).repairToolCalls = true;

	agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
		void handleAgentEvent(event);
	});

	await modelController.persistSelectedModel(agent.state.model);

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		onBeforeSend: async () => {
			await ensureSessionIdentity();
			await enqueueDefaultSkillLoadMessages(agent, piRuntimeConfig.defaultSkills);
			await modelController.persistSelectedModel(agent.state.model);
			await saveSession();
		},
		onModelSelect: handleModelSelect,
		onThinkingChange: async () => {
			await ensureSessionIdentity();
			await saveSession();
		},
		enableArtifacts: false,
		toolsFactory: (toolAgent) => [
			...createServerSkillTools(),
			...createServerProjectTools(() => ({
				sessionId: currentSessionId,
				title: sessionTitle(currentTitle, toolAgent.state.messages),
				activeSkillNames: getLatestRequiredSkillNames(
					toolAgent.state.messages,
					piRuntimeConfig.defaultSkills.map((skill) => skill.name),
				),
			})),
		],
	});
	applySkillSlashSuggestions();
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
	const sessionModel = await modelController.resolveCustomModel(sessionData.model);
	if (sessionModel) {
		await modelController.persistSelectedModel(sessionModel);
	}

	await createAgent({
		...(sessionModel ? { model: sessionModel } : {}),
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

const normalizeHandoffLanguage = (language?: string) => {
	const normalized = String(language || "")
		.trim()
		.toLowerCase()
		.replace("_", "-");
	if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
	if (normalized === "de" || normalized.startsWith("de-")) return "de";
	if (normalized === "ms" || normalized.startsWith("ms-")) return "ms";
	return "en";
};

const applyHandoffLanguage = (language?: string) => {
	const handoffLanguage = normalizeHandoffLanguage(language);
	setLanguage(handoffLanguage);
	document.documentElement.lang = handoffLanguage;
};

const applyHandoffDefaultThinkingLevel = async () => {
	if (agent.state.model?.reasoning !== true) return;
	if (agent.state.thinkingLevel !== "off") return;
	if (agent.state.messages.length > 0) return;

	agent.state.thinkingLevel = piRuntimeConfig.handoffDefaultThinkingLevel;
	if (currentSessionId) {
		await saveSession();
	}
};

const bootstrapHandoffSession = async (payload: PmHandoffPayload) => {
	applyHandoffLanguage(payload.language);
	const attachments = await Promise.all(
		(payload.documents || []).map((document) =>
			loadAttachment(buildPmApiUrl(document.download_url), document.filename),
		),
	);
	await startFreshSession(true);
	if (payload.title) {
		currentTitle = payload.title;
	}
	await applyHandoffDefaultThinkingLevel();
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
		await loadPiRuntimeConfig();
		const payload = await fetchPmHandoffPayload(handoffToken);
		if (!payload.documents_ready) {
			throw new Error("PM handoff documents are not ready");
		}
		await bootstrapHandoffSession(payload);
		return;
	}

	const sessionIdFromUrl = urlParams.get("session");
	if (sessionIdFromUrl) {
		if (urlParams.get("source") === "rqmd") {
			await loadPiRuntimeConfig();
		}
		const loaded = await loadSession(sessionIdFromUrl);
		if (loaded && urlParams.get("source") === "rqmd") {
			await applyHandoffDefaultThinkingLevel();
			renderApp();
		}
		if (loaded) return;
	}

	const storedCurrentSessionId = await storage.settings.get<string>(CURRENT_SESSION_ID_KEY);
	if (storedCurrentSessionId) {
		const loaded = await loadSession(storedCurrentSessionId);
		if (loaded) return;
		await setCurrentSessionId(undefined);
	}

	const configuredSettings = await configuredStorage.readSettings();
	if (configuredSettings?.selectedModel) {
		await storage.settings.set(SELECTED_MODEL_KEY, configuredSettings.selectedModel);
	}

	const latestSessionId = await storage.sessions.getLatestSessionId();
	if (latestSessionId) {
		const loaded = await loadSession(latestSessionId);
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
								getBrowserSessions,
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									void (async () => {
										await deleteBrowserSession(deletedSessionId);
										if (deletedSessionId === currentSessionId) {
											await setCurrentSessionId(undefined);
											const browserSessions = await getBrowserSessions();
											if (browserSessions.length > 0) {
												const loaded = await loadSession(browserSessions[0].id);
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
							const providersTab = new ProvidersModelsTab();
							providersTab.showKnownProviders = false;
							const skillStatusTab = new SkillStatusTab();
							skillStatusTab.skills = piRuntimeConfig.selectableSkills;
							skillStatusTab.defaultSkills = piRuntimeConfig.defaultSkills;
							skillStatusTab.diagnostics = piRuntimeConfig.skillDiagnostics;
							SettingsDialog.open([new LanguageTab(), providersTab, new ProxyTab(), skillStatusTab]);
						},
						title: i18n("Settings"),
					})}
				</div>
			</div>

			<main class=${`example-content app-workspace flex-1 min-h-0 overflow-hidden ${activeSidebarPanel ? "app-workspace--panel-open" : ""}`}>
				<nav class="app-side-rail" aria-label="Workspace tools">
					<button
						type="button"
						class="app-side-rail__item"
						disabled
						title="Files"
						aria-label="Files"
					>
						<span class="app-side-rail__icon">${icon(Folder, "md")}</span>
						<span class="app-side-rail__label">Files</span>
					</button>
					<button
						type="button"
						class=${`app-side-rail__item ${activeSidebarPanel === "apps" ? "app-side-rail__item--active" : ""}`}
						@click=${toggleGeneratedAppsPanel}
						title="Generated Apps"
						aria-label="Generated Apps"
						aria-pressed=${activeSidebarPanel === "apps" ? "true" : "false"}
					>
						<span class="app-side-rail__icon">${icon(PanelsTopLeft, "md")}</span>
						<span class="app-side-rail__label">APP</span>
					</button>
				</nav>
				${
					activeSidebarPanel === "apps"
						? html`
							<aside class="generated-apps-sidebar" style=${`width: ${generatedAppsPanelWidth}px;`}>
								<pi-generated-apps-panel></pi-generated-apps-panel>
							</aside>
							<div
								class="generated-apps-resizer"
								role="separator"
								aria-orientation="vertical"
								title="Resize generated apps panel"
								@pointerdown=${startGeneratedAppsPanelResize}
							></div>
						`
						: ""
				}
				<section class="app-chat-workspace">
					${chatPanel}
				</section>
			</main>
		</div>
	`;

	render(appHtml, app);
};

window.addEventListener(LANGUAGE_CHANGE_EVENT, () => {
	document.documentElement.lang = getCurrentLanguage();
	chatPanel?.requestUpdate();
	chatPanel?.agentInterface?.requestUpdate();
	(
		chatPanel?.agentInterface?.querySelector("message-editor") as { requestUpdate?: () => void } | null
	)?.requestUpdate?.();
	renderApp();
});

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
	await loadPiRuntimeConfig();
	await restoreInitialSession();
	renderApp();
	void syncRuntimeConfigAfterRender();
}
