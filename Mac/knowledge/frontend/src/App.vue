<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAuth } from './composables/useAuth'
import { useWorkspace } from './composables/useWorkspace'
import { useKnowledge } from './composables/useKnowledge'
import { useAI } from './composables/useAI'
import { useUpload } from './composables/useUpload'
import { isShiYanEmbedded } from './composables/useApi'

import AuthPanel from './components/AuthPanel.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import KnowledgeCanvas from './components/KnowledgeCanvas.vue'
import NodeDetailModal from './components/NodeDetailModal.vue'
import AiChatModal from './components/AiChatModal.vue'
import UploadModal from './components/UploadModal.vue'
import CreateKnowledgeBaseModal from './components/CreateKnowledgeBaseModal.vue'
import TaskStatusPanel from './components/TaskStatusPanel.vue'

const embedded = isShiYanEmbedded()
const embeddedChrome = ref({})
let embeddedThemeObserver = null

const systemTheme = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null
const isDark = ref(systemTheme ? systemTheme.matches : true)
const themeOverridden = ref(false)
const showAiModal = ref(false)
const showUploadModal = ref(false)
const showCreateKnowledgeBaseModal = ref(false)
const knowledgeBaseModalMode = ref('create')
const editingKnowledgeBase = ref(null)
const showDetailModal = ref(false)
const mobileSidebarOpen = ref(false)
const sidebarCollapsed = ref(typeof window !== 'undefined' && window.localStorage.getItem('knowledgeSidebarCollapsed') === 'true')
const sidebarResizing = ref(false)
const detailContent = ref('')
const notice = ref('')
const noticeKind = ref('info')
const deletingDocumentId = ref('')
const creatingKnowledgeBase = ref(false)
const renamingKnowledgeBase = ref(false)
const knowledgeBaseActionId = ref('')
const canvasRef = ref(null)
let noticeTimer = null
let sidebarResizeTimer = null

const auth = useAuth()
const workspace = useWorkspace({ token: auth.token })
const {
  knowledgeBases,
  documents,
  documentsByKnowledgeBase,
  documentsLoadingByKnowledgeBase,
  documentsErrorByKnowledgeBase,
  currentKnowledgeBase,
  currentKnowledgeBaseId,
  loading: workspaceLoading,
  error: workspaceError,
  loadSpaces,
  selectKnowledgeBase,
  loadKnowledgeBaseDocuments,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  refreshDocuments,
  deleteDocument
} = workspace

const knowledge = useKnowledge({ token: auth.token, currentKnowledgeBaseId })
const { knowledgeData, loading: knowledgeLoading, error: knowledgeError, loadKnowledgeData } = knowledge
const ai = useAI({ token: auth.token, currentKnowledgeBaseId, currentKnowledgeBase })
const { chatMessages, loading: aiLoading, sendAiMessage, clearHistory } = ai
const upload = useUpload({
  token: auth.token,
  currentKnowledgeBaseId,
  refreshDocuments,
  loadKnowledgeBaseDocuments,
  loadKnowledgeData,
})
const {
  showTaskStatus,
  documentId,
  taskKnowledgeBaseId,
  taskStatusText,
  taskStage,
  taskProgress,
  taskStageDone,
  taskStageTotal,
  taskActiveWorkers,
  taskQueueAhead,
  taskError,
  uploading,
  handleUpload,
  clearPolling
} = upload

