import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, Model } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	type Attachment,
	ChatPanel,
	CUSTOM_PROVIDER_SAVED_EVENT,
	type CustomProviderSavedEvent,
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
	type SessionMetadata,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
	setLanguage,
} from "@mariozechner/pi-web-ui";
import type {
	AgentV2Error,
	AgentV2RunEventRecord,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
} from "@mariozechner/pi-web-workspace";
import { html, render } from "lit";
import { Folder, PanelsTopLeft, Plus, Settings } from "lucide";
import "../app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { DiagnosticLogsTab } from "../diagnostics/DiagnosticLogsTab.js";
import { createDiagnosticClient, type DiagnosticData, type DiagnosticEvent } from "../diagnostics/diagnostic-client.js";
import { createLoggedStreamFn, type DiagnosticStreamLoggingConfig } from "../diagnostics/model-stream-logger.js";
import { normalizeHandoffLanguage } from "../integrations/handoff-language.js";
import {
	buildPmApiUrl,
	buildVisibleCodingHandoffPrompt,
	fetchPmHandoffPayload,
	type HandoffDocumentFile,
	type PmHandoffPayload,
	prepareHandoffDocumentFiles,
} from "../integrations/pm-handoff.js";
import {
	type AgentV2ActivityEvent,
	appendAgentV2ActivityMessage,
	createAgentV2ActivityMessage,
	formatAgentV2DeliveryReport,
	formatAgentV2FailureReport,
} from "../runtime/agent-v2-activity-message.js";
import { registerAgentV2ActivityMessageRenderer } from "../runtime/agent-v2-activity-renderer.js";
import {
	AgentV2BrowserController,
	type AgentV2BrowserRunEventDrainResult,
	type AgentV2BrowserRunSink,
	type AgentV2DiagnosticRecordedPayload,
	type AgentV2OutputRecordedPayload,
	agentV2OutputToAssistantMessage,
	settleAgentV2BrowserTerminalSnapshot,
} from "../runtime/agent-v2-browser-controller.js";
import {
	cancelAgentV2Run,
	connectAgentV2RunEvents,
	getAgentV2Run,
	listAgentV2RunEvents,
	type AgentV2RunEventConnection as RunEventConnection,
	startAgentV2Run,
} from "../runtime/agent-v2-run-client.js";
import { piClientHeaders } from "../runtime/client-id.js";
import {
	buildConversationSnapshot,
	type ConversationSnapshotState,
	normalizeConversationSnapshotState,
} from "../runtime/conversation-snapshot.js";
import { collectProjectFilesFromMessages, prepareAttachmentProjectFileSeeds } from "../runtime/project-file-seed.js";
import { runConnectionStatusText } from "../runtime/run-connection-status.js";
import { createQueuedRunTimeoutDiagnostic } from "../runtime/run-health.js";
import {
	retryStatusFromRunEvent,
	retryStatusText,
	shouldClearRetryStatusForRunEvent,
} from "../runtime/run-retry-status.js";
import {
	providerStallStatusDelayMs,
	providerStallStatusText,
	type RunTransientStatusSource,
	type RunTransientStatusTexts,
	selectRunTransientStatusText,
} from "../runtime/run-transient-status.js";
import { type ChatSkillRuntimeSnapshot, createChatSkillRuntime } from "../skill-tools/chat-skill-runtime.js";
import { createChatSystemPrompt } from "../skill-tools/chat-system-prompt.js";
import { loadServerSkillList } from "../skill-tools/client.js";
import { registerLegacyDefaultSkillLoadMessageRenderer } from "../skill-tools/legacy-default-skill-message.js";
import { SkillStatusTab } from "../skill-tools/SkillStatusTab.js";
import type { SkillListDetails, SkillSummary } from "../skill-tools/schemas.js";
import { getLatestExplicitSkillNames, parseSkillCommandPrefix } from "../skill-tools/skill-command.js";
import { setBrowserAppStorage } from "../storage/browser-app-storage.js";
import { ConfiguredServerStorage } from "../storage/configured-server-storage.js";
import type { MergedSessionEntry } from "../storage/merged-session-index.js";
import { ServerBackedCustomProvidersStore } from "../storage/server-backed-custom-providers-store.js";
import { ServerBackedProviderKeysStore } from "../storage/server-backed-provider-keys-store.js";
import { sessionLastMessageModifiedAt } from "../storage/session-timestamps.js";
import "./CurrentProjectFilesPanel.js";
import type { CurrentProjectFilesPanel } from "./CurrentProjectFilesPanel.js";
import {
	CURRENT_PROJECT_FILE_PREVIEW_DRAWER_DEFAULT_WIDTH,
	CURRENT_PROJECT_FILES_PANEL_DEFAULT_WIDTH,
	clampCurrentProjectFilePreviewDrawerWidth,
	clampCurrentProjectFilesPanelWidth,
	readCurrentProjectFilePreviewDrawerWidth,
	readCurrentProjectFilesPanelWidth,
	writeCurrentProjectFilePreviewDrawerWidth,
	writeCurrentProjectFilesPanelWidth,
} from "./current-project-files-state.js";
import "./GeneratedAppsPanel.js";
import type { GeneratedAppsPanel } from "./GeneratedAppsPanel.js";
import {
	clampGeneratedAppsPanelWidth,
	GENERATED_APPS_PANEL_DEFAULT_WIDTH,
	loadSessionProjectApps,
	readGeneratedAppsPanelWidth,
	writeGeneratedAppsPanelWidth,
} from "./generated-apps-state.js";
import { ModelController, SELECTED_MODEL_KEY } from "./model-controller.js";
import { createCoalescedRenderScheduler } from "./render-scheduler.js";
import { CURRENT_SESSION_ID_KEY, generateTitle, isDefaultNewSessionTitle, sessionTitle } from "./session-controller.js";
import {
	canSwitchSessionMode,
	defaultSessionModeForEntry,
	dispatchSessionPrompt,
	normalizeSessionMode,
	type SessionMode,
	sessionModeLabel,
	sessionModeTools,
} from "./session-mode.js";

const ACTIVE_RUN_STATUSES: ReadonlySet<AgentV2RunStatus> = new Set(["queued", "running", "cancelling"]);
const TERMINAL_RUN_STATUSES: ReadonlySet<AgentV2RunStatus> = new Set([
	"cancelled",
	"succeeded",
	"failed",
	"interrupted",
]);
const EMPTY_USAGE: SessionMetadata["usage"] = {
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
};

const piRuntimeConfig = {
	handoffDefaultThinkingLevel: "high" as ThinkingLevel,
	skills: [] as SkillSummary[],
	skillDiagnostics: [] as SkillDiagnostic[],
	skillSlashSuggestions: [] as SkillSlashSuggestion[],
	diagnosticLogging: {
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 12000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 20000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 20000,
		streamIdleTimeoutMs: 60000,
		maxOutputTokens: 12_000,
	} as DiagnosticStreamLoggingConfig,
};

type TrackedRemoteRun = Pick<AgentV2RunSnapshot, "runId" | "clientId" | "status" | "updatedAt"> & {
	sessionId: string;
	error?: AgentV2Error;
};

function agentV2LifecycleStatus(status: unknown): AgentV2RunStatus | undefined {
	if (status === "succeeded") return status;
	if (status === "queued" || status === "running" || status === "cancelling") return status;
	if (status === "failed" || status === "cancelled" || status === "interrupted") return status;
	return undefined;
}

function toTrackedRemoteRun(run: AgentV2RunSnapshot, sessionId: string): TrackedRemoteRun {
	return {
		runId: run.runId,
		sessionId,
		clientId: run.clientId,
		status: run.status,
		updatedAt: run.updatedAt,
		...(run.error ? { error: run.error } : {}),
	};
}

function runStatusFromAgentV2LifecycleEvent(event: AgentV2RunEventRecord): AgentV2RunStatus | undefined {
	if (!isRecord(event.payload)) return undefined;
	return agentV2LifecycleStatus(event.payload.status);
}

