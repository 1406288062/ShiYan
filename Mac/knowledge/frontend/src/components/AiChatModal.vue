<template>
  <Transition name="agent-desk">
    <div v-if="visible" class="ai-modal-overlay" :class="{ light: !isDark }" role="presentation" @click.self="closePanel">
      <aside class="ai-panel" :class="{ 'ai-panel--light': !isDark }" role="dialog" aria-modal="true" aria-label="问 AI">
        <header class="ai-header">
          <div class="ai-header-left">
            <svg v-if="!embedded" class="site-mark" viewBox="0 0 36 36" aria-hidden="true">
              <rect class="site-mark-bg" x="1" y="1" width="34" height="34" rx="11" />
              <path class="site-mark-line" d="M10 12.5 18 18l8-6M18 18v7" />
              <circle class="site-mark-node" cx="10" cy="12.5" r="2.5" />
              <circle class="site-mark-node" cx="26" cy="12" r="2.5" />
              <circle class="site-mark-node" cx="18" cy="25" r="2.5" />
            </svg>
            <div class="ai-heading">
              <div class="ai-title-line">
                <span class="ai-kicker">{{ embedded ? '知识库 RAG' : '知识库 Agent' }}</span>
                <span v-if="currentDomain" class="ai-title-separator" aria-hidden="true">·</span>
                <h2 v-if="currentDomain" id="agent-panel-title">{{ currentDomain }}</h2>
              </div>
            </div>
          </div>
          <div class="ai-header-right">
            <div class="context-status" aria-label="当前检索状态">
              <span class="status-dot" :class="{ active: !loading }"></span>
              <span>{{ contextStatus }}</span>
            </div>
            <button class="ai-header-btn" type="button" title="清除聊天记录" aria-label="清除聊天记录" @click="clearChat">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" /></svg>
            </button>
            <button class="ai-close-btn" type="button" aria-label="关闭问 AI 面板" @click="closePanel">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
            </button>
          </div>
        </header>

        <div ref="chatRef" class="ai-messages">
          <template v-for="(msg, i) in messages" :key="messageKey(msg, i)">
            <article v-if="msg.type === 'ai'" class="message message--agent">
              <div class="message-rail" aria-hidden="true">
                <span class="message-index">答</span>
                <span class="rail-line"></span>
              </div>
              <div class="message-copy">
                <div class="message-label">
                  <span>AI 回复</span>
                  <span v-if="msg.status === 'error'" class="message-state message-state--error">需要重试</span>
                </div>
                <div class="msg-bubble msg-bubble--ai" v-html="renderContent(msg.content)" />

                <section v-if="msg.citations?.length" class="source-ledger" aria-label="参考来源">
                  <div class="ledger-heading">
                    <span class="ledger-title">参考来源</span>
                    <span class="ledger-count">{{ msg.citations.length }} 条</span>
                  </div>
                  <ol class="source-list">
                    <li v-for="(citation, citationIndex) in msg.citations" :key="citation.chunk_id || citation.url || citationIndex" class="source-card">
                      <div class="source-index">[{{ String(citationIndex + 1).padStart(2, '0') }}]</div>
                      <div class="source-body">
                        <div class="source-reference">
                          <strong>{{ citation.document_name || citation.title || '外部资料' }}</strong>
                          <span v-if="hasPage(citation)" class="source-page">第 {{ citation.page_start }} 页</span>
                          <a v-if="safeCitationUrl(citation.url)" class="source-link" :href="safeCitationUrl(citation.url)" target="_blank" rel="noreferrer" aria-label="打开来源">↗</a>
                        </div>
                        <p v-if="citation.quote">{{ citation.quote }}</p>
                      </div>
                    </li>
                  </ol>
                </section>

                <div v-if="msg.mode" class="answer-meta"><span class="meta-dot"></span>{{ modeLabel(msg.mode) }}</div>
              </div>
            </article>

            <article v-else class="message message--user">
              <div class="message-copy">
                <div class="message-label message-label--user"><span>你的问题</span></div>
                <div class="msg-bubble msg-bubble--user">{{ msg.content }}</div>
              </div>
              <div class="user-mark" aria-hidden="true">Q</div>
            </article>
          </template>

          <div v-if="messages.length === 1 && !loading" class="starter-block">
            <div class="starter-heading">
              <span class="section-label">从这份知识库开始</span>
              <span class="starter-line"></span>
            </div>
            <button v-for="prompt in starterPrompts" :key="prompt" class="starter-prompt" type="button" @click="usePrompt(prompt)">
              <span>{{ prompt }}</span>
              <span class="prompt-arrow" aria-hidden="true">↗</span>
            </button>
          </div>

          <div v-if="loading" class="message message--agent message--thinking">
            <div class="message-rail" aria-hidden="true">
              <span class="message-index">知</span>
              <span class="rail-line"></span>
            </div>
            <div class="message-copy">
              <div class="message-label"><span>AI 正在检索</span></div>
              <div class="thinking-bubble">
                <span>正在检索匹配段落…</span>
                <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              </div>
            </div>
          </div>
        </div>

        <footer class="ai-input-area">
          <div class="input-shell">
            <textarea ref="inputRef" v-model="question" class="ai-input" rows="1" maxlength="1000" placeholder="总结、比较、定位原文……" :disabled="loading" @keydown.ctrl.enter.prevent="onSend" @keydown.meta.enter.prevent="onSend"></textarea>
            <button class="ai-send-btn" type="button" :class="{ sending: loading }" :disabled="loading || !question.trim()" aria-label="发送问题" @click="onSend">
              <svg v-if="!loading" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 20 18-8L3 4v6l11 2-11 2v6Z" /></svg>
              <svg v-else class="spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle></svg>
            </button>
          </div>
          <div class="input-hint">
            <span><kbd>⌘</kbd><span class="ctrl-copy">/ Ctrl</span><kbd>↵</kbd> 发送</span>
            <span>{{ question.length }}/1000</span>
          </div>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { escapeHtml, sanitizeHtml } from '../utils/sanitize'