const combinedError = computed(() => knowledgeError.value || workspaceError.value)
const indexedDocumentCount = computed(() => documents.value.filter(document => document.status === 'completed').length)
const hasIndexedDocuments = computed(() => indexedDocumentCount.value > 0)
const uploadBusy = computed(() => uploading.value || ['queued', 'processing'].includes(taskStatusText.value))
const knowledgeBaseModalLoading = computed(() => knowledgeBaseModalMode.value === 'create' ? creatingKnowledgeBase.value : renamingKnowledgeBase.value)
const knowledgeBaseModalTitle = computed(() => knowledgeBaseModalMode.value === 'create' ? '创建知识库' : '重命名知识库')
const knowledgeBaseModalDescription = computed(() => knowledgeBaseModalMode.value === 'create' ? '' : '换一个更容易识别的名称。')
const knowledgeBaseModalSubmitLabel = computed(() => knowledgeBaseModalMode.value === 'create' ? '创建并进入' : '保存名称')
const knowledgeBaseModalLoadingLabel = computed(() => knowledgeBaseModalMode.value === 'create' ? '创建中…' : '保存中…')
const knowledgeBaseModalInitialName = computed(() => editingKnowledgeBase.value?.name || '')

function toggleTheme() {
  themeOverridden.value = true
  isDark.value = !isDark.value
  document.body.classList.toggle('light-theme', !isDark.value)
}

function toggleSidebar() {
  sidebarResizing.value = true
  if (sidebarResizeTimer) window.clearTimeout(sidebarResizeTimer)
  sidebarCollapsed.value = !sidebarCollapsed.value
  window.localStorage.setItem('knowledgeSidebarCollapsed', String(sidebarCollapsed.value))
  sidebarResizeTimer = window.setTimeout(() => {
    sidebarResizing.value = false
    sidebarResizeTimer = null
  }, 280)
}

function closeMobileSidebar() {
  mobileSidebarOpen.value = false
}

function openCreateKnowledgeBase() {
  knowledgeBaseModalMode.value = 'create'
  editingKnowledgeBase.value = null
  showCreateKnowledgeBaseModal.value = true
}

function openRenameKnowledgeBase(knowledgeBase) {
  if (!knowledgeBase?.id) return
  knowledgeBaseModalMode.value = 'rename'
  editingKnowledgeBase.value = knowledgeBase
  showCreateKnowledgeBaseModal.value = true
}

function closeKnowledgeBaseModal() {
  if (knowledgeBaseModalLoading.value) return
  showCreateKnowledgeBaseModal.value = false
  editingKnowledgeBase.value = null
}

function syncEmbeddedAppearance() {
  if (!embedded || window.parent === window) return
  const host = window.parent
  const body = host.document.body
  const style = host.getComputedStyle(body)
  const sidebar = host.document.getElementById('agentSidebar')
  const search = host.document.getElementById('sidebarSearch')
  const toggle = host.document.getElementById('toggleLeftSidebar')
  const chrome = host.getComputedStyle(host.document.getElementById('desktopLayout') || body)
  const titleStyle = host.getComputedStyle(sidebar?.querySelector('.sidebar-header h2') || body)
  const theme = body.dataset.theme || (host.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  isDark.value = theme === 'dark'
  document.body.classList.toggle('light-theme', !isDark.value)
  embeddedChrome.value = {
    '--shiyan-sidebar-background': sidebar ? host.getComputedStyle(sidebar).backgroundColor : style.getPropertyValue('--v22-side'),
    '--shiyan-sidebar-text': titleStyle.color,
    '--shiyan-sidebar-title-size': titleStyle.fontSize,
    '--shiyan-sidebar-width': chrome.getPropertyValue('--shiyan-sidebar-width').trim() || '262px',
    '--shiyan-sidebar-control': search ? host.getComputedStyle(search).color : style.getPropertyValue('--secondary'),
    '--shiyan-sidebar-toggle': toggle ? host.getComputedStyle(toggle).color : style.getPropertyValue('--secondary'),
    '--shiyan-sidebar-hover': isDark.value ? style.getPropertyValue('--v22-hover') : 'rgba(100,110,130,.055)',
    '--shiyan-sidebar-hover-text': isDark.value ? '#fff' : '#252525',
    '--shiyan-sidebar-font': style.fontFamily,
    '--shiyan-search-top': search?.getClientRects().length ? search.getBoundingClientRect().top + 'px' : '9.5px',
    '--shiyan-search-right': '49px',
    '--shiyan-toggle-top': toggle?.getClientRects().length ? toggle.getBoundingClientRect().top + 'px' : '9px',
    '--shiyan-toggle-right': '13px',
  }
}

function syncSystemTheme(event) {
  if (embedded) { syncEmbeddedAppearance(); return }
  if (themeOverridden.value) return
  isDark.value = event.matches
  document.body.classList.toggle('light-theme', !isDark.value)
}

function showNotice(message, kind = 'info') {
  notice.value = message
  noticeKind.value = kind
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.value = '' }, 4200)
}

