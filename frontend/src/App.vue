<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import type { BusinessTemplateDetail, BusinessTemplateSummary } from './types/businessTemplate'
import RequirementMarkdownPreview from './components/RequirementMarkdownPreview.vue'
import StructuredRequirementPanel from './components/StructuredRequirementPanel.vue'
import { computeStructuredRequirementProgress } from './lib/structuredRequirementProgress'
import type {
  ChatMessage,
  ChatMessagePayload,
  GeneratedDocumentResponse,
  ImplementationContextResponse,
  LanguageCode,
  MessageResponse,
  PromptTemplate,
  SessionDetail,
  SessionSummary,
} from './types/session'
import {
  createEmptyStructuredRequirementModel,
  extractStructuredRequirementModel,
  hasStructuredRequirementContent,
  type StructuredRequirementModel,
  type StructuredRequirementResponse,
} from './types/structuredRequirement'

const sessionId = ref('')
const sessions = ref<SessionSummary[]>([])
const businessTemplates = ref<BusinessTemplateSummary[]>([])
const businessTemplateDetails = ref<Record<string, BusinessTemplateDetail>>({})
const sessionPromptTemplate = ref<PromptTemplate>('personal_project')
const inputText = ref('')
const messages = ref<ChatMessage[]>([])
const chatList = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const loadingSession = ref(false)
const loadingHistory = ref(false)
const loadingTemplates = ref(false)
const switchingSession = ref(false)
const deletingSessionId = ref('')
const applyingTemplateId = ref('')
const generatingDocuments = ref(false)
const openingGoCoding = ref(false)
const globalError = ref('')
const loadingStructuredRequirement = ref(false)
const structuredRequirementError = ref('')
const structuredRequirementModel = ref<StructuredRequirementModel>(createEmptyStructuredRequirementModel())
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const GO_CODING_URL = resolveExternalUrl(import.meta.env.VITE_GO_CODING_URL, 'http://localhost:8888')
let structuredRequirementRequestToken = 0
const activeReplyCount = ref(0)
const activeMessagePipelineCount = ref(0)
const activeStructuredRequirementSyncCount = ref(0)
const historyExpanded = ref(false)
const templateLibraryExpanded = ref(true)
const templateDialogOpen = ref(false)
const loadingTemplateDetail = ref(false)
const templateDialogError = ref('')
const selectedBusinessTemplateId = ref('')


// 褰曢煶鐩稿叧鍙橀噺
const recording = ref(false)
const audioBuffer = ref<Float32Array[]>([])
const audioContext = ref<AudioContext | null>(null)
const scriptProcessor = ref<ScriptProcessorNode | null>(null)

const hasSession = computed(() => Boolean(sessionId.value))
const currentLanguage = ref<LanguageCode>('zh')
const sidebarCollapsed = ref(false)
const sending = computed(() => activeReplyCount.value > 0)
const messagePipelineActive = computed(() => activeMessagePipelineCount.value > 0)
const syncingStructuredRequirement = computed(() => activeStructuredRequirementSyncCount.value > 0)
const structuredRequirementProgress = computed(() =>
  computeStructuredRequirementProgress(structuredRequirementModel.value),
)

const translations = {
  en: {
    title: 'AI PM',
    subtitle: 'From requirement interview to build spec',
    languageSection: 'Language',
    conversation: 'Conversation',
    history: 'History',
    historyLoading: 'Loading history...',
    historyEmpty: 'No conversation history yet',
    untitledChat: 'New Chat',
    newChat: 'New Chat',
    generatePrd: 'Generate Documents',
    generatingPrd: 'Generating documents...',
    sending: 'Sending...',
    send: 'Send',
    recording: 'Recording',
    stopRecording: 'Stop Recording',
    startRecording: 'Start Recording',
    loading: 'Loading...',
    creating: 'Creating...',
    startConversation: 'Start a conversation',
    startConversationDesc: 'Describe your project requirements and AI PM will help you collect and refine them.',
    describeRequirements: 'Describe your requirements...',
    error: 'Error',
    failedToSend: 'Failed to send message',
    failedToCreate: 'Failed to create session',
    failedToLoadHistory: 'Failed to load conversation history',
    failedToLoadSession: 'Failed to load session',
    failedToGenerate: 'Failed to generate documents',
    microphoneAccessError: 'Unable to access microphone',
    speechRecognitionError: 'Speech recognition failed',
    prdDocLabel: 'Requirements Document',
    designDocLabel: 'Design Document',
    downloadMarkdown: 'Download Markdown',
    streamingError: 'Streaming response error',
    browserNotSupport: 'Browser does not support streaming responses',
    requestFailed: 'Request failed',
    close: 'Close',
    viewReasoning: 'View reasoning',
    you: 'You',
    pmAssistant: 'AI PM',
    justNow: 'Just now',
    messagesLabel: 'messages',
    sessionsLabel: 'sessions',
    templatesLabel: 'templates',
    failedToDeleteSession: 'Failed to delete session',
    delete: 'Delete',
    deleteSession: 'Delete session',
    deleteSessionConfirm: 'Delete this conversation?',
    templateLabel: 'Session Template',
    templateLockedHint: 'Locked after first user message',
    personalProjectTemplate: 'Quick',
    standardTemplate: 'Expert',
    expandSidebar: 'Expand sidebar',
    collapseSidebar: 'Collapse sidebar',
    historyExpand: 'Expand history',
    historyCollapse: 'Collapse history',
    templateLibraryExpand: 'Expand template library',
    templateLibraryCollapse: 'Collapse template library',
    templateLibrary: 'Template Library',
    templateLibraryLoading: 'Loading templates...',
    templateLibraryEmpty: 'No templates available yet',
    templateLibraryHint: 'Choose a business template to start a structured session faster.',
    templateOpen: 'View details',
    templateApply: 'Use this template',
    templateCancel: 'Cancel',
    templateDetail: 'Template Details',
    templateScenarios: 'Applicable scenarios',
    templateSections: 'Template sections',
    templateSectionsShort: 'sections',
    templateTags: 'Tags',
    templateFieldCount: 'fields',
    templateApplyHint: 'Confirming will start a new conversation with this business template.',
    templatePromptManagedHint: 'A business template is active. Generic quick/expert prompting is disabled for this session.',
    templateSessionBadge: 'Template session',
    failedToLoadTemplates: 'Failed to load template library',
    failedToOpenGoCoding: 'Failed to open coding workspace',
  },
  de: {
    title: 'AI PM',
    subtitle: 'Vom Anforderungsdialog zur Entwicklungsspezifikation',
    languageSection: 'Sprache',
    conversation: 'Konversation',
    history: 'Verlauf',
    historyLoading: 'Verlauf wird geladen...',
    historyEmpty: 'Noch kein Verlauf vorhanden',
    untitledChat: 'Neuer Chat',
    newChat: 'Neuer Chat',
    generatePrd: 'Dokumente erzeugen',
    generatingPrd: 'Dokumente werden erzeugt...',
    sending: 'Wird gesendet...',
    send: 'Senden',
    recording: 'Aufnahme',
    stopRecording: 'Aufnahme stoppen',
    startRecording: 'Aufnahme starten',
    loading: 'Laedt...',
    creating: 'Wird erstellt...',
    startConversation: 'Konversation starten',
    startConversationDesc: 'Beschreibe deine Projektanforderungen, und AI PM hilft beim Sammeln und Strukturieren.',
    describeRequirements: 'Beschreibe deine Anforderungen...',
    error: 'Fehler',
    failedToSend: 'Senden der Nachricht fehlgeschlagen',
    failedToCreate: 'Chat konnte nicht erstellt werden',
    failedToLoadHistory: 'Verlauf konnte nicht geladen werden',
    failedToLoadSession: 'Chat konnte nicht geladen werden',
    failedToGenerate: 'Dokumente konnten nicht erstellt werden',
    microphoneAccessError: 'Kein Zugriff auf das Mikrofon',
    speechRecognitionError: 'Spracherkennung fehlgeschlagen',
    prdDocLabel: 'Anforderungsdokument',
    designDocLabel: 'Design-Dokument',
    downloadMarkdown: 'Markdown herunterladen',
    streamingError: 'Fehler bei der Streaming-Antwort',
    browserNotSupport: 'Der Browser unterstuetzt keine Streaming-Antworten',
    requestFailed: 'Anfrage fehlgeschlagen',
    close: 'Schliessen',
    viewReasoning: 'Denkprozess anzeigen',
    you: 'Du',
    pmAssistant: 'AI PM',
    justNow: 'Gerade eben',
    messagesLabel: 'Nachrichten',
    sessionsLabel: 'Chats',
    templatesLabel: 'Vorlagen',
    failedToDeleteSession: 'Chat konnte nicht geloescht werden',
    delete: 'Loeschen',
    deleteSession: 'Chat loeschen',
    deleteSessionConfirm: 'Diesen Chat wirklich loeschen?',
    templateLabel: 'Sitzungsvorlage',
    templateLockedHint: 'Nach der ersten Nutzernachricht gesperrt',
    personalProjectTemplate: 'Schnell',
    standardTemplate: 'Experte',
    expandSidebar: 'Seitenleiste ausklappen',
    collapseSidebar: 'Seitenleiste einklappen',
    historyExpand: 'Verlauf ausklappen',
    historyCollapse: 'Verlauf einklappen',
    templateLibraryExpand: 'Vorlagenbibliothek ausklappen',
    templateLibraryCollapse: 'Vorlagenbibliothek einklappen',
    templateLibrary: 'Vorlagenbibliothek',
    templateLibraryLoading: 'Vorlagen werden geladen...',
    templateLibraryEmpty: 'Noch keine Vorlagen verfuegbar',
    templateLibraryHint: 'Waehle eine Fachvorlage, um schneller in eine strukturierte Sitzung zu starten.',
    templateOpen: 'Details ansehen',
    templateApply: 'Vorlage verwenden',
    templateCancel: 'Abbrechen',
    templateDetail: 'Vorlagendetails',
    templateScenarios: 'Geeignete Szenarien',
    templateSections: 'Vorlagenabschnitte',
    templateSectionsShort: 'Abschnitte',
    templateTags: 'Tags',
    templateFieldCount: 'Felder',
    templateApplyHint: 'Beim Bestaetigen wird eine neue Konversation mit dieser Fachvorlage gestartet.',
    templatePromptManagedHint: 'Diese Sitzung wird von einer Fachvorlage gesteuert. Die generischen Schnell/Experte-Prompts sind deaktiviert.',
    templateSessionBadge: 'Vorlagen-Sitzung',
    failedToLoadTemplates: 'Vorlagenbibliothek konnte nicht geladen werden',
    failedToOpenGoCoding: 'Coding-Workspace konnte nicht geoeffnet werden',
  },
  zh: {
    title: 'AI PM',
    subtitle: '需求访谈到开发规格',
    languageSection: '语言',
    conversation: '对话',
    history: '历史会话',
    historyLoading: '加载历史中...',
    historyEmpty: '还没有历史会话',
    untitledChat: '新建对话',
    newChat: '新建对话',
    generatePrd: '生成文档',
    generatingPrd: '正在生成文档...',
    sending: '发送中...',
    send: '发送',
    recording: '录音中',
    stopRecording: '停止录音',
    startRecording: '开始录音',
    loading: '加载中...',
    creating: '创建中...',
    startConversation: '开始对话',
    startConversationDesc: '描述您的项目需求，AI PM 会帮助您收集并整理成开发规格。',
    describeRequirements: '描述您的需求...',
    error: '错误',
    failedToSend: '发送失败',
    failedToCreate: '创建对话失败',
    failedToLoadHistory: '加载历史会话失败',
    failedToLoadSession: '加载会话失败',
    failedToGenerate: '生成文档失败',
    microphoneAccessError: '无法访问麦克风',
    speechRecognitionError: '语音识别失败',
    prdDocLabel: '需求文档',
    designDocLabel: '设计文档',
    downloadMarkdown: '下载 Markdown',
    streamingError: '流式响应错误',
    browserNotSupport: '浏览器不支持流式响应',
    requestFailed: '请求失败',
    close: '关闭',
    viewReasoning: '查看思考过程',
    you: '你',
    pmAssistant: 'AI PM',
    justNow: '刚刚',
    messagesLabel: '条消息',
    sessionsLabel: '个会话',
    templatesLabel: '个模板',
    failedToDeleteSession: '删除会话失败',
    delete: '删除',
    deleteSession: '删除会话',
    deleteSessionConfirm: '确认删除这条历史会话吗？',
    templateLabel: '会话模板',
    templateLockedHint: '首条用户消息后锁定',
    personalProjectTemplate: '快速',
    standardTemplate: '专家',
    expandSidebar: '展开侧边栏',
    collapseSidebar: '收起侧边栏',
    historyExpand: '展开历史会话',
    historyCollapse: '收起历史会话',
    templateLibraryExpand: '展开模板库',
    templateLibraryCollapse: '收起模板库',
    templateLibrary: '模板库',
    templateLibraryLoading: '模板加载中...',
    templateLibraryEmpty: '还没有可用模板',
    templateLibraryHint: '选择一个业务模板，更快开始结构化需求会话。',
    templateOpen: '查看详情',
    templateApply: '使用该模板',
    templateCancel: '取消',
    templateDetail: '模板详情',
    templateScenarios: '适用场景',
    templateSections: '模板章节',
    templateSectionsShort: '章节',
    templateTags: '标签',
    templateFieldCount: '个字段',
    templateApplyHint: '确认后会新建一个基于该业务模板的会话。',
    templatePromptManagedHint: '当前会话已启用业务模板，通用的“快速/专家”提问策略已停用。',
    templateSessionBadge: '模板会话',
    failedToLoadTemplates: '加载模板库失败',
    failedToOpenGoCoding: '打开 Coding 工作区失败',
  },
  ms: {
    title: 'AI PM',
    subtitle: 'Daripada temubual ke spesifikasi pembangunan',
    languageSection: 'Bahasa',
    conversation: 'Perbualan',
    history: 'Sejarah',
    historyLoading: 'Memuatkan sejarah...',
    historyEmpty: 'Belum ada sejarah perbualan',
    untitledChat: 'Sembang Baharu',
    newChat: 'Sembang Baharu',
    generatePrd: 'Jana Dokumen',
    generatingPrd: 'Sedang menjana dokumen...',
    sending: 'Menghantar...',
    send: 'Hantar',
    recording: 'Merakam',
    stopRecording: 'Henti Rakaman',
    startRecording: 'Mula Merakam',
    loading: 'Memuatkan...',
    creating: 'Mencipta...',
    startConversation: 'Mulakan perbualan',
    startConversationDesc: 'Terangkan keperluan projek anda, dan AI PM akan membantu mengumpul serta menyusunnya.',
    describeRequirements: 'Terangkan keperluan anda...',
    error: 'Ralat',
    failedToSend: 'Gagal menghantar mesej',
    failedToCreate: 'Gagal mencipta sesi',
    failedToLoadHistory: 'Gagal memuatkan sejarah perbualan',
    failedToLoadSession: 'Gagal memuatkan sesi',
    failedToGenerate: 'Gagal menjana dokumen',
    microphoneAccessError: 'Tidak dapat mengakses mikrofon',
    speechRecognitionError: 'Pengecaman suara gagal',
    prdDocLabel: 'Dokumen Keperluan',
    designDocLabel: 'Dokumen Reka Bentuk',
    downloadMarkdown: 'Muat Turun Markdown',
    streamingError: 'Ralat respons penstriman',
    browserNotSupport: 'Pelayar tidak menyokong respons penstriman',
    requestFailed: 'Permintaan gagal',
    close: 'Tutup',
    viewReasoning: 'Lihat proses penaakulan',
    you: 'Anda',
    pmAssistant: 'AI PM',
    justNow: 'Baru sahaja',
    messagesLabel: 'mesej',
    sessionsLabel: 'sesi',
    templatesLabel: 'templat',
    failedToDeleteSession: 'Gagal memadam sesi',
    delete: 'Padam',
    deleteSession: 'Padam sesi',
    deleteSessionConfirm: 'Padam perbualan ini?',
    templateLabel: 'Templat Sesi',
    templateLockedHint: 'Dikunci selepas mesej pengguna pertama',
    personalProjectTemplate: 'Pantas',
    standardTemplate: 'Pakar',
    expandSidebar: 'Kembangkan bar sisi',
    collapseSidebar: 'Runtuhkan bar sisi',
    historyExpand: 'Kembangkan sejarah',
    historyCollapse: 'Runtuhkan sejarah',
    templateLibraryExpand: 'Kembangkan pustaka templat',
    templateLibraryCollapse: 'Runtuhkan pustaka templat',
    templateLibrary: 'Pustaka Templat',
    templateLibraryLoading: 'Memuatkan templat...',
    templateLibraryEmpty: 'Belum ada templat tersedia',
    templateLibraryHint: 'Pilih templat perniagaan untuk memulakan sesi berstruktur dengan lebih pantas.',
    templateOpen: 'Lihat butiran',
    templateApply: 'Guna templat ini',
    templateCancel: 'Batal',
    templateDetail: 'Butiran Templat',
    templateScenarios: 'Senario sesuai',
    templateSections: 'Bahagian templat',
    templateSectionsShort: 'bahagian',
    templateTags: 'Tag',
    templateFieldCount: 'medan',
    templateApplyHint: 'Pengesahan akan memulakan perbualan baharu menggunakan templat perniagaan ini.',
    templatePromptManagedHint: 'Sesi ini dikawal oleh templat perniagaan. Mod prompt umum Pantas/Pakar dimatikan.',
    templateSessionBadge: 'Sesi templat',
    failedToLoadTemplates: 'Gagal memuatkan pustaka templat',
    failedToOpenGoCoding: 'Gagal membuka workspace coding',
  },
} satisfies Record<LanguageCode, Record<string, string>>