import { isShiYanEmbedded } from '../composables/useApi'

const embedded = isShiYanEmbedded()

const props = defineProps({
  visible: Boolean,
  messages: { type: Array, default: () => [] },
  loading: Boolean,
  isDark: { type: Boolean, default: true },
  currentDomain: { type: String, default: '' }
})

const emit = defineEmits(['close', 'send', 'clear'])

const question = ref('')
const chatRef = ref(null)
const inputRef = ref(null)

const starterPrompts = [
  '哪些概念被多份资料共同支持？',
  '找出不同资料之间的关键联系',
  '定位一个关键结论的原文依据'
]

const latestCitedMessage = computed(() => {
  return [...props.messages].reverse().find(message => message.type === 'ai' && message.citations?.length) || null
})
const latestCitationCount = computed(() => latestCitedMessage.value?.citations?.length || 0)
const contextStatus = computed(() => {
  if (props.loading) return '正在检索'
  if (latestCitationCount.value) return '已关联 ' + latestCitationCount.value + ' 条依据'
  return '等待提问'
})

function closePanel() {
  emit('close')
}

function clearChat() {
  emit('clear')
  nextTick(() => inputRef.value?.focus())
}

function onSend() {
  const q = question.value.trim()
  if (!q || props.loading) return
  emit('send', q)
  question.value = ''
}

function usePrompt(prompt) {
  question.value = prompt
  nextTick(() => {
    inputRef.value?.focus()
    onSend()
  })
}

function messageKey(message, index) {
  return (message.type || 'message') + '-' + index + '-' + (message.content || '').slice(0, 12)
}

function hasPage(citation) {
  return citation.page_start !== null && citation.page_start !== undefined && citation.page_start !== ''
}

function safeCitationUrl(value) {
  if (!value) return ''
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const url = new URL(String(value), base)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch (_) {
    return ''
  }
}

watch(() => props.visible, async (isVisible) => {
  if (!isVisible) return
  await nextTick()
  inputRef.value?.focus()
})

watch(
  () => [props.messages.length, props.loading],
  async () => {
    await nextTick()
    if (chatRef.value) chatRef.value.scrollTo({ top: chatRef.value.scrollHeight, behavior: 'auto' })
  }
)

function renderContent(text) {
  let html = escapeHtml(text)
  html = html.replace(/\x60\x60\x60(\w*)\n([\s\S]*?)\x60\x60\x60/g, '<pre><code>$2</code></pre>')
  html = html.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  html = html.replace(/\n/g, '<br>')
  return sanitizeHtml(html)
}

function modeLabel(mode) {
  if (mode === 'codex_gateway') return 'Codex Gateway 生成'
  if (mode === 'codex_sdk') return 'Codex SDK 生成'
  if (mode === 'deepseek') return 'DeepSeek 远程生成'
  return '生成模式 · ' + mode
}
</script>

<style scoped>
.ai-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  justify-content: flex-end;
  overflow: hidden;
  background: rgba(4, 7, 9, 0.7);
  backdrop-filter: blur(9px);
  overscroll-behavior: contain;
}

.agent-desk-enter-active,
.agent-desk-leave-active {
  transition: opacity 0.24s ease;
}

.agent-desk-enter-from,
.agent-desk-leave-to {
  opacity: 0;
}

.agent-desk-enter-active .ai-panel,
.agent-desk-leave-active .ai-panel {
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

.agent-desk-enter-from .ai-panel,
.agent-desk-leave-to .ai-panel {
  transform: translateX(36px);
}

.ai-panel {
  --desk-bg: #13191b;
  --desk-bg-deep: #0e1416;
  --desk-paper: #f1eadc;
  --desk-muted: #9da9a6;
  --desk-dim: #697674;
  --desk-border: #314044;
  --desk-copper: #d6a85f;
  --desk-teal: #78b9b0;
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  width: min(640px, 100vw);
  height: 100%;
  overflow: hidden;
  color: var(--desk-paper);
  background-color: var(--desk-bg);
  border-left: 1px solid var(--desk-border);
  box-shadow: -30px 0 90px rgba(0, 0, 0, 0.42);
}


.ai-header,
.ai-messages,
.ai-input-area {
  position: relative;
  z-index: 1;
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 26px;
  background: transparent;
  border-bottom: 1px solid rgba(49, 64, 68, 0.34);
}

.ai-header-left {
  display: flex;
  min-width: 0;
  align-items: center;
  align-self: center;
  gap: 14px;
}

.ai-heading {
  min-width: 0;
}

.ai-kicker,
.section-label,
.message-label,
.ledger-title {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ai-kicker {
  display: block;
  margin: 0 0 6px;
  color: var(--desk-teal);
  font-size: 10px;
  line-height: 1;
}


.ai-heading h2 {
  max-width: 390px;
  margin: 0;
  overflow: hidden;
  color: var(--desk-paper);
  font-size: 20px;
  font-weight: 560;
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-header-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  align-self: center;
  gap: 8px;
  margin-left: 16px;
}

.ai-header-btn,
.ai-close-btn {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  color: var(--desk-dim);
  background: rgba(241, 234, 220, 0.035);
  border: 1px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
}

.ai-header-btn svg,
.ai-close-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}

.ai-header-btn:hover,
.ai-header-btn:focus-visible {
  color: var(--desk-paper);
  background: rgba(241, 234, 220, 0.08);
  border-color: var(--desk-border);
}

.ai-close-btn:hover,
.ai-close-btn:focus-visible {
  color: var(--desk-copper);
  background: rgba(215, 154, 98, 0.08);
  border-color: rgba(215, 154, 98, 0.35);
}

.section-label {
  color: var(--desk-copper);
  font-size: 10px;
}


.context-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  color: var(--desk-teal);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  border: 1px solid rgba(120, 185, 176, 0.24);
  border-radius: 999px;
}

