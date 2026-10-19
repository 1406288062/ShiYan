<template>
  <div class="modal" :class="{ active: visible }" @click.self="$emit('close')">
    <div class="modal-content node-detail-modal">
      <header class="node-detail-header">
        <h2 class="node-detail-title">{{ modalTitle }}</h2>
        <button
          class="modal-icon-close"
          type="button"
          aria-label="关闭知识点详情"
          @click="$emit('close')"
        >×</button>
      </header>
      <div class="node-detail-body" v-html="modalBody"></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { sanitizeHtml } from '../utils/sanitize'

const props = defineProps({ visible: Boolean, content: { type: String, default: '' } })
defineEmits(['close'])
const safeContent = computed(() => sanitizeHtml(props.content))

const parsedContent = computed(() => {
  const source = safeContent.value

  if (typeof DOMParser === 'undefined') {
    return { title: '知识点详情', body: source }
  }

  const document = new DOMParser().parseFromString(`<div>${source}</div>`, 'text/html')
  const wrapper = document.body.firstElementChild
  const heading = wrapper?.querySelector('h2')
  const title = heading?.textContent?.trim() || '知识点详情'

  heading?.remove()

  return {
    title,
    body: wrapper?.innerHTML || '',
  }
})

const modalTitle = computed(() => parsedContent.value.title)
const modalBody = computed(() => parsedContent.value.body)
</script>

<style scoped>
/*
 * Keep the knowledge-point window geometrically proportional to the current
 * browser viewport. Using the same viewport percentage for width and height
 * guarantees modalWidth / modalHeight === viewportWidth / viewportHeight.
 */
.node-detail-modal {
  width: 58vw;
  height: 58vh;
  max-width: none;
  max-height: 58vh;
}

.node-detail-body :deep(p),
.node-detail-body :deep(li) {
  font-size: 15px;
  line-height: 1.85;
}

.node-detail-body :deep(h3) {
  font-size: 15px;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .node-detail-modal {
    width: 78vw;
    height: 78vh;
    max-height: 78vh;
  }
}
</style>
