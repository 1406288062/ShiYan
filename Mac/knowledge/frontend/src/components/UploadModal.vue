<template>
  <div class="upload-modal" :class="{ active: visible }" @click.self="$emit('close')">
    <div
      class="upload-modal-content workspace-modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      aria-describedby="upload-modal-description"
    >
      <button class="modal-icon-close" type="button" aria-label="关闭上传窗口" @click="$emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <h3 id="upload-modal-title">上传 PDF</h3>
      <p id="upload-modal-description" class="modal-description">加入 <strong>{{ knowledgeBaseName }}</strong></p>
      <form @submit.prevent="onSubmit">
        <label
          class="drop-zone"
          :class="{ selected: selectedFile, dragging: isDragging, invalid: Boolean(displayError) }"
          for="pdf-file"
          @dragenter.prevent="onDragEnter"
          @dragover.prevent="onDragOver"
          @dragleave.prevent="onDragLeave"
          @drop.prevent="onDrop"
        >
          <span class="drop-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0 4 4m-4-4L8 8" /><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></svg>
          </span>
          <strong>{{ selectedFile?.name || '选择或拖入 PDF 文件' }}</strong>
          <small>{{ selectedFile ? `${formatSize(selectedFile.size)} · 点击更换文件` : 'PDF 文件 · 单文件最大 50 MB' }}</small>
          <input id="pdf-file" ref="fileRef" type="file" accept=".pdf,application/pdf" @change="onFileChange" />
        </label>
        <p v-if="displayError" class="form-error" role="alert">{{ displayError }}</p>
        <div class="form-actions modal-actions">
          <button type="submit" class="primary-button" :disabled="uploading || !selectedFile">{{ uploading ? '上传中…' : '上传' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const MAX_FILE_SIZE = 50 * 1024 * 1024

const props = defineProps({
  visible: Boolean,
  uploading: Boolean,
  error: { type: String, default: '' },
  knowledgeBaseName: { type: String, default: '' }
})

const emit = defineEmits(['close', 'upload'])
const fileRef = ref(null)
const selectedFile = ref(null)
const isDragging = ref(false)
const localError = ref('')
const externalErrorDismissed = ref(false)
let dragDepth = 0

const displayError = computed(() => localError.value || (externalErrorDismissed.value ? '' : props.error))

watch(() => props.visible, (visible) => {
  if (visible) return
  selectedFile.value = null
  isDragging.value = false
  localError.value = ''
  externalErrorDismissed.value = false
  dragDepth = 0
  if (fileRef.value) fileRef.value.value = ''
})

watch(() => props.error, (value) => {
  if (value) externalErrorDismissed.value = false
})

function onFileChange(event) {
  setFile(event.target.files?.[0] || null)
}

function onDragEnter() {
  dragDepth += 1
  isDragging.value = true
}

function onDragOver() {
  isDragging.value = true
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) isDragging.value = false
}

function onDrop(event) {
  dragDepth = 0
  isDragging.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length > 1) {
    selectedFile.value = null
    localError.value = '一次只能上传一个 PDF 文件'
    externalErrorDismissed.value = true
    return
  }
  setFile(files[0] || null)
}

function setFile(file) {
  localError.value = ''
  externalErrorDismissed.value = true
  if (!file) {
    selectedFile.value = null
    return
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    selectedFile.value = null
    localError.value = '请选择 PDF 文件'
    resetFileInput()
    return
  }
  if (file.size > MAX_FILE_SIZE) {
    selectedFile.value = null
    localError.value = '文件不能超过 50 MB'
    resetFileInput()
    return
  }
  selectedFile.value = file
}

function resetFileInput() {
  if (fileRef.value) fileRef.value.value = ''
}

function onSubmit() {
  if (!selectedFile.value) {
    localError.value = '请选择 PDF 文件'
    return
  }
  emit('upload', selectedFile.value)
}

function formatSize(size) {
  if (!size) return '0 KB'
  return (size / 1024 / 1024).toFixed(2) + ' MB'
}
</script>