.status-dot,
.meta-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--desk-copper);
}

.status-dot.active {
  background: var(--desk-teal);
  box-shadow: 0 0 0 4px rgba(120, 185, 176, 0.09);
}

.ai-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 26px 26px 34px;
  scrollbar-color: transparent transparent;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ai-messages::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.ai-messages::-webkit-scrollbar-track {
  background: transparent;
}

.ai-messages::-webkit-scrollbar-thumb {
  background: rgba(157, 169, 166, 0.23);
  border-radius: 999px;
}

.message {
  display: grid;
  gap: 14px;
  margin-bottom: 26px;
  animation: message-in 0.3s ease-out both;
}

.message--agent {
  grid-template-columns: 48px minmax(0, 1fr);
}

.message--user {
  grid-template-columns: minmax(0, 1fr) 34px;
  gap: 12px;
  margin-left: 62px;
}

@keyframes message-in {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: translateY(0); }
}

.message-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100%;
}

.message-index {
  color: var(--desk-copper);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.05em;
}

.rail-line {
  width: 1px;
  flex: 1;
  min-height: 30px;
  margin-top: 9px;
  background: linear-gradient(to bottom, rgba(215, 154, 98, 0.55), rgba(215, 154, 98, 0));
}

.message-copy {
  min-width: 0;
}

.message-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 9px;
  color: var(--desk-dim);
  font-size: 9px;
}

.message-label--user {
  justify-content: flex-end;
  color: rgba(120, 185, 176, 0.72);
}

.message-state--error {
  color: #df8c82;
  letter-spacing: 0;
  text-transform: none;
}

.msg-bubble {
  word-break: break-word;
}

.msg-bubble--ai {
  padding: 15px 17px 16px;
  color: rgba(241, 234, 220, 0.9);
  font-size: 13.5px;
  line-height: 1.75;
  background: rgba(241, 234, 220, 0.045);
  border: 1px solid rgba(157, 169, 166, 0.18);
  border-left: 2px solid var(--desk-copper);
  border-radius: 2px 10px 10px 10px;
}

.msg-bubble--user {
  padding: 12px 15px;
  color: var(--desk-paper);
  font-size: 13px;
  line-height: 1.65;
  background: rgba(120, 185, 176, 0.1);
  border: 1px solid rgba(120, 185, 176, 0.23);
  border-radius: 10px 2px 10px 10px;
}

.user-mark {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  align-self: start;
  color: var(--desk-teal);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  border: 1px solid rgba(120, 185, 176, 0.44);
  border-radius: 50%;
}

.msg-bubble--ai :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  color: var(--desk-paper);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  background: var(--desk-bg-deep);
  border: 1px solid var(--desk-border);
  border-radius: 5px;
}

.msg-bubble--ai :deep(pre::-webkit-scrollbar) { display: none; width: 0; height: 0; }

.msg-bubble--ai :deep(code) {
  padding: 2px 5px;
  color: var(--desk-copper);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.9em;
  background: rgba(215, 154, 98, 0.1);
  border-radius: 3px;
}

.msg-bubble--ai :deep(pre code) {
  padding: 0;
  color: var(--desk-paper);
  background: transparent;
}

.msg-bubble--ai :deep(strong) {
  color: var(--desk-paper);
  font-weight: 650;
}

.msg-bubble--ai :deep(h2),
.msg-bubble--ai :deep(h3),
.msg-bubble--ai :deep(h4) {
  margin: 10px 0 5px;
  color: var(--desk-paper);
  font-weight: 600;
}

.msg-bubble--ai :deep(h2) {
  font-family: Georgia, 'Noto Serif SC', serif;
  font-size: 18px;
}

.msg-bubble--ai :deep(h3) {
  font-size: 15px;
}

.msg-bubble--ai :deep(h4) {
  font-size: 13px;
}

.msg-bubble--ai :deep(ul),
.msg-bubble--ai :deep(ol) {
  margin: 5px 0;
  padding-left: 19px;
}

.msg-bubble--ai :deep(li) {
  margin-bottom: 3px;
}

.source-ledger {
  margin-top: 16px;
  padding-top: 13px;
  border-top: 1px solid rgba(157, 169, 166, 0.2);
}

.ledger-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
}

.ledger-title {
  color: var(--desk-copper);
  font-size: 10px;
}

.ledger-count {
  color: var(--desk-dim);
  font-size: 10px;
}