async function completeLogin(action, payload) {
  try {
    await action(payload.email, payload.password, payload.displayName)
    await loadSpaces()
    if (workspaceError.value) {
      showNotice(workspaceError.value, 'error')
      return
    }
    showNotice('欢迎回来，知识库已经准备好。')
  } catch (_) {
    // AuthPanel displays the reactive error from useAuth.
  }
}

async function retrySessionBootstrap() {
  const restored = await auth.bootstrap()
  if (restored) await loadSpaces()
}


async function onSelectKnowledgeBase(kbId) {
  mobileSidebarOpen.value = false
  await selectKnowledgeBase(kbId)
}

async function onLoadKnowledgeBaseDocuments(kbId, force = false) {
  try {
    await loadKnowledgeBaseDocuments(kbId, force)
  } catch (err) {
    showNotice(err.message || '文档加载失败', 'error')
  }
}

async function retryKnowledgeBase() {
  const kbId = currentKnowledgeBaseId.value
  if (!kbId) {
    await loadSpaces()
    return
  }
  await selectKnowledgeBase(kbId)
  await loadKnowledgeData(kbId).catch((err) => {
    showNotice(err.message || '知识地图加载失败', 'error')
  })
}


function normalizedKnowledgeBaseName(name) {
  return String(name || '').trim().toLocaleLowerCase()
}

function knowledgeBaseNameExists(name, excludeId = '') {
  const wanted = normalizedKnowledgeBaseName(name)
  return knowledgeBases.value.some(item => (
    item.id !== excludeId && normalizedKnowledgeBaseName(item.name) === wanted
  ))
}

async function onCreateKnowledgeBase(name) {
  if (!name || creatingKnowledgeBase.value) return
  if (knowledgeBaseNameExists(name)) {
    showNotice('知识库名称已存在', 'error')
    return
  }
  creatingKnowledgeBase.value = true
  try {
    await createKnowledgeBase(name)
    showCreateKnowledgeBaseModal.value = false
    showNotice('知识库「' + name + '」已创建。')
  } catch (err) {
    showNotice(err.message || '知识库创建失败', 'error')
  } finally {
    creatingKnowledgeBase.value = false
  }
}

async function onKnowledgeBaseModalSubmit(name) {
  if (knowledgeBaseModalMode.value === 'create') {
    await onCreateKnowledgeBase(name)
    return
  }

  const knowledgeBase = editingKnowledgeBase.value
  if (!knowledgeBase?.id || renamingKnowledgeBase.value) return
  if (knowledgeBaseNameExists(name, knowledgeBase.id)) {
    showNotice('知识库名称已存在', 'error')
    return
  }
  renamingKnowledgeBase.value = true
  try {
    await updateKnowledgeBase(knowledgeBase.id, { name })
    showCreateKnowledgeBaseModal.value = false
    editingKnowledgeBase.value = null
    showNotice('知识库名称已更新。')
  } catch (err) {
    showNotice(err.message || '知识库重命名失败', 'error')
  } finally {
    renamingKnowledgeBase.value = false
  }
}

async function onTogglePinKnowledgeBase(knowledgeBase) {
  if (!knowledgeBase?.id || knowledgeBaseActionId.value) return
  knowledgeBaseActionId.value = knowledgeBase.id
  try {
    const result = await updateKnowledgeBase(knowledgeBase.id, { is_pinned: !Boolean(knowledgeBase.is_pinned) })
    showNotice(result.is_pinned ? '知识库已置顶。' : '已取消置顶。')
  } catch (err) {
    showNotice(err.message || '知识库置顶失败', 'error')
  } finally {
    knowledgeBaseActionId.value = ''
  }
}

