import { ref, watch } from 'vue'
import { apiFetch } from './useApi.js'

const welcomeMessage = {
  type: 'ai',
  content: '可以解释知识点、比较资料之间的关系，并帮你定位原文页码。',
  citations: []
}

export function useAI({ token, currentKnowledgeBaseId, currentKnowledgeBase }: any) {
  const chatMessages = ref<any[]>([welcomeMessage])
  const loading = ref(false)
  const historyLoading = ref(false)
  const error = ref('')
  const conversationId = ref('')
  let requestId = 0

  function welcomeForKnowledgeBase() {
    chatMessages.value = [{
      ...welcomeMessage,
      content: currentKnowledgeBase.value
        ? '资料已准备好。询问其中的内容，我会同时给出可核对的原文页码。'
        : welcomeMessage.content
    }]
  }

  async function loadHistory(kbId: any) {
    const currentRequestId = ++requestId
    loading.value = false
    historyLoading.value = false
    error.value = ''
    conversationId.value = ''
    welcomeForKnowledgeBase()
    if (!kbId || !token.value) return

    historyLoading.value = true
    try {
      const result = await apiFetch(`/api/chat/history?knowledge_base_id=${encodeURIComponent(kbId)}`, {
        token: token.value
      })
      if (currentRequestId !== requestId || currentKnowledgeBaseId.value !== kbId) return
      conversationId.value = result.conversation_id || ''
      const restoredMessages = Array.isArray(result.messages) ? result.messages : []
      if (restoredMessages.length) {
        chatMessages.value = [chatMessages.value[0], ...restoredMessages]
      }
    } catch (err) {
      if (currentRequestId === requestId && currentKnowledgeBaseId.value === kbId) {
        error.value = (err as any).message || '聊天记录加载失败'
      }
    } finally {
      if (currentRequestId === requestId && currentKnowledgeBaseId.value === kbId) {
        historyLoading.value = false
      }
    }
  }

  watch(
    [() => token.value, () => currentKnowledgeBaseId.value],
    ([, kbId]) => loadHistory(kbId),
    { immediate: true }
  )

  async function sendAiMessage(question: any, allowWeb = false) {
    const q = question.trim()
    const kbId = currentKnowledgeBaseId.value
    if (!q || loading.value || historyLoading.value || !kbId) return
    const currentRequestId = ++requestId

    const history = chatMessages.value.slice(1).map(message => ({
      role: message.type === 'user' ? 'user' : 'assistant',
      content: message.content
    }))
    chatMessages.value.push({ type: 'user', content: q, citations: [] })
    loading.value = true
    error.value = ''

    try {
      const result = await apiFetch('/api/query', {
        token: token.value,
        method: 'POST',
        body: JSON.stringify({
          knowledge_base_id: kbId,
          question: q,
          conversation_id: conversationId.value || undefined,
          history,
          allow_web: allowWeb
        })
      })
      if (currentRequestId !== requestId || currentKnowledgeBaseId.value !== kbId) return result
      conversationId.value = result.conversation_id || conversationId.value
      chatMessages.value.push({
        type: 'ai',
        content: result.answer || '没有生成回答。',
        citations: result.citations || [],
        status: result.status,
        mode: result.mode,
        usedTools: result.used_tools || []
      })
      return result
    } catch (err) {
      if (currentRequestId !== requestId || currentKnowledgeBaseId.value !== kbId) return null
      error.value = (err as any).message || '问答请求失败'
      chatMessages.value.push({
        type: 'ai',
        content: error.value,
        citations: [],
        status: 'error'
      })
      return null
    } finally {
      if (currentRequestId === requestId && currentKnowledgeBaseId.value === kbId) loading.value = false
    }
  }

  async function clearHistory() {
    const kbId = currentKnowledgeBaseId.value
    const currentRequestId = ++requestId
    loading.value = false
    historyLoading.value = false
    error.value = ''
    conversationId.value = ''
    welcomeForKnowledgeBase()
    if (!kbId || !token.value) return

    historyLoading.value = true
    try {
      await apiFetch(`/api/chat/history?knowledge_base_id=${encodeURIComponent(kbId)}`, {
        token: token.value,
        method: 'DELETE'
      })
    } catch (err) {
      if (currentRequestId === requestId) error.value = (err as any).message || '聊天记录清除失败'
    } finally {
      if (currentRequestId === requestId) historyLoading.value = false
    }
  }

  return { chatMessages, loading, error, historyLoading, conversationId, sendAiMessage, clearHistory }
}