.source-card {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 11px;
  margin-top: 7px;
  padding: 11px 12px 12px 10px;
  background: rgba(14, 20, 22, 0.62);
  border: 1px solid rgba(49, 64, 68, 0.95);
  border-radius: 4px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.source-card:hover {
  background: rgba(241, 234, 220, 0.05);
  border-color: rgba(215, 154, 98, 0.45);
}

.source-index {
  color: var(--desk-copper);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
}

.source-body {
  min-width: 0;
}

.source-page {
  color: var(--desk-teal);
}

.source-body strong {
  display: block;
  overflow: hidden;
  color: var(--desk-paper);
  font-size: 12px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-body p {
  display: -webkit-box;
  margin: 7px 0 0;
  overflow: hidden;
  color: var(--desk-muted);
  font-size: 11px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.source-body a {
  display: inline-block;
  margin-top: 8px;
  color: var(--desk-teal);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  text-decoration: none;
}

.source-body a:hover {
  color: var(--desk-paper);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.answer-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  color: var(--desk-dim);
  font-size: 10px;
}

.meta-dot {
  width: 4px;
  height: 4px;
  background: var(--desk-teal);
}

.starter-block {
  margin: -5px 0 29px 62px;
}

.starter-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.starter-line {
  height: 1px;
  flex: 1;
  background: var(--desk-border);
}

.starter-prompt {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 7px;
  padding: 11px 12px;
  color: var(--desk-muted);
  font: inherit;
  font-size: 12px;
  text-align: left;
  background: rgba(241, 234, 220, 0.025);
  border: 1px solid rgba(49, 64, 68, 0.82);
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}

.starter-prompt:hover,
.starter-prompt:focus-visible {
  color: var(--desk-paper);
  background: rgba(215, 154, 98, 0.07);
  border-color: rgba(215, 154, 98, 0.45);
}

.prompt-arrow {
  color: var(--desk-copper);
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.message--thinking {
  margin-bottom: 0;
}

.thinking-bubble {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 15px;
  color: var(--desk-muted);
  font-size: 12px;
  background: rgba(241, 234, 220, 0.035);
  border: 1px solid rgba(157, 169, 166, 0.14);
  border-left: 2px solid var(--desk-teal);
  border-radius: 2px 8px 8px 8px;
}

.thinking-dots {
  display: inline-flex;
  gap: 4px;
}

.thinking-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--desk-teal);
  animation: dot-pulse 1.2s ease-in-out infinite;
}

.thinking-dots i:nth-child(2) { animation-delay: 0.16s; }
.thinking-dots i:nth-child(3) { animation-delay: 0.32s; }

@keyframes dot-pulse {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-3px); }
}

.ai-input-area {
  padding: 17px 26px 20px;
  background: transparent;
  border-top: 1px solid rgba(49, 64, 68, 0.34);
}

.input-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.input-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  gap: 10px;
  align-items: center;
  padding: 8px 8px 8px 13px;
  background: rgba(241, 234, 220, 0.045);
  border: 1px solid rgba(157, 169, 166, 0.25);
  border-radius: 7px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.input-shell:focus-within {
  background: rgba(241, 234, 220, 0.065);
  border-color: rgba(215, 154, 98, 0.72);
  box-shadow: 0 0 0 3px rgba(215, 154, 98, 0.08);
}

.ai-input {
  width: 100%;
  min-height: 45px;
  padding: 3px 0;
  resize: none;
  color: var(--desk-paper);
  font: inherit;
  font-size: 13px;
  line-height: 1.65;
  background: transparent;
  border: 0;
  outline: 0;
}

.ai-input::placeholder { color: var(--desk-dim); }
.ai-input:disabled { cursor: wait; opacity: 0.6; }

.ai-send-btn {
  display: grid;
  width: 44px;
  height: 44px;
  padding: 0;
  place-items: center;
  color: #1b211f;
  background: var(--desk-copper);
  border: 0;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.2s ease, background 0.2s ease, opacity 0.2s ease;
}

.ai-send-btn svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.ai-send-btn:hover:not(:disabled),
.ai-send-btn:focus-visible:not(:disabled) {
  background: #e6ae79;
  transform: translateY(-2px);
}

.ai-send-btn:active:not(:disabled) { transform: translateY(0); }
.ai-send-btn:disabled { cursor: not-allowed; opacity: 0.28; }

.ai-send-btn.sending {
  color: var(--desk-teal);
  background: rgba(120, 185, 176, 0.12);
}

.spinner {
  fill: none !important;
  stroke: currentColor;
  stroke-dasharray: 36;
  animation: spin 1s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.input-hint {
  margin-top: 7px;
  color: var(--desk-dim);
  font-size: 10px;
}

kbd {
  display: inline-grid;
  min-width: 17px;
  height: 17px;
  margin: 0 2px;
  padding: 0 4px;
  place-items: center;
  color: var(--desk-muted);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 9px;
  border: 1px solid var(--desk-border);
  border-radius: 3px;
}

.ctrl-copy { margin: 0 3px 0 1px; }

button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--desk-copper);
  outline-offset: 3px;
}

.ai-modal-overlay.light {
  background: rgba(23, 32, 30, 0.22);
}

.ai-panel--light {
  --desk-bg: #f7f6f1;
  --desk-bg-deep: #ebeae3;
  --desk-paper: #1e2b29;
  --desk-muted: #5e6b67;
  --desk-dim: #87918c;
  --desk-border: #d8ddd7;
  --desk-copper: #b8862f;
  --desk-teal: #3e8177;
  color: var(--desk-paper);
  background-color: var(--desk-bg);
  box-shadow: -22px 0 70px rgba(36, 50, 46, 0.18);
}


.ai-panel--light .ai-header {
  background: transparent;
  border-bottom-color: rgba(74, 92, 85, 0.18);
}

.ai-panel--light .ai-header-btn,
.ai-panel--light .ai-close-btn {
  background: rgba(30, 43, 41, 0.035);
}

.ai-panel--light .ai-header-btn:hover,
.ai-panel--light .ai-header-btn:focus-visible {
  background: rgba(30, 43, 41, 0.08);
}