const t = computed(() => translations[currentLanguage.value])
const activeSessionSummary = computed(() => sessions.value.find((item) => item.session_id === sessionId.value) || null)
const activeSessionTitle = computed(() => sessionTitle(activeSessionSummary.value?.title || ''))
const activeBusinessTemplateName = computed(() => activeSessionSummary.value?.applied_template_name?.trim() || '')
const templateDrivenSession = computed(() => Boolean(activeSessionSummary.value?.applied_template_id))
const hasUserMessage = computed(() => messages.value.some((item) => item.role === 'user'))
const latestPrdDocument = computed(() => findLatestDocumentMessage('prd_doc'))
const latestDesignDocument = computed(() => findLatestDocumentMessage('design_doc'))
const selectedBusinessTemplate = computed<BusinessTemplateDetail | null>(() => {
  const templateId = selectedBusinessTemplateId.value
  if (!templateId) {
    return null
  }
  return businessTemplateDetails.value[templateId] ?? null
})
const languageOptions: Array<{ code: LanguageCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'zh', label: '中文' },
  { code: 'ms', label: 'Bahasa Melayu' },
]
const sidebarToggleAriaLabel = computed(() =>
  sidebarCollapsed.value ? t.value.expandSidebar : t.value.collapseSidebar,
)

const canChangePromptTemplate = computed(
  () =>
    hasSession.value &&
    !templateDrivenSession.value &&
    !hasUserMessage.value &&
    !messagePipelineActive.value &&
    !generatingDocuments.value &&
    !switchingSession.value &&
    !loadingSession.value,
)
const promptTemplateOptions = computed<{ value: PromptTemplate; label: string }[]>(() => [
  { value: 'personal_project', label: t.value.personalProjectTemplate },
  { value: 'standard', label: t.value.standardTemplate },
])
const templateFacetLabels: Record<string, Record<LanguageCode, string>> = {
  business_requirement: {
    en: 'Business Requirement',
    de: 'Business Requirement',
    zh: '业务需求',
    ms: 'Keperluan Perniagaan',
  },
  finance_management: {
    en: 'Finance Management',
    de: 'Finanzmanagement',
    zh: '财务管理',
    ms: 'Pengurusan Kewangan',
  },
}

function selectLanguage(lang: LanguageCode) {
  currentLanguage.value = lang
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function toggleHistoryExpanded() {
  historyExpanded.value = !historyExpanded.value
}

function toggleTemplateLibraryExpanded() {
  templateLibraryExpanded.value = !templateLibraryExpanded.value
}

function clearError() {
  globalError.value = ''
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message
  }
  return fallback
}

function apiUrl(path: string): string {
  if (!API_BASE_URL) {
    return path
  }
  return `${API_BASE_URL}${path}`
}

function resolveExternalUrl(rawValue: unknown, fallback: string): string {
  const candidate = String(rawValue || '').trim() || fallback
  try {
    return new URL(candidate).toString()
  } catch {
    return new URL(`http://${candidate}`).toString()
  }
}

function localeCode() {
  if (currentLanguage.value === 'zh') {
    return 'zh-CN'
  }
  if (currentLanguage.value === 'de') {
    return 'de-DE'
  }
  if (currentLanguage.value === 'ms') {
    return 'ms-MY'
  }
  return 'en-US'
}

function parseThinkContent(raw: string): { content: string; thinking: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi
  const thinkingParts: string[] = []
  let plain = raw
  let match = thinkRegex.exec(raw)

  while (match) {
    if (match[1]?.trim()) {
      thinkingParts.push(match[1].trim())
    }
    match = thinkRegex.exec(raw)
  }

  plain = plain.replace(thinkRegex, '').trim()
  return { content: plain, thinking: thinkingParts.join('\n\n') }
}

function normalizeMessageKind(kind?: string): ChatMessage['kind'] {
  if (kind === 'prd_doc' || kind === 'design_doc') {
    return kind
  }
  return 'chat'
}

function normalizeMessages(rawMessages: ChatMessagePayload[]): ChatMessage[] {
  return rawMessages.map((item) => {
    const normalizedKind = normalizeMessageKind(item.kind)
    if (item.role !== 'assistant') {
      return {
        role: item.role,
        content: item.content,
        createdAt: item.created_at,
        kind: normalizedKind,
        downloadUrl: item.download_url,
        downloadFilename: item.download_filename,
      }
    }

    const parsed = parseThinkContent(item.content)
    return {
      role: item.role,
      content: parsed.content,
      thinking: item.thinking || parsed.thinking,
      createdAt: item.created_at,
      kind: normalizedKind,
      downloadUrl: item.download_url,
      downloadFilename: item.download_filename,
    }
  })
}

