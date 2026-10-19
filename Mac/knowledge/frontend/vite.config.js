/**
 * vite.config.js — Vite 构建配置
 * ===============================
 * 职责：
 *   - 加载 @vitejs/plugin-vue 插件处理 .vue 文件
 *   - 开发服务器端口 5174
 *   - /api 代理到 http://localhost:8001（FastAPI 后端）
 *
 * 这样开发时前端 localhost:5174/api/xxx 的请求会被转发到后端 8001 端口，避免跨域问题。
 */

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8001'
    }
  }
})
