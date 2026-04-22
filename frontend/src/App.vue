<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type MessageRole = 'user' | 'assistant'

type ChatMessage = {
  role: MessageRole
  content: string
  thinking?: string
}

const sessionId = ref('')
const inputText = ref('')
const messages = ref<ChatMessage[]>([])
const chatList = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const loadingSession = ref(false)
const sending = ref(false)
const quickGuiding = ref(false)
const globalError = ref('')
const isConnected = ref(true)
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

const QUICK_GUIDE_PROMPT =
  'For the remaining key requirement questions, assume the simplest reasonable business needs by default and generate a system design.'

// 录音相关变量
const recording = ref(false)
const audioBuffer = ref<Float32Array[]>([])
const audioContext = ref<AudioContext | null>(null)
const scriptProcessor = ref<ScriptProcessorNode | null>(null)

const hasSession = computed(() => Boolean(sessionId.value))
const currentLanguage = ref<'zh' | 'en'>('zh')
const showLangMenu = ref(false)

const translations = {
  zh: {
    title: 'PM 需求对话',
    eyebrow: '需求工作室',
    conversation: '对话',
    newChat: '新建对话',
    connected: '已连接',
    disconnected: '已断开',
    quickDesign: '快速系统设计',
    generating: '生成中...',
    sending: '发送中...',
    send: '发送',
    recording: '录音中',
    stopRecording: '停止录音',
    startRecording: '开始录音',
    loading: '加载中...',
    creating: '创建中...',
    startConversation: '开始对话',
    startConversationDesc: '描述您的项目需求，我们的PM助手将帮助您收集和整理。',
    describeRequirements: '描述您的需求...',
    error: '错误',
    failedToSend: '发送失败',
    failedToCreate: '创建对话失败',
    failedToGenerate: '生成快速系统设计失败',
    streamingError: '流式响应错误',
    browserNotSupport: '浏览器不支持流式响应',
    requestFailed: '请求失败',
    close: '关闭',
    viewReasoning: '查看思考过程',
    you: '你',
    pmAssistant: 'PM 助手'
  },
  en: {
    title: 'PM Requirement Conversation',
    eyebrow: 'Requirement Studio',
    conversation: 'Conversation',
    newChat: 'New Chat',
    connected: 'Connected',
    disconnected: 'Disconnected',
    quickDesign: 'Quick System Design',
    generating: 'Generating...',
    sending: 'Sending...',
    send: 'Send',
    recording: 'Recording',
    stopRecording: 'Stop Recording',
    startRecording: 'Start Recording',
    loading: 'Loading...',
    creating: 'Creating...',
    startConversation: 'Start a conversation',
    startConversationDesc: 'Describe your project requirements and our PM Assistant will help you collect and refine them.',
    describeRequirements: 'Describe your requirements...',
    error: 'Error',
    failedToSend: 'Failed to send message',
    failedToCreate: 'Failed to create session',
    failedToGenerate: 'Failed to generate quick system design',
    streamingError: 'Streaming response error',
    browserNotSupport: 'Browser does not support streaming responses',
    requestFailed: 'Request failed',
    close: 'Close',
    viewReasoning: 'View reasoning',
    you: 'You',
    pmAssistant: 'PM Assistant'
  }
}

function toggleLanguage() {
  currentLanguage.value = currentLanguage.value === 'zh' ? 'en' : 'zh'
}

function selectLanguage(lang: 'zh' | 'en') {
  currentLanguage.value = lang
  showLangMenu.value = false
}

const t = computed(() => translations[currentLanguage.value])


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

function normalizeMessages(rawMessages: Array<{ role: MessageRole; content: string }>): ChatMessage[] {
  return rawMessages.map((item) => {
    if (item.role !== 'assistant') {
      return { role: item.role, content: item.content }
    }

    const parsed = parseThinkContent(item.content)
    return {
      role: item.role,
      content: parsed.content,
      thinking: parsed.thinking,
    }
  })
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

async function createSession() {
  clearError()
  loadingSession.value = true
  isConnected.value = true
  try {
    const data = await apiJson<{ session_id: string; messages: Array<{ role: MessageRole; content: string }> }>(
      '/api/sessions',
      {
        method: 'POST',
      },
    )
    sessionId.value = data.session_id
    messages.value = normalizeMessages(data.messages ?? [])
    scrollToBottom()
  } catch (error) {
    globalError.value = formatError(error, 'Failed to create session.')
    isConnected.value = false
  } finally {
    loadingSession.value = false
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
      // Auto scroll to bottom when new content is pushed
      scrollToBottom()
    },
    async finish() {
      // Ensure scroll to bottom when streaming is complete
      scrollToBottom()
    },
  }
}

