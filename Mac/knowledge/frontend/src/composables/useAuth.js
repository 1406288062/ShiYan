import {setKnowledgeCacheOwner, clearKnowledgeCache} from './knowledgeCache'
import { ref } from 'vue'
import { apiFetch, isShiYanEmbedded, primeKnowledgeCache } from './useApi'

const TOKEN_KEY = 'knowledgeAgentToken'

export function useAuth() {
  const embedded = isShiYanEmbedded()
  // This marker only activates the original composables; no credential enters the iframe.
  const token = ref(embedded ? 'shiyan-account-session' : localStorage.getItem(TOKEN_KEY) || '')
  const user = ref(null)
  const ready = ref(false)
  const loading = ref(false)
  const error = ref('')
  const sessionRecoveryAvailable = ref(false)

  function saveSession(result) {
    token.value = result.access_token
    user.value = result.user
    setKnowledgeCacheOwner(result.user.id)
    localStorage.setItem(TOKEN_KEY, token.value)
  }

  async function bootstrap() {
    if (loading.value) return false
    sessionRecoveryAvailable.value = false
    if (embedded) {
      loading.value = true
      error.value = ''
      try {
        const account = window.parent !== window ? window.parent.ShiYanAccount : null
        const current = account ? await account.ready : (await apiFetch('/api/auth/me')).user
        if (!current?.id) throw new Error('请在拾燕中登录')
        setKnowledgeCacheOwner(current.id)
        await primeKnowledgeCache()
        user.value = { ...current, display_name: current.display_name || current.displayName || current.email }
        return true
      } catch (err) {
        sessionRecoveryAvailable.value = true
        error.value = err.message || '暂时无法连接拾燕，请稍后重试'
        return false
      } finally {
        ready.value = true
        loading.value = false
      }
    }
    if (!token.value) {
      ready.value = true
      return false
    }
    loading.value = true
    error.value = ''
    try {
      const result = await apiFetch('/api/auth/me', { token: token.value })
      user.value = result.user
      setKnowledgeCacheOwner(result.user.id)
      return true
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        logout()
      } else {
        sessionRecoveryAvailable.value = true
        error.value = err.message || '暂时无法连接服务器，请稍后重试'
      }
      return false
    } finally {
      ready.value = true
      loading.value = false
    }
  }

  async function authenticate(path, payload) {
    if (embedded) throw new Error('请使用拾燕的账户登录')
    loading.value = true
    error.value = ''
    sessionRecoveryAvailable.value = false
    try {
      const result = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(payload)
      })
      saveSession(result)
      ready.value = true
      return result
    } catch (err) {
      error.value = err.message || '认证失败，请稍后重试'
      throw err
    } finally {
      loading.value = false
    }
  }

  function login(email, password) {
    return authenticate('/api/auth/login', { email, password })
  }

  function register(email, password, displayName) {
    return authenticate('/api/auth/register', { email, password, display_name: displayName })
  }

  function logout() {
    clearKnowledgeCache(); setKnowledgeCacheOwner('')
    if (embedded) {
      const account = window.parent !== window ? window.parent.ShiYanAccount : null
      if (account) return account.logout(document.createElement('button'))
      return apiFetch('/api/auth/logout', { method: 'POST', body: '{}' }).then(() => window.location.reload())
    }
    token.value = ''
    user.value = null
    sessionRecoveryAvailable.value = false
    ready.value = true
    localStorage.removeItem(TOKEN_KEY)
  }

  return { token, user, ready, loading, error, sessionRecoveryAvailable, bootstrap, login, register, logout }
}
