<template>
  <aside v-if="visible" class="task-status workspace-task-status">
    <div class="task-heading"><strong>{{ statusLabel }}</strong><button type="button" class="task-dismiss" aria-label="关闭进度" @click="$emit('close')">×</button></div>
    <div class="task-progress-track"><span :style="{ width: progress + '%' }"></span></div>
    <div class="task-progress-label"><span>{{ progressText }}</span><strong>{{ statusText === 'queued' ? '等待' : progress + '%' }}</strong></div>
    <p v-if="error" class="task-error">{{ error }}</p>
  </aside>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  visible: Boolean,
  statusText: { type: String, default: '' },
  stage: { type: String, default: '' },
  progress: { type: [Number, String], default: 0 },
  stageDone: { type: [Number, String], default: 0 },
  stageTotal: { type: [Number, String], default: 0 },
  activeWorkers: { type: [Number, String], default: 0 },
  queueAhead: { type: [Number, String], default: 0 },
  error: { type: String, default: '' }
})

defineEmits(['close'])

const statusLabel = computed(() => ({
  queued: '已加入处理队列',
  processing: 'PDF 正在处理中',
  completed: '知识库已更新',
  failed: '任务失败'
}[props.statusText] || '正在准备'))

const progressText = computed(() => {
  if (props.statusText === 'failed') return '请检查文件后重试'
  if (props.statusText === 'completed') return '可以开始浏览'
  if (props.statusText === 'queued') {
    return Number(props.queueAhead) > 0
      ? '前面还有 ' + Number(props.queueAhead) + ' 个任务'
      : '等待后台开始处理'
  }

  const labels = {
    starting: '准备文档',
    inspecting: '检查页面质量',
    extracting: '页面视觉识别',
    chunking: '整理知识片段',
    indexing: 'Embedding 向量化',
    mapping: '知识地图生成',
    saving: '保存知识地图'
  }
  const label = labels[props.stage] || '准备处理'
  const done = Number(props.stageDone) || 0
  const total = Number(props.stageTotal) || 0
  const workers = Number(props.activeWorkers) || 0
  const countText = total > 0 ? ' ' + Math.min(done, total) + ' / ' + total : ''
  const workerText = workers > 0 ? ' · ' + workers + ' 个 Agent 工作中' : ''
  return label + countText + workerText
})
</script>