const runClient = {
	cancelRun: async (runId: string) => toTrackedRemoteRun(await cancelAgentV2Run(runId), currentSessionId ?? ""),
	connectRunEvents: (
		runId: string,
		afterSeq: number,
		onEvent: (event: AgentV2RunEventRecord) => void | Promise<void>,
		options = {},
	) => connectAgentV2RunEvents(runId, afterSeq, onEvent, options),
	getRun: async (runId: string) => {
		const run = await getAgentV2Run(runId);
		return run ? toTrackedRemoteRun(run, currentSessionId ?? "") : undefined;
	},
	listRunEvents: listAgentV2RunEvents,
	startRun: startAgentV2Run,
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
type SessionMetadataWithRunState = SessionMetadata & {
	mode?: SessionMode;
	runStatus?: AgentV2RunStatus;
	activeRunId?: string;
	lastRunId?: string;
	runUpdatedAt?: string;
};

type SlashSuggestionHost = {
	slashSuggestions: SkillSlashSuggestion[];
	requestUpdate?: () => void;
};

document.documentElement.lang = getCurrentLanguage();
registerAgentV2ActivityMessageRenderer();
registerLegacyDefaultSkillLoadMessageRenderer();

const configuredStorage = new ConfiguredServerStorage();
const settings = new SettingsStore();
const sessions = new SessionsStore();
const customProviders = new ServerBackedCustomProvidersStore(configuredStorage);
const providerKeys = new ServerBackedProviderKeysStore(configuredStorage, async (providerName) => {
	const customProvider = (await customProviders.getAll()).find(
		(provider) =>
			provider.name === providerName ||
			provider.id === providerName ||
			`custom-provider:${provider.id}` === providerName,
	);
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
setBrowserAppStorage(storage);
const modelController = new ModelController(storage, configuredStorage);
const diagnosticClient = createDiagnosticClient({ headers: piClientHeaders });

const getProviderApiKey = async (provider: string): Promise<string | undefined> => {
	return (await storage.providerKeys.get(provider)) ?? undefined;
};

const getProxyUrl = async (): Promise<string | undefined> => {
	const enabled = await storage.settings.get<boolean>("proxy.enabled");
	return enabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
};

const loadPiRuntimeConfig = async () => {
	const [status, skillList] = await Promise.all([configuredStorage.getStatus(), loadServerSkillList()]);
	const skills = Array.isArray(skillList.skills) ? skillList.skills : [];
	const diagnostics = Array.isArray(skillList.diagnostics) ? skillList.diagnostics : [];
	piRuntimeConfig.handoffDefaultThinkingLevel = normalizeThinkingLevel(status?.handoffDefaultThinkingLevel);
	piRuntimeConfig.skills = skills;
	piRuntimeConfig.skillDiagnostics = diagnostics;
	piRuntimeConfig.diagnosticLogging = {
		rawProviderLoggingEnabled: status?.rawProviderLoggingEnabled === true,
		rawProviderLogMaxChars: normalizePositiveInteger(status?.rawProviderLogMaxChars, 12000),
		promptSnapshotLoggingEnabled: status?.promptSnapshotLoggingEnabled === true,
		promptSnapshotMaxChars: normalizePositiveInteger(status?.promptSnapshotMaxChars, 20000),
		modelOutputSnapshotLoggingEnabled: status?.modelOutputSnapshotLoggingEnabled === true,
		modelOutputSnapshotMaxChars: normalizePositiveInteger(status?.modelOutputSnapshotMaxChars, 20000),
		streamIdleTimeoutMs: normalizePositiveInteger(status?.modelStreamIdleTimeoutMs, 60000),
		maxOutputTokens: normalizeNonNegativeInteger(status?.modelMaxOutputTokens, 12_000),
	};
	piRuntimeConfig.skillSlashSuggestions = [
		createSkillSlashCommand(skillApiErrorDetail(diagnostics)),
		...skills.map(skillToSlashSuggestion),
	];
};

const syncRuntimeConfigAfterRender = async () => {
	await loadPiRuntimeConfig();
	applySkillSlashSuggestions();
};

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

const normalizePositiveInteger = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;

const normalizeNonNegativeInteger = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;

const isActiveRunStatus = (status: AgentV2RunStatus | undefined): status is AgentV2RunStatus =>
	status !== undefined && ACTIVE_RUN_STATUSES.has(status);

const isTerminalRunStatus = (status: AgentV2RunStatus | undefined): status is AgentV2RunStatus =>
	status !== undefined && TERMINAL_RUN_STATUSES.has(status);

let currentSessionId: string | undefined;
let currentSessionCreatedAt: string | undefined;
let currentTitle = "";
let currentSessionMode: SessionMode = defaultSessionModeForEntry("standalone");
let conversationSnapshotState: ConversationSnapshotState | undefined;
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let activeChatSkillRuntime: ChatSkillRuntimeSnapshot | undefined;
let agentV2BrowserController: AgentV2BrowserController | undefined;
let remoteRunConnection: RunEventConnection | undefined;
let remoteRunStatusPollId: ReturnType<typeof setTimeout> | undefined;
let remoteRunProviderStallStatusTimerId: ReturnType<typeof setTimeout> | undefined;
let currentActiveRunId: string | undefined;
let currentLastRunId: string | undefined;
let currentRunStatus: AgentV2RunStatus | undefined;
let currentRunUpdatedAt: string | undefined;
const remoteRunTransientStatusTexts: RunTransientStatusTexts = {};
const reportedQueuedRunTimeouts = new Set<string>();
let activeSidebarPanel: "files" | "apps" | null = null;
let currentProjectFilesPanelWidth = safeReadCurrentProjectFilesPanelWidth();
let generatedAppsPanelWidth = safeReadGeneratedAppsPanelWidth();
let currentProjectFilePreviewFilename = "";
let currentProjectFilePreviewDrawerWidth = safeReadCurrentProjectFilePreviewDrawerWidth();
const scheduleRemoteRunRender = createCoalescedRenderScheduler(() => {
	renderApp();
});

const getDisplayTitle = () => (isDefaultNewSessionTitle(currentTitle) ? i18n("New Session") : currentTitle);

const writeDiagnosticEvent = (event: DiagnosticEvent): void => {
	diagnosticClient.write({
		sessionId: currentSessionId,
		traceId: currentSessionId,
		...event,
		data: event.data || {},
	});
};

const errorDiagnosticData = (error: unknown, extra: DiagnosticData = {}): DiagnosticData => ({
	...extra,
	message: error instanceof Error ? error.message : String(error),
});

const trackRemoteRun = (run?: Pick<AgentV2RunSnapshot, "runId" | "status" | "updatedAt">): void => {
	currentActiveRunId = run?.runId;
	currentRunStatus = run?.status;
	currentRunUpdatedAt = run?.updatedAt;
	if (run?.runId) currentLastRunId = run.runId;
};

const closeRemoteRunConnection = (): void => {
	remoteRunConnection?.close();
	remoteRunConnection = undefined;
	if (remoteRunStatusPollId !== undefined) {
		clearTimeout(remoteRunStatusPollId);
		remoteRunStatusPollId = undefined;
	}
};

const clearProviderStallStatusTimer = (): void => {
	if (remoteRunProviderStallStatusTimerId !== undefined) {
		clearTimeout(remoteRunProviderStallStatusTimerId);
		remoteRunProviderStallStatusTimerId = undefined;
	}
};

const applyRemoteRunTransientStatusText = (): void => {
	const agentInterface = chatPanel?.agentInterface;
	if (!agentInterface) return;
	agentInterface.transientStatusText = selectRunTransientStatusText(remoteRunTransientStatusTexts);
	agentInterface.requestUpdate();
};

const setRemoteRunTransientStatusText = (source: RunTransientStatusSource, statusText = ""): void => {
	if (statusText) {
		remoteRunTransientStatusTexts[source] = statusText;
	} else {
		delete remoteRunTransientStatusTexts[source];
	}
	applyRemoteRunTransientStatusText();
};

const clearRemoteRunTransientStatusTexts = (): void => {
	delete remoteRunTransientStatusTexts.connection;
	delete remoteRunTransientStatusTexts.retry;
	delete remoteRunTransientStatusTexts.providerStalled;
	applyRemoteRunTransientStatusText();
};

const scheduleProviderStallStatus = (runId: string): void => {
	clearProviderStallStatusTimer();
	setRemoteRunTransientStatusText("providerStalled");
	remoteRunProviderStallStatusTimerId = setTimeout(() => {
		remoteRunProviderStallStatusTimerId = undefined;
		if (runId !== currentActiveRunId || agentV2BrowserController?.activeRunId !== runId) return;
		if (currentRunStatus && currentRunStatus !== "running") return;
		setRemoteRunTransientStatusText("providerStalled", providerStallStatusText(i18nText));
		requestChatPanelUpdate();
	}, providerStallStatusDelayMs(piRuntimeConfig.diagnosticLogging.streamIdleTimeoutMs));
};

const hasObservableRunInProgress = (): boolean => {
	return currentActiveRunId !== undefined || agent?.state?.isStreaming === true;
};

const syncActiveRunStatusOnce = (): void => {
	const runId = currentActiveRunId;
	if (!runId) return;
	void syncCurrentRunStatusFromServer(runId, 1, 0).catch((error) => {
		console.error("Failed to sync remote run status after reconnect:", error);
	});
};

const resetRemoteRunState = (): void => {
	closeRemoteRunConnection();
	clearProviderStallStatusTimer();
	agentV2BrowserController = undefined;
	reportedQueuedRunTimeouts.clear();
	clearRemoteRunTransientStatusTexts();
	trackRemoteRun(undefined);
	currentLastRunId = undefined;
};

const requestChatPanelUpdate = (): void => {
	chatPanel?.requestUpdate();
	chatPanel?.agentInterface?.requestUpdate();
};

const i18nText = (key: string): string => i18n(key as Parameters<typeof i18n>[0]);

const markRemoteRunSettled = (runId: string, status: AgentV2RunStatus, updatedAt?: string): void => {
	closeRemoteRunConnection();
	clearProviderStallStatusTimer();
	agentV2BrowserController = undefined;
	currentActiveRunId = undefined;
	currentLastRunId = runId;
	currentRunStatus = status;
	currentRunUpdatedAt = updatedAt ?? currentRunUpdatedAt;
	clearRemoteRunTransientStatusTexts();
};

const buildSessionMetadata = (
	state: AgentState,
	createdAt: string,
	resolvedTitle: string,
	lastModified: string,
): SessionMetadataWithRunState => ({
	id: currentSessionId!,
	title: resolvedTitle,
	createdAt,
	lastModified,
	messageCount: state.messages.length,
	usage: EMPTY_USAGE,
	thinkingLevel: state.thinkingLevel,
	preview: generateTitle(state.messages),
	mode: currentSessionMode,
	...(currentRunStatus ? { runStatus: currentRunStatus } : {}),
	...(currentActiveRunId ? { activeRunId: currentActiveRunId } : {}),
	...(currentLastRunId ? { lastRunId: currentLastRunId } : {}),
	...(currentRunUpdatedAt ? { runUpdatedAt: currentRunUpdatedAt } : {}),
});

function safeReadCurrentProjectFilesPanelWidth(): number {
	try {
		return readCurrentProjectFilesPanelWidth();
	} catch {
		return CURRENT_PROJECT_FILES_PANEL_DEFAULT_WIDTH;
	}
}

function safeWriteCurrentProjectFilesPanelWidth(width: number): number {
	try {
		return writeCurrentProjectFilesPanelWidth(width);
	} catch {
		return clampCurrentProjectFilesPanelWidth(width, window.innerWidth);
	}
}

function safeReadCurrentProjectFilePreviewDrawerWidth(): number {
	try {
		return readCurrentProjectFilePreviewDrawerWidth();
	} catch {
		return CURRENT_PROJECT_FILE_PREVIEW_DRAWER_DEFAULT_WIDTH;
	}
}

function safeWriteCurrentProjectFilePreviewDrawerWidth(width: number): number {
	try {
		return writeCurrentProjectFilePreviewDrawerWidth(width);
	} catch {
		return clampCurrentProjectFilePreviewDrawerWidth(width, window.innerWidth);
	}
}

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
	if (currentSessionId !== sessionId) {
		currentProjectFilePreviewFilename = "";
	}
	currentSessionId = sessionId;
	if (sessionId) {
		await storage.settings.set(CURRENT_SESSION_ID_KEY, sessionId);
	} else {
		await storage.settings.delete(CURRENT_SESSION_ID_KEY);
	}
	updateUrl(sessionId);
};

const ensureSessionIdentity = async () => {
	if (currentSessionId) return;
	currentSessionCreatedAt = new Date().toISOString();
	await setCurrentSessionId(crypto.randomUUID());
};

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
	detail: skill.allowImplicitInvocation
		? skill.interface?.shortDescription || skill.description
		: `${i18n("Explicit-only skills" as Parameters<typeof i18n>[0])}: ${skill.interface?.shortDescription || skill.description}`,
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
	systemPrompt: createChatSystemPrompt(piRuntimeConfig.skills, model?.contextWindow ?? 128_000),
	...(model ? { model } : {}),
	thinkingLevel: "off",
	messages: [],
	tools: [],
});

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent) return;

	const state = agent.state;
	if (state.messages.length === 0 && !currentActiveRunId) {
		const emptySessionId = currentSessionId;
		try {
			await storage.sessions.deleteSession(emptySessionId);
			if (emptySessionId === currentSessionId) {
				currentSessionCreatedAt = undefined;
				await setCurrentSessionId(undefined);
			}
		} catch (err) {
			console.error("Failed to discard empty session:", err);
			writeDiagnosticEvent({
				level: "error",
				category: "storage",
				eventType: "storage.session.empty_discard.error",
				data: errorDiagnosticData(err, { sessionId: emptySessionId }),
			});
		}
		return;
	}

	const createdAt = currentSessionCreatedAt || new Date().toISOString();
	currentSessionCreatedAt = createdAt;
	const resolvedTitle = sessionTitle(currentTitle, state.messages);
	const lastModified = sessionLastMessageModifiedAt(state.messages, createdAt, createdAt);

	try {
		const sessionData = {
			id: currentSessionId,
			title: resolvedTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt,
			lastModified,
			...(conversationSnapshotState ? { conversationSnapshotState } : {}),
		};

		const metadata = buildSessionMetadata(state, createdAt, resolvedTitle, lastModified);

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
		writeDiagnosticEvent({
			level: "error",
			category: "storage",
			eventType: "storage.session.save.error",
			data: errorDiagnosticData(err, { sessionId: currentSessionId }),
		});
	}
};