function normalizePromptTemplate(value?: string): PromptTemplate {
  return value === 'standard' ? 'standard' : 'personal_project'
}

function humanizeTemplateFacet(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatTemplateFacet(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return ''
  }
  return templateFacetLabels[normalized]?.[currentLanguage.value] || humanizeTemplateFacet(normalized)
}

function resetStructuredRequirementState() {
  structuredRequirementModel.value = createEmptyStructuredRequirementModel()
  structuredRequirementError.value = ''
  loadingStructuredRequirement.value = false
  activeStructuredRequirementSyncCount.value = 0
}

function applyStructuredRequirementPayload(payload: unknown) {
  const model = extractStructuredRequirementModel(payload)
  if (model) {
    structuredRequirementModel.value = model
    structuredRequirementError.value = ''
    loadingStructuredRequirement.value = false
  }
}

function beginStructuredRequirementSync() {
  activeStructuredRequirementSyncCount.value += 1
}

function endStructuredRequirementSync() {
  activeStructuredRequirementSyncCount.value = Math.max(0, activeStructuredRequirementSyncCount.value - 1)
}

function createMessagePipelineState() {
  activeReplyCount.value += 1
  activeMessagePipelineCount.value += 1
  return {
    replyReleased: false,
    syncStarted: false,
  }
}

function releaseMessageReplyPhase(state: { replyReleased: boolean }) {
  if (state.replyReleased) {
    return
  }
  state.replyReleased = true
  activeReplyCount.value = Math.max(0, activeReplyCount.value - 1)
}

function startMessageSyncPhase(state: { syncStarted: boolean }) {
  if (state.syncStarted) {
    return
  }
  state.syncStarted = true
  beginStructuredRequirementSync()
}

function finishMessageSyncPhase(state: { syncStarted: boolean }) {
  if (!state.syncStarted) {
    return
  }
  state.syncStarted = false
  endStructuredRequirementSync()
}

function completeMessagePipeline(state: { replyReleased: boolean; syncStarted: boolean }) {
  releaseMessageReplyPhase(state)
  finishMessageSyncPhase(state)
  activeMessagePipelineCount.value = Math.max(0, activeMessagePipelineCount.value - 1)
}

function shouldRefreshStructuredRequirement(syncStatus?: string): boolean {
  return syncStatus === 'stale' || syncStatus === 'missing'
}

function sessionTitle(rawTitle: string): string {
  return rawTitle.trim() || t.value.untitledChat
}

function sessionPreview(session: SessionSummary): string {
  return session.last_message_preview?.trim() || t.value.startConversationDesc
}

function canMutateHistory(): boolean {
  return !messagePipelineActive.value && !generatingDocuments.value && !loadingSession.value && !switchingSession.value
}

function formatSessionTime(timestamp?: string): string {
  if (!timestamp) {
    return t.value.justNow
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return t.value.justNow
  }

  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const formatter = new Intl.DateTimeFormat(
    localeCode(),
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' },
  )

  return formatter.format(date)
}

function formatMessageTime(timestamp?: string): string {
  if (!timestamp) {
    return ''
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat(localeCode(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const errorMessage = typeof data?.error === 'string' ? data.error : `Request failed: ${response.status}`
    throw new Error(errorMessage)
  }
  return data as T
}

function isGeneratedDocumentMessage(message: ChatMessage): boolean {
  return message.kind === 'design_doc' || message.kind === 'prd_doc'
}

function findLatestDocumentMessage(kind: NonNullable<ChatMessage['kind']>): ChatMessage | null {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index]
    if (message.kind === kind && message.downloadUrl) {
      return message
    }
  }
  return null
}

function documentBadgeLabel(message: ChatMessage): string {
  if (message.kind === 'prd_doc') {
    return t.value.prdDocLabel
  }
  return t.value.designDocLabel
}

function triggerDocumentDownload(path: string, filename?: string) {
  const link = document.createElement('a')
  link.href = apiUrl(path)
  if (filename) {
    link.download = filename
  }
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

function downloadLatestGeneratedDocument(kind: 'prd' | 'design') {
  const target = kind === 'prd' ? latestPrdDocument.value : latestDesignDocument.value
  if (!target?.downloadUrl) {
    return
  }
  triggerDocumentDownload(target.downloadUrl, target.downloadFilename)
}

function redirectToGoCoding(payload: ImplementationContextResponse) {
  const targetUrl = new URL(GO_CODING_URL)
  targetUrl.searchParams.set('source', 'rqmd')
  targetUrl.searchParams.set('context_transport', 'window.name')
  targetUrl.searchParams.set('context_type', 'implementation-context')
  targetUrl.searchParams.set('session_id', payload.session_id)

  window.name = JSON.stringify(payload)
  window.location.assign(targetUrl.toString())
}

async function openGoCoding() {
  if (
    !sessionId.value ||
    openingGoCoding.value ||
    generatingDocuments.value ||
    messagePipelineActive.value ||
    switchingSession.value ||
    !latestPrdDocument.value ||
    !latestDesignDocument.value
  ) {
    return
  }

  clearError()
  openingGoCoding.value = true

  try {
    const payload = await apiJson<ImplementationContextResponse>(
      `/api/sessions/${sessionId.value}/implementation-context?language=${encodeURIComponent(currentLanguage.value)}`,
    )
    redirectToGoCoding(payload)
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToOpenGoCoding)
  } finally {
    openingGoCoding.value = false
  }
}

async function loadSessions() {
  const data = await apiJson<{ sessions: SessionSummary[] }>('/api/sessions')
  sessions.value = (data.sessions ?? []).map((item) => ({
    ...item,
    prompt_template: normalizePromptTemplate(item.prompt_template),
    applied_template_id: item.applied_template_id || '',
    applied_template_name: item.applied_template_name || '',
  }))
}

async function loadBusinessTemplates() {
  const data = await apiJson<{ templates: BusinessTemplateSummary[] }>('/api/templates')
  businessTemplates.value = data.templates ?? []
}

async function ensureBusinessTemplateDetail(templateId: string): Promise<BusinessTemplateDetail> {
  const cached = businessTemplateDetails.value[templateId]
  if (cached) {
    return cached
  }

  const detail = await apiJson<BusinessTemplateDetail>(`/api/templates/${templateId}`)
  businessTemplateDetails.value = {
    ...businessTemplateDetails.value,
    [templateId]: detail,
  }
  return detail
}

function buildDocumentGenerationConfirmMessage(): string {
  const progress = structuredRequirementProgress.value
  if (currentLanguage.value === 'zh') {
    return `当前收集覆盖率为 ${progress.collectionCoveragePercentage}%，确认完成度为 ${progress.confirmationPercentage}%，生成的文档会带较多假设，是否继续？`
  }
  if (currentLanguage.value === 'de') {
    return `Die Erfassungsquote liegt bei ${progress.collectionCoveragePercentage}% und der Bestaetigungsstand bei ${progress.confirmationPercentage}%. Die erzeugten Dokumente werden mehr Annahmen enthalten. Trotzdem fortfahren?`
  }
  if (currentLanguage.value === 'ms') {
    return `Liputan kutipan kini ${progress.collectionCoveragePercentage}% dan kemajuan pengesahan ${progress.confirmationPercentage}%. Dokumen yang dijana akan mengandungi lebih banyak andaian. Teruskan?`
  }
  return `Collection coverage is ${progress.collectionCoveragePercentage}% and confirmation progress is ${progress.confirmationPercentage}%. The generated documents will contain more assumptions. Continue anyway?`
}

async function loadStructuredRequirement(
  targetSessionId: string,
  options: { background?: boolean } = {},
) {
  if (!targetSessionId) {
    resetStructuredRequirementState()
    return
  }

  const requestToken = ++structuredRequirementRequestToken
  structuredRequirementError.value = ''
  const useBackgroundSync =
    Boolean(options.background) || hasStructuredRequirementContent(structuredRequirementModel.value)

  if (useBackgroundSync) {
    beginStructuredRequirementSync()
  } else {
    loadingStructuredRequirement.value = true
  }

  try {
    const data = await apiJson<StructuredRequirementResponse>(
      `/api/sessions/${targetSessionId}/structured-requirement?language=${encodeURIComponent(currentLanguage.value)}`,
    )
    if (requestToken !== structuredRequirementRequestToken || sessionId.value !== targetSessionId) {
      return
    }
    applyStructuredRequirementPayload(data)
  } catch (error) {
    if (requestToken !== structuredRequirementRequestToken || sessionId.value !== targetSessionId) {
      return
    }
    structuredRequirementError.value = formatError(error, t.value.requestFailed)
    if (!useBackgroundSync) {
      structuredRequirementModel.value = createEmptyStructuredRequirementModel()
    }
  } finally {
    if (useBackgroundSync) {
      endStructuredRequirementSync()
    } else if (requestToken === structuredRequirementRequestToken && sessionId.value === targetSessionId) {
      loadingStructuredRequirement.value = false
    }
  }
}

async function loadSession(targetSessionId: string) {
  if (!targetSessionId) {
    return
  }

  clearError()
  switchingSession.value = true

  try {
    const data = await apiJson<SessionDetail>(
      `/api/sessions/${targetSessionId}?language=${encodeURIComponent(currentLanguage.value)}`,
    )
    sessionId.value = data.session_id
    sessionPromptTemplate.value = normalizePromptTemplate(data.prompt_template)
    messages.value = normalizeMessages(data.messages ?? [])
    structuredRequirementError.value = ''
    applyStructuredRequirementPayload(data)
    if (shouldRefreshStructuredRequirement(data.structured_requirement_sync_status)) {
      void loadStructuredRequirement(
        data.session_id,
        { background: hasStructuredRequirementContent(structuredRequirementModel.value) },
      )
    } else {
      loadingStructuredRequirement.value = false
    }
    await nextTick()
    scrollToBottom()
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToLoadSession)
  } finally {
    switchingSession.value = false
  }
}

async function createSession(options: { templateId?: string } = {}) {
  if (messagePipelineActive.value || generatingDocuments.value || loadingSession.value) {
    return
  }

  clearError()
  loadingSession.value = true

  try {
    const data = await apiJson<SessionDetail>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(options.templateId ? { template_id: options.templateId } : {}),
    })

    sessionId.value = data.session_id
    sessionPromptTemplate.value = normalizePromptTemplate(data.prompt_template)
    messages.value = normalizeMessages(data.messages ?? [])
    resetStructuredRequirementState()
    applyStructuredRequirementPayload(data)
    await loadSessions()
    await nextTick()
    scrollToBottom()
    return data
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToCreate)
    return null
  } finally {
    loadingSession.value = false
  }
}

async function bootstrapSessions() {
  clearError()
  loadingHistory.value = true

  try {
    await loadSessions()
    if (sessions.value.length > 0) {
      await loadSession(sessions.value[0].session_id)
    } else {
      await createSession()
    }
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToLoadHistory)
  } finally {
    loadingHistory.value = false
  }
}

async function refreshHistory() {
  try {
    await loadSessions()
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToLoadHistory)
  }
}

