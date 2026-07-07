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
	AppPreviewGoalRecord,
	AppPreviewGoalSource,
	DeleteSessionResult,
	RunStatus,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
} from "@mariozechner/pi-web-workspace";
import { html, render } from "lit";
import { Eye, Folder, PanelsTopLeft, Plus, Settings } from "lucide";
import "../app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { DiagnosticLogsTab } from "../diagnostics/DiagnosticLogsTab.js";
import { createDiagnosticClient, type DiagnosticData, type DiagnosticEvent } from "../diagnostics/diagnostic-client.js";
import { createLoggedStreamFn, type DiagnosticStreamLoggingConfig } from "../diagnostics/model-stream-logger.js";
import { normalizeHandoffLanguage } from "../integrations/handoff-language.js";
import {
	buildCodingHandoffPromptFromSource,
	buildPmApiUrl,
	buildVisibleCodingHandoffPrompt,
	fetchPmHandoffPayload,
	type HandoffDocumentFile,
	type PmHandoffPayload,
	prepareHandoffDocumentFiles,
} from "../integrations/pm-handoff.js";
import {
	type ProjectContextCompactionSummary,
	resolveProjectContextProviderPayloadBudget,
} from "../project-tools/context-manifest.js";
import { createServerProjectTools } from "../project-tools/tools.js";
import { buildCodingSystemPrompt } from "../prompts/coding-system-prompt.js";
import { type CapabilityPlan, capabilityPlanDiagnosticData, planCapabilities } from "../runtime/capability-planner.js";
import { piClientHeaders } from "../runtime/client-id.js";
import {
	type ContextOrchestratorDecision,
	contextDecisionDiagnosticData,
	prepareContextPacket,
} from "../runtime/context-orchestrator.js";
import { STATIC_PREVIEW_CONTRACT } from "../runtime/platform-contract.js";
import { collectProjectFilesFromMessages, prepareAttachmentProjectFileSeeds } from "../runtime/project-file-seed.js";
import {
	RemoteAgentController,
	type RemoteRunEventDrainResult,
	tryDrainRemoteRunEvents,
} from "../runtime/remote-agent-controller.js";
import { resolveActiveRunRestore, resumeInterruptedToolResultSession } from "../runtime/remote-resume.js";
import {
	buildAppPreviewGoalStartRequest,
	cancelRun as cancelRuntimeRun,
	connectRunEvents,
	deleteSession as deleteRuntimeSession,
	disableAppPreviewGoal,
	enableAppPreviewGoal,
	getAppPreviewGoal,
	getSession as getRuntimeSession,
	listRunEvents as listRuntimeRunEvents,
	listSessions as listRuntimeSessions,
	type RunEventConnection,
	renameSession as renameRuntimeSession,
	startRun as startRuntimeRun,
} from "../runtime/run-client.js";
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
	shouldClearProviderStallStatusForRunEvent,
	shouldScheduleProviderStallStatusAfterRunEvent,
} from "../runtime/run-transient-status.js";
import { trimRecoverableProviderStallErrors } from "../runtime/runtime-message-conversion.js";
import { buildSpecArtifact, type SpecArtifact, specArtifactDiagnosticData } from "../runtime/spec-artifact.js";
import { mergeProjectFileSeeds, specArtifactProjectFileSeeds } from "../runtime/spec-artifact-files.js";
import { loadServerSkillList } from "../skill-tools/client.js";
import { enqueueDefaultSkillLoadMessages } from "../skill-tools/default-skill-message.js";
import { SkillStatusTab } from "../skill-tools/SkillStatusTab.js";
import type { SkillListDetails, SkillSummary } from "../skill-tools/schemas.js";
import { expandSkillCommandsInMessages, getLatestRequiredSkillNames } from "../skill-tools/skill-command.js";
import { createServerSkillTools } from "../skill-tools/tools.js";
import { ConfiguredServerStorage } from "../storage/configured-server-storage.js";
import { type MergedSessionEntry, mergeRuntimeSessionMetadata } from "../storage/merged-session-index.js";
import { ServerBackedCustomProvidersStore } from "../storage/server-backed-custom-providers-store.js";
import { ServerBackedProviderKeysStore } from "../storage/server-backed-provider-keys-store.js";
import { sessionLastMessageModifiedAt } from "../storage/session-timestamps.js";
import "./CurrentProjectFilesPanel.js";
import {
	appPreviewGoalActionState,
	appPreviewGoalContinuationProgress,
	appPreviewGoalContinuationRunId,
	appPreviewGoalStageDetailLabel,
	appPreviewGoalStageLabel,
	appPreviewGoalToggleLabel,
	isAppPreviewGoalEnabled,
	isAppPreviewGoalSettledForRun,
} from "./app-preview-goal-state.js";
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
	isRuntimeSessionDeletionDeferred,
	loadSessionProjectApps,
	readGeneratedAppsPanelWidth,
	writeGeneratedAppsPanelWidth,
} from "./generated-apps-state.js";
import { ModelController, SELECTED_MODEL_KEY } from "./model-controller.js";
import { createCoalescedRenderScheduler } from "./render-scheduler.js";
import { CURRENT_SESSION_ID_KEY, generateTitle, isDefaultNewSessionTitle, sessionTitle } from "./session-controller.js";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running", "cancelling"]);
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["cancelled", "completed", "failed", "interrupted"]);
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
	selectableSkills: [] as SkillSummary[],
	globalSkills: [] as SkillSummary[],
	defaultSkills: [] as SkillSummary[],
	skillDiagnostics: [] as SkillDiagnostic[],
	skillSlashSuggestions: [] as SkillSlashSuggestion[],
	contextProviderPayloadBudgetChars: 90_000,
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