const sessionModeSwitchEnabled = (): boolean =>
	canSwitchSessionMode({
		isStreaming: agent?.state?.isStreaming === true,
		hasActiveRun: currentActiveRunId !== undefined,
	});

const syncSessionModeTools = (): void => {
	if (!agent) return;
	activeChatSkillRuntime = undefined;
	agent.state.tools = [];
	agent.state.systemPrompt = createChatSystemPrompt(
		piRuntimeConfig.skills,
		agent.state.model?.contextWindow ?? 128_000,
	);
};

const changeSessionMode = async (mode: SessionMode): Promise<void> => {
	if (mode === currentSessionMode || !sessionModeSwitchEnabled()) return;
	currentSessionMode = mode;
	syncSessionModeTools();
	if (currentSessionId && agent.state.messages.length > 0) await saveSession();
	renderApp();
	requestChatPanelUpdate();
};

const getBrowserSessions = async (): Promise<MergedSessionEntry[]> => {
	const browserSessions = (await storage.sessions.getAllMetadata()) as SessionMetadataWithRunState[];
	return browserSessions
		.filter(
			(session) => session.messageCount > 0 || Boolean(session.activeRunId) || isActiveRunStatus(session.runStatus),
		)
		.map((session) => ({
			...session,
			browser: session,
			preferredSource: "browser" as const,
		}))
		.sort((left, right) => right.lastModified.localeCompare(left.lastModified));
};

const loadGeneratedAppsForSessions = async (options: { force?: boolean } = {}) => {
	const browserSessions = await getBrowserSessions();
	return loadSessionProjectApps(browserSessions, undefined, undefined, options);
};

const renameSessionProject = async (sessionId: string, title: string) => {
	if (storage.sessions) {
		await storage.sessions.updateTitle(sessionId, title);
	}
	if (sessionId === currentSessionId) {
		currentTitle = title;
		await saveSession();
		renderApp();
	}
	refreshGeneratedAppsPanel();
};

const deleteSessionEverywhere = async (sessionId: string) => {
	if (storage.sessions) {
		await storage.sessions.deleteSession(sessionId);
	}
	if (sessionId === currentSessionId) {
		currentProjectFilePreviewFilename = "";
		resetRemoteRunState();
		await setCurrentSessionId(undefined);
		const browserSessions = await getBrowserSessions();
		if (browserSessions.length > 0) {
			const loaded = await loadSession(browserSessions[0].id);
			if (loaded) return;
		}
		await startFreshSession(true);
		return;
	}
	refreshGeneratedAppsPanel();
	if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
};

const handleAgentEvent = async (event: AgentEvent) => {
	recordAgentEvent(event);
	switch (event.type) {
		case "tool_execution_end": {
			if (activeSidebarPanel === "files" && event.toolName === "project_file") {
				refreshCurrentProjectFilesPanel();
			}
			break;
		}
		case "message_end":
		case "agent_end": {
			const generatedTitle = generateTitle(agent.state.messages);
			if (isDefaultNewSessionTitle(currentTitle) && generatedTitle) {
				currentTitle = generatedTitle;
			}
			if (currentSessionId) {
				await saveSession();
			}
			if (agentV2BrowserController?.activeRunId) {
				scheduleRemoteRunRender();
			} else {
				renderApp();
			}
			if (event.type === "agent_end") {
				if (activeSidebarPanel === "apps") refreshGeneratedAppsPanel({ force: true });
				if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
			}
			break;
		}
	}
};

