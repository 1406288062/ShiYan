import { ref, watch } from 'vue'
import { apiFetch } from './useApi'

export function useUpload({ token, currentKnowledgeBaseId, refreshDocuments, loadKnowledgeBaseDocuments, loadKnowledgeData }) {
  const showTaskStatus = ref(false)
  const taskId = ref('')
  const documentId = ref('')
  const taskKnowledgeBaseId = ref('')
  const taskStatusText = ref('')
  const taskProgress = ref(0)
  const taskStage = ref('')
  const taskStageDone = ref(0)
  const taskStageTotal = ref(0)
  const taskActiveWorkers = ref(0)
  const taskQueueAhead = ref(0)
  const taskError = ref('')
  const uploading = ref(false)
  let pollingTimer = null
  let dismissTimer = null
  let pollingInFlight = false
  let recoveryRevision = 0
  let pollingFailures = 0

  const isActiveStatus = status => status === 'queued' || status === 'processing'

  function applyTask(result) {
    taskId.value = result.task_id || ''
    documentId.value = result.document_id || ''
    taskKnowledgeBaseId.value = result.knowledge_base_id || ''
    taskStatusText.value = result.status || ''
    taskStage.value = result.stage || result.status || ''
    taskProgress.value = Number(result.progress || 0)
    taskStageDone.value = Number(result.stage_done || 0)
    taskStageTotal.value = Number(result.stage_total || 0)
    taskActiveWorkers.value = Number(result.active_workers || 0)
    taskQueueAhead.value = Number(result.queue_ahead || 0)
    taskError.value = result.error || ''
    pollingFailures = 0
  }

  watch(
    () => token.value,
    async (authToken) => {
      const revision = ++recoveryRevision
      clearPolling()
      showTaskStatus.value = false
      applyTask({})
      if (!authToken) return
      try {
        const result = await apiFetch('/api/tasks/active', { token: authToken })
        if (revision !== recoveryRevision || authToken !== token.value) return
        if (result?.task_id && isActiveStatus(result.status)) {
          applyTask(result)
          showTaskStatus.value = true
          startTaskPolling()
        }
      } catch {
        // Recovery is auxiliary; regular workspace loading remains usable.
      }
    },
    { immediate: true }
  )

  async function refreshTaskKnowledgeBase(kbId) {
    if (!kbId) {
      await refreshDocuments().catch(() => {})
      return
    }

    if (loadKnowledgeBaseDocuments) {
      await loadKnowledgeBaseDocuments(kbId, true)
    } else if (kbId === currentKnowledgeBaseId.value) {
      await refreshDocuments()
    }

    if (kbId === currentKnowledgeBaseId.value) {
      await loadKnowledgeData(kbId)
    }
  }

  async function pollTask() {
    const currentTaskId = taskId.value
    if (!currentTaskId || pollingInFlight) return
    pollingInFlight = true
    try {
      const result = await apiFetch(`/api/tasks/${currentTaskId}`, { token: token.value })
      pollingFailures = 0
      if (currentTaskId !== taskId.value) return result
      taskStatusText.value = result.status
      taskStage.value = result.stage || result.status || ''
      taskProgress.value = Number(result.progress || 0)
      taskStageDone.value = Number(result.stage_done || 0)
      taskStageTotal.value = Number(result.stage_total || 0)
      taskActiveWorkers.value = Number(result.active_workers || 0)
      taskQueueAhead.value = Number(result.queue_ahead || 0)
      taskError.value = result.error || ''
      if (result.document_id) documentId.value = result.document_id
      if (result.knowledge_base_id) taskKnowledgeBaseId.value = result.knowledge_base_id
      if (result.status === 'completed' || result.status === 'failed') {
        clearPolling()
        try {
          await refreshTaskKnowledgeBase(result.knowledge_base_id || taskKnowledgeBaseId.value)
        } catch (refreshError) {
          if (currentTaskId === taskId.value && !taskError.value) {
            taskError.value = refreshError.message || '知识库状态刷新失败'
          }
        }
        if (result.status === 'completed') {
          if (dismissTimer) window.clearTimeout(dismissTimer)
          dismissTimer = window.setTimeout(() => {
            if (currentTaskId === taskId.value && taskStatusText.value === 'completed') showTaskStatus.value = false
          }, 2200)
        }
      }
      return result
    } catch (err) {
      if (currentTaskId !== taskId.value) return
      if (err.status === 404) {
        taskStatusText.value = 'failed'
        taskStage.value = 'failed'
        taskError.value = '任务记录不存在'
        clearPolling()
        return
      }
      if (err.status === 401 || err.status === 403) {
        taskError.value = '登录状态已失效，请重新登录后查看任务'
        clearPolling()
        return
      }
      pollingFailures += 1
      taskError.value = pollingFailures >= 2
        ? '进度连接暂时中断，正在自动重试'
        : ''
    } finally {
      pollingInFlight = false
    }
  }

  function startTaskPolling() {
    clearPolling()
    pollTask().catch(() => {})
    pollingTimer = window.setInterval(() => pollTask().catch(() => {}), 2000)
  }

  async function handleUpload(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      throw new Error('请选择 PDF 文件')
    }
    const kbId = currentKnowledgeBaseId.value
    if (!kbId) throw new Error('请先选择知识库')
    if (isActiveStatus(taskStatusText.value)) throw new Error('当前 PDF 仍在处理中')

    uploading.value = true
    if (dismissTimer) {
      window.clearTimeout(dismissTimer)
      dismissTimer = null
    }
    taskError.value = ''
    const formData = new FormData()
    formData.append('file', file)
    try {
      const result = await apiFetch(`/api/knowledge-bases/${kbId}/documents`, {
        token: token.value,
        method: 'POST',
        body: formData
      })
      applyTask({ ...result, knowledge_base_id: result.knowledge_base_id || kbId })
      showTaskStatus.value = true
      if (loadKnowledgeBaseDocuments) await loadKnowledgeBaseDocuments(kbId, true).catch(() => {})
      else await refreshDocuments().catch(() => {})
      startTaskPolling()
      return result
    } catch (err) {
      taskError.value = err.message || '上传失败'
      throw err
    } finally {
      uploading.value = false
    }
  }

  function clearPolling() {
    if (pollingTimer) {
      window.clearInterval(pollingTimer)
      pollingTimer = null
    }
    if (dismissTimer) {
      window.clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  return {
    showTaskStatus,
    taskId,
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
  }
}