let pendingHandoffModelContext: { documentFiles: HandoffDocumentFile[] } | undefined;
let currentAppPreviewGoal: AppPreviewGoalRecord | undefined;
let pendingHandoffAppPreviewGoal = false;
let manualAppPreviewGoalEnabled = false;

const runClient = {
	cancelRun: cancelRuntimeRun,
	connectRunEvents,
	getSession: getRuntimeSession,
	disableAppPreviewGoal,
	enableAppPreviewGoal,
	getAppPreviewGoal,
	listRunEvents: listRuntimeRunEvents,
	listSessions: listRuntimeSessions,
	startRun: startRuntimeRun,
};

type AppPreviewGoalExtensionAction = {
	id: string;
	label: string;
	detail?: string;
	active?: boolean;
	disabled?: boolean;
	icon?: unknown;
	onSelect: () => void | Promise<void>;
};
type ExtensionActionHost = {
	extensionActions: AppPreviewGoalExtensionAction[];
	requestUpdate?: () => void;
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
	runStatus?: RunStatus;
	activeRunId?: string;
	lastRunId?: string;
	runUpdatedAt?: string;
};

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
	const selectableSkills = Array.isArray(skillList.skills) ? skillList.skills : [];
	const promptSkills = Array.isArray(skillList.promptSkills) ? skillList.promptSkills : [];
	const defaultSkills = Array.isArray(skillList.defaultSkills) ? skillList.defaultSkills : [];
	const diagnostics = Array.isArray(skillList.diagnostics) ? skillList.diagnostics : [];
	piRuntimeConfig.handoffDefaultThinkingLevel = normalizeThinkingLevel(status?.handoffDefaultThinkingLevel);
	piRuntimeConfig.selectableSkills = selectableSkills;
	piRuntimeConfig.globalSkills = promptSkills;
	piRuntimeConfig.defaultSkills = defaultSkills;
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
	piRuntimeConfig.contextProviderPayloadBudgetChars = normalizePositiveInteger(
		status?.contextProviderPayloadBudgetChars,
		90_000,
	);
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

const isActiveRunStatus = (status: RunStatus | undefined): status is RunStatus =>
	status !== undefined && ACTIVE_RUN_STATUSES.has(status);

const isTerminalRunStatus = (status: RunStatus | undefined): status is RunStatus =>
	status !== undefined && TERMINAL_RUN_STATUSES.has(status);

let currentSessionId: string | undefined;
let currentSessionCreatedAt: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let remoteAgentController: RemoteAgentController | undefined;
let remoteRunConnection: RunEventConnection | undefined;
let remoteRunStatusPollId: ReturnType<typeof setTimeout> | undefined;
let remoteRunProviderStallStatusTimerId: ReturnType<typeof setTimeout> | undefined;
let currentActiveRunId: string | undefined;
let currentLastRunId: string | undefined;
let currentRunStatus: RunStatus | undefined;
let currentRunUpdatedAt: string | undefined;
let currentCapabilityPlan: CapabilityPlan | undefined;
let currentSpecArtifact: SpecArtifact | undefined;
const remoteRunTransientStatusTexts: RunTransientStatusTexts = {};
const reportedQueuedRunTimeouts = new Set<string>();
const resumedInterruptedSessions = new Set<string>();
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