async function openBusinessTemplate(templateId: string) {
  if (
    !templateId ||
    loadingSession.value ||
    switchingSession.value ||
    deletingSessionId.value ||
    messagePipelineActive.value ||
    generatingDocuments.value
  ) {
    return
  }

  selectedBusinessTemplateId.value = templateId
  templateDialogOpen.value = true
  templateDialogError.value = ''
  loadingTemplateDetail.value = true

  try {
    await ensureBusinessTemplateDetail(templateId)
  } catch (error) {
    templateDialogError.value = formatError(error, t.value.failedToLoadTemplates)
  } finally {
    loadingTemplateDetail.value = false
  }
}

function closeBusinessTemplateDialog() {
  templateDialogOpen.value = false
  loadingTemplateDetail.value = false
  templateDialogError.value = ''
  selectedBusinessTemplateId.value = ''
}

async function applyBusinessTemplate() {
  const detail = selectedBusinessTemplate.value
  if (
    !detail ||
    applyingTemplateId.value ||
    loadingSession.value ||
    switchingSession.value ||
    deletingSessionId.value ||
    messagePipelineActive.value ||
    generatingDocuments.value
  ) {
    return
  }

  applyingTemplateId.value = detail.template_id
  templateDialogError.value = ''

  try {
    const created = await createSession({ templateId: detail.template_id })
    if (created) {
      closeBusinessTemplateDialog()
    }
  } catch (error) {
    templateDialogError.value = formatError(error, t.value.failedToCreate)
  } finally {
    applyingTemplateId.value = ''
  }
}

async function updatePromptTemplate(template: PromptTemplate) {
  if (!sessionId.value || !canChangePromptTemplate.value || sessionPromptTemplate.value === template) {
    return
  }

  clearError()

  try {
    const data = await apiJson<SessionDetail>(`/api/sessions/${sessionId.value}/prompt-template`, {
      method: 'POST',
      body: JSON.stringify({ prompt_template: template }),
    })

    const normalizedTemplate = normalizePromptTemplate(data.prompt_template)
    sessionPromptTemplate.value = normalizedTemplate
    sessions.value = sessions.value.map((item) =>
      item.session_id === data.session_id
        ? { ...item, prompt_template: normalizedTemplate }
        : item,
    )
  } catch (error) {
    globalError.value = formatError(error, t.value.requestFailed)
  }
}

async function selectSession(targetSessionId: string) {
  if (
    !targetSessionId ||
    targetSessionId === sessionId.value ||
    messagePipelineActive.value ||
    generatingDocuments.value ||
    loadingSession.value ||
    deletingSessionId.value
  ) {
    return
  }
  await loadSession(targetSessionId)
}

async function deleteSession(targetSessionId: string) {
  if (!targetSessionId || !canMutateHistory() || deletingSessionId.value) {
    return
  }

  const confirmed = window.confirm(t.value.deleteSessionConfirm)
  if (!confirmed) {
    return
  }

  clearError()
  deletingSessionId.value = targetSessionId

  try {
    await apiJson<Record<string, never>>(`/api/sessions/${targetSessionId}`, {
      method: 'DELETE',
    })

    const remainingSessions = sessions.value.filter((item) => item.session_id !== targetSessionId)
    sessions.value = remainingSessions

    if (sessionId.value !== targetSessionId) {
      return
    }

    if (remainingSessions.length > 0) {
      await loadSession(remainingSessions[0].session_id)
      return
    }

    sessionId.value = ''
    sessionPromptTemplate.value = 'personal_project'
    messages.value = []
    resetStructuredRequirementState()
    await createSession()
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToDeleteSession)
  } finally {
    deletingSessionId.value = ''
  }
}

function parseSseEvent(eventBlock: string): { event: string; data: string } {
  const lines = eventBlock.split(/\r?\n/)
  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  return { event: eventName, data: dataLines.join('\n') }
}

function splitSseBlocks(rawBuffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = []
  const separator = /(?:\r?\n){2}/g
  let lastIndex = 0
  let match: RegExpExecArray | null = separator.exec(rawBuffer)

  while (match) {
    const block = rawBuffer.slice(lastIndex, match.index)
    if (block.trim()) {
      blocks.push(block)
    }
    lastIndex = separator.lastIndex
    match = separator.exec(rawBuffer)
  }

  return {
    blocks,
    rest: rawBuffer.slice(lastIndex),
  }
}

function createSmoothWriter(target: ChatMessage) {
  return {
    push(chunk: string) {
      if (!chunk) {
        return
      }
      target.content += chunk
      scrollToBottom()
    },
    async finish() {
      scrollToBottom()
    },
  }
}

async function sendMessageStream(
  session: string,
  message: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
  pipelineState?: { replyReleased: boolean; syncStarted: boolean },
) {
  const response = await fetch(apiUrl(`/api/sessions/${session}/messages/stream`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, language }),
  })

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}))
    throw new Error(typeof errorJson?.error === 'string' ? errorJson.error : `Request failed: ${response.status}`)
  }

  if (!response.body) {
    throw new Error(t.value.browserNotSupport)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const writer = createSmoothWriter(assistantMessage)

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const extracted = splitSseBlocks(buffer)
    const chunks = extracted.blocks
    buffer = extracted.rest

    for (const chunk of chunks) {
      const parsed = parseSseEvent(chunk)
      let payload: any = {}
      try {
        payload = parsed.data ? JSON.parse(parsed.data) : {}
      } catch {
        payload = {}
      }

      if (parsed.event === 'error') {
        throw new Error(payload.error || t.value.streamingError)
      }

      if (parsed.event === 'content' && typeof payload.delta === 'string') {
        writer.push(payload.delta)
      }

      if (parsed.event === 'thinking' && typeof payload.delta === 'string') {
        assistantMessage.thinking = (assistantMessage.thinking || '') + payload.delta
        scrollToBottom()
      }

      if (parsed.event === 'thinking_done' && typeof payload.thinking === 'string') {
        assistantMessage.thinking = payload.thinking
        scrollToBottom()
      }

      if (parsed.event === 'assistant_done') {
        if (pipelineState) {
          releaseMessageReplyPhase(pipelineState)
          startMessageSyncPhase(pipelineState)
        }
      }

      if (parsed.event === 'summary') {
        applyStructuredRequirementPayload(payload)
        if (pipelineState) {
          finishMessageSyncPhase(pipelineState)
        }
      }
    }
  }

  await writer.finish()
}

async function sendMessageFallback(
  session: string,
  message: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  const data = await apiJson<MessageResponse>(`/api/sessions/${session}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message, language }),
  })

  const parsed = parseThinkContent(data.assistant_message || '')
  assistantMessage.content = parsed.content
  assistantMessage.thinking = data.assistant_thinking || parsed.thinking
  applyStructuredRequirementPayload(data)
}

function documentKindFromType(documentType?: string): ChatMessage['kind'] {
  if (documentType === 'prd_markdown') {
    return 'prd_doc'
  }
  if (documentType === 'system_design_markdown') {
    return 'design_doc'
  }
  return 'chat'
}

function applyGeneratedDocumentResponse(
  assistantMessage: ChatMessage,
  payload: Partial<GeneratedDocumentResponse>,
) {
  if (typeof payload.document_markdown === 'string') {
    assistantMessage.content = payload.document_markdown
  }

  const resolvedKind = documentKindFromType(payload.document_type)
  assistantMessage.kind = resolvedKind === 'chat' ? assistantMessage.kind || 'chat' : resolvedKind
  assistantMessage.downloadUrl = payload.download_url
  assistantMessage.downloadFilename = payload.filename
  assistantMessage.createdAt = payload.saved_at || assistantMessage.createdAt
  applyStructuredRequirementPayload(payload)
}

function finalizeGeneratedDocumentContent(assistantMessage: ChatMessage) {
  const parsed = parseThinkContent(assistantMessage.content)
  assistantMessage.content = parsed.content
  assistantMessage.thinking = [assistantMessage.thinking || '', parsed.thinking].filter(Boolean).join('\n\n')
}

function createGeneratedDocumentMessage(kind: NonNullable<ChatMessage['kind']>): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    thinking: '',
    createdAt: new Date().toISOString(),
    kind,
  }
}

async function sendDocumentStream(
  session: string,
  endpoint: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  const response = await fetch(apiUrl(`/api/sessions/${session}/${endpoint}/stream`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ language }),
  })

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}))
    throw new Error(typeof errorJson?.error === 'string' ? errorJson.error : `Request failed: ${response.status}`)
  }

  if (!response.body) {
    throw new Error(t.value.browserNotSupport)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const writer = createSmoothWriter(assistantMessage)

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const extracted = splitSseBlocks(buffer)
    const chunks = extracted.blocks
    buffer = extracted.rest

    for (const chunk of chunks) {
      const parsed = parseSseEvent(chunk)
      let payload: any = {}
      try {
        payload = parsed.data ? JSON.parse(parsed.data) : {}
      } catch {
        payload = {}
      }

      if (parsed.event === 'error') {
        throw new Error(payload.error || t.value.streamingError)
      }

      if (parsed.event === 'content' && typeof payload.delta === 'string') {
        writer.push(payload.delta)
      }

      if (parsed.event === 'thinking' && typeof payload.delta === 'string') {
        assistantMessage.thinking = (assistantMessage.thinking || '') + payload.delta
        scrollToBottom()
      }

      if (parsed.event === 'thinking_done' && typeof payload.thinking === 'string') {
        assistantMessage.thinking = payload.thinking
        scrollToBottom()
      }

      if (parsed.event === 'done') {
        applyGeneratedDocumentResponse(assistantMessage, payload)
      }
    }
  }

  await writer.finish()
}

async function sendDocumentFallback(
  session: string,
  endpoint: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  const data = await apiJson<GeneratedDocumentResponse>(`/api/sessions/${session}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({ language }),
  })

  applyGeneratedDocumentResponse(assistantMessage, data)
}

async function sendPrdDocStream(
  session: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  await sendDocumentStream(session, 'prd-doc', assistantMessage, language)
}

async function sendPrdDocFallback(
  session: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  await sendDocumentFallback(session, 'prd-doc', assistantMessage, language)
}

async function sendDesignDocStream(
  session: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  await sendDocumentStream(session, 'design-doc', assistantMessage, language)
}

async function sendDesignDocFallback(
  session: string,
  assistantMessage: ChatMessage,
  language: LanguageCode = 'zh',
) {
  await sendDocumentFallback(session, 'design-doc', assistantMessage, language)
}

function scrollToBottom() {
  setTimeout(() => {
    if (chatList.value) {
      chatList.value.scrollTop = chatList.value.scrollHeight
    }
  }, 100)
}

function autoResizeTextarea() {
  const textarea = textareaRef.value
  if (textarea) {
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px'
  }
}

async function insertLineBreak(event: KeyboardEvent) {
  event.preventDefault()
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) {
    return
  }

  const start = target.selectionStart
  const end = target.selectionEnd
  inputText.value = `${inputText.value.slice(0, start)}\n${inputText.value.slice(end)}`

  await nextTick()
  if (textareaRef.value) {
    textareaRef.value.selectionStart = start + 1
    textareaRef.value.selectionEnd = start + 1
  }
  autoResizeTextarea()
}

