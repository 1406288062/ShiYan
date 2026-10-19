<template>
  <aside class="workspace-sidebar" :class="{ open: mobileOpen, collapsed }" @click="closeMenu">
    <div class="sidebar-brand">
      <div v-if="!embedded" class="brand-symbol">✦</div>
      <div class="sidebar-brand-copy">
        <strong>{{ embedded ? '知识库' : 'Knowledge OS' }}</strong>
      </div>
      <button
        v-if="embedded"
        class="sidebar-search-toggle sidebar-header-search"
        type="button"
        :aria-expanded="searchOpen"
        aria-label="搜索知识库和文档"
        title="搜索"
        @click="toggleSearch"
      >
        <svg viewBox="-1.7 -1.7 26.4 26.4" aria-hidden="true"><path d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM15.7 15.7 21 21" /></svg>
      </button>
      <button
        class="sidebar-collapse-toggle"
        type="button"
        :aria-expanded="String(!collapsed)"
        :aria-label="collapsed ? '打开侧边栏' : '收起侧边栏'"
        :title="collapsed ? '打开侧边栏' : '收起侧边栏'"
        @click="emit('toggle-sidebar')"
      >
        <svg v-if="embedded" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM8 3.5v17" /></svg>
        <svg v-else viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M8 3v14" /></svg>
      </button>
      <button class="sidebar-mobile-close" type="button" aria-label="关闭侧边栏" @click="$emit('close-mobile')">×</button>
    </div>

    <div v-if="searchOpen" class="sidebar-search">
      <div class="sidebar-search-field">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input ref="searchInput" v-model="searchQuery" type="search" placeholder="搜索知识库和文档" autocomplete="off" />
        <button v-if="searchQuery" type="button" aria-label="清除搜索" @click="searchQuery = ''">×</button>
      </div>
    </div>

    <div class="sidebar-section sidebar-section--grow">
      <div class="section-label">
        <span>知识库</span>
        <div class="section-label-actions">
          <button
            v-if="!embedded"
            class="sidebar-search-toggle"
            type="button"
            :aria-expanded="searchOpen"
            aria-label="搜索知识库和文档"
            title="搜索"
            @click="toggleSearch"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
          </button>
          <button class="section-create-button" type="button" title="创建知识库" @click="$emit('create-knowledge-base')">＋</button>
        </div>
      </div>
      <div
        v-for="knowledgeBase in filteredKnowledgeBases"
        :key="knowledgeBase.id"
        class="knowledge-base-group"
        :class="{ expanded: isExpanded(knowledgeBase.id) }"
      >
        <div
          class="knowledge-base-row"
          :class="{ selected: knowledgeBase.id === currentKnowledgeBaseId }"
        >
          <button
            class="knowledge-base-expand-toggle"
            type="button"
            :aria-expanded="String(isExpanded(knowledgeBase.id))"
            :aria-label="(isExpanded(knowledgeBase.id) ? '收起' : '展开') + '「' + knowledgeBase.name + '」中的文档'"
            :title="isExpanded(knowledgeBase.id) ? '收起文档' : '展开文档'"
            @click.stop="toggleKnowledgeBase(knowledgeBase)"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg>
          </button>
          <button
            type="button"
            class="knowledge-base-item"
            @click="selectKnowledgeBase(knowledgeBase.id)"
          >
            <span class="kb-icon">◈</span>
            <span class="kb-copy"><strong>{{ knowledgeBase.name }}</strong><small>{{ knowledgeBase.description }}</small></span>
          </button>
          <span v-if="knowledgeBase.is_pinned" class="kb-pinned-mark" title="已置顶" aria-label="已置顶">•</span>
          <button
            class="knowledge-base-menu-button"
            type="button"
            :aria-expanded="String(activeMenuId === knowledgeBase.id)"
            aria-haspopup="menu"
            :aria-label="'打开「' + knowledgeBase.name + '」菜单'"
            title="更多操作"
            @click.stop="toggleMenu(knowledgeBase.id)"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.25" /><circle cx="10" cy="10" r="1.25" /><circle cx="16" cy="10" r="1.25" /></svg>
          </button>
          <div v-if="activeMenuId === knowledgeBase.id" class="knowledge-base-menu" role="menu" @click.stop>
            <button type="button" role="menuitem" @click="requestRename(knowledgeBase)">重命名</button>
            <button type="button" role="menuitem" @click="requestTogglePin(knowledgeBase)">{{ knowledgeBase.is_pinned ? '取消置顶' : '置顶' }}</button>
            <button class="danger" type="button" role="menuitem" @click="requestDelete(knowledgeBase)">删除</button>
          </div>
        </div>

        <div v-if="isExpanded(knowledgeBase.id)" class="knowledge-base-documents">
          <div v-if="isDocumentsLoading(knowledgeBase.id)" class="knowledge-base-documents-state">
            <span class="documents-loading-dot"></span>
            <span>读取文档…</span>
          </div>
          <div v-else-if="documentsErrorFor(knowledgeBase.id)" class="knowledge-base-documents-state documents-error-state">
            <span class="documents-error-copy" :title="documentsErrorFor(knowledgeBase.id)">{{ documentsErrorFor(knowledgeBase.id) }}</span>
            <button type="button" @click.stop="$emit('load-knowledge-base-documents', knowledgeBase.id, true)">重新读取</button>
          </div>
          <template v-else-if="filteredDocumentsFor(knowledgeBase.id).length">
            <div v-for="document in visibleDocumentsFor(knowledgeBase.id)" :key="document.id" class="document-item">
              <div class="document-main">
                <span class="document-icon">▤</span>
                <span class="document-copy"><strong :title="document.title">{{ document.title }}</strong><small :title="documentStatusTitle(document)">{{ documentStatus(document) }}</small></span>
              </div>
              <button
                class="document-delete"
                type="button"
                :disabled="['queued', 'processing'].includes(document.status) || deletingDocumentId === document.id"
                :title="['queued', 'processing'].includes(document.status) ? '文档处理中' : '删除文档'"
                @click="$emit('delete-document', document)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 5.5v7A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5v-7M2.5 4h11M6 4V2.5h4V4M6.5 7v4.5M9.5 7v4.5" /></svg>
              </button>
            </div>
            <p v-if="hiddenDocumentCount(knowledgeBase.id)" class="documents-more">
              还有 {{ hiddenDocumentCount(knowledgeBase.id) }} 份文档
            </p>
          </template>
          <p v-else-if="searchQuery && documentsFor(knowledgeBase.id).length" class="sidebar-empty documents-empty">没有匹配的文档</p>
          <p v-else class="sidebar-empty documents-empty">还没有 PDF</p>
        </div>
      </div>
      <p v-if="searchQuery && !filteredKnowledgeBases.length" class="sidebar-empty">没有匹配的知识库</p>
      <p v-else-if="!knowledgeBases.length" class="sidebar-empty">先创建知识库，再上传 PDF</p>
    </div>

    <div v-if="!embedded" class="sidebar-footer">
      <div class="user-row">
        <span class="user-avatar">{{ initials }}</span>
        <span class="user-copy"><strong>{{ user?.display_name || user?.email || '本地用户' }}</strong><small>{{ user?.email || 'workspace owner' }}</small></span>
        <button type="button" class="logout-button" title="退出登录" @click="$emit('logout')">↗</button>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { isShiYanEmbedded } from '../composables/useApi'