async function sendMessageStream(session: string, message: string, assistantMessage: ChatMessage, language: 'zh' | 'en' = 'zh') {
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
    throw new Error('Browser does not support streaming responses.')
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
        throw new Error(payload.error || 'Streaming response error.')
      }

      if (parsed.event === 'content' && typeof payload.delta === 'string') {
        writer.push(payload.delta)
      }

      if (parsed.event === 'thinking' && typeof payload.delta === 'string') {
        assistantMessage.thinking = (assistantMessage.thinking || '') + payload.delta
        // Auto scroll to bottom when thinking content is updated
        scrollToBottom()
      }

      if (parsed.event === 'thinking_done' && typeof payload.thinking === 'string') {
        assistantMessage.thinking = payload.thinking
        // Auto scroll to bottom when thinking is done
        scrollToBottom()
      }
    }
  }

  await writer.finish()
}

async function sendMessageFallback(session: string, message: string, assistantMessage: ChatMessage, language: 'zh' | 'en' = 'zh') {
  const data = await apiJson<{
    assistant_message: string
  }>(`/api/sessions/${session}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message, language }),
  })

  const parsed = parseThinkContent(data.assistant_message || '')
  assistantMessage.content = parsed.content
  assistantMessage.thinking = parsed.thinking
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

async function sendMessage() {
  const message = inputText.value.trim()
  if (!message || sending.value) {
    return
  }

  if (!hasSession.value) {
    await createSession()
    if (!hasSession.value) {
      return
    }
  }

  clearError()
  sending.value = true

  messages.value.push({ role: 'user', content: message })
  messages.value.push({ role: 'assistant', content: '', thinking: '' })
  const assistantMessage = messages.value[messages.value.length - 1] as ChatMessage
  inputText.value = ''
  
  // 滚动到底部
  scrollToBottom()

  try {
    await sendMessageStream(sessionId.value, message, assistantMessage, currentLanguage.value)
    const streamParsed = parseThinkContent(assistantMessage.content)
    assistantMessage.content = streamParsed.content
    assistantMessage.thinking = [assistantMessage.thinking || '', streamParsed.thinking].filter(Boolean).join('\n\n')

    if (!assistantMessage.content.trim()) {
      await sendMessageFallback(sessionId.value, message, assistantMessage, currentLanguage.value)
    }
  } catch (error) {
    messages.value.pop()
    messages.value.pop()
    globalError.value = formatError(error, 'Failed to send message.')
    isConnected.value = false
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

async function quickFinalize() {
  if (!hasSession.value || quickGuiding.value || sending.value) {
    return
  }

  clearError()
  quickGuiding.value = true
  try {
    messages.value.push({ role: 'assistant', content: '', thinking: '' })
    const assistantMessage = messages.value[messages.value.length - 1] as ChatMessage
    
    // 滚动到底部
    scrollToBottom()

    await sendMessageStream(sessionId.value, QUICK_GUIDE_PROMPT, assistantMessage)
    const streamParsed = parseThinkContent(assistantMessage.content)
    assistantMessage.content = streamParsed.content
    assistantMessage.thinking = [assistantMessage.thinking || '', streamParsed.thinking].filter(Boolean).join('\n\n')

    if (!assistantMessage.content.trim()) {
      await sendMessageFallback(sessionId.value, QUICK_GUIDE_PROMPT, assistantMessage)
    }
  } catch (error) {
    globalError.value = formatError(error, 'Failed to generate quick system design.')
    isConnected.value = false
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      messages.value.pop()
    }
  } finally {
    quickGuiding.value = false
    scrollToBottom()
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    
    // 重置音频缓冲区
    audioBuffer.value = []
    
    // 创建AudioContext
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
    console.log('Recording started')
  } catch (error) {
    console.error('Error starting recording:', error)
    globalError.value = '无法访问麦克风'
  }
}

function stopRecording() {
  if (audioContext.value && scriptProcessor.value) {
    scriptProcessor.value.disconnect()
    
    // 关闭AudioContext
    if (audioContext.value.state !== 'closed') {
      audioContext.value.close()
    }
    
    // 合并音频数据
    const totalLength = audioBuffer.value.reduce((acc, chunk) => acc + chunk.length, 0)
    const result = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of audioBuffer.value) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    
    // 转换为16-bit PCM
    const pcmData = new Int16Array(result.length)
    for (let i = 0; i < result.length; i++) {
      pcmData[i] = Math.max(-32768, Math.min(32767, result[i] * 32767))
    }
    
    // 创建WAV文件头
    const wavData = createWavHeader(pcmData.buffer)
    
    // 创建FormData
    const formData = new FormData()
    const audioBlob = new Blob([wavData], { type: 'audio/wav' })
    formData.append('audio', audioBlob, 'recording.wav')
    
    // 发送到后端
    fetch(apiUrl('/api/asr/recognize'), {
      method: 'POST',
      body: formData
    })
    .then(response => response.json())
    .then(data => {
      if (data.text) {
        inputText.value = data.text
        sendMessage()
      } else if (data.error) {
        globalError.value = data.error
      }
    })
    .catch(error => {
      console.error('Error recognizing speech:', error)
      globalError.value = '语音识别失败'
    })
    
    recording.value = false
    console.log('Recording stopped')
  }
}

function createWavHeader(pcmData: ArrayBuffer) {
  const dataLength = pcmData.byteLength
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  
  // RIFF头
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, 'WAVE')
  
  // fmt子块
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)  // PCM格式
  view.setUint16(22, 1, true)  // 单声道
  view.setUint32(24, 16000, true)  // 采样率
  view.setUint32(28, 32000, true)  // 字节率
  view.setUint16(32, 2, true)  // 块对齐
  view.setUint16(34, 16, true)  // 位深度
  
  // data子块
  writeString(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  
  // 写入PCM数据
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
  await createSession()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="header-content">
        <p class="eyebrow">{{ t.eyebrow }}</p>
        <h1>{{ t.title }}</h1>
      </div>
      <div class="header-actions">
        <div class="lang-selector">
          <button class="lang-toggle" @click="showLangMenu = !showLangMenu">
            {{ currentLanguage === 'zh' ? '中文' : 'English' }}
            <svg class="lang-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div v-if="showLangMenu" class="lang-menu">
            <button 
              class="lang-option" 
              @click="selectLanguage('zh')"
              :class="{ 'active': currentLanguage === 'zh' }"
            >
              中文
            </button>
            <button 
              class="lang-option" 
              @click="selectLanguage('en')"
              :class="{ 'active': currentLanguage === 'en' }"
            >
              English
            </button>
          </div>
        </div>
        <div class="status-indicator" :class="{ 'online': isConnected, 'offline': !isConnected }">
          <span class="status-dot"></span>
          <span class="status-text">{{ isConnected ? t.connected : t.disconnected }}</span>
        </div>
      </div>
    </header>

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

    <main class="layout">
      <section class="panel chat-panel">
        <div class="panel-header">
          <div class="panel-title">
            <h2>{{ t.conversation }}</h2>
            <span class="message-count">{{ messages.length }} {{ currentLanguage === 'zh' ? '条消息' : 'messages' }}</span>
          </div>
          <div class="panel-actions">
            <button class="btn btn-secondary" :disabled="loadingSession" @click="createSession">
              <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              {{ loadingSession ? t.creating : t.newChat }}
            </button>
          </div>
        </div>

        <div class="chat-list" ref="chatList" :class="{ 'empty': !messages.length }">
          <div v-for="(msg, idx) in messages" :key="`${msg.role}-${idx}`" class="bubble" :class="msg.role">
            <div class="message-header">
              <span class="role">{{ msg.role === 'user' ? t.you : t.pmAssistant }}</span>
              <span class="timestamp">{{ new Date().toLocaleTimeString() }}</span>
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

            <div v-if="(sending || quickGuiding) && msg.role === 'assistant' && !msg.content" class="typing-indicator">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
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
              :disabled="sending"
              class="composer-input"
              @keydown.enter.exact.prevent="sendMessage"
              @keydown.enter.shift="$event.target.value += '\n'"
              @input="autoResizeTextarea"
              ref="textareaRef"
            />
            <div class="composer-actions">
              <div class="composer-actions-left">
                <button class="btn btn-ghost" :disabled="quickGuiding || sending || !hasSession" @click="quickFinalize">
                  <svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
                  </svg>
                  {{ quickGuiding ? t.generating : t.quickDesign }}
                </button>
              </div>
              <div class="composer-actions-right">
                <button 
                    class="btn btn-icon" 
                    type="button" 
                    :class="{ 'recording': recording }"
                    @click="recording ? stopRecording() : startRecording()"
                    :title="recording ? t.stopRecording : t.startRecording"
                    :disabled="sending"
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
                <button class="btn btn-primary" type="submit" :disabled="!inputText.trim() || sending">
                  <svg v-if="!sending" class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                  {{ sending ? t.sending : t.send }}
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>
    </main>
  </div>
</template>