const trackRemoteRun = (run?: Pick<RuntimeRunRecord, "runId" | "status" | "updatedAt">): void => {
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
		if (runId !== currentActiveRunId || remoteAgentController?.activeRunId !== runId) return;
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

const setAppPreviewGoalStatusText = (goal = currentAppPreviewGoal): void => {
	const agentInterface = chatPanel?.agentInterface;
	if (!agentInterface) return;
	const previewPending = manualAppPreviewGoalEnabled || pendingHandoffAppPreviewGoal;
	const stageLabel = appPreviewGoalStageLabel(goal, previewPending);
	const detailLabel = appPreviewGoalStageDetailLabel(goal);
	const continuationProgress = appPreviewGoalContinuationProgress(goal);
	agentInterface.appPreviewGoalStatusText = stageLabel
		? `${i18nText(stageLabel)}${continuationProgress ? ` (${continuationProgress.used}/${continuationProgress.max})` : ""}`
		: "";
	agentInterface.appPreviewGoalStatusDetail = detailLabel ? i18nText(detailLabel) : "";
	agentInterface.requestUpdate();
};

const resetRemoteRunState = (): void => {
	closeRemoteRunConnection();
	clearProviderStallStatusTimer();
	remoteAgentController = undefined;
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

const currentAppPreviewGoalRequest = (source: AppPreviewGoalSource | undefined) =>
	buildAppPreviewGoalStartRequest(source);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildAppPreviewGoalExtensionActions(): AppPreviewGoalExtensionAction[] {
	const previewPending = manualAppPreviewGoalEnabled || pendingHandoffAppPreviewGoal;
	const actionState = appPreviewGoalActionState(currentAppPreviewGoal, previewPending);
	return [
		{
			id: "app-preview-goal",
			label: i18nText("Automatic preview"),
			detail: i18nText(appPreviewGoalToggleLabel(currentAppPreviewGoal, previewPending)),
			active: actionState.active,
			disabled: actionState.disabled,
			icon: icon(Eye, "sm"),
			onSelect: async () => {
				await setManualAppPreviewGoal(actionState.nextAction === "enable");
			},
		},
	];
}

function updateAppPreviewGoalExtensionActions(): void {
	const agentInterface = chatPanel?.agentInterface as unknown as ExtensionActionHost | undefined;
	if (!agentInterface) return;
	agentInterface.extensionActions = buildAppPreviewGoalExtensionActions();
	agentInterface.requestUpdate?.();
}

function applyAppPreviewGoal(goal: AppPreviewGoalRecord | undefined): void {
	currentAppPreviewGoal = goal;
	manualAppPreviewGoalEnabled = isAppPreviewGoalEnabled(currentAppPreviewGoal);
	updateAppPreviewGoalExtensionActions();
	setAppPreviewGoalStatusText(currentAppPreviewGoal);
	renderApp();
	requestChatPanelUpdate();
}

async function refreshAppPreviewGoal(): Promise<AppPreviewGoalRecord | undefined> {
	if (!currentSessionId) {
		applyAppPreviewGoal(undefined);
		return undefined;
	}
	try {
		const result = await runClient.getAppPreviewGoal(currentSessionId);
		applyAppPreviewGoal(result.goal ?? undefined);
	} catch (error) {
		console.error("Failed to refresh app preview goal:", error);
	}
	return currentAppPreviewGoal;
}

function refreshAppPreviewGoalInBackground(): void {
	void refreshAppPreviewGoal().catch((error) => {
		console.error("Failed to refresh app preview goal:", error);
	});
}

async function refreshAppPreviewGoalAfterTerminalRun(runId: string, attempts = 20, intervalMs = 100): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const goal = await refreshAppPreviewGoal();
		const continuationRunId = appPreviewGoalContinuationRunId(goal, runId);
		if (continuationRunId && (await attachAppPreviewGoalContinuationRun(continuationRunId))) return;
		if (isAppPreviewGoalSettledForRun(goal, runId)) return;
		if (attempt < attempts - 1) await sleep(intervalMs);
	}
}

async function attachAppPreviewGoalContinuationRun(runId: string): Promise<boolean> {
	if (!currentSessionId) return false;
	if (runId === currentActiveRunId && remoteAgentController?.activeRunId === runId) return true;

	const detail = await runClient.getSession(currentSessionId);
	const activeRun = resolveActiveRunRestore(detail, runId);
	if (!activeRun) return false;

	const runtimeMessages = trimMessagesForActiveRunReplay(detail.messages, {
		hideRecoverableProviderStallErrors: true,
	}).map(runtimeMessageToAgentMessage);
	const sessionModel = await modelController.resolveCustomModel(detail.session.model as unknown as Model<any>);
	await createAgent({
		...(sessionModel
			? { model: sessionModel }
			: {
					model: (detail.session.model as unknown as Model<any>) || undefined,
				}),
		thinkingLevel: normalizeThinkingLevel(detail.session.thinkingLevel),
		messages: runtimeMessages,
		tools: [],
	});

	const controller = new RemoteAgentController(agent);
	controller.startRemoteRun(activeRun.run.runId);
	controller.hydrateCheckpoint(activeRun.checkpointEvent, activeRun.afterSeq);
	remoteAgentController = controller;
	connectToRemoteRun(activeRun.run, controller);
	renderApp();
	requestChatPanelUpdate();
	await saveSession();
	return true;
}

