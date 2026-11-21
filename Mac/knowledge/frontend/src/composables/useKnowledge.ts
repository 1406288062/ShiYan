import { ref, watch } from 'vue'
import { apiFetch } from './useApi.js'

export function useKnowledge({ token, currentKnowledgeBaseId }: any) {
  const knowledgeData = ref(null)
  const loading = ref(false)
  const error = ref('')
  let requestId = 0

  async function loadKnowledgeData(kbId = currentKnowledgeBaseId.value) {
    const currentRequestId = ++requestId
    if (!kbId) {
      knowledgeData.value = null
      loading.value = false
      error.value = ''
      return null
    }
    knowledgeData.value = null
    loading.value = true
    error.value = ''
    try {
      const result = await apiFetch(`/api/knowledge-bases/${kbId}/knowledge`, { token: token.value, onCached: (value: any) => { if (currentRequestId === requestId && currentKnowledgeBaseId.value === kbId) knowledgeData.value = value } })
      if (currentRequestId !== requestId || currentKnowledgeBaseId.value !== kbId) return result
      knowledgeData.value = result
      return knowledgeData.value
    } catch (err) {
      if (currentRequestId !== requestId || currentKnowledgeBaseId.value !== kbId) return null
      error.value = (err as any).message || '知识图谱加载失败'
      if ([401,403,404].includes((err as any).status)) knowledgeData.value = null
      throw err
    } finally {
      if (currentRequestId === requestId && currentKnowledgeBaseId.value === kbId) loading.value = false
    }
  }

  watch(() => currentKnowledgeBaseId.value, (kbId) => {
    if (kbId) loadKnowledgeData(kbId).catch(() => {})
    else loadKnowledgeData('')
  })

  return { knowledgeData, loading, error, loadKnowledgeData }
}