function recordAgentEvent(event: AgentEvent): void {
	if (event.type === "message_update" || event.type === "tool_execution_update") return;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		writeDiagnosticEvent({
			level: event.type === "tool_execution_end" && event.isError ? "error" : "info",
			category: "tool",
			eventType: `agent.${event.type}`,
			data: summarizeAgentEvent(event),
		});
		return;
	}
	writeDiagnosticEvent({
		level: event.type === "turn_end" && messageHasError(event.message) ? "error" : "info",
		category: "agent",
		eventType: `agent.${event.type}`,
		data: summarizeAgentEvent(event),
	});
}

function summarizeAgentEvent(event: AgentEvent): DiagnosticData {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return {};
		case "agent_end":
			return { messageCount: event.messages.length };
		case "turn_end":
			return {
				message: summarizeAgentMessage(event.message),
				toolResultCount: event.toolResults.length,
			};
		case "message_start":
		case "message_end":
			return { message: summarizeAgentMessage(event.message) };
		case "tool_execution_start":
			return {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				argsSummary: summarizeUnknown(event.args),
			};
		case "tool_execution_end":
			return {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				result: event.result,
				resultSummary: summarizeUnknown(event.result),
			};
		default:
			return {};
	}
}

function summarizeAgentMessage(message: unknown): DiagnosticData {
	if (!isRecord(message)) return { role: "unknown" };
	return {
		role: typeof message.role === "string" ? message.role : "unknown",
		contentSummary: summarizeUnknown(message.content),
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		hasError: typeof message.errorMessage === "string" && message.errorMessage.length > 0,
	};
}

function messageHasError(message: unknown): boolean {
	return isRecord(message) && typeof message.errorMessage === "string" && message.errorMessage.length > 0;
}

function summarizeUnknown(value: unknown): string {
	if (typeof value === "string") return `string:${value.length}`;
	if (Array.isArray(value)) return `array:${value.length}`;
	if (isRecord(value)) return `object:${Object.keys(value).length}`;
	if (value === undefined || value === null) return "empty";
	return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toggleCurrentProjectFilesPanel(): void {
	activeSidebarPanel = activeSidebarPanel === "files" ? null : "files";
	if (activeSidebarPanel !== "files") currentProjectFilePreviewFilename = "";
	renderApp();
}

function toggleGeneratedAppsPanel(): void {
	activeSidebarPanel = activeSidebarPanel === "apps" ? null : "apps";
	if (activeSidebarPanel === "apps") currentProjectFilePreviewFilename = "";
	renderApp();
}

function refreshCurrentProjectFilesPanel(): void {
	requestAnimationFrame(() => {
		const panel = document.querySelector("pi-current-project-files-panel") as CurrentProjectFilesPanel | null;
		void panel?.refresh();
	});
}

function refreshGeneratedAppsPanel(options: { force?: boolean } = {}): void {
	requestAnimationFrame(() => {
		const panel = document.querySelector("pi-generated-apps-panel") as GeneratedAppsPanel | null;
		void panel?.refresh(options);
	});
}

function startCurrentProjectFilesPanelResize(event: PointerEvent): void {
	if (activeSidebarPanel !== "files") return;
	event.preventDefault();
	const startX = event.clientX;
	const startWidth = currentProjectFilesPanelWidth;
	document.body.classList.add("app-is-resizing-current-project-files");

	const updateWidth = (moveEvent: PointerEvent) => {
		currentProjectFilesPanelWidth = clampCurrentProjectFilesPanelWidth(
			startWidth + moveEvent.clientX - startX,
			window.innerWidth,
		);
		renderApp();
	};
	const finishResize = () => {
		window.removeEventListener("pointermove", updateWidth);
		window.removeEventListener("pointerup", finishResize);
		window.removeEventListener("pointercancel", finishResize);
		document.body.classList.remove("app-is-resizing-current-project-files");
		currentProjectFilesPanelWidth = safeWriteCurrentProjectFilesPanelWidth(currentProjectFilesPanelWidth);
		renderApp();
	};

	window.addEventListener("pointermove", updateWidth);
	window.addEventListener("pointerup", finishResize, { once: true });
	window.addEventListener("pointercancel", finishResize, { once: true });
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

function startCurrentProjectFilePreviewDrawerResize(event: PointerEvent): void {
	if (!currentProjectFilePreviewFilename) return;
	event.preventDefault();
	const startX = event.clientX;
	const startWidth = currentProjectFilePreviewDrawerWidth;
	document.body.classList.add("app-is-resizing-current-project-file-preview");

	const updateWidth = (moveEvent: PointerEvent) => {
		currentProjectFilePreviewDrawerWidth = clampCurrentProjectFilePreviewDrawerWidth(
			startWidth - (moveEvent.clientX - startX),
			window.innerWidth,
		);
		renderApp();
	};
	const finishResize = () => {
		window.removeEventListener("pointermove", updateWidth);
		window.removeEventListener("pointerup", finishResize);
		window.removeEventListener("pointercancel", finishResize);
		document.body.classList.remove("app-is-resizing-current-project-file-preview");
		currentProjectFilePreviewDrawerWidth = safeWriteCurrentProjectFilePreviewDrawerWidth(
			currentProjectFilePreviewDrawerWidth,
		);
		renderApp();
	};

	window.addEventListener("pointermove", updateWidth);
	window.addEventListener("pointerup", finishResize, { once: true });
	window.addEventListener("pointercancel", finishResize, { once: true });
}

function openCurrentProjectFilePreview(event: CustomEvent<{ filename?: string }>): void {
	const filename = String(event.detail?.filename || "");
	if (!filename) return;
	currentProjectFilePreviewFilename = filename;
	renderApp();
}

function closeCurrentProjectFilePreview(): void {
	currentProjectFilePreviewFilename = "";
	renderApp();
}

const handleModelSelect = () => {
	ModelSelector.open(
		agent.state.model ?? null,
		(model: Model<any>) => {
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

const syncActiveModelFromSavedCustomProvider = async (
	provider: CustomProviderSavedEvent["detail"]["provider"],
): Promise<void> => {
	if (!agent?.state.model) return;
	const refreshedModel = await modelController.resolveSavedCustomProviderModel(agent.state.model, provider);
	if (!refreshedModel) return;

	agent.state.model = refreshedModel;
	await modelController.persistSelectedModel(refreshedModel);
	if (currentSessionId) {
		await saveSession();
	}
	requestChatPanelUpdate();
	renderApp();
};

window.addEventListener(CUSTOM_PROVIDER_SAVED_EVENT, (event) => {
	const provider = (event as CustomProviderSavedEvent).detail?.provider;
	if (!provider) return;
	void syncActiveModelFromSavedCustomProvider(provider).catch((error) => {
		console.error("Failed to refresh active model from saved custom provider:", error);
		writeDiagnosticEvent({
			level: "error",
			category: "storage",
			eventType: "storage.custom_provider.active_model_refresh.error",
			data: errorDiagnosticData(error, { providerId: provider.id }),
		});
	});
});

const normalizeRemotePromptInput = (
	input: string | AgentMessage | AgentMessage[],
	images?: ImageContent[],
): AgentMessage[] => {
	if (Array.isArray(input)) {
		if (input.length !== 1) {
			throw new Error("Remote runs currently support a single prompt message.");
		}
		return input.map(preparePromptAttachmentSeeds);
	}
	if (typeof input !== "string") {
		return [preparePromptAttachmentSeeds(input)];
	}
	const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text: input }];
	if (images && images.length > 0) {
		content.push(...images);
	}
	return [{ role: "user", content, timestamp: Date.now() }];
};

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "object" && block !== null && "text" in block) {
					const text = (block as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n\n");
	}
	return "";
}

function nonEmptyText(value: string | undefined): string | undefined {
	return value?.trim() ? value.trim() : undefined;
}

function objectiveTextFromMessage(message: AgentMessage): string | undefined {
	return nonEmptyText(messageContentText((message as { content?: unknown }).content));
}

function preparePromptAttachmentSeeds(message: AgentMessage): AgentMessage {
	if ((message as { role?: unknown }).role !== "user-with-attachments") return message;
	const attachments = (message as { attachments?: unknown }).attachments;
	if (!Array.isArray(attachments)) return message;
	const preparedAttachments = prepareAttachmentProjectFileSeeds(attachments);
	return {
		...(message as Record<string, unknown>),
		content: (message as { content?: unknown }).content,
		attachments: preparedAttachments,
	} as unknown as AgentMessage;
}

type AgentV2BrowserMutableState = {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: ReadonlySet<string>;
	errorMessage?: string;
};

function createAgentV2BrowserRunSink(browserAgent: Agent): AgentV2BrowserRunSink {
	let activeRunId: string | undefined;
	let deliveryReported = false;
	let lastPhase = "intake";
	const taskProgress = new Map<string, { kind: string; status: string }>();
	const artifactProgress = new Map<string, { path: string; action: "created" | "updated" }>();
	const appliedSkills = new Set<string>();
	const diagnosticMessages: string[] = [];
	const validationFailures: string[] = [];
	const mutableState = (): AgentV2BrowserMutableState => browserAgent.state as unknown as AgentV2BrowserMutableState;
	const appendActivity = (event: AgentV2ActivityEvent): void => {
		const message = createAgentV2ActivityMessage(event, activeRunId);
		browserAgent.state.messages = appendAgentV2ActivityMessage(browserAgent.state.messages, message);
	};
	return {
		beginRun(runId) {
			activeRunId = runId;
			deliveryReported = false;
			lastPhase = "intake";
			taskProgress.clear();
			artifactProgress.clear();
			appliedSkills.clear();
			diagnosticMessages.length = 0;
			validationFailures.length = 0;
			const state = mutableState();
			state.isStreaming = true;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = undefined;
		},
		setPhase(phase, status) {
			lastPhase = phase;
			currentRunStatus = status;
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: "agent_v2.browser_phase_projected",
				data: { runId: activeRunId, phase, status },
			});
		},
		setTask(event) {
			taskProgress.set(event.taskId, { kind: event.kind, status: event.status });
			appendActivity(event);
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId: activeRunId,
					taskId: event.taskId,
					kind: event.kind,
					status: event.status,
					phase: event.phase,
				},
			});
		},
		setArtifact(event) {
			artifactProgress.set(event.artifactId, { path: event.path, action: event.action });
			appendActivity(event);
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId: activeRunId,
					artifactId: event.artifactId,
					path: event.path,
					validationStatus: event.validationStatus,
					revision: event.revision,
				},
			});
			refreshGeneratedAppsPanel();
			if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		},
		setValidation(event) {
			if (event.status !== "passed")
				validationFailures.push(`${event.validationId}: ${event.status} — ${event.summary}`);
			appendActivity(event);
			writeDiagnosticEvent({
				level: event.status === "failed" || event.status === "blocked" ? "warn" : "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId: activeRunId,
					validationId: event.validationId,
					taskId: event.taskId,
					attempt: event.attempt,
					status: event.status,
					summary: event.summary,
				},
			});
		},
		appendOutput(event) {
			appendActivity(event);
			appendAgentV2BrowserOutput(browserAgent, event);
		},
		appendDiagnostic(event) {
			diagnosticMessages.push(`${event.code}: ${event.message}`);
			appendActivity(event);
			writeAgentV2BrowserDiagnostic(activeRunId, event);
		},
		setSkill(event) {
			appliedSkills.add(event.name);
			appendActivity(event);
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId: activeRunId, name: event.name, location: event.location },
			});
		},
		setSkillResource(event) {
			appendActivity(event);
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId: activeRunId, name: event.name, path: event.path, checksum: event.checksum },
			});
		},
		setDeliveryReport(event) {
			deliveryReported = true;
			appendActivity(event);
			appendAgentV2BrowserReport(browserAgent, formatAgentV2DeliveryReport(event, getCurrentLanguage()), {
				model: "delivery-report",
				timestamp: Date.parse(event.at),
			});
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId: activeRunId,
					taskId: event.taskId,
					projectId: event.projectId,
					previewUrl: event.previewUrl,
				},
			});
		},
		settle(status, error) {
			const state = mutableState();
			state.isStreaming = false;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = error?.message;
			if ((status === "failed" || status === "interrupted") && !deliveryReported) {
				const completedItems = [...taskProgress.values()].map((task) => `${task.kind}: ${task.status}`);
				const remainingItems = [...taskProgress.values()]
					.filter((task) => task.status !== "succeeded" && task.status !== "cancelled")
					.map((task) => task.kind);
				if (!remainingItems.includes("delivery")) remainingItems.push("delivery");
				const artifacts = [...artifactProgress.values()];
				const failureCause = error?.message ?? diagnosticMessages.at(-1) ?? "Agent v2 run did not complete.";
				const failedTask = [...taskProgress.entries()].find(
					([, task]) => task.status === "failed" || task.status === "blocked",
				);
				const report = formatAgentV2FailureReport(
					{
						failureStage: lastPhase,
						failureTask: failedTask?.[0] ?? "run",
						completedItems,
						failureCause,
						repairAttempts: [...taskProgress.values()].filter((task) => task.kind === "repair").length,
						diagnostics: diagnosticMessages,
						unpassedValidations: validationFailures,
						safeToRetry: error?.retryable === true,
						remainingItems,
						nextSuggestions: [agentV2FailureSuggestion(getCurrentLanguage(), error?.retryable === true)],
						appliedSkills: [...appliedSkills],
						createdFiles: artifacts
							.filter((artifact) => artifact.action === "created")
							.map((artifact) => artifact.path),
						updatedFiles: artifacts
							.filter((artifact) => artifact.action === "updated")
							.map((artifact) => artifact.path),
					},
					getCurrentLanguage(),
				);
				appendAgentV2BrowserReport(browserAgent, report, {
					model: "failure-report",
					timestamp: Date.now(),
					errorMessage: failureCause,
				});
			}
			activeRunId = undefined;
		},
	};
}