async function onDeleteKnowledgeBase(knowledgeBase) {
  if (!knowledgeBase?.id || knowledgeBaseActionId.value) return
  const confirmed = window.confirm(
    '确定删除「' + knowledgeBase.name + '」吗？\n其中的文档、索引和知识地图也会一起删除，且无法恢复。'
  )
  if (!confirmed) return

  knowledgeBaseActionId.value = knowledgeBase.id
  try {
    const result = await deleteKnowledgeBase(knowledgeBase.id)
    showNotice(result?.warning || '知识库已删除。')
  } catch (err) {
    showNotice(err.message || '知识库删除失败', 'error')
  } finally {
    knowledgeBaseActionId.value = ''
  }
}

async function onUploadFile(file) {
  try {
    await handleUpload(file)
    showUploadModal.value = false
    showNotice('文件已接收，正在解析页面并生成知识地图。')
  } catch (err) {
    showNotice(err.message || '文件上传失败', 'error')
  }
}

function onNodeClick(nodeId) {
  if (!canvasRef.value) return
  detailContent.value = canvasRef.value.getNodeContent(nodeId)
  showDetailModal.value = true
}


async function onDeleteDocument(document) {
  if (!document?.id || deletingDocumentId.value) return
  if (['queued', 'processing'].includes(document.status)) {
    showNotice('文档仍在处理或排队，完成后才可以删除。', 'error')
    return
  }
  const confirmed = window.confirm('确定删除「' + document.title + '」吗？\n相关索引和知识地图节点也会一起删除。')
  if (!confirmed) return

  deletingDocumentId.value = document.id
  try {
    const result = await deleteDocument(document.id, document.knowledge_base_id)
    if (documentId.value === document.id) showTaskStatus.value = false
    if (document.knowledge_base_id === currentKnowledgeBaseId.value) {
      await loadKnowledgeData(currentKnowledgeBaseId.value).catch(() => {})
    }
    showNotice(result?.warning || '文档已删除，知识地图已更新。')
  } catch (err) {
    showNotice(err.message || '文档删除失败', 'error')
  } finally {
    deletingDocumentId.value = ''
  }
}



function onKeydown(event) {
  if (event.key !== 'Escape') return
  showAiModal.value = false
  showUploadModal.value = false
  showCreateKnowledgeBaseModal.value = false
  editingKnowledgeBase.value = null
  showDetailModal.value = false
  mobileSidebarOpen.value = false
}