const embedded = isShiYanEmbedded()

const props = defineProps({
  knowledgeBases: { type: Array, default: () => [] },
  documents: { type: Array, default: () => [] },
  documentsByKnowledgeBase: { type: Object, default: () => ({}) },
  documentsLoadingByKnowledgeBase: { type: Object, default: () => ({}) },
  documentsErrorByKnowledgeBase: { type: Object, default: () => ({}) },
  currentKnowledgeBaseId: { type: String, default: '' },
  activeTaskDocumentId: { type: String, default: '' },
  activeTaskKnowledgeBaseId: { type: String, default: '' },
  activeTaskStatus: { type: String, default: '' },
  activeTaskStage: { type: String, default: '' },
  activeTaskProgress: { type: [Number, String], default: 0 },
  activeTaskError: { type: String, default: '' },
  deletingDocumentId: { type: String, default: '' },
  user: { type: Object, default: null },
  mobileOpen: Boolean,
  collapsed: Boolean
})

const emit = defineEmits([
  'select-knowledge-base',
  'delete-document',
  'logout',
  'create-knowledge-base',
  'close-mobile',
  'toggle-sidebar',
  'load-knowledge-base-documents',
  'rename-knowledge-base',
  'toggle-pin-knowledge-base',
  'delete-knowledge-base'
])

const searchOpen = ref(false)
const searchQuery = ref('')
const searchInput = ref(null)
const activeMenuId = ref('')
const expandedKnowledgeBaseIds = ref(new Set())

const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLocaleLowerCase())
function documentsFor(knowledgeBaseId) {
  const cachedDocuments = props.documentsByKnowledgeBase?.[knowledgeBaseId]
  if (Array.isArray(cachedDocuments)) return cachedDocuments
  return knowledgeBaseId === props.currentKnowledgeBaseId ? props.documents : []
}

const filteredKnowledgeBases = computed(() => {
  if (!normalizedSearchQuery.value) return props.knowledgeBases
  return props.knowledgeBases.filter((knowledgeBase) => {
    const text = [knowledgeBase.name, knowledgeBase.description].filter(Boolean).join(' ').toLocaleLowerCase()
    if (text.includes(normalizedSearchQuery.value)) return true
    return documentsFor(knowledgeBase.id).some(document => String(document.title || '').toLocaleLowerCase().includes(normalizedSearchQuery.value))
  })
})

function filteredDocumentsFor(knowledgeBaseId) {
  const items = documentsFor(knowledgeBaseId)
  if (!normalizedSearchQuery.value) return items
  return items.filter(document => String(document.title || '').toLocaleLowerCase().includes(normalizedSearchQuery.value))
}

function visibleDocumentsFor(knowledgeBaseId) {
  return filteredDocumentsFor(knowledgeBaseId).slice(0, 8)
}