function appendAgentV2BrowserOutput(browserAgent: Agent, event: AgentV2OutputRecordedPayload): void {
	const timestamp = Date.parse(event.at);
	const alreadyProjected = browserAgent.state.messages.some((message) => {
		if (message.role !== "assistant") return false;
		return (
			message.provider === event.provider &&
			message.model === event.model &&
			message.timestamp === timestamp &&
			message.content.length === 1 &&
			message.content[0]?.type === "text" &&
			message.content[0].text === event.summary
		);
	});
	if (alreadyProjected) return;
	const message = agentV2OutputToAssistantMessage(event);
	browserAgent.state.messages = [...browserAgent.state.messages, message];
}

function appendAgentV2BrowserReport(
	browserAgent: Agent,
	text: string,
	options: { model: "delivery-report" | "failure-report"; timestamp: number; errorMessage?: string },
): void {
	if (
		browserAgent.state.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.length === 1 &&
				message.content[0]?.type === "text" &&
				message.content[0].text === text,
		)
	) {
		return;
	}
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agent-v2",
		provider: "agent-v2",
		model: options.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.errorMessage ? "error" : "stop",
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		timestamp: options.timestamp,
	};
	browserAgent.state.messages = [...browserAgent.state.messages, message];
}

function agentV2FailureSuggestion(language: string, retryable: boolean): string {
	const code = language.toLowerCase().split(/[-_]/u)[0];
	if (code === "zh")
		return retryable ? "修复上述问题后重试本次运行。" : "检查诊断信息并调整需求或项目文件后重新运行。";
	if (code === "de")
		return retryable
			? "Beheben Sie das gemeldete Problem und starten Sie den Lauf erneut."
			: "Prüfen Sie die Diagnose und passen Sie die Anforderung oder Projektdateien vor einem neuen Lauf an.";
	if (code === "ms")
		return retryable
			? "Baiki masalah yang dilaporkan dan cuba semula larian ini."
			: "Semak diagnostik dan laraskan keperluan atau fail projek sebelum menjalankan semula.";
	return retryable
		? "Fix the reported issue and retry this run."
		: "Review the diagnostics and adjust the request or project files before running again.";
}

function writeAgentV2BrowserDiagnostic(runId: string | undefined, event: AgentV2DiagnosticRecordedPayload): void {
	writeDiagnosticEvent({
		level: event.severity === "debug" ? "info" : event.severity,
		category: "agent",
		eventType: event.code,
		data: {
			runId,
			diagnosticId: event.diagnosticId,
			message: event.message,
			at: event.at,
		},
	});
}

const drainCurrentRemoteRunEvents = async (runId: string): Promise<AgentV2BrowserRunEventDrainResult | undefined> => {
	const controller = agentV2BrowserController;
	if (!controller || controller.activeRunId !== runId) return;
	const afterSeq = controller.lastSeq;
	try {
		const events = await runClient.listRunEvents(runId, controller.lastSeq);
		controller.hydrate(events, controller.lastSeq);
		return { ok: true, afterSeq: controller.lastSeq };
	} catch (error) {
		return { ok: false, afterSeq, error };
	}
};