async function sendMessage() {
  const message = inputText.value.trim()
  if (!message || sending.value || generatingDocuments.value || switchingSession.value) {
    return
  }

  if (!hasSession.value) {
    await createSession()
    if (!hasSession.value) {
      return
    }
  }

  clearError()
  const pipelineState = createMessagePipelineState()

  const userChatMessage: ChatMessage = {
    role: 'user',
    content: message,
    createdAt: new Date().toISOString(),
  }
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: '',
    thinking: '',
    createdAt: new Date().toISOString(),
  }
  messages.value.push(userChatMessage)
  messages.value.push(assistantMessage)
  inputText.value = ''
  autoResizeTextarea()
  scrollToBottom()

  try {
    await sendMessageStream(sessionId.value, message, assistantMessage, currentLanguage.value, pipelineState)
    const streamParsed = parseThinkContent(assistantMessage.content)
    assistantMessage.content = streamParsed.content
    assistantMessage.thinking = [assistantMessage.thinking || '', streamParsed.thinking].filter(Boolean).join('\n\n')

    if (!assistantMessage.content.trim()) {
      await sendMessageFallback(sessionId.value, message, assistantMessage, currentLanguage.value)
    }

    await refreshHistory()
  } catch (error) {
    messages.value = messages.value.filter(
      (item) => item !== userChatMessage && item !== assistantMessage,
    )
    globalError.value = formatError(error, t.value.failedToSend)
  } finally {
    completeMessagePipeline(pipelineState)
    scrollToBottom()
  }
}

async function generateDocuments() {
  if (!hasSession.value || generatingDocuments.value || messagePipelineActive.value || switchingSession.value) {
    return
  }

  if (!structuredRequirementProgress.value.readyToGenerate) {
    const confirmed = window.confirm(buildDocumentGenerationConfirmMessage())
    if (!confirmed) {
      return
    }
  }

  clearError()
  generatingDocuments.value = true
  let shouldRefreshHistory = false

  try {
    const prdMessage = createGeneratedDocumentMessage('prd_doc')
    messages.value.push(prdMessage)
    scrollToBottom()

    await sendPrdDocStream(sessionId.value, prdMessage, currentLanguage.value)
    finalizeGeneratedDocumentContent(prdMessage)
    if (!prdMessage.content.trim()) {
      await sendPrdDocFallback(sessionId.value, prdMessage, currentLanguage.value)
      finalizeGeneratedDocumentContent(prdMessage)
    }
    shouldRefreshHistory = true

    const designMessage = createGeneratedDocumentMessage('design_doc')
    messages.value.push(designMessage)
    scrollToBottom()

    await sendDesignDocStream(sessionId.value, designMessage, currentLanguage.value)
    finalizeGeneratedDocumentContent(designMessage)
    if (!designMessage.content.trim()) {
      await sendDesignDocFallback(sessionId.value, designMessage, currentLanguage.value)
      finalizeGeneratedDocumentContent(designMessage)
    }
    shouldRefreshHistory = true
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToGenerate)
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      messages.value.pop()
    }
  } finally {
    if (shouldRefreshHistory) {
      await refreshHistory()
    }
    generatingDocuments.value = false
    scrollToBottom()
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    audioBuffer.value = []

    audioContext.value = new AudioContext({ sampleRate: 16000 })
    const source = audioContext.value.createMediaStreamSource(stream)
    const processor = audioContext.value.createScriptProcessor(4096, 1, 1)

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0)
      audioBuffer.value.push(new Float32Array(inputData))
    }

    source.connect(processor)
    processor.connect(audioContext.value.destination)

    scriptProcessor.value = processor
    recording.value = true
  } catch (error) {
    console.error('Error starting recording:', error)
    globalError.value = t.value.microphoneAccessError
  }
}

function stopRecording() {
  if (audioContext.value && scriptProcessor.value) {
    scriptProcessor.value.disconnect()

    if (audioContext.value.state !== 'closed') {
      audioContext.value.close()
    }

    const totalLength = audioBuffer.value.reduce((acc, chunk) => acc + chunk.length, 0)
    const result = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of audioBuffer.value) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    const pcmData = new Int16Array(result.length)
    for (let i = 0; i < result.length; i++) {
      pcmData[i] = Math.max(-32768, Math.min(32767, result[i] * 32767))
    }

    const wavData = createWavHeader(pcmData.buffer)

    const formData = new FormData()
    const audioBlob = new Blob([wavData], { type: 'audio/wav' })
    formData.append('audio', audioBlob, 'recording.wav')

    fetch(apiUrl('/api/asr/recognize'), {
      method: 'POST',
      body: formData,
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.text) {
          inputText.value = data.text
          sendMessage()
        } else if (data.error) {
          globalError.value = data.error
        }
      })
      .catch((error) => {
        console.error('Error recognizing speech:', error)
        globalError.value = t.value.speechRecognitionError
      })

    recording.value = false
  }
}

