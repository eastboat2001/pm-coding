import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
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
import {
	type AgentV2ResponseLanguage,
	inferAgentV2ResponseLanguage,
} from "@mariozechner/pi-web-workspace/agent-v2-response-language";
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
import { selectAgentV2ActiveRunPresentation } from "../runtime/agent-v2-active-run.js";
import { registerLegacyAgentV2ActivityMessageRenderer } from "../runtime/agent-v2-activity-renderer.js";
import {
	AgentV2BrowserController,
	type AgentV2BrowserRunEventDrainResult,
	type AgentV2DiagnosticRecordedPayload,
	settleAgentV2BrowserTerminalSnapshot,
} from "../runtime/agent-v2-browser-controller.js";
import {
	type AgentV2BrowserProjectedEvent,
	createAgentV2BrowserRunSink,
} from "../runtime/agent-v2-browser-run-sink.js";
import type { AgentV2ProgressSection } from "../runtime/agent-v2-progress-card.js";
import "../runtime/agent-v2-progress-card.js";
import {
	cancelAgentV2Run,
	connectAgentV2RunEvents,
	getAgentV2Run,
	listAgentV2RunEvents,
	type AgentV2RunEventConnection as RunEventConnection,
	startAgentV2Run,
} from "../runtime/agent-v2-run-client.js";
import type { AgentV2RunPresentation } from "../runtime/agent-v2-run-presentation.js";
import { restoreAgentV2BrowserRunProjection } from "../runtime/agent-v2-run-restoration.js";
import { registerAgentV2RunResultMessageRenderer } from "../runtime/agent-v2-run-result-message.js";
import { piClientHeaders } from "../runtime/client-id.js";
import {
	buildConversationSnapshot,
	type ConversationSnapshotState,
	normalizeConversationSnapshotState,
} from "../runtime/conversation-snapshot.js";
import { collectAgentV2ProjectFilesForRun, prepareAttachmentProjectFileSeeds } from "../runtime/project-file-seed.js";
import { runConnectionStatusText } from "../runtime/run-connection-status.js";
import { createQueuedRunTimeoutDiagnostic } from "../runtime/run-health.js";
import {
	retryStatusFromRunEvent,
	retryStatusText,
	shouldClearRetryStatusForRunEvent,
} from "../runtime/run-retry-status.js";
import {
	AGENT_V2_RUN_ACTIVITY_TICK_MS,
	agentV2RunActivityStatusText,
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
import {
	getLatestExplicitSkillNames,
	parseSkillCommandPrefix,
	validateSelectedSkillNames,
} from "../skill-tools/skill-command.js";
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
import {
	AGENT_V2_MIN_MODEL_OUTPUT_TOKENS,
	ModelController,
	SELECTED_MODEL_KEY,
	supportsApplicationGeneration,
} from "./model-controller.js";
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
import {
	createWorkspaceExpansionState,
	reduceWorkspaceExpansion,
	type WorkspaceExpansionAction,
	type WorkspaceExpansionState,
	workspaceViewportForWidth,
} from "./workspace-expansion-coordinator.js";

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
registerLegacyAgentV2ActivityMessageRenderer();
registerAgentV2RunResultMessageRenderer({
	detailOpenForRun: historicalRunDetailOpen,
	expandedSectionForRun: historicalRunExpandedSection,
	onDetailChange: setHistoricalRunDetailOpen,
	onSectionChange: setHistoricalRunExpandedSection,
});
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
		streamIdleTimeoutMs: normalizePositiveInteger(status?.modelStreamIdleTimeoutMs, 180000),
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
let activeAgentV2Presentation: AgentV2RunPresentation | undefined;
let activeAgentV2ResponseLanguage: AgentV2ResponseLanguage = "en";
let workspaceExpansionState: WorkspaceExpansionState = createWorkspaceExpansionState(currentWorkspaceViewport());
let currentProjectFilesPanelWidth = safeReadCurrentProjectFilesPanelWidth();
let generatedAppsPanelWidth = safeReadGeneratedAppsPanelWidth();
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
		clearInterval(remoteRunProviderStallStatusTimerId);
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
	const phaseStartedAt = Date.parse(activeAgentV2Presentation?.updatedAt ?? currentRunUpdatedAt ?? "");
	const startedAt = Number.isFinite(phaseStartedAt) ? phaseStartedAt : Date.now();
	const updateActivityStatus = (): void => {
		if (runId !== currentActiveRunId || agentV2BrowserController?.activeRunId !== runId) return;
		if (currentRunStatus && currentRunStatus !== "running") return;
		setRemoteRunTransientStatusText(
			"providerStalled",
			agentV2RunActivityStatusText(
				activeAgentV2Presentation?.phase,
				Date.now() - startedAt,
				activeAgentV2ResponseLanguage,
			),
		);
		requestChatPanelUpdate();
	};
	updateActivityStatus();
	remoteRunProviderStallStatusTimerId = setInterval(updateActivityStatus, AGENT_V2_RUN_ACTIVITY_TICK_MS);
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
	activeAgentV2Presentation = undefined;
	activeAgentV2ResponseLanguage = "en";
	reportedQueuedRunTimeouts.clear();
	updateWorkspaceExpansion({ type: "reset_active_run_expansion" });
	clearRemoteRunTransientStatusTexts();
	trackRemoteRun(undefined);
	currentLastRunId = undefined;
};