function refreshAppPreviewGoalAfterTerminalRunInBackground(runId: string): void {
	void refreshAppPreviewGoalAfterTerminalRun(runId).catch((error) => {
		console.error("Failed to refresh app preview goal after run terminal:", error);
	});
}

async function setManualAppPreviewGoal(enabled: boolean): Promise<void> {
	if (!enabled) pendingHandoffAppPreviewGoal = false;
	manualAppPreviewGoalEnabled = enabled;
	if (!currentSessionId) {
		updateAppPreviewGoalExtensionActions();
		setAppPreviewGoalStatusText();
		renderApp();
		requestChatPanelUpdate();
		return;
	}
	try {
		const result = enabled
			? await runClient.enableAppPreviewGoal(currentSessionId, "manual")
			: await runClient.disableAppPreviewGoal(currentSessionId);
		applyAppPreviewGoal(result.goal ?? undefined);
	} catch (error) {
		if (enabled && error instanceof Error && error.message === "Runtime session not found") {
			currentAppPreviewGoal = undefined;
			manualAppPreviewGoalEnabled = true;
			updateAppPreviewGoalExtensionActions();
			setAppPreviewGoalStatusText();
			renderApp();
			requestChatPanelUpdate();
			return;
		}
		throw error;
	}
}

const markRemoteRunSettled = (runId: string, status: RunStatus, updatedAt?: string): void => {
	closeRemoteRunConnection();
	clearProviderStallStatusTimer();
	remoteAgentController = undefined;
	currentActiveRunId = undefined;
	currentLastRunId = runId;
	currentRunStatus = status;
	currentRunUpdatedAt = updatedAt ?? currentRunUpdatedAt;
	clearRemoteRunTransientStatusTexts();
	refreshAppPreviewGoalAfterTerminalRunInBackground(runId);
};

const runtimeMessageToAgentMessage = (message: RuntimeMessageRecord): AgentMessage => {
	const payload = isRecord(message.payload) ? message.payload : {};
	return {
		...payload,
		role: typeof payload.role === "string" ? payload.role : message.role,
	} as AgentMessage;
};

const trimMessagesForActiveRunReplay = (
	messages: RuntimeMessageRecord[],
	options: { hideRecoverableProviderStallErrors?: boolean } = {},
): RuntimeMessageRecord[] =>
	options.hideRecoverableProviderStallErrors ? trimRecoverableProviderStallErrors(messages) : messages;

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

const buildCurrentSystemPrompt = (capabilityPlan = currentCapabilityPlan, specArtifact = currentSpecArtifact) =>
	buildCodingSystemPrompt(
		piRuntimeConfig.globalSkills,
		capabilityPlan
			? {
					platformContract: STATIC_PREVIEW_CONTRACT,
					capabilityPlan,
					specArtifact,
				}
			: {},
	);

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

const getBrowserSessions = async (): Promise<MergedSessionEntry[]> => {
	const browserSessions = (await storage.sessions.getAllMetadata()) as SessionMetadataWithRunState[];
	try {
		const runtimeSessions = await runClient.listSessions();
		return mergeRuntimeSessionMetadata(runtimeSessions, browserSessions, []);
	} catch {
		return mergeRuntimeSessionMetadata([], browserSessions, []);
	}
};

const loadGeneratedAppsForSessions = async (options: { force?: boolean } = {}) => {
	const browserSessions = await getBrowserSessions();
	return loadSessionProjectApps(browserSessions, undefined, undefined, options);
};