function createWavHeader(pcmData: ArrayBuffer) {
  const dataLength = pcmData.byteLength
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, 'WAVE')

  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  writeString(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  const pcmArray = new Int16Array(pcmData)
  const dataView = new DataView(buffer, 44)
  for (let i = 0; i < pcmArray.length; i++) {
    dataView.setInt16(i * 2, pcmArray[i], true)
  }

  return buffer
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

onMounted(async () => {
  loadingTemplates.value = true
  try {
    await loadBusinessTemplates()
  } catch (error) {
    globalError.value = formatError(error, t.value.failedToLoadTemplates)
  } finally {
    loadingTemplates.value = false
  }
  await bootstrapSessions()
})

watch(currentLanguage, (language, previousLanguage) => {
  if (!sessionId.value || language === previousLanguage) {
    return
  }
  void loadStructuredRequirement(
    sessionId.value,
    { background: hasStructuredRequirementContent(structuredRequirementModel.value) },
  )
})
</script>

<template>
  <div class="app-shell">
    <div v-if="globalError" class="error-banner" @click="clearError">
      <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ globalError }}</span>
      <button class="close-btn" :aria-label="t.close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <main class="layout" :class="{ 'sidebar-collapsed': sidebarCollapsed, 'layout-empty-chat': !messages.length }">
      <aside class="panel sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="sidebar-header">
          <div class="sidebar-hero">
            <div class="sidebar-brand">
              <div class="sidebar-brand-lockup">
                <div class="sidebar-brand-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="5" y="7" width="14" height="10" rx="2.4"/>
                    <path d="M12 4v3"/>
                    <path d="M8 17v2"/>
                    <path d="M16 17v2"/>
                    <path d="M3 11h2"/>
                    <path d="M19 11h2"/>
                    <path d="M9.25 11h.01"/>
                    <path d="M14.75 11h.01"/>
                  </svg>
                </div>
                <div class="sidebar-brand-copy">
                  <h1>{{ t.title }}</h1>
                  <p class="hero-subtitle">{{ t.subtitle }}</p>
                </div>
              </div>
              <button
                class="sidebar-toggle"
                type="button"
                :title="sidebarToggleAriaLabel"
                :aria-label="sidebarToggleAriaLabel"
                :aria-expanded="!sidebarCollapsed"
                @click="toggleSidebar"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline v-if="!sidebarCollapsed" points="15 18 9 12 15 6"/>
                  <polyline v-else points="9 18 15 12 9 6"/>
                </svg>
              </button>
            </div>
            <div class="language-card">
              <div class="language-card-header">
                <svg class="language-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 5h7"/>
                  <path d="M7.5 5c0 7.5-3 11.5-5.5 13"/>
                  <path d="M4.5 11c1.1 1.3 2.5 2.5 4.1 3.4"/>
                  <path d="M13 7h7"/>
                  <path d="M16.5 7c0 5.3 2.1 9 4.5 11"/>
                  <path d="M12.8 14h7.4"/>
                </svg>
                <h2>{{ t.languageSection }}</h2>
              </div>
              <div class="language-grid">
                <button
                  v-for="option in languageOptions"
                  :key="option.code"
                  class="language-chip"
                  type="button"
                  :class="{ active: currentLanguage === option.code }"
                  :aria-pressed="currentLanguage === option.code"
                  @click="selectLanguage(option.code)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </div>
          <div class="sidebar-history-head">
            <div class="sidebar-copy">
              <h2>{{ t.history }}</h2>
              <p>{{ loadingHistory ? t.historyLoading : `${sessions.length} ${t.sessionsLabel}` }}</p>
            </div>
            <div class="sidebar-section-actions">
              <button
                class="sidebar-section-toggle"
                type="button"
                :title="historyExpanded ? t.historyCollapse : t.historyExpand"
                :aria-label="historyExpanded ? t.historyCollapse : t.historyExpand"
                @click="toggleHistoryExpanded"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline
                    :points="historyExpanded ? '6 15 12 9 18 15' : '6 9 12 15 18 9'"
                  />
                </svg>
              </button>
              <button class="btn btn-primary sidebar-new-chat" type="button" :disabled="loadingSession || sending || generatingDocuments || switchingSession || Boolean(deletingSessionId) || Boolean(applyingTemplateId)" @click="createSession()">
                <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                <span class="sidebar-new-chat-label">{{ loadingSession ? t.creating : t.newChat }}</span>
              </button>
            </div>
          </div>
        </div>

        <div
          v-show="!sidebarCollapsed"
          class="sidebar-body"
          :class="{
            'history-collapsed': !historyExpanded,
            'template-library-collapsed': !templateLibraryExpanded,
            'sidebar-body-fully-collapsed': !historyExpanded && !templateLibraryExpanded,
          }"
        >
          <div v-show="historyExpanded" class="session-history" :class="{ 'empty': !sessions.length }">
            <div v-if="loadingHistory && !sessions.length" class="session-history-placeholder">
              {{ t.historyLoading }}
            </div>

            <template v-else-if="sessions.length">
              <div
                v-for="session in sessions"
                :key="session.session_id"
                class="session-card"
                :class="{ 'active': session.session_id === sessionId }"
              >
                <button
                  class="session-card-main"
                  type="button"
                  :disabled="switchingSession || sending || generatingDocuments || Boolean(deletingSessionId)"
                  @click="selectSession(session.session_id)"
                  >
                    <div class="session-card-top">
                      <span class="session-card-title">{{ sessionTitle(session.title) }}</span>
                      <span class="session-card-time">{{ formatSessionTime(session.updated_at) }}</span>
                    </div>
                    <p class="session-card-preview">{{ sessionPreview(session) }}</p>
                    <p v-if="session.applied_template_name" class="session-card-template">
                      {{ t.templateSessionBadge }} · {{ session.applied_template_name }}
                    </p>
                  </button>

                <button
                  class="session-card-delete"
                  type="button"
                  :title="t.deleteSession"
                  :aria-label="t.deleteSession"
                  :disabled="!canMutateHistory() || deletingSessionId === session.session_id"
                  @click="deleteSession(session.session_id)"
                >
                  <svg class="session-card-delete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </button>
              </div>
            </template>

            <div v-else class="session-history-placeholder">
              {{ t.historyEmpty }}
            </div>
          </div>

          <div class="template-library">
            <div class="template-library-head">
              <div class="sidebar-copy">
                <h2>{{ t.templateLibrary }}</h2>
                <p>{{ loadingTemplates ? t.templateLibraryLoading : `${businessTemplates.length} ${t.templatesLabel}` }}</p>
              </div>
              <div class="sidebar-section-actions">
                <button
                  class="sidebar-section-toggle"
                  type="button"
                  :title="templateLibraryExpanded ? t.templateLibraryCollapse : t.templateLibraryExpand"
                  :aria-label="templateLibraryExpanded ? t.templateLibraryCollapse : t.templateLibraryExpand"
                  @click="toggleTemplateLibraryExpanded"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline
                      :points="templateLibraryExpanded ? '6 15 12 9 18 15' : '6 9 12 15 18 9'"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div v-show="templateLibraryExpanded" class="template-library-body">
              <div v-if="loadingTemplates && !businessTemplates.length" class="session-history-placeholder">
                {{ t.templateLibraryLoading }}
              </div>

              <div v-else-if="businessTemplates.length" class="template-library-list">
                <button
                  v-for="templateItem in businessTemplates"
                  :key="templateItem.template_id"
                  class="template-library-item"
                  type="button"
                  :disabled="loadingSession || messagePipelineActive || generatingDocuments || Boolean(applyingTemplateId)"
                  @click="openBusinessTemplate(templateItem.template_id)"
                >
                  <div class="template-library-item-main">
                    <div class="template-library-item-top">
                      <span class="template-library-item-title">{{ templateItem.template_name }}</span>
                      <span class="template-library-item-count">
                        {{ templateItem.section_count }} {{ t.templateSectionsShort }}
                      </span>
                    </div>
                    <p class="template-library-item-meta">
                      {{ formatTemplateFacet(templateItem.business_domain || templateItem.template_category) }}
                      <span v-if="templateItem.version"> · v{{ templateItem.version }}</span>
                    </p>
                  </div>
                  <span class="template-library-item-arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </span>
                </button>
              </div>

              <div v-else class="session-history-placeholder">
                {{ t.templateLibraryEmpty }}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section class="panel chat-panel" :class="{ 'chat-panel-empty': !messages.length }">
        <div class="chat-workspace">
          <div class="workspace-stack">
            <div class="chat-main" :class="{ 'chat-main-empty': !messages.length }">
              <div class="chat-primary-stage">
                <div class="panel-header chat-main-header">
                  <div class="panel-title">
                    <h2>{{ activeSessionTitle || t.conversation }}</h2>
                    <span class="message-count">{{ messages.length }} {{ t.messagesLabel }}</span>
                    <span v-if="activeBusinessTemplateName" class="message-count message-count-template">
                      {{ activeBusinessTemplateName }}
                    </span>
                  </div>
                  <div v-if="hasSession" class="template-picker">
                    <div class="template-picker-options">
                      <button
                        v-for="option in promptTemplateOptions"
                        :key="option.value"
                        class="template-chip"
                        :class="{ active: sessionPromptTemplate === option.value }"
                        type="button"
                        :disabled="!canChangePromptTemplate"
                        @click="updatePromptTemplate(option.value)"
                      >
                        {{ option.label }}
                      </button>
                    </div>
                    <p v-if="templateDrivenSession" class="template-picker-hint">
                      {{ t.templatePromptManagedHint }}
                    </p>
                  </div>
                </div>

                <div class="chat-list" ref="chatList" :class="{ 'empty': !messages.length }">
                  <div
                    v-for="(msg, idx) in messages"
                    :key="`${msg.role}-${idx}`"
                    class="bubble"
                    :class="[msg.role, { 'design-doc-bubble': isGeneratedDocumentMessage(msg) }]"
                  >
                    <div class="message-header">
                      <span class="role">{{ msg.role === 'user' ? t.you : t.pmAssistant }}</span>
                      <span class="timestamp">{{ formatMessageTime(msg.createdAt) }}</span>
                    </div>
                    <details v-if="msg.role === 'assistant' && msg.thinking" class="think-box" :open="!msg.content">
                      <summary class="think-box-summary">
                        <svg class="think-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="12" cy="12" r="10"/>
                          <path d="M12 16v-4"/>
                          <path d="M12 8h.01"/>
                        </svg>
                        {{ t.viewReasoning }}
                      </summary>
                      <pre class="think-content">{{ msg.thinking }}</pre>
                    </details>

                    <div v-if="(sending || generatingDocuments) && msg.role === 'assistant' && !msg.content" class="typing-indicator">
                      <div class="typing-dot"></div>
                      <div class="typing-dot"></div>
                      <div class="typing-dot"></div>
                    </div>
                    <div v-else-if="isGeneratedDocumentMessage(msg)" class="design-doc-card">
                      <div class="design-doc-toolbar">
                        <span class="design-doc-badge">{{ documentBadgeLabel(msg) }}</span>
                      </div>
                      <pre class="content design-doc-content">{{ msg.content }}</pre>
                      <div v-if="msg.downloadUrl" class="design-doc-footer">
                        <button
                          class="btn btn-secondary design-doc-download"
                          type="button"
                          @click="triggerDocumentDownload(msg.downloadUrl, msg.downloadFilename)"
                        >
                          <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 3v12"/>
                            <path d="M7 10l5 5 5-5"/>
                            <path d="M5 21h14"/>
                          </svg>
                          {{ t.downloadMarkdown }}
                        </button>
                      </div>
                    </div>
                    <p v-else class="content">{{ msg.content }}</p>
                  </div>

                  <div v-if="!messages.length" class="empty-state">
                    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <h3>{{ t.startConversation }}</h3>
                    <p>{{ t.startConversationDesc }}</p>
                  </div>
                </div>

                <form class="composer" @submit.prevent="sendMessage">
                  <div class="composer-input-wrapper">
                    <textarea
                      v-model="inputText"
                      rows="1"
                      :placeholder="t.describeRequirements"
                      :disabled="sending || generatingDocuments || switchingSession"
                      class="composer-input"
                      @keydown.enter.exact.prevent="sendMessage"
                      @keydown.enter.shift.prevent="insertLineBreak"
                      @input="autoResizeTextarea"
                      ref="textareaRef"
                    />
                    <div class="composer-actions">
                      <button
                        class="btn btn-icon"
                        type="button"
                        :class="{ 'recording': recording }"
                        @click="recording ? stopRecording() : startRecording()"
                        :title="recording ? t.stopRecording : t.startRecording"
                        :disabled="sending || generatingDocuments || switchingSession"
                      >
                        <svg v-if="!recording" class="icon-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                          <line x1="12" y1="19" x2="12" y2="23"/>
                          <line x1="8" y1="23" x2="16" y2="23"/>
                        </svg>
                        <svg v-else class="icon-stop" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2"/>
                        </svg>
                      </button>
                      <button class="btn btn-primary" type="submit" :disabled="!inputText.trim() || sending || generatingDocuments || switchingSession">
                        <svg v-if="!sending" class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="22" y1="2" x2="11" y2="13"/>
                          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                        {{ sending ? t.sending : t.send }}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>

            <div class="chat-preview-stage">
              <RequirementMarkdownPreview
                :language="currentLanguage"
                :model="structuredRequirementModel"
                :loading="loadingStructuredRequirement"
                :syncing="syncingStructuredRequirement"
                :error="structuredRequirementError"
              />
            </div>
          </div>
        </div>
      </section>

      <aside class="workspace-side">
        <div class="workspace-requirement-stage">
          <StructuredRequirementPanel
            :language="currentLanguage"
            :model="structuredRequirementModel"
            :loading="loadingStructuredRequirement"
            :syncing="syncingStructuredRequirement"
            :generating-documents="generatingDocuments"
            :opening-go-coding="openingGoCoding"
            :generation-disabled="messagePipelineActive || switchingSession || !hasSession"
            :has-prd-document="Boolean(latestPrdDocument)"
            :has-design-document="Boolean(latestDesignDocument)"
            :error="structuredRequirementError"
            @generate-documents="generateDocuments"
            @download-document="downloadLatestGeneratedDocument"
            @go-coding="openGoCoding"
          />
        </div>
      </aside>
    </main>

    <div v-if="templateDialogOpen" class="template-dialog-backdrop" @click.self="closeBusinessTemplateDialog">
      <div class="template-dialog" role="dialog" aria-modal="true" :aria-label="t.templateDetail">
        <div class="template-dialog-head">
          <div>
            <p class="template-dialog-eyebrow">{{ t.templateLibrary }}</p>
            <h3>{{ selectedBusinessTemplate?.template_name || t.templateDetail }}</h3>
          </div>
          <button class="template-dialog-close" type="button" :aria-label="t.close" @click="closeBusinessTemplateDialog">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div v-if="loadingTemplateDetail" class="template-dialog-state">
          {{ t.templateLibraryLoading }}
        </div>
        <div v-else-if="templateDialogError" class="template-dialog-state error">
          {{ templateDialogError }}
        </div>
        <div v-else-if="selectedBusinessTemplate" class="template-dialog-body">
          <p class="template-dialog-description">{{ selectedBusinessTemplate.description }}</p>

          <div v-if="selectedBusinessTemplate.tags.length" class="template-dialog-block">
            <h4>{{ t.templateTags }}</h4>
            <div class="template-dialog-tags">
              <span v-for="tag in selectedBusinessTemplate.tags" :key="tag" class="template-dialog-tag">{{ tag }}</span>
            </div>
          </div>

          <div v-if="selectedBusinessTemplate.applicable_scenarios.length" class="template-dialog-block">
            <h4>{{ t.templateScenarios }}</h4>
            <ul class="template-dialog-list">
              <li v-for="scenario in selectedBusinessTemplate.applicable_scenarios" :key="scenario">{{ scenario }}</li>
            </ul>
          </div>

          <div v-if="selectedBusinessTemplate.sections.length" class="template-dialog-block">
            <h4>{{ t.templateSections }}</h4>
            <ul class="template-dialog-list">
              <li v-for="section in selectedBusinessTemplate.sections" :key="section.section_key">
                <strong>{{ section.section_title }}</strong>
                <span class="template-dialog-field-count">{{ section.field_count }} {{ t.templateFieldCount }}</span>
              </li>
            </ul>
          </div>

          <div class="template-dialog-note">
            <p>{{ t.templateApplyHint }}</p>
            <p>{{ t.templatePromptManagedHint }}</p>
          </div>
        </div>

        <div class="template-dialog-actions">
          <button class="btn btn-secondary" type="button" :disabled="Boolean(applyingTemplateId)" @click="closeBusinessTemplateDialog">
            {{ t.templateCancel }}
          </button>
          <button class="btn btn-primary" type="button" :disabled="loadingTemplateDetail || Boolean(applyingTemplateId) || !selectedBusinessTemplate" @click="applyBusinessTemplate">
            {{ applyingTemplateId ? t.creating : t.templateApply }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  --bg-0: #f4f7f0;
  --bg-1: #fdfcf9;
  --ink: #172422;
  --muted: #50615b;
  --line: #d8e1dc;
  --panel: #ffffff;
  --accent: #0e7c66;
  --accent-strong: #085746;
  --warn: #a32828;
  --radius: 14px;
  --shadow: 0 12px 30px rgba(13, 35, 28, 0.08);
  --font: 'Space Grotesk', 'Noto Sans SC', 'Segoe UI', sans-serif;
  --mono: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;

  font-family: var(--font);
  color: var(--ink);
  background: radial-gradient(circle at 0% 0%, #e7f4ee, var(--bg-0) 45%),
    linear-gradient(180deg, var(--bg-1), var(--bg-0));
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
}

#app {
  min-height: 100vh;
}