const syncCurrentRunStatusFromServer = async (runId: string, attempts = 10, intervalMs = 200): Promise<boolean> => {
	if (!currentSessionId) return false;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const run = await runClient.getRun(runId);
		if (!run) return false;

		trackRemoteRun(run);
		reportQueuedRunTimeoutIfNeeded(run);
		if (!isTerminalRunStatus(run.status)) {
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
			continue;
		}

		const settlement = await settleAgentV2BrowserTerminalSnapshot({
			controller: agentV2BrowserController,
			runId: run.runId,
			status: run.status,
			...(run.error ? { error: run.error } : {}),
			drain: () => drainCurrentRemoteRunEvents(run.runId),
			onSettled: () => {
				closeRemoteRunConnection();
				markRemoteRunSettled(run.runId, run.status, run.updatedAt);
			},
		});
		if (settlement.status === "retry") {
			const drainResult = settlement.drainResult;
			if (drainResult && !drainResult.ok) {
				writeDiagnosticEvent({
					level: "warn",
					category: "agent",
					eventType: "agent.remote_run.event_drain_failed",
					data: errorDiagnosticData(drainResult.error, { runId: run.runId, afterSeq: drainResult.afterSeq }),
				});
			}
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
				continue;
			}
			return false;
		}
		if (settlement.status === "inactive") return true;
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		refreshGeneratedAppsPanel({ force: true });
		if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		return true;
	}
	return false;
};

function reportQueuedRunTimeoutIfNeeded(run: TrackedRemoteRun): void {
	const diagnostic = createQueuedRunTimeoutDiagnostic(run);
	if (!diagnostic || reportedQueuedRunTimeouts.has(run.runId)) {
		return;
	}
	reportedQueuedRunTimeouts.add(run.runId);
	writeDiagnosticEvent(diagnostic);
}

const scheduleRemoteRunStatusPoll = (runId: string): void => {
	if (remoteRunStatusPollId !== undefined) clearTimeout(remoteRunStatusPollId);
	remoteRunStatusPollId = setTimeout(() => {
		remoteRunStatusPollId = undefined;
		if (runId !== currentActiveRunId || agentV2BrowserController?.activeRunId !== runId) return;
		void syncCurrentRunStatusFromServer(runId, 1, 0)
			.catch((error) => {
				console.error("Failed to poll remote run status:", error);
			})
			.finally(() => {
				if (runId === currentActiveRunId && agentV2BrowserController?.activeRunId === runId) {
					scheduleRemoteRunStatusPoll(runId);
				}
			});
	}, 2000);
};

const cancelCurrentRemoteRun = async (runId: string): Promise<void> => {
	const shouldRestoreCurrentRunState = runId === currentActiveRunId;
	const previousRunStatus = currentRunStatus;
	const previousRunUpdatedAt = currentRunUpdatedAt;
	if (shouldRestoreCurrentRunState) {
		currentRunStatus = "cancelling";
		currentRunUpdatedAt = new Date().toISOString();
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		refreshGeneratedAppsPanel();
	}

	let run: TrackedRemoteRun;
	try {
		run = await runClient.cancelRun(runId);
	} catch (error) {
		console.error("Failed to cancel remote run:", error);
		writeDiagnosticEvent({
			level: "error",
			category: "agent",
			eventType: "agent.remote_run.cancel.error",
			data: errorDiagnosticData(error, { runId }),
		});
		if (shouldRestoreCurrentRunState && runId === currentActiveRunId) {
			currentRunStatus = previousRunStatus;
			currentRunUpdatedAt = previousRunUpdatedAt;
			await saveSession();
			renderApp();
			requestChatPanelUpdate();
			refreshGeneratedAppsPanel();
		}
		throw error;
	}

	if (run.sessionId === currentSessionId) {
		trackRemoteRun(run);
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		refreshGeneratedAppsPanel({ force: true });

		void syncCurrentRunStatusFromServer(runId, 60, 1000).catch((error) => {
			console.error("Failed to settle remote run cancellation:", error);
			writeDiagnosticEvent({
				level: "error",
				category: "agent",
				eventType: "agent.remote_run.cancel_settle.error",
				data: errorDiagnosticData(error, { runId }),
			});
		});
	}
};

const applyConnectedRunEvent = async (event: AgentV2RunEventRecord): Promise<void> => {
	if (!agentV2BrowserController || event.runId !== agentV2BrowserController.activeRunId) return;

	const retryStatus = retryStatusFromRunEvent(event);
	setRemoteRunTransientStatusText("connection");
	if (retryStatus) {
		setRemoteRunTransientStatusText("retry", retryStatusText(retryStatus, i18nText));
	} else if (shouldClearRetryStatusForRunEvent(event)) {
		setRemoteRunTransientStatusText("retry");
	}

	agentV2BrowserController.apply(event);
	const runStatus = runStatusFromAgentV2LifecycleEvent(event);
	trackRemoteRun({
		runId: event.runId,
		status: runStatus ?? currentRunStatus ?? "running",
		updatedAt: event.createdAt,
	});
	clearProviderStallStatusTimer();
	setRemoteRunTransientStatusText("providerStalled");
	if (!runStatus || !isTerminalRunStatus(runStatus)) scheduleProviderStallStatus(event.runId);
	scheduleRemoteRunRender();
	requestChatPanelUpdate();
	refreshGeneratedAppsPanel();
	if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
	currentRunUpdatedAt = event.createdAt;

	if (runStatus && isTerminalRunStatus(runStatus)) {
		await syncCurrentRunStatusFromServer(event.runId);
	}
};

const connectToRemoteRun = (run: TrackedRemoteRun, controller: AgentV2BrowserController): void => {
	closeRemoteRunConnection();
	trackRemoteRun(run);
	scheduleRemoteRunStatusPoll(run.runId);
	if (run.status === "running") scheduleProviderStallStatus(run.runId);
	let connectionWasInterrupted = false;
	remoteRunConnection = runClient.connectRunEvents(
		run.runId,
		controller.lastSeq,
		async (event) => {
			try {
				await applyConnectedRunEvent(event);
			} catch (error) {
				console.error("Failed to apply remote run event:", error);
				writeDiagnosticEvent({
					level: "error",
					category: "agent",
					eventType: "agent.remote_event.error",
					data: errorDiagnosticData(error, {
						runId: event.runId,
						sessionId: currentSessionId,
						seq: event.seq,
					}),
				});
				throw error;
			}
		},
		{
			onStatusChange: (connection: RunEventConnection) => {
				if (
					connection.closed ||
					run.runId !== currentActiveRunId ||
					agentV2BrowserController?.activeRunId !== run.runId
				) {
					return;
				}
				if (connection.readyState === connection.CONNECTING && connection.lastError) {
					connectionWasInterrupted = true;
					const status = navigator.onLine === false ? "offline" : "run_reconnecting";
					setRemoteRunTransientStatusText("connection", runConnectionStatusText(status, i18nText));
					requestChatPanelUpdate();
					return;
				}
				if (connection.readyState === connection.OPEN && connectionWasInterrupted) {
					connectionWasInterrupted = false;
					setRemoteRunTransientStatusText("connection", runConnectionStatusText("run_reconnected", i18nText));
					requestChatPanelUpdate();
					syncActiveRunStatusOnce();
				}
			},
		},
	);
};