const renameSessionProject = async (sessionId: string, title: string) => {
	try {
		await renameRuntimeSession(sessionId, title);
	} catch (error) {
		if (!isRuntimeSessionMissingError(error)) throw error;
	}
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
	let runtimeDeleteResult: DeleteSessionResult | undefined;
	try {
		runtimeDeleteResult = await deleteRuntimeSession(sessionId, {
			force: true,
		});
	} catch (error) {
		if (!isRuntimeSessionMissingError(error)) throw error;
	}
	if (isRuntimeSessionDeletionDeferred(runtimeDeleteResult)) {
		refreshGeneratedAppsPanel();
		if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		return;
	}
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

function isRuntimeSessionMissingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message === "Session not found." || message.includes("HTTP 404");
}

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
			if (remoteAgentController?.activeRunId) {
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

const resumeInterruptedSessionIfNeeded = () => {
	if (!agent) return;
	resumeInterruptedToolResultSession({
		activeRunId: currentActiveRunId,
		isStreaming: agent.state.isStreaming,
		messages: agent.state.messages,
		parentRunId: currentLastRunId,
		resumedSessions: resumedInterruptedSessions,
		runStatus: currentRunStatus,
		sessionId: currentSessionId,
		startRemoteContinuation: startRemoteContinuationRun,
		reportError: (error, sessionId) => {
			console.error("Failed to resume interrupted session:", error);
			writeDiagnosticEvent({
				level: "error",
				category: "agent",
				eventType: "agent.resume.error",
				data: errorDiagnosticData(error, { sessionId }),
			});
		},
	});
};

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

function applyPendingHandoffModelContent(messages: AgentMessage[]): AgentMessage[] {
	if (!pendingHandoffModelContext || messages.length !== 1) return messages;
	const message = messages[0];
	if ((message as { role?: unknown }).role !== "user-with-attachments") return messages;
	const visibleContent = (message as { content?: unknown }).content;
	const visibleText = messageContentText(visibleContent);
	const messageWithModelContent = {
		...(message as unknown as Record<string, unknown>),
		llmContent: buildCodingHandoffPromptFromSource(visibleText, pendingHandoffModelContext.documentFiles),
	} as unknown as AgentMessage;
	return [messageWithModelContent];
}

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

function preparePromptAttachmentSeeds(message: AgentMessage): AgentMessage {
	if ((message as { role?: unknown }).role !== "user-with-attachments") return message;
	const attachments = (message as { attachments?: unknown }).attachments;
	if (!Array.isArray(attachments)) return message;
	const preparedAttachments = prepareAttachmentProjectFileSeeds(attachments);
	return {
		...message,
		content: (message as { content?: unknown }).content,
		attachments: preparedAttachments,
	} as AgentMessage;
}

const drainCurrentRemoteRunEvents = async (runId: string): Promise<RemoteRunEventDrainResult | undefined> => {
	const controller = remoteAgentController;
	if (!controller || controller.activeRunId !== runId) return;
	return await tryDrainRemoteRunEvents(runId, controller, runClient.listRunEvents);
};

const syncCurrentRunStatusFromServer = async (runId: string, attempts = 10, intervalMs = 200): Promise<boolean> => {
	if (!currentSessionId) return false;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const detail = await runClient.getSession(currentSessionId);
		const run = detail.runs.find((candidate) => candidate.runId === runId);
		if (!run) return false;

		trackRemoteRun(run);
		reportQueuedRunTimeoutIfNeeded(run);
		if (!isTerminalRunStatus(run.status)) {
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
			continue;
		}

		const drainResult = await drainCurrentRemoteRunEvents(run.runId);
		if (drainResult && !drainResult.ok) {
			writeDiagnosticEvent({
				level: "warn",
				category: "agent",
				eventType: "agent.remote_run.event_drain_failed",
				data: errorDiagnosticData(drainResult.error, { runId: run.runId, afterSeq: drainResult.afterSeq }),
			});
		}
		closeRemoteRunConnection();
		if (remoteAgentController?.activeRunId === run.runId) {
			await remoteAgentController.settleRemoteRun(run.status, run.error ?? undefined);
		}
		markRemoteRunSettled(run.runId, run.status, run.updatedAt);
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		refreshGeneratedAppsPanel({ force: true });
		if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		return true;
	}
	return false;
};