function hiddenDocumentCount(knowledgeBaseId) {
  return Math.max(0, filteredDocumentsFor(knowledgeBaseId).length - 8)
}

function isExpanded(knowledgeBaseId) {
  return expandedKnowledgeBaseIds.value.has(knowledgeBaseId)
}

function isDocumentsLoading(knowledgeBaseId) {
  return Boolean(props.documentsLoadingByKnowledgeBase?.[knowledgeBaseId])
}

function documentsErrorFor(knowledgeBaseId) {
  return props.documentsErrorByKnowledgeBase?.[knowledgeBaseId] || ''
}

function toggleKnowledgeBase(knowledgeBase) {
  const next = new Set(expandedKnowledgeBaseIds.value)
  const shouldExpand = !next.has(knowledgeBase.id)
  if (shouldExpand) next.add(knowledgeBase.id)
  else next.delete(knowledgeBase.id)
  expandedKnowledgeBaseIds.value = next
  closeMenu()
  if (shouldExpand) emit('load-knowledge-base-documents', knowledgeBase.id)
}

watch(() => props.currentKnowledgeBaseId, (knowledgeBaseId) => {
  if (!knowledgeBaseId) return
  const next = new Set(expandedKnowledgeBaseIds.value)
  next.add(knowledgeBaseId)
  expandedKnowledgeBaseIds.value = next
}, { immediate: true })

function hasDocumentCache(knowledgeBaseId) {
  return Object.prototype.hasOwnProperty.call(props.documentsByKnowledgeBase || {}, knowledgeBaseId)
}

function requestMissingDocuments(knowledgeBaseIds) {
  for (const knowledgeBaseId of knowledgeBaseIds) {
    if (!hasDocumentCache(knowledgeBaseId)) {
      emit('load-knowledge-base-documents', knowledgeBaseId)
    }
  }
}

function requestSearchDocuments() {
  requestMissingDocuments(props.knowledgeBases.map(knowledgeBase => knowledgeBase.id))
}

function requestExpandedDocuments() {
  const availableIds = new Set(props.knowledgeBases.map(knowledgeBase => knowledgeBase.id))
  requestMissingDocuments(
    [...expandedKnowledgeBaseIds.value].filter(knowledgeBaseId => availableIds.has(knowledgeBaseId))
  )
}

watch(
  () => [searchOpen.value, props.knowledgeBases.map(knowledgeBase => knowledgeBase.id).join('|')],
  ([isOpen]) => {
    if (isOpen) requestSearchDocuments()
  }
)

watch(
  () => [
    props.knowledgeBases.map(knowledgeBase => knowledgeBase.id).join('|'),
    [...expandedKnowledgeBaseIds.value].sort().join('|'),
    Object.keys(props.documentsByKnowledgeBase || {}).sort().join('|')
  ],
  requestExpandedDocuments,
  { immediate: true }
)

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) searchQuery.value = ''
  else nextTick(() => searchInput.value?.focus())
}

function selectKnowledgeBase(knowledgeBaseId) {
  emit('select-knowledge-base', knowledgeBaseId)
  searchQuery.value = ''
  closeMenu()
}

function toggleMenu(knowledgeBaseId) {
  activeMenuId.value = activeMenuId.value === knowledgeBaseId ? '' : knowledgeBaseId
}

function closeMenu() {
  activeMenuId.value = ''
}

function requestRename(knowledgeBase) {
  closeMenu()
  emit('rename-knowledge-base', knowledgeBase)
}

function requestTogglePin(knowledgeBase) {
  closeMenu()
  emit('toggle-pin-knowledge-base', knowledgeBase)
}

function requestDelete(knowledgeBase) {
  closeMenu()
  emit('delete-knowledge-base', knowledgeBase)
}

const initials = computed(() => (props.user?.display_name || props.user?.email || 'U').slice(0, 1).toUpperCase())
const taskStageLabels = {
  queued: '排队中',
  starting: '准备文档',
  inspecting: '检查页面',
  extracting: '页面识别',
  chunking: '整理片段',
  indexing: '语义索引',
  mapping: '知识地图',
  saving: '保存结果',
  completed: '已索引',
  failed: '导入失败'
}

function isActiveTaskDocument(document) {
  return document?.id && document.id === props.activeTaskDocumentId
}

function documentStatus(document) {
  if (isActiveTaskDocument(document) && ['queued', 'processing', 'failed'].includes(props.activeTaskStatus)) {
    if (props.activeTaskStatus === 'queued') return '排队中 · 等待处理'
    const stageLabel = taskStageLabels[props.activeTaskStage] || '处理中'
    return `${stageLabel} · ${Math.max(0, Math.min(100, Number(props.activeTaskProgress) || 0))}%`
  }
  const labels = { queued: '排队中', completed: '已索引', processing: '处理中', failed: '导入失败', duplicate: '重复资料', archived: '已归档' }
  return labels[document.status] || document.status
}

function documentStatusTitle(document) {
  if (isActiveTaskDocument(document) && props.activeTaskError) return props.activeTaskError
  return documentStatus(document)
}
</script>