.ai-panel--light .ai-close-btn:hover,
.ai-panel--light .ai-close-btn:focus-visible {
  background: rgba(167, 101, 53, 0.08);
}

.ai-panel--light .msg-bubble--ai {
  color: rgba(30, 43, 41, 0.9);
  background: rgba(255, 255, 255, 0.62);
  border-color: rgba(74, 92, 85, 0.18);
}

.ai-panel--light .msg-bubble--user {
  color: var(--desk-paper);
  background: rgba(62, 129, 119, 0.1);
  border-color: rgba(62, 129, 119, 0.25);
}

.ai-panel--light .source-card {
  background: rgba(255, 255, 255, 0.54);
  border-color: rgba(74, 92, 85, 0.19);
}

.ai-panel--light .source-card:hover {
  background: rgba(255, 255, 255, 0.84);
  border-color: rgba(167, 101, 53, 0.42);
}

.ai-panel--light .starter-prompt {
  background: rgba(255, 255, 255, 0.48);
  border-color: rgba(74, 92, 85, 0.18);
}

.ai-panel--light .starter-prompt:hover,
.ai-panel--light .starter-prompt:focus-visible {
  background: rgba(167, 101, 53, 0.08);
}

.ai-panel--light .thinking-bubble {
  background: rgba(255, 255, 255, 0.54);
  border-color: rgba(74, 92, 85, 0.16);
}

.ai-panel--light .ai-input-area {
  background: transparent;
  border-top-color: rgba(74, 92, 85, 0.18);
}

.ai-panel--light .input-shell {
  background: rgba(255, 255, 255, 0.62);
  border-color: rgba(74, 92, 85, 0.24);
}

.ai-panel--light .input-shell:focus-within {
  background: rgba(255, 255, 255, 0.9);
}

/* Shared glass language: the panel follows the auth surface without becoming ornamental. */
.ai-modal-overlay {
  background: rgba(14, 17, 23, 0.5);
  -webkit-backdrop-filter: blur(16px) saturate(125%);
  backdrop-filter: blur(16px) saturate(125%);
}

.ai-modal-overlay.light {
  background: rgba(36, 42, 56, 0.16);
}

.ai-panel {
  --desk-bg: #0e1117;
  --desk-bg-deep: #0a0d12;
  --desk-paper: #f4f5f8;
  --desk-muted: #a3a9b8;
  --desk-dim: #788092;
  --desk-border: rgba(185, 178, 255, 0.2);
  --desk-copper: #d6a85f;
  --desk-teal: #48b9b1;
  background:
    radial-gradient(ellipse 54% 30% at 85% 8%, rgba(129, 120, 242, 0.2) 0%, transparent 72%),
    radial-gradient(ellipse 52% 34% at 10% 90%, rgba(72, 185, 177, 0.12) 0%, transparent 74%),
    radial-gradient(ellipse 48% 28% at 48% 52%, rgba(79, 120, 201, 0.04) 0%, transparent 72%),
    linear-gradient(145deg, rgba(72, 66, 117, 0.44), rgba(25, 28, 40, 0.5) 54%, rgba(15, 18, 27, 0.46)),
    var(--desk-bg);
  -webkit-backdrop-filter: blur(28px) saturate(135%);
  backdrop-filter: blur(28px) saturate(135%);
  border-left-color: rgba(185, 178, 255, 0.18);
  box-shadow: -30px 0 90px rgba(0, 0, 0, 0.34);
}

.ai-panel::before,
.ai-panel::after {
  content: "";
  position: absolute;
  z-index: 0;
  pointer-events: none;
  border-radius: 47% 53% 46% 54% / 52% 43% 57% 48%;
  filter: blur(42px) saturate(125%);
  opacity: 0.52;
  mix-blend-mode: screen;
  will-change: transform;
}

.ai-panel::before {
  inset: -24%;
  background:
    radial-gradient(ellipse 48% 30% at 76% 20%, rgba(147, 132, 255, 0.34), transparent 72%),
    radial-gradient(ellipse 50% 32% at 22% 78%, rgba(72, 203, 191, 0.24), transparent 74%),
    radial-gradient(ellipse 42% 28% at 49% 51%, rgba(79, 120, 201, 0.06), transparent 74%),
    linear-gradient(118deg, rgba(72, 203, 191, 0.08) 5%, transparent 30%, rgba(79, 120, 201, 0.05) 48%, transparent 64%, rgba(147, 132, 255, 0.1) 91%);
  animation: agentGlassFlow 38s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite alternate;
}

.ai-panel::after {
  inset: -14%;
  border-radius: 53% 47% 58% 42% / 43% 56% 44% 57%;
  background:
    radial-gradient(ellipse 34% 20% at 35% 48%, rgba(255, 255, 255, 0.12), transparent 70%),
    linear-gradient(104deg, transparent 31%, rgba(255, 255, 255, 0.09) 45%, rgba(255, 255, 255, 0.03) 53%, transparent 69%);
  filter: blur(22px);
  opacity: 0.22;
  animation: agentGlassFlowReverse 46s cubic-bezier(0.45, 0.05, 0.55, 0.95) -4s infinite alternate;
  will-change: transform;
}

@keyframes agentGlassFlow {
  0% { transform: translate3d(-4%, -3%, 0) rotate(-2deg) scale(0.99); }
  50% { transform: translate3d(4%, 3%, 0) rotate(2deg) scale(1.04); }
  100% { transform: translate3d(-2%, 6%, 0) rotate(-1deg) scale(1.01); }
}

@keyframes agentGlassFlowReverse {
  0% { transform: translate3d(-6%, -2%, 0) rotate(-3deg) scale(0.98); }
  50% { transform: translate3d(4%, 3%, 0) rotate(2deg) scale(1.04); }
  100% { transform: translate3d(-2%, 6%, 0) rotate(3deg) scale(1.01); }
}