input,
textarea,
button {
  font: inherit;
}

.app-shell {
  --shell-padding: clamp(12px, 1.6vw, 18px);
  --workspace-gap: 16px;
  --workspace-column-height: 200dvh;
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--shell-padding);
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto;
  gap: var(--workspace-gap);
  overflow: visible;
}

.topbar,
.header-content,
.header-actions {
  display: none;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid #efb7b7;
  background: #fff1f1;
  color: var(--warn);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.error-banner:hover {
  background: #ffe8e8;
}

.error-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.error-banner span {
  flex: 1;
  font-size: 0.9rem;
}

.close-btn {
  background: none;
  border: none;
  color: var(--warn);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-btn svg {
  width: 16px;
  height: 16px;
}

.layout {
  display: flex;
  gap: var(--workspace-gap);
  min-height: 0;
  overflow: visible;
  align-items: stretch;
}

.layout.layout-empty-chat {
  align-items: stretch;
}

.layout.sidebar-collapsed {
  align-items: stretch;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--shadow);
  min-height: 0;
  overflow: hidden;
}

.sidebar {
  position: relative;
  flex: 1 1 0;
  height: var(--workspace-column-height);
  max-height: none;
  padding: 18px;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 18px;
  transition: padding 0.24s ease;
}

.sidebar.collapsed {
  flex: 0 0 92px;
  padding: 18px 12px;
  grid-template-rows: auto;
}

.sidebar-header {
  display: grid;
  gap: 14px;
}

.sidebar-hero {
  display: grid;
  gap: 18px;
}

.sidebar-brand-lockup {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  min-width: 0;
}

.sidebar-brand-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: #1b2b25;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 14px 24px rgba(27, 43, 37, 0.16);
}

.sidebar-brand-icon svg {
  width: 30px;
  height: 30px;
}

.sidebar-brand {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sidebar-brand-copy {
  min-width: 0;
}

.sidebar-brand-copy h1 {
  margin: 2px 0 0;
  font-size: clamp(1.95rem, 2.2vw, 2.45rem);
  line-height: 1.02;
  font-weight: 700;
  letter-spacing: -0.04em;
}

.hero-subtitle {
  margin: 8px 0 0;
  color: #667871;
  font-size: 0.98rem;
  line-height: 1.35;
}

.language-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #d9e2de;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 18px rgba(13, 35, 28, 0.05);
}

.language-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.language-card-header h2 {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
}

.language-card-icon {
  width: 18px;
  height: 18px;
  color: #2c3b36;
  flex-shrink: 0;
}

.language-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.language-chip {
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid #d6dfdb;
  border-radius: 12px;
  background: #fff;
  color: var(--ink);
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.language-chip:hover {
  border-color: #b7c6bf;
  box-shadow: 0 8px 16px rgba(13, 35, 28, 0.08);
  transform: translateY(-1px);
}

.language-chip.active {
  background: #1b2b25;
  border-color: #1b2b25;
  color: #fff;
}

.sidebar-history-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 12px;
  padding: 2px 2px 0;
}

.sidebar-section-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-shrink: 0;
}

.sidebar-copy {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.sidebar-copy h2 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.2;
}

.sidebar-copy p {
  width: fit-content;
  margin: 0;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid #e3ebe7;
  background: #f7fbf9;
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.sidebar-new-chat {
  width: auto;
  min-width: 0;
  justify-content: center;
  padding-inline: 14px;
  border-radius: 14px;
  box-shadow: 0 10px 18px rgba(14, 124, 102, 0.14);
}

.sidebar-section-toggle {
  width: 40px;
  height: 40px;
  border: 1px solid #d9e2de;
  border-radius: 12px;
  background: #fff;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.sidebar-section-toggle:hover {
  border-color: #b8d9cf;
  color: var(--accent);
  background: #eef7f3;
}

.sidebar-section-toggle svg {
  width: 18px;
  height: 18px;
}

.sidebar-new-chat-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-toggle {
  width: 40px;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #f6faf8;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.sidebar-toggle:hover {
  background: #e8f5ee;
  border-color: #b8d9cf;
  color: var(--accent);
  transform: translateY(-1px);
}

.sidebar-toggle svg {
  width: 18px;
  height: 18px;
}

.sidebar.collapsed .sidebar-header {
  justify-items: center;
}

.sidebar.collapsed .sidebar-hero {
  width: 100%;
}

.sidebar.collapsed .sidebar-brand {
  width: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
}

.sidebar.collapsed .sidebar-brand-lockup {
  gap: 0;
  justify-content: center;
}

.sidebar.collapsed .sidebar-brand-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
}

.sidebar.collapsed .sidebar-brand-copy,
.sidebar.collapsed .sidebar-copy,
.sidebar.collapsed .language-card {
  display: none;
}

.sidebar.collapsed .sidebar-history-head {
  width: 100%;
  justify-items: center;
}

.sidebar.collapsed .sidebar-section-toggle {
  display: none;
}

.sidebar.collapsed .sidebar-new-chat {
  width: 48px;
  min-width: 48px;
  height: 48px;
  padding: 0;
}

.sidebar.collapsed .sidebar-new-chat-label {
  display: none;
}

.sidebar-body {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: minmax(260px, 0.96fr) minmax(280px, 1.04fr);
  gap: 16px;
}

.sidebar-body.history-collapsed {
  grid-template-rows: auto minmax(0, 1fr);
}

.sidebar-body.template-library-collapsed {
  grid-template-rows: minmax(0, 1fr) auto;
}

.sidebar-body.history-collapsed.template-library-collapsed,
.sidebar-body.sidebar-body-fully-collapsed {
  grid-template-rows: auto auto;
}

.session-history,
.template-library {
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  scrollbar-width: none;
  scrollbar-color: transparent transparent;
  scrollbar-gutter: stable;
}

.session-history::-webkit-scrollbar,
.template-library::-webkit-scrollbar {
  width: 0;
}

.sidebar:hover .session-history,
.sidebar:hover .template-library {
  scrollbar-width: thin;
  scrollbar-color: rgba(109, 137, 128, 0.82) transparent;
}

.sidebar:hover .session-history::-webkit-scrollbar,
.sidebar:hover .template-library::-webkit-scrollbar {
  width: 6px;
}

.sidebar:hover .session-history::-webkit-scrollbar-track,
.sidebar:hover .template-library::-webkit-scrollbar-track {
  background: transparent;
}

.sidebar:hover .session-history::-webkit-scrollbar-thumb,
.sidebar:hover .template-library::-webkit-scrollbar-thumb {
  background: rgba(109, 137, 128, 0.82);
  border-radius: 999px;
}

.sidebar:hover .session-history::-webkit-scrollbar-thumb:hover,
.sidebar:hover .template-library::-webkit-scrollbar-thumb:hover {
  background: rgba(76, 104, 96, 0.92);
}

.session-history {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 0 0;
  border-top: 1px solid #ecf2ef;
}

.session-history.empty {
  justify-content: center;
}

.session-history-placeholder {
  border: 1px dashed var(--line);
  border-radius: 14px;
  padding: 18px 16px;
  color: var(--muted);
  background: #fcfffd;
  text-align: center;
  font-size: 0.9rem;
}

.session-card {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 0;
  color: var(--ink);
  transition: none;
}

.session-card + .session-card {
  padding-top: 6px;
  border-top: 1px solid #e3ece7;
}

.session-card-main {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 13px 14px;
  border: 1px solid transparent;
  border-radius: 16px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: block;
  position: relative;
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.session-card-main:hover {
  background: #f8fbfa;
  border-color: #d8e5df;
}

.session-card.active .session-card-main {
  background: linear-gradient(180deg, #f5fbf8 0%, #edf7f2 100%);
  border-color: #9fc6b8;
  box-shadow:
    0 0 0 1px rgba(14, 124, 102, 0.1),
    0 10px 18px rgba(14, 124, 102, 0.08);
}

.session-card-main:disabled,
.session-card-delete:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.session-card-top {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}

.session-card-title {
  font-weight: 600;
  font-size: 0.92rem;
  line-height: 1.3;
  color: var(--ink);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.session-card.active .session-card-title {
  color: #0b5c4a;
}

.session-card-time {
  color: var(--muted);
  font-size: 0.75rem;
  white-space: nowrap;
  flex-shrink: 0;
}

.session-card.active .session-card-time {
  color: #356c60;
  font-weight: 600;
}

.session-card-preview {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.session-card.active .session-card-preview {
  color: #4b675f;
}

.session-card-template {
  margin: 8px 0 0;
  color: #2d6a59;
  font-size: 0.74rem;
  font-weight: 700;
}

.session-card-delete {
  width: 32px;
  height: 32px;
  border: 1px solid #e1ebe6;
  border-radius: 10px;
  background: #fff;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
  opacity: 0.8;
  margin-top: 0;
  box-shadow: 0 1px 2px rgba(13, 35, 28, 0.04);
}

.session-card-delete:hover {
  color: var(--warn);
  background: #fff1f1;
  border-color: #efb7b7;
  opacity: 1;
}

.session-card-delete-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.session-card.active .session-card-delete {
  background: #f3fbf7;
  border-color: #cfe1d9;
}

.template-library {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  padding: 14px 0 0;
  border-top: 1px solid #ecf2ef;
  align-content: start;
}

.template-library-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 12px;
  padding: 0 2px 8px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0.94) 84%, rgba(255, 255, 255, 0) 100%);
  backdrop-filter: blur(8px);
}

.template-library-body {
  min-height: 0;
  display: grid;
}

.template-library-list {
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 0;
  padding-bottom: 4px;
}

.template-library-item {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 10px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.template-library-item + .template-library-item {
  border-top: 1px solid #e3ece7;
  border-radius: 0;
}

.template-library-item:hover {
  background: #f8fbfa;
  border-color: #d8e5df;
}

.template-library-item:focus-visible {
  outline: none;
  border-color: #8ec7b5;
  box-shadow: 0 0 0 3px rgba(14, 124, 102, 0.12);
}

.template-library-item:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.template-library-item-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.template-library-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.template-library-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1.3;
  color: var(--ink);
}

.template-library-item-count {
  color: #2d6a59;
  font-size: 0.73rem;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
}

.template-library-item-meta {
  margin: 0;
  color: #5a6d66;
  font-size: 0.76rem;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.template-library-item-arrow {
  color: #6e837b;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.template-library-item:hover .template-library-item-arrow {
  color: #0f715d;
}

.template-library-item-arrow svg {
  width: 16px;
  height: 16px;
}

@media (hover: hover) {
  .session-card-delete {
    opacity: 0;
  }

  .session-card:hover .session-card-delete,
  .session-card.active .session-card-delete,
  .session-card-delete:focus-visible {
    opacity: 1;
  }
}

.chat-panel {
  flex: 2 1 0;
  height: var(--workspace-column-height);
  display: flex;
  padding: 0;
  min-width: 0;
  min-height: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  overflow: visible;
}

.chat-panel.chat-panel-empty {
  min-height: 0;
}

.chat-panel.chat-panel-empty .chat-workspace {
  min-height: 0;
}

.chat-panel .panel-header {
  padding: 14px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow);
  border-bottom: none;
}

.chat-workspace {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  display: block;
  overflow: visible;
}

.workspace-stack {
  flex: 2 1 0;
  height: var(--workspace-column-height);
  min-height: var(--workspace-column-height);
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--workspace-gap);
}