onMounted(async () => {
  document.body.classList.toggle('light-theme', !isDark.value)
  if (embedded && window.parent !== window) {
    syncEmbeddedAppearance()
    embeddedThemeObserver = new MutationObserver(syncEmbeddedAppearance)
    for (const element of [window.parent.document.body, window.parent.document.documentElement, window.parent.document.getElementById('desktopLayout')].filter(Boolean)) {
      embeddedThemeObserver.observe(element, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    }
  }
  systemTheme?.addEventListener?.('change', syncSystemTheme)
  document.addEventListener('keydown', onKeydown)
  if (await auth.bootstrap()) await loadSpaces()
})

onUnmounted(() => {
  embeddedThemeObserver?.disconnect()
  systemTheme?.removeEventListener?.('change', syncSystemTheme)
  document.removeEventListener('keydown', onKeydown)
  clearPolling()
  if (noticeTimer) window.clearTimeout(noticeTimer)
  if (sidebarResizeTimer) window.clearTimeout(sidebarResizeTimer)
})
</script>

<template>
  <div v-if="!auth.ready.value" class="auth-loading">
    <div class="loading-orbit"></div>
    <span>正在准备知识库…</span>
  </div>

  <AuthPanel
    v-else-if="!auth.user.value"
    :loading="auth.loading.value"
    :error="auth.error.value"
    :session-retry="auth.sessionRecoveryAvailable.value"
    @login="completeLogin(auth.login, $event)"
    @register="completeLogin(auth.register, $event)"
    @retry="retrySessionBootstrap"
  />

  <template v-else>
    <div class="workspace-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarResizing, 'shiyan-embedded': embedded }" :style="embedded ? embeddedChrome : undefined">
      <div v-if="mobileSidebarOpen" class="sidebar-scrim" @click="mobileSidebarOpen = false"></div>
      <WorkspaceSidebar
        :documents-error-by-knowledge-base="documentsErrorByKnowledgeBase"
        :knowledge-bases="knowledgeBases"
        :documents="documents"
        :documents-by-knowledge-base="documentsByKnowledgeBase"
        :documents-loading-by-knowledge-base="documentsLoadingByKnowledgeBase"
        :current-knowledge-base-id="currentKnowledgeBaseId"
        :active-task-document-id="documentId"
        :active-task-knowledge-base-id="taskKnowledgeBaseId"
        :active-task-status="taskStatusText"
        :active-task-stage="taskStage"
        :active-task-progress="taskProgress"
        :active-task-error="taskError"
        :deleting-document-id="deletingDocumentId"
        :user="auth.user.value"
        :mobile-open="mobileSidebarOpen"
        :collapsed="sidebarCollapsed"
        @select-knowledge-base="onSelectKnowledgeBase"
        @load-knowledge-base-documents="onLoadKnowledgeBaseDocuments"
        @delete-document="onDeleteDocument"
        @create-knowledge-base="openCreateKnowledgeBase"
        @rename-knowledge-base="openRenameKnowledgeBase"
        @toggle-pin-knowledge-base="onTogglePinKnowledgeBase"
        @delete-knowledge-base="onDeleteKnowledgeBase"
        @close-mobile="closeMobileSidebar"
        @toggle-sidebar="toggleSidebar"
        @logout="auth.logout"
      />

      <main class="workspace-main">
        <header class="workspace-header">
          <button class="mobile-menu-button" type="button" @click="mobileSidebarOpen = true">☰</button>
          <div class="workspace-heading">
            <button
              v-if="sidebarCollapsed"
              class="sidebar-reopen"
              type="button"
              aria-expanded="false"
              aria-label="打开侧边栏"
              title="打开侧边栏"
              @click="toggleSidebar"
            >
              <svg v-if="embedded" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM7 8v8" /></svg>
              <svg v-else viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M8 3v14" /></svg>
            </button>
            <h1>{{ currentKnowledgeBase?.name || (embedded ? '知识库' : 'Knowledge OS') }}</h1>
          </div>
          <div class="workspace-actions">
            <button v-if="hasIndexedDocuments" class="header-action" type="button" title="导入到当前知识库" aria-label="上传 PDF" :disabled="uploadBusy" @click="showUploadModal = true">
              <svg class="header-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M12 18v-6m0 0-3 3m3-3 3 3" /></svg>
            </button>
            <button class="header-action" :class="{ 'header-action--primary': !embedded }" type="button" :title="hasIndexedDocuments ? '问 AI' : '上传 PDF 后即可提问'" aria-label="打开问 AI" :disabled="!hasIndexedDocuments" @click="showAiModal = true">
              <svg class="header-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.65 6.35L20 11l-6.35 1.65L12 19l-1.65-6.35L4 11l6.35-1.65L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>
            </button>
            <button v-if="!embedded" class="theme-button" type="button" :title="isDark ? '切换浅色主题' : '切换深色主题'" :aria-label="isDark ? '切换浅色主题' : '切换深色主题'" @click="toggleTheme">
              <svg class="header-action-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path v-if="isDark" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
                <g v-else><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></g>
              </svg>
            </button>
          </div>
        </header>

        <section class="workspace-stage">
          <div v-if="currentKnowledgeBaseId && hasIndexedDocuments" class="stage-toolbar">
            <div class="stage-status"><span class="status-dot active"></span><span>{{ indexedDocumentCount }} 份资料</span></div>
            <div class="stage-hint">
              <span class="stage-view-label">中心放射图</span>
              <span>{{ knowledgeData?.cluster_mode ? '点击资料组展开主题' : '点击主题查看关联知识点' }}</span>
              <span v-if="knowledgeData?.relation_count" class="stage-relation-count">{{ knowledgeData.relation_count }} 条关系</span>
            </div>
          </div>
          <div v-if="(knowledgeLoading || workspaceLoading) && !knowledgeData?.structure" class="workspace-loading"><div class="loading-orbit"></div><span>正在绘制知识地图…</span></div>
          <div v-else-if="combinedError && !knowledgeData?.structure" class="workspace-empty workspace-empty--error">
            <h2>暂时无法读取知识库</h2>
            <p>{{ combinedError }}</p>
            <button class="primary-button" type="button" @click="retryKnowledgeBase">重新加载</button>
          </div>
          <KnowledgeCanvas
            v-else-if="knowledgeData?.structure && hasIndexedDocuments"
            ref="canvasRef"
            :knowledge-data="knowledgeData"
            @node-click="onNodeClick"
          />
          <div v-else-if="!currentKnowledgeBaseId" class="workspace-empty">
            <h2>先创建一个知识库</h2>
            <p>知识库确定资料范围，之后上传的 PDF 都会在这里融合。</p>
            <button class="primary-button" type="button" @click="openCreateKnowledgeBase">创建知识库</button>
          </div>
          <div v-else class="workspace-empty">
            <h2>上传第一份 PDF</h2>
            <p>系统会生成知识总览，并按主题组、主题、知识点逐层整理原文内容。</p>
            <button class="primary-button" type="button" :disabled="uploadBusy" @click="showUploadModal = true">{{ uploadBusy ? '正在生成…' : '上传 PDF' }}</button>
          </div>
        </section>

      </main>
    </div>

    <div v-if="notice" class="notice-toast" :class="'notice-' + noticeKind">{{ notice }}</div>

    <NodeDetailModal :visible="showDetailModal" :content="detailContent" @close="showDetailModal = false" />
    <CreateKnowledgeBaseModal
      :visible="showCreateKnowledgeBaseModal"
      :loading="knowledgeBaseModalLoading"
      :title="knowledgeBaseModalTitle"
      :description="knowledgeBaseModalDescription"
      :submit-label="knowledgeBaseModalSubmitLabel"
      :loading-label="knowledgeBaseModalLoadingLabel"
      :initial-name="knowledgeBaseModalInitialName"
      @close="closeKnowledgeBaseModal"
      @create="onKnowledgeBaseModalSubmit"
    />
    <AiChatModal
      :visible="showAiModal"
      :messages="chatMessages"
      :loading="aiLoading"
      :is-dark="isDark"
      :current-domain="currentKnowledgeBase?.name || ''"
      @close="showAiModal = false"
      @send="sendAiMessage"
      @clear="clearHistory"
    />
    <UploadModal
      :visible="showUploadModal"
      :uploading="uploadBusy"
      :error="taskError"
      :knowledge-base-name="currentKnowledgeBase?.name || ''"
      @close="showUploadModal = false"
      @upload="onUploadFile"
    />
    <TaskStatusPanel
      :visible="showTaskStatus"
      :status-text="taskStatusText"
      :stage="taskStage"
      :progress="taskProgress"
      :stage-done="taskStageDone"
      :stage-total="taskStageTotal"
      :active-workers="taskActiveWorkers"
      :queue-ahead="taskQueueAhead"
      :error="taskError"
      @close="showTaskStatus = false"
    />
  </template>
</template>


<style>
/* Match ShiYan's existing desktop sidebar chrome only in its embedded RAG view. */
.workspace-shell.shiyan-embedded .workspace-sidebar {
  width: var(--shiyan-sidebar-width,262px);
  background: var(--shiyan-sidebar-background, #f8f8f9);
}
.workspace-shell.shiyan-embedded .workspace-main { margin-left:var(--shiyan-sidebar-width,262px); }
.workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-main { margin-left:0; }
.workspace-shell.shiyan-embedded .sidebar-brand {
  position: relative;
  height: 48px;
  flex: 0 0 48px;
  width: calc(100% + 29px);
  margin: 0 -14px;
  padding: 7px 49px 6px 14px;
  gap: 8px;
}
.workspace-shell.shiyan-embedded .sidebar-brand strong {
  font-family: var(--shiyan-sidebar-font, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: var(--shiyan-sidebar-title-size,19px);
  line-height: 1.15;
  font-weight: 600;
  letter-spacing: -.4px;
  color: var(--shiyan-sidebar-text, var(--workspace-text));
}
.workspace-shell.shiyan-embedded :is(.sidebar-header-search, .sidebar-collapse-toggle, .sidebar-reopen) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  color: var(--shiyan-sidebar-control, #66686c);
  background: transparent;
  box-shadow: none;
}
.workspace-shell.shiyan-embedded .sidebar-header-search { position:absolute; top:var(--shiyan-search-top,9.5px); right:var(--shiyan-search-right,49px); margin-left:0; border-radius:8px; }
.workspace-shell.shiyan-embedded :is(.sidebar-collapse-toggle, .sidebar-reopen) { color: var(--shiyan-sidebar-toggle, #737780); }
.workspace-shell.shiyan-embedded .sidebar-collapse-toggle { position: absolute; top:var(--shiyan-toggle-top,9px); right:var(--shiyan-toggle-right,13px); }
.workspace-shell.shiyan-embedded :is(.sidebar-header-search, .sidebar-collapse-toggle, .sidebar-reopen) svg {
  display: block;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: none;
}
.workspace-shell.shiyan-embedded .sidebar-header-search svg { stroke-width: 1.5; }
.workspace-shell.shiyan-embedded.sidebar-collapsed .sidebar-reopen { position: fixed; z-index: 30; top: 9px; left: 11px; border: 0; background: transparent; box-shadow: none; }
.workspace-shell.shiyan-embedded :is(.sidebar-header-search, .sidebar-collapse-toggle, .sidebar-reopen):hover {
  color: var(--shiyan-sidebar-hover-text, #252525);
  background: var(--shiyan-sidebar-hover, var(--workspace-hover));
}
body:not(.light-theme) .workspace-shell.shiyan-embedded :is(.sidebar-header-search, .sidebar-collapse-toggle, .sidebar-reopen):hover { color: #fff; }
body.light-theme .workspace-shell.shiyan-embedded :is(.sidebar-collapse-toggle, .sidebar-reopen):hover { color: var(--shiyan-sidebar-toggle, #737780); }
body:not(.light-theme) .workspace-shell.shiyan-embedded .sidebar-header-search:hover svg { stroke-width: 1.9; }
body:not(.light-theme) .workspace-shell.shiyan-embedded :is(.sidebar-collapse-toggle, .sidebar-reopen):hover svg { stroke-width: 1.9; }
@media (max-width: 860px) {
  .workspace-shell.shiyan-embedded .workspace-sidebar { transform: translateX(0); box-shadow: none; }
  .workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-sidebar { transform: translateX(-102%); }
  .workspace-shell.shiyan-embedded .workspace-main { margin-left:var(--shiyan-sidebar-width,262px); }
  .workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-main { margin-left: 0; }
  .workspace-shell.shiyan-embedded .workspace-header { padding: 0 20px; }
  .workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-header { padding-left: 56px; }
  .workspace-shell.shiyan-embedded :is(.mobile-menu-button, .sidebar-mobile-close, .sidebar-scrim) { display: none; }
}

.workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-header { height:48px; flex:0 0 48px; padding-left:51px; }
.workspace-shell.shiyan-embedded.sidebar-collapsed .workspace-heading h1 { line-height:24px; }
</style>