function currentWorkspaceViewport(): WorkspaceExpansionState["viewport"] {
	return workspaceViewportForWidth(window.innerWidth);
}

function updateWorkspaceExpansion(action: WorkspaceExpansionAction): void {
	workspaceExpansionState = reduceWorkspaceExpansion(workspaceExpansionState, action);
}

function isAgentV2ProgressSection(value: string | null): value is AgentV2ProgressSection {
	return (
		value === "tasks" || value === "files" || value === "validation" || value === "skills" || value === "technical"
	);
}

function activeRunExpandedSection(): AgentV2ProgressSection | null {
	if (
		!workspaceExpansionState.activeRunDetailOpen ||
		!isAgentV2ProgressSection(workspaceExpansionState.internalSection)
	) {
		return null;
	}
	return workspaceExpansionState.internalSection;
}

function setActiveRunDetailOpen(expanded: boolean): void {
	updateWorkspaceExpansion({ type: expanded ? "open_active_run_detail" : "close_active_run_detail" });
	if (!expanded) updateWorkspaceExpansion({ type: "close_internal_section" });
	requestChatPanelUpdate();
	renderApp();
}

function setActiveRunExpandedSection(section: AgentV2ProgressSection | null): void {
	updateWorkspaceExpansion({ type: "set_active_run_section", section });
	requestChatPanelUpdate();
	renderApp();
}

function historicalRunExpandedSection(runId: string): AgentV2ProgressSection | null {
	if (
		workspaceExpansionState.historicalRunDetailId !== runId ||
		!isAgentV2ProgressSection(workspaceExpansionState.internalSection)
	) {
		return null;
	}
	return workspaceExpansionState.internalSection;
}

function historicalRunDetailOpen(runId: string): boolean {
	return workspaceExpansionState.historicalRunDetailId === runId;
}

function setHistoricalRunDetailOpen(runId: string, expanded: boolean): void {
	updateWorkspaceExpansion(
		expanded ? { type: "open_historical_run_detail", runId } : { type: "close_historical_run_detail" },
	);
	if (!expanded) updateWorkspaceExpansion({ type: "close_internal_section" });
	requestChatPanelUpdate();
	renderApp();
}

function setHistoricalRunExpandedSection(runId: string, section: AgentV2ProgressSection | null): void {
	updateWorkspaceExpansion({ type: "set_historical_run_section", runId, section });
	requestChatPanelUpdate();
	renderApp();
}