.workspace-stack > * {
  min-height: 0;
}

.chat-main {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.workspace-side {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  min-height: var(--workspace-column-height);
  height: var(--workspace-column-height);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-main.chat-main-empty {
  min-height: 0;
}

.chat-primary-stage {
  min-height: 0;
  flex: 1 1 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 14px;
  padding: 18px;
}

.chat-preview-stage {
  min-height: 0;
  height: 100%;
  padding: 0;
  overflow: hidden;
}

.chat-preview-stage > * {
  min-height: 0;
}

.workspace-requirement-stage {
  min-height: 0;
  height: 100%;
  flex: 1 1 auto;
  display: flex;
  overflow: hidden;
}

.workspace-requirement-stage > * {
  flex: 1 1 auto;
  min-height: 0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.panel-title h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.template-picker {
  display: grid;
  justify-items: end;
  gap: 0;
}

.template-picker-options {
  display: inline-flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.template-picker-hint {
  margin: 8px 0 0;
  max-width: 320px;
  color: var(--muted);
  font-size: 0.74rem;
  line-height: 1.45;
  text-align: right;
}

.template-chip {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 8px 12px;
  background: #f6faf8;
  color: var(--muted);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.template-chip:hover {
  border-color: #b8d9cf;
  color: var(--accent);
}

.template-chip.active {
  background: #e8f5ee;
  border-color: var(--accent);
  color: var(--accent);
}

.template-chip:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.message-count {
  color: var(--muted);
  font-size: 0.86rem;
  background: #f4f7f0;
  padding: 4px 10px;
  border-radius: 12px;
}

.message-count-template {
  background: #eef7f3;
  color: #2d6a59;
  font-weight: 700;
}

.chat-list {
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 16px;
  background: linear-gradient(180deg, #fcfffd 0%, #f6faf8 100%);
  overflow: auto;
  min-height: 0;
  height: auto;
  max-height: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-gutter: stable;
}

.chat-list.empty {
  justify-content: center;
  align-items: center;
  min-height: 0;
}

.bubble {
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 16px 20px;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.bubble:hover {
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
}

.bubble.user {
  background: #e8f5ee;
  border-color: #c7e9dd;
  border-top-right-radius: 6px;
  align-self: flex-end;
  max-width: 85%;
  margin-left: auto;
}

.bubble.assistant {
  background: #f9fbfd;
  border-top-left-radius: 6px;
  align-self: flex-start;
  max-width: 85%;
  margin-right: auto;
}

.bubble.design-doc-bubble {
  width: min(100%, 960px);
  max-width: 100%;
}

.message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 12px;
}

.role {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #31564a;
}

.timestamp {
  font-size: 0.75rem;
  color: var(--muted);
  white-space: nowrap;
}

.content {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.5;
  font-size: 0.95rem;
}

.design-doc-card {
  display: grid;
  gap: 12px;
}

.design-doc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.design-doc-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: #e8f5ee;
  color: #0e7c66;
  font-size: 0.8rem;
  font-weight: 700;
}

.design-doc-download {
  padding: 8px 12px;
}

.design-doc-content {
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #d7e7e1;
  background: #f4faf7;
  font-family: var(--mono);
  line-height: 1.55;
  overflow: auto;
}

.design-doc-footer {
  display: flex;
  justify-content: flex-end;
}

.think-box {
  margin-top: 12px;
  border-top: 1px dashed #bfd2cb;
  padding-top: 12px;
}

.think-box-summary {
  cursor: pointer;
  color: #31564a;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

.think-icon {
  width: 16px;
  height: 16px;
}

.think-content {
  margin: 12px 0 0;
  padding: 12px;
  border-radius: 10px;
  background: #f4faf7;
  border: 1px solid #d7e7e1;
  color: #29443d;
  white-space: pre-wrap;
  font-size: 0.85rem;
  font-family: var(--mono);
  line-height: 1.4;
}

.typing-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
}

.typing-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: typingBounce 1.4s infinite ease-in-out both;
}

.typing-dot:nth-child(1) {
  animation-delay: -0.32s;
}

.typing-dot:nth-child(2) {
  animation-delay: -0.16s;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 18px 12px;
  text-align: center;
  color: var(--muted);
}

.empty-icon {
  width: 64px;
  height: 64px;
  margin-bottom: 14px;
  opacity: 0.5;
}

.empty-state h3 {
  margin: 0 0 8px 0;
  font-size: 1.1rem;
  color: var(--ink);
  font-weight: 600;
}

.empty-state p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  max-width: 400px;
}

.composer {
  padding-top: 4px;
}

.composer-input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.composer-input {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  border: 2px solid var(--line);
  border-radius: 14px;
  padding: 12px 16px;
  color: var(--ink);
  background: #fff;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  font-size: 0.95rem;
  line-height: 1.4;
  transition: all 0.2s ease;
  font-family: var(--font);
  overflow-y: hidden;
}

.composer-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(14, 124, 102, 0.1);
}

.composer-input:disabled {
  background: #f4f7f0;
  cursor: not-allowed;
  opacity: 0.7;
}

.composer-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: nowrap;
}

.btn {
  border: 0;
  border-radius: 12px;
  padding: 12px 18px;
  font-weight: 600;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font);
  font-size: 0.9rem;
}

.btn:hover {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}

.btn-secondary {
  background: #f4f7f0;
  color: var(--ink);
  border: 1px solid var(--line);
}

.btn-secondary:hover {
  background: #e7f2ee;
}

.btn-ghost {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
}

.btn-ghost:hover {
  background: rgba(14, 124, 102, 0.05);
}

.btn-icon {
  width: 44px;
  height: 44px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #f4f7f0;
  color: var(--accent);
  border: 2px solid var(--line);
}

.btn-icon:hover {
  background: #e7f2ee;
}

.btn-icon.recording {
  background: var(--warn);
  color: #fff;
  border-color: var(--warn);
  animation: pulse 1.5s infinite;
}

.btn-icon-svg,
.btn-icon svg {
  width: 16px;
  height: 16px;
}

.template-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgba(11, 23, 19, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.template-dialog {
  width: min(720px, 100%);
  max-height: min(88vh, 920px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-radius: 24px;
  border: 1px solid #dbe4df;
  background: #fff;
  box-shadow: 0 28px 60px rgba(11, 23, 19, 0.24);
  overflow: hidden;
}

.template-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 16px;
  border-bottom: 1px solid #ecf2ef;
}

.template-dialog-head h3 {
  margin: 6px 0 0;
  font-size: 1.2rem;
  line-height: 1.25;
}

.template-dialog-eyebrow {
  margin: 0;
  color: #2d6a59;
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.template-dialog-close {
  width: 40px;
  height: 40px;
  border: 1px solid #d9e2de;
  border-radius: 12px;
  background: #fff;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.template-dialog-close svg {
  width: 18px;
  height: 18px;
}

.template-dialog-body {
  overflow: auto;
  padding: 20px 24px;
  display: grid;
  gap: 18px;
}

.template-dialog-state {
  margin: 20px 24px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px dashed #c8d7d1;
  background: #fbfdfc;
  color: var(--muted);
}

.template-dialog-state.error {
  border-style: solid;
  border-color: #efb7b7;
  color: #8b2525;
  background: #fff4f4;
}

.template-dialog-description {
  margin: 0;
  color: #304640;
  line-height: 1.65;
}

.template-dialog-block {
  display: grid;
  gap: 10px;
}

.template-dialog-block h4 {
  margin: 0;
  font-size: 0.95rem;
}

.template-dialog-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.template-dialog-tag {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: #eef7f3;
  color: #2d6a59;
  font-size: 0.78rem;
  font-weight: 700;
}

.template-dialog-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 8px;
  color: #304640;
}

.template-dialog-field-count {
  margin-left: 8px;
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 600;
}

.template-dialog-note {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 16px;
  background: linear-gradient(180deg, #f8fcfa 0%, #eef7f3 100%);
  border: 1px solid #d9e7e0;
}

.template-dialog-note p {
  margin: 0;
  color: #35524a;
  font-size: 0.84rem;
  line-height: 1.55;
}

.template-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px 22px;
  border-top: 1px solid #ecf2ef;
  background: #fff;
}

.icon-mic,
.icon-stop {
  width: 20px;
  height: 20px;
}

@keyframes typingBounce {
  0%,
  80%,
  100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(163, 40, 40, 0.4);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(163, 40, 40, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(163, 40, 40, 0);
  }
}

@media (max-width: 1280px) {
  .workspace-side {
    height: var(--workspace-column-height);
    min-height: var(--workspace-column-height);
  }
}

@media (max-width: 1024px) {
  .app-shell {
    min-height: 100dvh;
    overflow: visible;
  }

  .layout {
    flex-direction: column;
    overflow: visible;
  }

  .layout.layout-empty-chat {
    align-content: start;
  }

  .layout.sidebar-collapsed {
    align-items: stretch;
  }

  .sidebar {
    flex: none;
    position: static;
    height: auto;
    max-height: 320px;
  }

  .sidebar.collapsed {
    max-height: none;
  }

  .sidebar-body {
    overflow: visible;
    display: flex;
    flex-direction: column;
  }

  .chat-workspace {
    height: auto;
    overflow: visible;
  }

  .workspace-stack {
    min-height: auto;
    grid-template-rows: minmax(78dvh, auto) minmax(78dvh, auto);
  }

  .chat-panel {
    flex: none;
    height: auto;
  }

  .chat-main {
    height: auto;
    min-height: min(78dvh, 920px);
  }

  .workspace-side {
    flex: none;
    height: auto;
    min-height: min(100dvh, 980px);
  }
}

@media (max-width: 768px) {
  .app-shell {
    padding: 10px;
    gap: 12px;
  }

  .panel-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .template-picker {
    width: 100%;
    justify-items: start;
  }

  .template-picker-options {
    justify-content: flex-start;
  }

  .template-picker-hint {
    text-align: left;
    max-width: none;
  }

  .template-library-item {
    padding-left: 8px;
    padding-right: 8px;
  }

  .composer-input-wrapper {
    gap: 6px;
  }

  .chat-main {
    height: auto;
    min-height: min(72dvh, 860px);
    overflow: visible;
  }

  .workspace-stack {
    min-height: auto;
    grid-template-rows: minmax(72dvh, auto) minmax(320px, auto);
  }

  .workspace-side {
    height: auto;
    min-height: auto;
  }

  .chat-list {
    min-height: 0;
    height: auto;
  }

  .chat-main.chat-main-empty .chat-list.empty {
    min-height: 56vh;
    height: auto;
    max-height: none;
  }

  .bubble.user,
  .bubble.assistant {
    max-width: 92%;
  }

  .template-dialog-backdrop {
    padding: 10px;
  }

  .template-dialog {
    max-height: 92vh;
  }

  .template-dialog-head,
  .template-dialog-body,
  .template-dialog-actions {
    padding-left: 16px;
    padding-right: 16px;
  }

  .template-dialog-actions {
    justify-content: stretch;
    flex-direction: column-reverse;
  }

  .template-dialog-actions .btn {
    width: 100%;
    justify-content: center;
  }
}
</style>


