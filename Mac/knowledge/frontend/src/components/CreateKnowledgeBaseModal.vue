<template>
  <div v-if="visible" class="modal create-kb-modal active" @click.self="$emit('close')">
    <section class="modal-content compact-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-modal-title">
      <button class="modal-icon-close" type="button" aria-label="关闭" @click="$emit('close')">×</button>
      <h2 id="knowledge-base-modal-title">{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
      <form @submit.prevent="submit">
        <label class="sr-only" for="knowledge-base-name">知识库名称</label>
        <input
          id="knowledge-base-name"
          ref="inputRef"
          v-model.trim="name"
          maxlength="120"
          autocomplete="off"
          :placeholder="placeholder"
          required
        />
        <button class="primary-button" type="submit" :disabled="loading || !name">
          {{ loading ? loadingLabel : submitLabel }}
        </button>
      </form>
    </section>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'

const props = defineProps({
  visible: Boolean,
  loading: Boolean,
  title: { type: String, default: '创建知识库' },
  description: { type: String, default: '' },
  submitLabel: { type: String, default: '创建并进入' },
  loadingLabel: { type: String, default: '创建中…' },
  placeholder: { type: String, default: '例如：Java 面试' },
  initialName: { type: String, default: '' }
})
const emit = defineEmits(['close', 'create'])
const inputRef = ref(null)
const name = ref('')

watch(() => props.visible, async (visible) => {
  if (!visible) {
    name.value = ''
    return
  }
  name.value = props.initialName
  await nextTick()
  inputRef.value?.focus()
})

function submit() {
  const value = name.value.trim()
  if (value && !props.loading) emit('create', value)
}
</script>