.ai-header {
  min-height: 54px;
  padding: 10px 20px 9px;
  background: rgba(255, 255, 255, 0.025);
  border-bottom-color: rgba(185, 178, 255, 0.15);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.ai-header-left { gap: 10px; }

.site-mark {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  box-shadow:
    0 7px 18px rgba(103, 91, 226, 0.25),
    0 1px 0 rgba(255, 255, 255, 0.24) inset;
}

.site-mark-bg { fill: #7468ed; }
.site-mark-line { fill: none; stroke: rgba(255, 255, 255, 0.88); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.35; }
.site-mark-node { fill: #fff; }

.ai-title-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
  white-space: nowrap;
}

.ai-kicker {
  flex: 0 0 auto;
  margin: 0;
  color: var(--desk-teal);
  font-family: inherit;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.01em;
  text-transform: none;
}

.ai-title-separator {
  flex: 0 0 auto;
  color: var(--desk-dim);
  font-size: 13px;
}

.ai-heading h2 {
  color: var(--desk-paper);
  max-width: 250px;
  font-size: 12px;
  font-weight: 520;
  letter-spacing: -0.01em;
}

.ai-header-right { gap: 6px; }

.ai-header-btn,
.ai-close-btn {
  width: 30px;
  height: 30px;
  color: var(--desk-dim);
  background: rgba(255, 255, 255, 0.045);
  border-color: rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}

.ai-header-btn:hover,
.ai-header-btn:focus-visible {
  color: var(--desk-paper);
  background: rgba(129, 120, 242, 0.14);
  border-color: rgba(129, 120, 242, 0.32);
}

.ai-close-btn:hover,
.ai-close-btn:focus-visible {
  color: #ffcbc1;
  background: rgba(224, 139, 132, 0.12);
  border-color: rgba(224, 139, 132, 0.3);
}

.context-status {
  padding: 6px 10px;
  color: var(--desk-teal);
  font-family: inherit;
  font-size: 10px;
  background: rgba(72, 185, 177, 0.06);
  border-color: rgba(72, 185, 177, 0.25);
}

.ai-messages {
  padding: 28px 24px 34px;
  scrollbar-color: transparent transparent;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ai-messages::-webkit-scrollbar { display: none; width: 0; height: 0; }

.message { gap: 12px; margin-bottom: 28px; }
.message-rail { width: 42px; }
.message-index { color: var(--desk-copper); font-weight: 650; }
.rail-line { background: linear-gradient(to bottom, rgba(129, 120, 242, 0.55), rgba(72, 185, 177, 0)); }

.message-label {
  margin-bottom: 8px;
  color: var(--desk-dim);
  font-family: inherit;
  letter-spacing: 0.01em;
  text-transform: none;
}

.message-label--user { color: rgba(72, 185, 177, 0.82); }

.msg-bubble--ai {
  padding: 16px 18px 17px;
  color: rgba(244, 245, 248, 0.92);
  line-height: 1.72;
  background:
    linear-gradient(145deg, rgba(129, 120, 242, 0.09), rgba(255, 255, 255, 0.035) 54%, rgba(72, 185, 177, 0.035)),
    rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(185, 178, 255, 0.2);
  border-left: 2px solid var(--desk-copper);
  border-radius: 6px 16px 16px 16px;
  box-shadow:
    0 14px 34px rgba(0, 0, 0, 0.1),
    0 1px 0 rgba(255, 255, 255, 0.08) inset;
}

.msg-bubble--user {
  padding: 13px 16px;
  color: var(--desk-paper);
  background:
    linear-gradient(135deg, rgba(129, 120, 242, 0.2), rgba(72, 185, 177, 0.08)),
    rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(129, 120, 242, 0.28);
  border-radius: 16px 6px 16px 16px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.08);
}

.user-mark {
  width: 30px;
  height: 30px;
  color: var(--desk-copper);
  border-color: rgba(129, 120, 242, 0.46);
  border-radius: 10px;
  background: rgba(129, 120, 242, 0.08);
}

.msg-bubble--ai :deep(pre) {
  background: rgba(10, 13, 18, 0.72);
  border-color: rgba(185, 178, 255, 0.16);
  border-radius: 10px;
}

.msg-bubble--ai :deep(code) {
  color: #b8b1ff;
  background: rgba(129, 120, 242, 0.13);
  border-radius: 5px;
}

.source-ledger {
  margin-top: 15px;
  padding-top: 11px;
  border-top-color: rgba(185, 178, 255, 0.17);
}

.ledger-title { color: var(--desk-copper); }
.ledger-count { color: var(--desk-dim); }
.source-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.source-card {
  grid-template-columns: 31px minmax(0, 1fr);
  gap: 8px;
  margin-top: 0;
  padding: 7px 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(185, 178, 255, 0.11);
  border-radius: 0;
  box-shadow: none;
}

.source-card:hover {
  background: rgba(129, 120, 242, 0.055);
  border-color: rgba(129, 120, 242, 0.2);
}

.source-index {
  padding-top: 1px;
  color: var(--desk-copper);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.source-reference {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.source-reference strong {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
}

.source-page {
  flex: 0 0 auto;
  font-size: 10px;
}

.source-body p {
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.4;
  -webkit-line-clamp: 1;
}

.source-link {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  margin: 0;
  color: var(--desk-teal);
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  text-decoration: none;
}

.answer-meta { color: var(--desk-dim); }

.starter-block { margin: -3px 0 30px 54px; }
.starter-heading { gap: 10px; margin-bottom: 11px; }
.starter-line { background: rgba(185, 178, 255, 0.16); }
.starter-prompt {
  margin-top: 8px;
  padding: 12px 13px;
  color: var(--desk-muted);
  background: rgba(255, 255, 255, 0.035);
  border-color: rgba(185, 178, 255, 0.16);
  border-radius: 12px;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05) inset;
}

.starter-prompt:hover,
.starter-prompt:focus-visible {
  color: var(--desk-paper);
  background: rgba(129, 120, 242, 0.1);
  border-color: rgba(129, 120, 242, 0.36);
}

.prompt-arrow { color: var(--desk-copper); }

.thinking-bubble {
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(185, 178, 255, 0.16);
  border-left-color: var(--desk-teal);
  border-radius: 6px 14px 14px 14px;
}

.ai-input-area {
  padding: 12px 20px 14px;
  background: rgba(255, 255, 255, 0.025);
  border-top-color: rgba(185, 178, 255, 0.15);
  box-shadow: 0 -18px 44px rgba(0, 0, 0, 0.1);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.input-shell {
  grid-template-columns: minmax(0, 1fr) 36px;
  gap: 10px;
  align-items: center;
  padding: 5px 5px 5px 12px;
  background:
    linear-gradient(135deg, rgba(129, 120, 242, 0.08), rgba(255, 255, 255, 0.035)),
    rgba(255, 255, 255, 0.04);
  border-color: rgba(185, 178, 255, 0.24);
  border-radius: 15px;
  box-shadow:
    0 14px 30px rgba(0, 0, 0, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.08) inset;
}

.input-shell:focus-within {
  background:
    linear-gradient(135deg, rgba(129, 120, 242, 0.13), rgba(72, 185, 177, 0.045)),
    rgba(255, 255, 255, 0.06);
  border-color: rgba(129, 120, 242, 0.62);
  box-shadow:
    0 0 0 3px rgba(129, 120, 242, 0.12),
    0 14px 30px rgba(0, 0, 0, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.1) inset;
}

.ai-input {
  height: 34px;
  min-height: 34px;
  max-height: 68px;
  padding: 4px 0;
  overflow-y: auto;
  color: var(--desk-paper);
  line-height: 1.5;
}
.ai-input::placeholder { color: var(--desk-dim); }

.ai-send-btn {
  width: 36px;
  height: 36px;
  align-self: center;
  color: #fff;
  background: linear-gradient(135deg, #8178f2, #5c52df);
  border-radius: 12px;
  box-shadow:
    0 8px 18px rgba(103, 91, 226, 0.25),
    0 1px 0 rgba(255, 255, 255, 0.24) inset;
}

.ai-send-btn:hover:not(:disabled),
.ai-send-btn:focus-visible:not(:disabled) {
  color: #fff;
  background: linear-gradient(135deg, #8d84f7, #6258e7);
  box-shadow:
    0 11px 23px rgba(103, 91, 226, 0.34),
    0 1px 0 rgba(255, 255, 255, 0.3) inset;
}

.ai-send-btn.sending {
  color: var(--desk-teal);
  background: rgba(72, 185, 177, 0.13);
  box-shadow: none;
}

.input-hint { margin-top: 6px; font-size: 9px; }
kbd { border-color: rgba(185, 178, 255, 0.18); }

.ai-panel--light {
  --desk-bg: #f4f6fa;
  --desk-bg-deep: #e8ebf2;
  --desk-paper: #181b23;
  --desk-muted: #69707d;
  --desk-dim: #8a91a0;
  --desk-border: rgba(98, 87, 231, 0.16);
  --desk-copper: #b8862f;
  --desk-teal: #1e9e96;
  color: var(--desk-paper);
  background:
    radial-gradient(ellipse 54% 30% at 85% 8%, rgba(98, 87, 231, 0.13) 0%, transparent 72%),
    radial-gradient(ellipse 52% 34% at 10% 90%, rgba(30, 158, 150, 0.08) 0%, transparent 74%),
    radial-gradient(ellipse 48% 28% at 48% 52%, rgba(79, 120, 201, 0.03) 0%, transparent 72%),
    linear-gradient(145deg, rgba(255, 255, 255, 0.78), rgba(250, 250, 253, 0.56) 54%, rgba(242, 244, 250, 0.64)),
    var(--desk-bg);
  -webkit-backdrop-filter: blur(28px) saturate(135%);
  backdrop-filter: blur(28px) saturate(135%);
  border-left-color: rgba(98, 87, 231, 0.14);
  box-shadow: -24px 0 76px rgba(35, 42, 56, 0.16);
}

.ai-panel--light::before {
  background:
    radial-gradient(ellipse 48% 30% at 76% 20%, rgba(118, 106, 240, 0.2), transparent 72%),
    radial-gradient(ellipse 50% 32% at 22% 78%, rgba(30, 158, 150, 0.14), transparent 74%),
    radial-gradient(ellipse 42% 28% at 49% 51%, rgba(79, 120, 201, 0.05), transparent 74%),
    linear-gradient(118deg, rgba(30, 158, 150, 0.05) 5%, transparent 30%, rgba(79, 120, 201, 0.04) 48%, transparent 64%, rgba(118, 106, 240, 0.06) 91%);
  filter: blur(46px) saturate(112%);
  opacity: 0.62;
  mix-blend-mode: multiply;
}

.ai-panel--light::after {
  background:
    radial-gradient(ellipse 34% 20% at 35% 48%, rgba(255, 255, 255, 0.16), transparent 70%),
    linear-gradient(104deg, transparent 31%, rgba(255, 255, 255, 0.12) 45%, rgba(255, 255, 255, 0.05) 53%, transparent 69%);
  filter: blur(24px);
  opacity: 0.44;
  mix-blend-mode: normal;
}

.ai-panel--light .ai-header,
.ai-panel--light .ai-input-area {
  background: rgba(255, 255, 255, 0.34);
  border-color: rgba(98, 87, 231, 0.13);
  box-shadow: 0 -18px 44px rgba(35, 42, 56, 0.05);
}

.ai-panel--light .ai-header-btn,
.ai-panel--light .ai-close-btn {
  color: var(--desk-dim);
  background: rgba(255, 255, 255, 0.42);
  border-color: rgba(98, 87, 231, 0.1);
}

.ai-panel--light .ai-header-btn:hover,
.ai-panel--light .ai-header-btn:focus-visible {
  color: var(--desk-paper);
  background: rgba(98, 87, 231, 0.1);
  border-color: rgba(98, 87, 231, 0.25);
}

.ai-panel--light .ai-close-btn:hover,
.ai-panel--light .ai-close-btn:focus-visible {
  color: #b85e65;
  background: rgba(208, 122, 139, 0.1);
  border-color: rgba(208, 122, 139, 0.25);
}

.ai-panel--light .context-status {
  background: rgba(30, 158, 150, 0.06);
  border-color: rgba(30, 158, 150, 0.22);
}

.ai-panel--light .msg-bubble--ai {
  color: rgba(24, 27, 35, 0.92);
  background:
    linear-gradient(145deg, rgba(98, 87, 231, 0.07), rgba(255, 255, 255, 0.58) 54%, rgba(30, 158, 150, 0.035)),
    rgba(255, 255, 255, 0.62);
  border-color: rgba(98, 87, 231, 0.14);
  box-shadow:
    0 14px 34px rgba(35, 42, 56, 0.07),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
}

.ai-panel--light .msg-bubble--user {
  color: var(--desk-paper);
  background:
    linear-gradient(135deg, rgba(98, 87, 231, 0.13), rgba(30, 158, 150, 0.06)),
    rgba(255, 255, 255, 0.48);
  border-color: rgba(98, 87, 231, 0.2);
  box-shadow: 0 10px 25px rgba(35, 42, 56, 0.06);
}

.ai-panel--light .msg-bubble--ai :deep(pre) {
  color: var(--desk-paper);
  background: rgba(232, 235, 242, 0.92);
  border-color: rgba(98, 87, 231, 0.12);
}

.ai-panel--light .msg-bubble--ai :deep(code) {
  color: #5147c9;
  background: rgba(98, 87, 231, 0.09);
}

.ai-panel--light .source-ledger { border-top-color: rgba(98, 87, 231, 0.13); }

.ai-panel--light .source-card {
  background: transparent;
  border-color: rgba(98, 87, 231, 0.13);
  box-shadow: none;
}

.ai-panel--light .source-card:hover {
  background: rgba(98, 87, 231, 0.045);
  border-color: rgba(98, 87, 231, 0.3);
}

.ai-panel--light .starter-line { background: rgba(98, 87, 231, 0.13); }

.ai-panel--light .starter-prompt {
  color: var(--desk-muted);
  background: rgba(255, 255, 255, 0.48);
  border-color: rgba(98, 87, 231, 0.13);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.86) inset;
}

.ai-panel--light .starter-prompt:hover,
.ai-panel--light .starter-prompt:focus-visible {
  color: var(--desk-paper);
  background: rgba(98, 87, 231, 0.07);
  border-color: rgba(98, 87, 231, 0.28);
}

.ai-panel--light .thinking-bubble {
  background: rgba(255, 255, 255, 0.5);
  border-color: rgba(98, 87, 231, 0.13);
}

.ai-panel--light .input-shell {
  background:
    linear-gradient(135deg, rgba(98, 87, 231, 0.06), rgba(255, 255, 255, 0.56)),
    rgba(255, 255, 255, 0.62);
  border-color: rgba(98, 87, 231, 0.2);
  box-shadow:
    0 14px 30px rgba(35, 42, 56, 0.07),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
}

.ai-panel--light .input-shell:focus-within {
  background:
    linear-gradient(135deg, rgba(98, 87, 231, 0.1), rgba(30, 158, 150, 0.035)),
    rgba(255, 255, 255, 0.86);
  border-color: rgba(98, 87, 231, 0.56);
  box-shadow:
    0 0 0 3px rgba(98, 87, 231, 0.1),
    0 14px 30px rgba(35, 42, 56, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.94) inset;
}

.ai-panel--light kbd { border-color: rgba(98, 87, 231, 0.14); }

@media (max-width: 640px) {
  .ai-header { padding: 10px 16px 9px; }
  .ai-messages { padding: 22px 18px 28px; }
  .message--agent { grid-template-columns: 35px minmax(0, 1fr); gap: 10px; }
  .message--user { margin-left: 45px; }
  .starter-block { margin-left: 45px; }
  .ai-input-area { padding: 11px 16px 13px; }
}

@media (max-width: 430px) {
  .ai-heading h2 { max-width: 155px; font-size: 12px; }
  .context-status { padding-inline: 7px; }
  .context-status span:last-child { display: none; }
  .input-hint .ctrl-copy { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .agent-desk-enter-active,
  .agent-desk-leave-active,
  .agent-desk-enter-active .ai-panel,
  .agent-desk-leave-active .ai-panel,
  .ai-panel::before,
  .ai-panel::after,
  .message,
  .thinking-dots i,
  .spinner {
    animation: none;
    transition: none;
  }
}
</style>