function reportQueuedRunTimeoutIfNeeded(run: RuntimeRunRecord): void {
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
		if (runId !== currentActiveRunId || remoteAgentController?.activeRunId !== runId) return;
		void syncCurrentRunStatusFromServer(runId, 1, 0)
			.catch((error) => {
				console.error("Failed to poll remote run status:", error);
			})
			.finally(() => {
				if (runId === currentActiveRunId && remoteAgentController?.activeRunId === runId) {
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

	let run: RuntimeRunRecord;
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

const applyConnectedRunEvent = async (event: RuntimeRunEventRecord): Promise<void> => {
	if (!remoteAgentController || event.runId !== remoteAgentController.activeRunId) return;

	const retryStatus = retryStatusFromRunEvent(event);
	setRemoteRunTransientStatusText("connection");
	if (retryStatus) {
		setRemoteRunTransientStatusText("retry", retryStatusText(retryStatus, i18nText));
	} else if (shouldClearRetryStatusForRunEvent(event)) {
		setRemoteRunTransientStatusText("retry");
	}

	const payloadType =
		isRecord(event.payload) && typeof event.payload.type === "string" ? event.payload.type : undefined;
	await remoteAgentController.applyRunEvent(event);
	if (shouldClearProviderStallStatusForRunEvent(payloadType)) {
		clearProviderStallStatusTimer();
		setRemoteRunTransientStatusText("providerStalled");
	}
	if (shouldScheduleProviderStallStatusAfterRunEvent(payloadType)) scheduleProviderStallStatus(event.runId);
	if (payloadType !== "agent_end") scheduleRemoteRunRender();
	currentRunUpdatedAt = event.createdAt;

	if (payloadType === "agent_end") {
		const syncedTerminalStatus = await syncCurrentRunStatusFromServer(event.runId);
		if (!syncedTerminalStatus) {
			if (remoteAgentController?.activeRunId === event.runId) {
				await remoteAgentController.finishRemoteRun("completed");
			}
			markRemoteRunSettled(event.runId, "completed", event.createdAt);
			await saveSession();
			scheduleRemoteRunRender();
			requestChatPanelUpdate();
			refreshGeneratedAppsPanel({ force: true });
			if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
		}
	}
};

const connectToRemoteRun = (run: RuntimeRunRecord, controller: RemoteAgentController): void => {
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
						sessionId: event.sessionId,
						seq: event.seq,
					}),
				});
				throw error;
			}
		},
		{
			onStatusChange: (connection) => {
				if (
					connection.closed ||
					run.runId !== currentActiveRunId ||
					remoteAgentController?.activeRunId !== run.runId
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
	const messages = applyPendingHandoffModelContent(normalizeRemotePromptInput(input, images));
	const message = messages[0];
	if (!isRecord(message)) {
		throw new Error("Remote runs require a JSON-object prompt message.");
	}

	const previousMessages = agent.state.messages.slice();
	const previousCapabilityPlan = currentCapabilityPlan;
	const previousSpecArtifact = currentSpecArtifact;
	const previousSystemPrompt = agent.state.systemPrompt;
	const capabilityPlan = planCapabilities({
		messages: [...previousMessages, ...messages],
		platform: STATIC_PREVIEW_CONTRACT,
		source: "browser",
	});
	const specArtifact = buildSpecArtifact({
		messages: [...previousMessages, ...messages],
		capabilityPlan,
		platform: STATIC_PREVIEW_CONTRACT,
	});
	currentCapabilityPlan = capabilityPlan;
	currentSpecArtifact = specArtifact;
	agent.state.systemPrompt = buildCurrentSystemPrompt(capabilityPlan, specArtifact);
	writeCapabilityPlanDiagnostic(capabilityPlan);
	writeSpecArtifactDiagnostic(specArtifact);
	agent.state.messages = [...previousMessages, message];
	renderApp();
	requestChatPanelUpdate();
	void saveSession();

	let runResult: Awaited<ReturnType<typeof runClient.startRun>>;
	const appPreviewGoalSource: AppPreviewGoalSource | undefined = pendingHandoffAppPreviewGoal
		? "pm_handoff"
		: manualAppPreviewGoalEnabled
			? "manual"
			: undefined;
	try {
		const projectFiles = mergeProjectFileSeeds([
			...specArtifactProjectFileSeeds(specArtifact),
			...collectProjectFilesFromMessages(messages),
		]);
		const appPreviewGoal = currentAppPreviewGoalRequest(appPreviewGoalSource);
		runResult = await runClient.startRun({
			sessionId: currentSessionId,
			title: sessionTitle(currentTitle, agent.state.messages),
			message,
			model: agent.state.model as unknown as Record<string, unknown>,
			thinkingLevel: agent.state.thinkingLevel,
			...(projectFiles.length > 0 ? { projectFiles } : {}),
			...(appPreviewGoal ? { appPreviewGoal } : {}),
		});
	} catch (error) {
		agent.state.messages = previousMessages;
		currentCapabilityPlan = previousCapabilityPlan;
		currentSpecArtifact = previousSpecArtifact;
		agent.state.systemPrompt = previousSystemPrompt;
		if (appPreviewGoalSource === "pm_handoff") {
			pendingHandoffAppPreviewGoal = false;
			updateAppPreviewGoalExtensionActions();
			setAppPreviewGoalStatusText();
		}
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		throw error;
	}

	pendingHandoffModelContext = undefined;
	pendingHandoffAppPreviewGoal = false;
	currentSessionCreatedAt = runResult.session.createdAt;
	await setCurrentSessionId(runResult.session.sessionId);

	const controller = new RemoteAgentController(agent);
	controller.startRemoteRun(runResult.run.runId);
	clearRemoteRunTransientStatusTexts();
	remoteAgentController = controller;
	connectToRemoteRun(runResult.run, controller);
	renderApp();
	requestChatPanelUpdate();
	await saveSession();
	refreshAppPreviewGoalInBackground();
	refreshGeneratedAppsPanel();
	await agent.waitForIdle();
};

const startRemoteContinuationRun = async (parentRunId: string): Promise<void> => {
	await ensureSessionIdentity();
	const projectFiles = collectProjectFilesFromMessages(agent.state.messages);
	let runResult: Awaited<ReturnType<typeof runClient.startRun>>;
	try {
		const appPreviewGoal = currentAppPreviewGoalRequest(manualAppPreviewGoalEnabled ? "manual" : undefined);
		runResult = await runClient.startRun({
			sessionId: currentSessionId,
			title: sessionTitle(currentTitle, agent.state.messages),
			model: agent.state.model as unknown as Record<string, unknown>,
			thinkingLevel: agent.state.thinkingLevel,
			continuation: {
				source: "interrupted_recovery",
				parentRunId,
			},
			...(projectFiles.length > 0 ? { projectFiles } : {}),
			...(appPreviewGoal ? { appPreviewGoal } : {}),
		});
	} catch (error) {
		await saveSession();
		renderApp();
		requestChatPanelUpdate();
		throw error;
	}

	currentSessionCreatedAt = runResult.session.createdAt;
	await setCurrentSessionId(runResult.session.sessionId);

	const controller = new RemoteAgentController(agent);
	controller.startRemoteRun(runResult.run.runId);
	clearRemoteRunTransientStatusTexts();
	remoteAgentController = controller;
	connectToRemoteRun(runResult.run, controller);
	renderApp();
	requestChatPanelUpdate();
	await saveSession();
	refreshAppPreviewGoalInBackground();
	refreshGeneratedAppsPanel();
	await agent.waitForIdle();
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}
	resetRemoteRunState();

	const defaultModel = await modelController.getDefaultModel();
	const resolvedInitialState = initialState || createInitialAgentState(defaultModel);
	agent = new Agent({
		initialState: {
			...resolvedInitialState,
			systemPrompt: buildCurrentSystemPrompt(),
		},
		convertToLlm: defaultConvertToLlm,
		transformContext: async (messages) => {
			const providerBudget = resolveProjectContextProviderPayloadBudget({
				model: agent.state.model,
				thinkingLevel: agent.state.thinkingLevel,
				systemPrompt: agent.state.systemPrompt,
				tools: agent.state.tools,
				providerPayloadBudgetChars: piRuntimeConfig.contextProviderPayloadBudgetChars,
			});
			const result = await prepareContextPacket(
				await expandSkillCommandsInMessages(messages, {
					defaultSkillNames: piRuntimeConfig.defaultSkills.map((skill) => skill.name),
				}),
				{
					capabilityPlan: currentCapabilityPlan,
					specArtifact: currentSpecArtifact,
					providerPayloadBudgetChars: providerBudget.providerPayloadBudgetChars,
					providerPayloadFixedOverheadChars: providerBudget.providerPayloadFixedOverheadChars,
					onCompaction: writeProjectContextCompactionDiagnostic,
					onDecision: writeProjectContextPacketDiagnostic,
				},
			);
			return result.messages;
		},
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
	(agent as Agent & { repairToolCalls: boolean }).repairToolCalls = true;
	const abortAgentLocally = agent.abort.bind(agent);
	agent.abort = () => {
		if (currentActiveRunId && remoteAgentController?.activeRunId === currentActiveRunId) {
			void cancelCurrentRemoteRun(currentActiveRunId).catch(() => {});
		}
		abortAgentLocally();
	};
	agent.prompt = (async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> => {
		await startRemotePrompt(input, images);
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
			await enqueueDefaultSkillLoadMessages(agent, piRuntimeConfig.defaultSkills);
			await modelController.persistSelectedModel(agent.state.model);
			await saveSession();
			if (activeSidebarPanel === "apps") refreshGeneratedAppsPanel();
			if (activeSidebarPanel === "files") refreshCurrentProjectFilesPanel();
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
	updateAppPreviewGoalExtensionActions();
	setAppPreviewGoalStatusText();
	applySkillSlashSuggestions();
};

function writeProjectContextCompactionDiagnostic(summary: ProjectContextCompactionSummary): void {
	diagnosticClient.write({
		level: "info",
		category: "model",
		eventType: "model.context_compaction",
		sessionId: currentSessionId,
		traceId: currentSessionId,
		data: { ...summary },
	});
}

function writeCapabilityPlanDiagnostic(capabilityPlan: CapabilityPlan): void {
	writeDiagnosticEvent({
		level: "info",
		category: "model",
		eventType: "model.capability_plan",
		data: capabilityPlanDiagnosticData(capabilityPlan),
	});
}

function writeSpecArtifactDiagnostic(specArtifact: SpecArtifact): void {
	writeDiagnosticEvent({
		level: "info",
		category: "model",
		eventType: "model.spec_artifact",
		data: specArtifactDiagnosticData(specArtifact),
	});
}

function writeProjectContextPacketDiagnostic(decision: ContextOrchestratorDecision): void {
	writeDiagnosticEvent({
		level: "info",
		category: "model",
		eventType: "model.context_packet",
		data: contextDecisionDiagnosticData(decision),
	});
}

const loadSession = async (sessionId: string): Promise<boolean> => {
	pendingHandoffModelContext = undefined;
	currentCapabilityPlan = undefined;
	currentSpecArtifact = undefined;
	pendingHandoffAppPreviewGoal = false;
	manualAppPreviewGoalEnabled = false;
	if (!storage.sessions) return false;

	try {
		const runtimeDetail = await runClient.getSession(sessionId);
		const activeRun = resolveActiveRunRestore(runtimeDetail);
		const runtimeMessages = trimMessagesForActiveRunReplay(runtimeDetail.messages, {
			hideRecoverableProviderStallErrors: Boolean(activeRun),
		}).map(runtimeMessageToAgentMessage);

		await setCurrentSessionId(sessionId);
		currentSessionCreatedAt = runtimeDetail.session.createdAt;
		currentTitle = isDefaultNewSessionTitle(runtimeDetail.session.title) ? "" : runtimeDetail.session.title || "";

		const sessionModel = await modelController.resolveCustomModel(
			runtimeDetail.session.model as unknown as Model<any>,
		);
		if (sessionModel) {
			await modelController.persistSelectedModel(sessionModel);
		}

		await createAgent({
			...(sessionModel
				? { model: sessionModel }
				: {
						model: (runtimeDetail.session.model as unknown as Model<any>) || undefined,
					}),
			thinkingLevel: normalizeThinkingLevel(runtimeDetail.session.thinkingLevel),
			messages: runtimeMessages,
			tools: [],
		});

		if (activeRun) {
			trackRemoteRun(activeRun.run);
			const controller = new RemoteAgentController(agent);
			controller.startRemoteRun(activeRun.run.runId);
			controller.hydrateCheckpoint(activeRun.checkpointEvent, activeRun.afterSeq);
			remoteAgentController = controller;
			connectToRemoteRun(activeRun.run, controller);
		} else {
			currentActiveRunId = undefined;
			currentLastRunId = runtimeDetail.session.lastRunId;
			currentRunStatus = runtimeDetail.session.lastRunStatus;
			currentRunUpdatedAt = runtimeDetail.session.updatedAt;
		}

		await saveSession();
		await refreshAppPreviewGoal();
		renderApp();
		if (!activeRun) {
			resumeInterruptedSessionIfNeeded();
		}
		return true;
	} catch {}

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
	currentActiveRunId = sessionMetadata?.activeRunId;
	currentLastRunId = sessionMetadata?.lastRunId ?? sessionMetadata?.activeRunId;
	currentRunStatus = sessionMetadata?.runStatus;
	currentRunUpdatedAt = sessionMetadata?.runUpdatedAt;

	await refreshAppPreviewGoal();
	renderApp();
	resumeInterruptedSessionIfNeeded();
	return true;
};

const startFreshSession = async (persistImmediately = false) => {
	pendingHandoffModelContext = undefined;
	currentCapabilityPlan = undefined;
	currentSpecArtifact = undefined;
	currentAppPreviewGoal = undefined;
	pendingHandoffAppPreviewGoal = false;
	manualAppPreviewGoalEnabled = false;
	currentTitle = "";
	currentSessionCreatedAt = undefined;
	resetRemoteRunState();
	await setCurrentSessionId(undefined);
	const model = await modelController.getDefaultModel();
	await createAgent(createInitialAgentState(model));
	if (persistImmediately) {
		await ensureSessionIdentity();
		await saveSession();
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
	await startFreshSession(false);
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
	pendingHandoffModelContext = { documentFiles };
	pendingHandoffAppPreviewGoal = true;
	manualAppPreviewGoalEnabled = false;
	currentAppPreviewGoal = undefined;
	updateAppPreviewGoalExtensionActions();
	setAppPreviewGoalStatusText();
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
	updateAppPreviewGoalExtensionActions();
	setAppPreviewGoalStatusText();
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
