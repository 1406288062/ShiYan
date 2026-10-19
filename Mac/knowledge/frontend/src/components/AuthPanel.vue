<template>
  <main class="auth-shell">
    <div class="auth-frame">
      <div class="auth-brand" aria-label="Knowledge Agent">
        <svg class="auth-mark" viewBox="0 0 36 36" aria-hidden="true">
          <rect class="auth-mark-bg" x="1" y="1" width="34" height="34" rx="11" />
          <path class="auth-mark-line" d="M10 12.5 18 18l8-6M18 18v7" />
          <circle class="auth-mark-node" cx="10" cy="12.5" r="2.5" />
          <circle class="auth-mark-node" cx="26" cy="12" r="2.5" />
          <circle class="auth-mark-node" cx="18" cy="25" r="2.5" />
        </svg>
        <span>Knowledge Agent</span>
      </div>

      <section class="auth-card" aria-labelledby="auth-title">
        <div class="auth-heading">
          <h1 id="auth-title">{{ mode === 'login' ? '登录' : '创建账户' }}</h1>
        </div>

        <form class="auth-form" @submit.prevent="submit">
          <label v-if="mode === 'register'" class="auth-field">
            <span class="sr-only">显示名称</span>
            <input v-model.trim="displayName" type="text" maxlength="80" placeholder="显示名称（可选）" autocomplete="name" />
          </label>
          <label class="auth-field">
            <span class="sr-only">邮箱</span>
            <input v-model.trim="email" type="email" autocomplete="email" placeholder="邮箱地址" required />
          </label>
          <label class="auth-field">
            <span class="sr-only">密码</span>
            <input v-model="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" type="password" minlength="8" placeholder="密码（至少 8 位）" required />
          </label>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <button class="auth-submit" type="submit" :disabled="loading">
            <span>{{ loading ? '处理中…' : mode === 'login' ? '登录' : '创建账户' }}</span>
            <span class="auth-submit-arrow" aria-hidden="true">→</span>
          </button>
        </form>

        <p v-if="sessionRetry" class="auth-retry">
          <span>连接暂时中断</span>
          <button type="button" :disabled="loading" @click="emit('retry')">重新连接</button>
        </p>

        <p class="auth-switch">
          <span>{{ mode === 'login' ? '还没有账户？' : '已有账户？' }}</span>
          <button type="button" @click="mode = mode === 'login' ? 'register' : 'login'">
            {{ mode === 'login' ? '创建账户' : '返回登录' }}
          </button>
        </p>
      </section>
    </div>
  </main>
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  loading: Boolean,
  error: { type: String, default: '' },
  sessionRetry: Boolean
})

const emit = defineEmits(['login', 'register', 'retry'])
const mode = ref('login')
const email = ref('')
const password = ref('')
const displayName = ref('')

function submit() {
  if (mode.value === 'login') emit('login', { email: email.value, password: password.value })
  else emit('register', { email: email.value, password: password.value, displayName: displayName.value })
}
</script>