const syncAgentV2ActiveRunContent = (): void => {
	const agentInterface = chatPanel?.agentInterface as
		| (NonNullable<ChatPanel["agentInterface"]> & { activeRunContent?: ReturnType<typeof html> })
		| undefined;
	if (!agentInterface) return;
	const selectedPresentation = selectAgentV2ActiveRunPresentation(currentSessionMode, activeAgentV2Presentation);
	agentInterface.activeRunContent = selectedPresentation
		? html`<agent-v2-progress-card
					.presentation=${selectedPresentation}
					.responseLanguage=${activeAgentV2ResponseLanguage}
					.terminal=${false}
					.detailsExpanded=${workspaceExpansionState.activeRunDetailOpen}
					.expandedSection=${activeRunExpandedSection()}
					.onDetailChange=${setActiveRunDetailOpen}
					.onSectionChange=${setActiveRunExpandedSection}
				></agent-v2-progress-card>`
		: undefined;
};

const requestChatPanelUpdate = (): void => {
	syncAgentV2ActiveRunContent();
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
	updateWorkspaceExpansion({ type: "reset_active_run_expansion" });
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
		updateWorkspaceExpansion({ type: "close_file_preview" });
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
		updateWorkspaceExpansion({ type: "close_file_preview" });
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
	if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
};

const handleAgentEvent = async (event: AgentEvent) => {
	recordAgentEvent(event);
	switch (event.type) {
		case "tool_execution_end": {
			if (workspaceExpansionState.sidebar === "files" && event.toolName === "project_file") {
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
				if (workspaceExpansionState.sidebar === "apps") refreshGeneratedAppsPanel({ force: true });
				if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
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
	if (workspaceExpansionState.sidebar === "files") {
		updateWorkspaceExpansion({ type: "close_sidebar" });
		updateWorkspaceExpansion({ type: "close_file_preview" });
	} else {
		updateWorkspaceExpansion({ type: "open_sidebar", sidebar: "files" });
	}
	renderApp();
}

function toggleGeneratedAppsPanel(): void {
	if (workspaceExpansionState.sidebar === "apps") {
		updateWorkspaceExpansion({ type: "close_sidebar" });
	} else {
		updateWorkspaceExpansion({ type: "open_sidebar", sidebar: "apps" });
	}
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
	if (workspaceExpansionState.sidebar !== "files") return;
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
	if (workspaceExpansionState.sidebar !== "apps") return;
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
	if (!workspaceExpansionState.filePreviewPath) return;
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
	updateWorkspaceExpansion({ type: "open_file_preview", path: filename });
	renderApp();
}

function closeCurrentProjectFilePreview(): void {
	updateWorkspaceExpansion({ type: "close_file_preview" });
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

function recordAgentV2BrowserProjection(runId: string, event: AgentV2BrowserProjectedEvent): void {
	switch (event.type) {
		case "agent_v2.task_updated":
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId, taskId: event.taskId, kind: event.kind, status: event.status, phase: event.phase },
			});
			return;
		case "agent_v2.artifact_indexed":
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId,
					artifactId: event.artifactId,
					path: event.path,
					validationStatus: event.validationStatus,
					revision: event.revision,
				},
			});
			refreshGeneratedAppsPanel();
			if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
			return;
		case "agent_v2.validation_recorded":
			writeDiagnosticEvent({
				level: event.status === "failed" || event.status === "blocked" ? "warn" : "info",
				category: "agent",
				eventType: event.type,
				data: {
					runId,
					validationId: event.validationId,
					taskId: event.taskId,
					attempt: event.attempt,
					status: event.status,
					summary: event.summary,
				},
			});
			return;
		case "agent_v2.diagnostic_recorded":
			writeAgentV2BrowserDiagnostic(runId, event);
			return;
		case "agent_v2.skill_applied":
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId, name: event.name, location: event.location },
			});
			return;
		case "agent_v2.skill_resource_loaded":
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId, name: event.name, path: event.path, checksum: event.checksum },
			});
			return;
		case "agent_v2.delivery_reported":
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: event.type,
				data: { runId, taskId: event.taskId, projectId: event.projectId, previewUrl: event.previewUrl },
			});
			return;
		case "agent_v2.output_recorded":
			return;
	}
}