const startRemotePrompt = async (
	input: string | AgentMessage | AgentMessage[],
	images?: ImageContent[],
): Promise<void> => {
	await ensureSessionIdentity();
	const messages = normalizeRemotePromptInput(input, images);
	const message = messages[0];
	if (!isRecord(message)) {
		throw new Error("Remote runs require a JSON-object prompt message.");
	}

	const previousMessages = agent.state.messages.slice();
	agent.state.messages = [...previousMessages, message];
	renderApp();
	requestChatPanelUpdate();
	void saveSession();

	let runResult: Awaited<ReturnType<typeof runClient.startRun>>;
	try {
		const projectFiles = collectProjectFilesFromMessages(messages);
		const attachments = Array.isArray((message as { attachments?: unknown }).attachments)
			? ((message as { attachments?: unknown[] }).attachments ?? [])
			: undefined;
		const title = sessionTitle(currentTitle, agent.state.messages);
		const rawObjective = objectiveTextFromMessage(message) ?? title;
		const selectedSkillNames = getLatestExplicitSkillNames([message]);
		const objective = parseSkillCommandPrefix(rawObjective)?.args || rawObjective;
		const selectedModel = agent.state.model;
		const conversation = await buildConversationSnapshot({
			messages: previousMessages,
			currentObjective: objective,
			contextWindowTokens: selectedModel?.contextWindow ?? 128_000,
			...(conversationSnapshotState ? { previousState: conversationSnapshotState } : {}),
		});
		runResult = await runClient.startRun({
			sessionId: currentSessionId!,
			title,
			objective: conversation.snapshot.currentObjective,
			conversationSnapshot: conversation.snapshot,
			...(selectedSkillNames.length > 0 ? { selectedSkillNames } : {}),
			...(attachments ? { attachments } : {}),
			model: selectedModel ? { provider: selectedModel.provider, id: selectedModel.id } : undefined,
			...(projectFiles.length > 0 ? { projectFiles } : {}),
		});
		conversationSnapshotState = conversation.state;
		if (conversation.warning) {
			writeDiagnosticEvent({
				level: "warn",
				category: "agent",
				eventType: "agent.conversation_snapshot.incomplete",
				data: { sessionId: currentSessionId, warning: conversation.warning },
			});
		}
	} catch (error) {
		agent.state.messages = previousMessages;
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		throw error;
	}

	const controller = new AgentV2BrowserController(createAgentV2BrowserRunSink(agent));
	controller.start(runResult);
	clearRemoteRunTransientStatusTexts();
	agentV2BrowserController = controller;
	connectToRemoteRun(toTrackedRemoteRun(runResult, currentSessionId!), controller);
	renderApp();
	requestChatPanelUpdate();
	await saveSession();
	refreshGeneratedAppsPanel();
	await agent.waitForIdle();
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}
	resetRemoteRunState();
	activeChatSkillRuntime = undefined;

	const defaultModel = await modelController.getDefaultModel();
	const resolvedInitialState = initialState || createInitialAgentState(defaultModel);
	const initialModel = resolvedInitialState.model ?? defaultModel;
	agent = new Agent({
		initialState: {
			...resolvedInitialState,
			systemPrompt: createChatSystemPrompt(piRuntimeConfig.skills, initialModel?.contextWindow ?? 128_000),
		},
		convertToLlm: defaultConvertToLlm,
		transformContext: async (messages) =>
			activeChatSkillRuntime ? await activeChatSkillRuntime.transformMessages(messages) : messages,
		streamFn: createLoggedStreamFn(
			createStreamFn(getProxyUrl),
			diagnosticClient,
			() => ({
				sessionId: currentSessionId,
				traceId: currentSessionId,
			}),
			() => piRuntimeConfig.diagnosticLogging,
		),
		getApiKey: getProviderApiKey,
	});
	const chatPrompt = agent.prompt.bind(agent);
	const invokeChatPrompt = async (
		chatInput: string | AgentMessage | AgentMessage[],
		chatImages?: ImageContent[],
	): Promise<void> => {
		if (typeof chatInput === "string") {
			await chatPrompt(chatInput, chatImages);
			return;
		}
		await chatPrompt(chatInput);
	};
	(agent as Agent & { repairToolCalls: boolean }).repairToolCalls = true;
	const abortAgentLocally = agent.abort.bind(agent);
	agent.abort = () => {
		if (currentActiveRunId && agentV2BrowserController?.activeRunId === currentActiveRunId) {
			void cancelCurrentRemoteRun(currentActiveRunId).catch(() => {});
		}
		abortAgentLocally();
	};
	agent.prompt = (async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> => {
		await dispatchSessionPrompt(
			currentSessionMode,
			{
				chat: async (chatInput, chatImages) => {
					const runtime = await createChatSkillRuntime({
						skills: piRuntimeConfig.skills,
						input: chatInput,
						contextWindowTokens: agent.state.model?.contextWindow ?? 128_000,
					});
					activeChatSkillRuntime = runtime;
					agent.state.systemPrompt = runtime.systemPrompt;
					agent.state.tools = [...runtime.tools];
					await invokeChatPrompt(chatInput, chatImages);
				},
				appGeneration: startRemotePrompt,
			},
			input,
			images,
		);
	}) as typeof agent.prompt;

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
			await modelController.persistSelectedModel(agent.state.model);
			if (agent.state.messages.length > 0 || currentActiveRunId) await saveSession();
			if (activeSidebarPanel === "apps") refreshGeneratedAppsPanel();
			if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		},
		onModelSelect: handleModelSelect,
		onThinkingChange: async () => {
			await ensureSessionIdentity();
			await saveSession();
		},
		enableArtifacts: false,
		toolsFactory: () => sessionModeTools(currentSessionMode, []),
	});
	applySkillSlashSuggestions();
};

function restoredRunStatusFromEvents(events: AgentV2RunEventRecord[]): AgentV2RunStatus | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		const lifecycleStatus = runStatusFromAgentV2LifecycleEvent(event);
		if (lifecycleStatus) return lifecycleStatus;
	}
	return undefined;
}

const restoreActiveRemoteRunFromMetadata = async (
	sessionId: string,
	sessionData: { lastModified: string },
	sessionMetadata: SessionMetadataWithRunState | null,
): Promise<boolean> => {
	const activeRunId = sessionMetadata?.activeRunId;
	if (!activeRunId || !isActiveRunStatus(sessionMetadata?.runStatus)) return false;

	const run = await getAgentV2Run(activeRunId).catch((error) => {
		writeDiagnosticEvent({
			level: "warn",
			category: "agent",
			eventType: "agent.remote_run.restore.snapshot_error",
			data: errorDiagnosticData(error, { runId: activeRunId, sessionId }),
		});
		return undefined;
	});

	let replayedEvents: AgentV2RunEventRecord[] = [];
	try {
		replayedEvents = await listAgentV2RunEvents(activeRunId, 0);
	} catch (error) {
		writeDiagnosticEvent({
			level: "warn",
			category: "agent",
			eventType: "agent.remote_run.restore.replay_error",
			data: errorDiagnosticData(error, { runId: activeRunId, sessionId }),
		});
	}

	const restoredStatus =
		restoredRunStatusFromEvents(replayedEvents) ?? (run ? run.status : sessionMetadata?.runStatus);
	if (!restoredStatus || !isActiveRunStatus(restoredStatus)) {
		currentActiveRunId = undefined;
		currentLastRunId = run?.runId ?? sessionMetadata?.lastRunId ?? activeRunId;
		currentRunStatus = restoredStatus;
		currentRunUpdatedAt = run?.updatedAt ?? sessionMetadata?.runUpdatedAt ?? sessionData.lastModified;
		return false;
	}

	const runSnapshot: AgentV2RunSnapshot =
		run ??
		({
			clientId: piClientHeaders()["X-PI-Client-ID"] || "",
			runId: activeRunId,
			status: restoredStatus,
			phase: "intake",
			attempt: 0,
			input: {},
			model: {},
			createdAt: sessionData.lastModified,
			updatedAt: sessionMetadata?.runUpdatedAt ?? sessionData.lastModified,
		} satisfies AgentV2RunSnapshot);
	const controller = new AgentV2BrowserController(createAgentV2BrowserRunSink(agent));
	controller.start(runSnapshot);
	if (replayedEvents.length > 0) {
		controller.hydrate(replayedEvents, replayedEvents.at(-1)?.seq ?? 0);
	}
	agentV2BrowserController = controller;
	clearRemoteRunTransientStatusTexts();
	const trackedRun: TrackedRemoteRun = run
		? toTrackedRemoteRun(run, sessionId)
		: {
				runId: activeRunId,
				sessionId,
				clientId: piClientHeaders()["X-PI-Client-ID"] || "",
				status: restoredStatus,
				updatedAt: sessionMetadata?.runUpdatedAt ?? sessionData.lastModified,
			};
	trackRemoteRun({ ...trackedRun, status: restoredStatus });
	connectToRemoteRun({ ...trackedRun, status: restoredStatus }, controller);
	return true;
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		writeDiagnosticEvent({
			level: "error",
			category: "storage",
			eventType: "storage.session.not_found",
			data: { sessionId },
		});
		return false;
	}

	await setCurrentSessionId(sessionId);
	currentSessionCreatedAt = sessionData.createdAt;
	currentTitle = isDefaultNewSessionTitle(sessionData.title) ? "" : sessionData.title || "";
	const sessionMetadata = (await storage.sessions.getMetadata(sessionId)) as SessionMetadataWithRunState | null;
	currentSessionMode = normalizeSessionMode(sessionMetadata?.mode);
	conversationSnapshotState = normalizeConversationSnapshotState(
		(sessionData as typeof sessionData & { conversationSnapshotState?: unknown }).conversationSnapshotState,
	);
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
	currentActiveRunId = undefined;
	currentLastRunId = sessionMetadata?.lastRunId ?? sessionMetadata?.activeRunId;
	currentRunStatus = sessionMetadata?.runStatus;
	currentRunUpdatedAt = sessionMetadata?.runUpdatedAt;

	await restoreActiveRemoteRunFromMetadata(sessionId, sessionData, sessionMetadata);

	await saveSession();
	renderApp();
	return true;
};

const startFreshSession = async (persistImmediately = false, entry: "standalone" | "pm_handoff" = "standalone") => {
	currentTitle = "";
	currentSessionMode = defaultSessionModeForEntry(entry);
	conversationSnapshotState = undefined;
	currentSessionCreatedAt = undefined;
	resetRemoteRunState();
	await setCurrentSessionId(undefined);
	const model = await modelController.getDefaultModel();
	await createAgent(createInitialAgentState(model));
	if (persistImmediately) {
		await ensureSessionIdentity();
	}
	renderApp();
};

