import {readKnowledgeCache} from './knowledgeCache'
import { ref, computed, watch } from 'vue'
import { apiFetch } from './useApi'

export function useWorkspace({ token }) {
  const spaces = ref([])
  const knowledgeBases = ref([])
  const documents = ref([])
  const documentsByKnowledgeBase = ref({})
  const documentsLoadingByKnowledgeBase = ref({})
  const documentsErrorByKnowledgeBase = ref({})
  const currentSpaceId = ref('')
  const currentKnowledgeBaseId = ref('')
  const loading = ref(false)
  const error = ref('')
  let spacesRequestId = 0
  let spaceRequestId = 0
  let knowledgeBaseRequestId = 0
  let documentsRequestId = 0
  const documentsRequests = new Map()

  const currentKnowledgeBase = computed(() => knowledgeBases.value.find(item => item.id === currentKnowledgeBaseId.value) || null)

  function sortKnowledgeBases(items) {
    return [...items].sort((left, right) => {
      const pinOrder = Number(Boolean(right.is_pinned)) - Number(Boolean(left.is_pinned))
      if (pinOrder) return pinOrder
      return String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || ''))
    })
  }

  function clearError() { error.value = '' }

  function cacheDocuments(kbId, items) {
    documentsByKnowledgeBase.value = { ...documentsByKnowledgeBase.value, [kbId]: items }
  }

  function setDocumentsLoading(kbId, value) {
    const next = { ...documentsLoadingByKnowledgeBase.value }
    if (value) next[kbId] = true
    else delete next[kbId]
    documentsLoadingByKnowledgeBase.value = next
  }

  function setDocumentsError(kbId, message) {
    const next = { ...documentsErrorByKnowledgeBase.value }
    if (message) next[kbId] = message
    else delete next[kbId]
    documentsErrorByKnowledgeBase.value = next
  }

  async function loadKnowledgeBaseDocuments(kbId, force = false) {
    if (!kbId) return []
    const hasCache = Object.prototype.hasOwnProperty.call(documentsByKnowledgeBase.value, kbId)
    if (hasCache && currentKnowledgeBaseId.value === kbId) documents.value = documentsByKnowledgeBase.value[kbId]

    const pendingRequest = documentsRequests.get(kbId)
    if (pendingRequest && !force) return pendingRequest
    setDocumentsError(kbId, '')

    setDocumentsLoading(kbId, true)
    const request = apiFetch(`/api/knowledge-bases/${kbId}/documents`, { token: token.value, onCached: items => { cacheDocuments(kbId, items); if (currentKnowledgeBaseId.value === kbId) documents.value = items } })
      .then((result) => {
        if (documentsRequests.get(kbId) !== request) return result
        const stillVisible = knowledgeBases.value.some(item => item.id === kbId)
        if (stillVisible) cacheDocuments(kbId, result)
        if (currentKnowledgeBaseId.value === kbId) documents.value = result
        setDocumentsError(kbId, '')
        return result
      })
      .catch((err) => {
        if (documentsRequests.get(kbId) === request) {
          setDocumentsError(kbId, err.message || '文档读取失败')
        }
        throw err
      })
      .finally(() => {
        if (documentsRequests.get(kbId) !== request) return
        documentsRequests.delete(kbId)
        setDocumentsLoading(kbId, false)
      })
    documentsRequests.set(kbId, request)
    return request
  }

  async function loadSpaces() {
    const requestId = ++spacesRequestId
    const initialSpaceRequestId = spaceRequestId
    const previousSpaceId = currentSpaceId.value
    const previousKnowledgeBaseId = currentKnowledgeBaseId.value
    loading.value = true
    clearError()
    const cachedSpaces = readKnowledgeCache('/api/spaces')
    if (!currentSpaceId.value && cachedSpaces?.length) {
      spaces.value = cachedSpaces
      currentSpaceId.value = cachedSpaces[0].id
      knowledgeBases.value = sortKnowledgeBases(readKnowledgeCache(`/api/spaces/${currentSpaceId.value}/knowledge-bases`) || [])
      if (knowledgeBases.value.length) {
        currentKnowledgeBaseId.value = knowledgeBases.value[0].id
        documents.value = readKnowledgeCache(`/api/knowledge-bases/${currentKnowledgeBaseId.value}/documents`) || []
      }
    }
    try {
      const result = await apiFetch('/api/spaces', { token: token.value, onCached: items => { if (requestId === spacesRequestId) spaces.value = items } })
      if (requestId !== spacesRequestId) return
      spaces.value = result
      const selected = spaces.value.find(item => item.id === previousSpaceId) || spaces.value[0]
      if (selected) await selectSpace(selected.id, selected.id === previousSpaceId ? previousKnowledgeBaseId : '')
    } catch (err) {
      if (requestId === spacesRequestId) {
        error.value = err.message || '空间加载失败'
        if (spaceRequestId === initialSpaceRequestId) loading.value = false
      }
    } finally {
      if (requestId === spacesRequestId && !spaces.value.length) loading.value = false
    }
  }

  async function selectSpace(spaceId, preferredKnowledgeBaseId = '') {
    const requestId = ++spaceRequestId
    ++knowledgeBaseRequestId
    ++documentsRequestId
    clearError()
    currentSpaceId.value = spaceId
    currentKnowledgeBaseId.value = ''
    knowledgeBases.value = []
    documents.value = []
    documentsByKnowledgeBase.value = {}
    documentsLoadingByKnowledgeBase.value = {}
    documentsErrorByKnowledgeBase.value = {}
    documentsRequests.clear()
    loading.value = true
    const cachedBases = readKnowledgeCache(`/api/spaces/${spaceId}/knowledge-bases`)
    if (cachedBases) {
      knowledgeBases.value = sortKnowledgeBases(cachedBases)
      const selected = knowledgeBases.value.find(item => item.id === preferredKnowledgeBaseId) || knowledgeBases.value[0]
      if (selected) {
        currentKnowledgeBaseId.value = selected.id
        documents.value = readKnowledgeCache(`/api/knowledge-bases/${selected.id}/documents`) || []
      }
    }
    try {
      const result = await apiFetch(`/api/spaces/${spaceId}/knowledge-bases`, { token: token.value, onCached: items => { if (requestId === spaceRequestId && currentSpaceId.value === spaceId) knowledgeBases.value = sortKnowledgeBases(items) } })
      if (requestId !== spaceRequestId || currentSpaceId.value !== spaceId) return
      knowledgeBases.value = sortKnowledgeBases(result)
      const selected = knowledgeBases.value.find(item => item.id === preferredKnowledgeBaseId) || knowledgeBases.value[0]
      if (selected) await selectKnowledgeBase(selected.id, false)
    } catch (err) {
      if (requestId === spaceRequestId && currentSpaceId.value === spaceId) error.value = err.message || '知识库加载失败'
    } finally {
      if (requestId === spaceRequestId && currentSpaceId.value === spaceId) loading.value = false
    }
  }

  async function selectKnowledgeBase(kbId, invalidateSpace = true) {
    const requestId = ++knowledgeBaseRequestId
    const documentRequestId = ++documentsRequestId
    if (invalidateSpace) ++spaceRequestId
    clearError()
    currentKnowledgeBaseId.value = kbId
    documents.value = []
    loading.value = true
    try {
      const result = await loadKnowledgeBaseDocuments(kbId)
      if (requestId !== knowledgeBaseRequestId || documentRequestId !== documentsRequestId || currentKnowledgeBaseId.value !== kbId) return
      documents.value = result
    } catch (err) {
      if (requestId === knowledgeBaseRequestId && documentRequestId === documentsRequestId && currentKnowledgeBaseId.value === kbId) {
        error.value = err.message || '文档加载失败'
      }
    } finally {
      if (requestId === knowledgeBaseRequestId && documentRequestId === documentsRequestId && currentKnowledgeBaseId.value === kbId) {
        loading.value = false
      }
    }
  }


  async function createKnowledgeBase(name, description = '') {
    const spaceId = currentSpaceId.value
    if (!spaceId) return null
    const result = await apiFetch(`/api/spaces/${spaceId}/knowledge-bases`, {
      token: token.value,
      method: 'POST',
      body: JSON.stringify({ name, description })
    })
    await selectSpace(spaceId, result.id)
    return result
  }

  async function updateKnowledgeBase(kbId, payload) {
    const result = await apiFetch(`/api/knowledge-bases/${kbId}`, {
      token: token.value,
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    knowledgeBases.value = sortKnowledgeBases(
      knowledgeBases.value.map(item => item.id === kbId ? { ...item, ...result } : item)
    )
    return result
  }

  async function deleteKnowledgeBase(kbId) {
    const result = await apiFetch(`/api/knowledge-bases/${kbId}`, {
      token: token.value,
      method: 'DELETE'
    })
    const wasCurrent = currentKnowledgeBaseId.value === kbId
    knowledgeBases.value = knowledgeBases.value.filter(item => item.id !== kbId)
    const nextDocuments = { ...documentsByKnowledgeBase.value }
    const nextDocumentErrors = { ...documentsErrorByKnowledgeBase.value }
    delete nextDocumentErrors[kbId]
    documentsErrorByKnowledgeBase.value = nextDocumentErrors
    delete nextDocuments[kbId]
    documentsByKnowledgeBase.value = nextDocuments
    documentsRequests.delete(kbId)
    setDocumentsLoading(kbId, false)
    if (wasCurrent) {
      currentKnowledgeBaseId.value = ''
      documents.value = []
      const nextKnowledgeBase = knowledgeBases.value[0]
      if (nextKnowledgeBase) await selectKnowledgeBase(nextKnowledgeBase.id)
    }
    return result
  }

  async function refreshDocuments() {
    const kbId = currentKnowledgeBaseId.value
    if (!kbId) return []
    const requestId = ++documentsRequestId
    const result = await loadKnowledgeBaseDocuments(kbId, true)
    if (requestId !== documentsRequestId || currentKnowledgeBaseId.value !== kbId) return result
    documents.value = result
    return documents.value
  }

  async function deleteDocument(documentId, knowledgeBaseId = currentKnowledgeBaseId.value) {
    const result = await apiFetch(`/api/documents/${documentId}`, {
      token: token.value,
      method: 'DELETE'
    })
    if (knowledgeBaseId === currentKnowledgeBaseId.value) await refreshDocuments()
    else await loadKnowledgeBaseDocuments(knowledgeBaseId, true)
    return result
  }

  watch(() => token.value, (value) => {
    ++spacesRequestId
    ++spaceRequestId
    ++knowledgeBaseRequestId
    ++documentsRequestId
    if (!value) {
      spaces.value = []
      knowledgeBases.value = []
      documents.value = []
      documentsByKnowledgeBase.value = {}
      documentsErrorByKnowledgeBase.value = {}
      documentsLoadingByKnowledgeBase.value = {}
      documentsRequests.clear()
      currentSpaceId.value = ''
      currentKnowledgeBaseId.value = ''
      loading.value = false
    }
  })

  return {
    knowledgeBases,
    documents,
    documentsByKnowledgeBase,
    documentsErrorByKnowledgeBase,
    documentsLoadingByKnowledgeBase,
    currentKnowledgeBase,
    currentKnowledgeBaseId,
    loading,
    error,
    loadSpaces,
    selectKnowledgeBase,
    loadKnowledgeBaseDocuments,
    createKnowledgeBase,
    updateKnowledgeBase,
    deleteKnowledgeBase,
    refreshDocuments,
    deleteDocument
  }
}