function createBrowserRunProjectionSink(browserAgent: Agent, responseLanguage: AgentV2ResponseLanguage) {
	activeAgentV2ResponseLanguage = responseLanguage;
	return createAgentV2BrowserRunSink({
		browserAgent,
		responseLanguage,
		narrationTypingIntervalMs: 14,
		onPresentationChange: (presentation) => {
			activeAgentV2Presentation = presentation;
			requestChatPanelUpdate();
		},
		onNarrationChange: requestChatPanelUpdate,
		onPhaseProjected: (runId, phase, status, at) => {
			currentRunStatus = status;
			writeDiagnosticEvent({
				level: "info",
				category: "agent",
				eventType: "agent_v2.browser_phase_projected",
				data: { runId, phase, status, at },
			});
		},
		onEventProjected: recordAgentV2BrowserProjection,
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
			at: run.updatedAt,
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
		if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
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
	if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
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
	if (!supportsApplicationGeneration(agent.state.model)) {
		const minimumTokens = AGENT_V2_MIN_MODEL_OUTPUT_TOKENS.toLocaleString();
		const language = getCurrentLanguage().toLocaleLowerCase().split(/[-_]/u)[0];
		const message =
			language === "zh"
				? `当前模型的最大输出容量不足，无法可靠生成完整应用。请点击下方模型选择器，手动切换到至少支持 ${minimumTokens} 输出 tokens 的模型后重试。系统不会自动切换模型。`
				: `The current model cannot reliably generate a complete application because its maximum output is too small. Use the model selector below to manually switch to a model that supports at least ${minimumTokens} output tokens, then retry. The system will not switch models automatically.`;
		throw new Error(message);
	}
	const messages = normalizeRemotePromptInput(input, images);
	const message = messages[0];
	if (!isRecord(message)) {
		throw new Error("Remote runs require a JSON-object prompt message.");
	}
	const selectedSkillNames = validateSelectedSkillNames(
		getLatestExplicitSkillNames([message]),
		piRuntimeConfig.skills.map((skill) => skill.name),
	);

	const previousMessages = agent.state.messages.slice();
	agent.state.messages = [...previousMessages, message];
	renderApp();
	requestChatPanelUpdate();
	void saveSession();

	let runResult: Awaited<ReturnType<typeof runClient.startRun>>;
	try {
		const projectFiles = collectAgentV2ProjectFilesForRun(previousMessages, messages);
		const attachments = Array.isArray((message as { attachments?: unknown }).attachments)
			? ((message as { attachments?: unknown[] }).attachments ?? [])
			: undefined;
		const title = sessionTitle(currentTitle, agent.state.messages);
		const rawObjective = objectiveTextFromMessage(message) ?? title;
		const objective = parseSkillCommandPrefix(rawObjective)?.args || rawObjective;
		const selectedModel = agent.state.model;
		const conversation = await buildConversationSnapshot({
			messages: previousMessages,
			currentObjective: objective,
			contextWindowTokens: selectedModel?.contextWindow ?? 128_000,
			...(conversationSnapshotState ? { previousState: conversationSnapshotState } : {}),
		});
		const responseLanguage = inferAgentV2ResponseLanguage(
			{ objective: conversation.snapshot.currentObjective, conversationSnapshot: conversation.snapshot },
			getCurrentLanguage(),
		);
		runResult = await runClient.startRun({
			sessionId: currentSessionId!,
			title,
			objective: conversation.snapshot.currentObjective,
			conversationSnapshot: conversation.snapshot,
			responseLanguage,
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

	const responseLanguage = inferAgentV2ResponseLanguage(runResult.input, getCurrentLanguage());
	const controller = new AgentV2BrowserController(createBrowserRunProjectionSink(agent, responseLanguage));
	updateWorkspaceExpansion({ type: "reset_active_run_expansion" });
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
			if (workspaceExpansionState.sidebar === "apps") refreshGeneratedAppsPanel();
			if (workspaceExpansionState.sidebar === "files") refreshCurrentProjectFilesPanel();
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
	if (!restoredStatus) return false;

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
	const restored = restoreAgentV2BrowserRunProjection({
		snapshot: runSnapshot,
		events: replayedEvents,
		sink: createBrowserRunProjectionSink(
			agent,
			inferAgentV2ResponseLanguage(runSnapshot.input, getCurrentLanguage()),
		),
		...(isTerminalRunStatus(restoredStatus)
			? {
					terminalStatus: restoredStatus,
					terminalAt: run?.updatedAt ?? sessionMetadata?.runUpdatedAt ?? sessionData.lastModified,
					...(run?.error ? { error: run.error } : {}),
				}
			: {}),
	});
	clearRemoteRunTransientStatusTexts();
	if (!restored.active) {
		agentV2BrowserController = undefined;
		currentActiveRunId = undefined;
		currentLastRunId = run?.runId ?? sessionMetadata?.lastRunId ?? activeRunId;
		currentRunStatus = restoredStatus;
		currentRunUpdatedAt = run?.updatedAt ?? sessionMetadata?.runUpdatedAt ?? sessionData.lastModified;
		updateWorkspaceExpansion({ type: "reset_active_run_expansion" });
		return false;
	}
	const controller = restored.controller;
	agentV2BrowserController = controller;
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
	syncAgentV2ActiveRunContent();
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
						updateWorkspaceExpansion({ type: "open_settings" });
						const providersTab = new ProvidersModelsTab();
						providersTab.showKnownProviders = false;
						const skillStatusTab = new SkillStatusTab();
						skillStatusTab.skills = piRuntimeConfig.skills;
						skillStatusTab.diagnostics = piRuntimeConfig.skillDiagnostics;
						void SettingsDialog.open(
							[new LanguageTab(), providersTab, new ProxyTab(), new DiagnosticLogsTab(), skillStatusTab],
							() => {
								updateWorkspaceExpansion({ type: "close_settings" });
								renderApp();
							},
						);
					},
					title: i18n("Settings"),
				})}
        </div>
      </div>

      <main
		class=${`example-content app-workspace flex-1 min-h-0 overflow-hidden ${workspaceExpansionState.sidebar ? "app-workspace--panel-open" : ""}`}
      >
        <nav class="app-side-rail" aria-label="Workspace tools">
          <button
            type="button"
			class=${`app-side-rail__item ${workspaceExpansionState.sidebar === "files" ? "app-side-rail__item--active" : ""}`}
            @click=${toggleCurrentProjectFilesPanel}
            title="Files"
            aria-label="Files"
			aria-pressed=${workspaceExpansionState.sidebar === "files" ? "true" : "false"}
          >
            <span class="app-side-rail__icon">${icon(Folder, "md")}</span>
            <span class="app-side-rail__label">Files</span>
          </button>
          <button
            type="button"
			class=${`app-side-rail__item ${workspaceExpansionState.sidebar === "apps" ? "app-side-rail__item--active" : ""}`}
            @click=${toggleGeneratedAppsPanel}
            title="Generated Apps"
            aria-label="Generated Apps"
			aria-pressed=${workspaceExpansionState.sidebar === "apps" ? "true" : "false"}
          >
            <span class="app-side-rail__icon"
              >${icon(PanelsTopLeft, "md")}</span
            >
            <span class="app-side-rail__label">APP</span>
          </button>
        </nav>
        ${
				workspaceExpansionState.sidebar === "files"
					? html`
                <aside
                  class="current-project-files-sidebar"
                  style=${`width: ${currentProjectFilesPanelWidth}px;`}
                >
                  <pi-current-project-files-panel
                    .sessionId=${currentSessionId || ""}
                    .title=${currentProjectTitle}
					.selectedFilename=${workspaceExpansionState.filePreviewPath ?? ""}
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
				workspaceExpansionState.sidebar === "apps"
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
				workspaceExpansionState.filePreviewPath
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
				  .filename=${workspaceExpansionState.filePreviewPath}
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

window.addEventListener("resize", () => {
	const viewport = currentWorkspaceViewport();
	if (viewport === workspaceExpansionState.viewport) return;
	updateWorkspaceExpansion({ type: "set_viewport", viewport });
	renderApp();
	requestChatPanelUpdate();
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