const applyHandoffLanguage = (language?: string) => {
	const handoffLanguage = normalizeHandoffLanguage(language);
	setLanguage(handoffLanguage);
	document.documentElement.lang = handoffLanguage;
	return handoffLanguage;
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

const markHandoffAttachmentsUiOnly = (attachments: Attachment[], documentFiles: HandoffDocumentFile[]): Attachment[] =>
	attachments.map((attachment, index) => ({
		...attachment,
		llmContext: "none" as const,
		...(documentFiles[index] ? { projectFilePath: documentFiles[index].filename } : {}),
	}));

const bootstrapHandoffSession = async (payload: PmHandoffPayload) => {
	applyHandoffLanguage(payload.language);
	const attachments = await Promise.all(
		(payload.documents || []).map((document) =>
			loadAttachment(buildPmApiUrl(document.download_url), document.filename),
		),
	);
	await startFreshSession(false, "pm_handoff");
	if (payload.title) {
		currentTitle = payload.title;
	}
	let documentFiles: HandoffDocumentFile[] = [];
	try {
		documentFiles = prepareHandoffDocumentFiles(payload.documents || [], attachments);
	} catch (error) {
		writeDiagnosticEvent({
			level: "error",
			category: "handoff",
			eventType: "handoff.documents.prepare.error",
			data: errorDiagnosticData(error, {
				documentCount: payload.documents?.length ?? 0,
			}),
		});
	}

	const inputAttachments =
		documentFiles.length > 0 ? markHandoffAttachmentsUiOnly(attachments, documentFiles) : attachments;
	await applyHandoffDefaultThinkingLevel();
	chatPanel.agentInterface?.setInput(buildVisibleCodingHandoffPrompt(payload), inputAttachments);
	if (currentSessionId) {
		await saveSession();
	}
	renderApp();
	requestChatPanelUpdate();
};

const restoreInitialSession = async () => {
	const urlParams = new URLSearchParams(window.location.search);
	const handoffToken = urlParams.get("handoff_token");
	if (handoffToken) {
		await loadPiRuntimeConfig();
		let payload: PmHandoffPayload;
		try {
			payload = await fetchPmHandoffPayload(handoffToken);
		} catch (error) {
			writeDiagnosticEvent({
				level: "error",
				category: "handoff",
				eventType: "handoff.fetch.error",
				data: errorDiagnosticData(error),
			});
			throw error;
		}
		if (!payload.documents_ready) {
			writeDiagnosticEvent({
				level: "error",
				category: "handoff",
				eventType: "handoff.documents.not_ready",
				data: {
					title: payload.title,
					documentCount: payload.documents?.length ?? 0,
				},
			});
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
	const currentProjectTitle = agent ? sessionTitle(currentTitle, agent.state.messages) : currentTitle;

	const appHtml = html`
    <div
      class="example-shell w-full h-screen flex flex-col bg-background text-foreground overflow-hidden"
    >
      <div
        class="example-header flex items-center justify-between border-b border-border shrink-0"
      >
        <div
          class="example-header__brand-row flex items-center gap-3 px-4 py-3 min-w-0"
        >
          <div
            class="example-header__logo"
            aria-label=${i18n("AITC platform logo")}
          >
            <span
              class="example-header__logo-segment example-header__logo-segment--ats"
              >AT&amp;S</span
            >
            <span
              class="example-header__logo-segment example-header__logo-segment--aitc"
              >AITC</span
            >
          </div>
          <div class="example-header__session flex items-center gap-2 min-w-0">
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
						: html`<span
                  class="example-header__title text-base font-semibold text-foreground"
                  >${i18n("AI Coding Platform")}</span
                >`
				}
          </div>
        </div>
		<div
			class="example-header__actions flex items-center gap-1 px-2 py-2 shrink-0"
		>
			<label class="session-mode-control">
				<span class="session-mode-control__label">${sessionModeLabel(currentSessionMode, getCurrentLanguage())}</span>
				<select
					class="session-mode-control__select"
					aria-label="Session mode"
					.value=${currentSessionMode}
					?disabled=${!sessionModeSwitchEnabled()}
					@change=${(event: Event) => {
						const mode = normalizeSessionMode((event.target as HTMLSelectElement).value);
						void changeSessionMode(mode);
					}}
				>
					<option value="chat">${sessionModeLabel("chat", getCurrentLanguage())}</option>
					<option value="app_generation">${sessionModeLabel("app_generation", getCurrentLanguage())}</option>
				</select>
			</label>
			<theme-toggle></theme-toggle>
          ${Button({
					variant: "ghost",
					size: "sm",
					children: icon(Settings, "sm"),
					onClick: () => {
						const providersTab = new ProvidersModelsTab();
						providersTab.showKnownProviders = false;
						const skillStatusTab = new SkillStatusTab();
						skillStatusTab.skills = piRuntimeConfig.skills;
						skillStatusTab.diagnostics = piRuntimeConfig.skillDiagnostics;
						SettingsDialog.open([
							new LanguageTab(),
							providersTab,
							new ProxyTab(),
							new DiagnosticLogsTab(),
							skillStatusTab,
						]);
					},
					title: i18n("Settings"),
				})}
        </div>
      </div>

      <main
        class=${`example-content app-workspace flex-1 min-h-0 overflow-hidden ${activeSidebarPanel ? "app-workspace--panel-open" : ""}`}
      >
        <nav class="app-side-rail" aria-label="Workspace tools">
          <button
            type="button"
            class=${`app-side-rail__item ${activeSidebarPanel === "files" ? "app-side-rail__item--active" : ""}`}
            @click=${toggleCurrentProjectFilesPanel}
            title="Files"
            aria-label="Files"
            aria-pressed=${activeSidebarPanel === "files" ? "true" : "false"}
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
            <span class="app-side-rail__icon"
              >${icon(PanelsTopLeft, "md")}</span
            >
            <span class="app-side-rail__label">APP</span>
          </button>
        </nav>
        ${
				activeSidebarPanel === "files"
					? html`
                <aside
                  class="current-project-files-sidebar"
                  style=${`width: ${currentProjectFilesPanelWidth}px;`}
                >
                  <pi-current-project-files-panel
                    .sessionId=${currentSessionId || ""}
                    .title=${currentProjectTitle}
                    .selectedFilename=${currentProjectFilePreviewFilename}
                    @pi-open-current-project-file-preview=${openCurrentProjectFilePreview}
                  ></pi-current-project-files-panel>
                </aside>
                <div
                  class="current-project-files-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  title="Resize files panel"
                  @pointerdown=${startCurrentProjectFilesPanelResize}
                ></div>
              `
					: ""
			}
        ${
				activeSidebarPanel === "apps"
					? html`
                <aside
                  class="generated-apps-sidebar"
                  style=${`width: ${generatedAppsPanelWidth}px;`}
                >
                  <pi-generated-apps-panel
                    .openSession=${(sessionId: string) => loadSession(sessionId)}
                    .deleteSession=${(sessionId: string) => deleteSessionEverywhere(sessionId)}
                    .cancelRun=${(runId: string) => cancelCurrentRemoteRun(runId)}
                    .loadProjects=${loadGeneratedAppsForSessions}
                    .renameProject=${(project: { sessionId: string }, title: string) =>
								renameSessionProject(project.sessionId, title)}
                    .selectedSessionStatus=${isActiveRunStatus(currentRunStatus) ? "running" : "idle"}
                  ></pi-generated-apps-panel>
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
        <section class="app-chat-workspace">${chatPanel}</section>
        ${
				currentProjectFilePreviewFilename
					? html`
                <div
                  class="current-project-file-preview-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  title="Resize file preview"
                  @pointerdown=${startCurrentProjectFilePreviewDrawerResize}
                ></div>
                <pi-current-project-file-preview-drawer
                  .sessionId=${currentSessionId || ""}
                  .title=${currentProjectTitle}
                  .filename=${currentProjectFilePreviewFilename}
                  style=${`width: ${currentProjectFilePreviewDrawerWidth}px; flex-basis: ${currentProjectFilePreviewDrawerWidth}px;`}
                  @pi-close-current-project-file-preview=${closeCurrentProjectFilePreview}
                ></pi-current-project-file-preview-drawer>
              `
					: ""
			}
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
		chatPanel?.agentInterface?.querySelector("message-editor") as {
			requestUpdate?: () => void;
		} | null
	)?.requestUpdate?.();
	renderApp();
});

window.addEventListener("offline", () => {
	if (!hasObservableRunInProgress()) return;
	setRemoteRunTransientStatusText("connection", runConnectionStatusText("offline", i18nText));
	requestChatPanelUpdate();
});

window.addEventListener("online", () => {
	if (!hasObservableRunInProgress()) return;
	setRemoteRunTransientStatusText("connection", runConnectionStatusText("online_syncing", i18nText));
	requestChatPanelUpdate();
	syncActiveRunStatusOnce();
});

export async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
      <div
        class="w-full h-screen flex items-center justify-center bg-background text-foreground"
      >
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
