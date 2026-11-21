/**
 * main.js — Vue 应用入口
 * ======================
 * 职责：创建 Vue 应用实例，挂载到 index.html 的 #app 元素。
 * 全局导入 index.css（工作台、知识地图、弹窗和主题样式）。
 *
 * 依赖：vue (Vue 3.5+)
 */

import { createApp } from 'vue'
import App from './App.vue'
import './assets/index.css'

if (typeof window !== 'undefined' && window.matchMedia) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.body.classList.toggle('light-theme', !prefersDark)
}

createApp(App).mount('#app')
