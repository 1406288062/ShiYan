// 网页端首页：Dots 为唯一对话入口，对话页不显示左侧大型面板（置顶 / 项目 / 最近 / 新聊天）。
// 仅在网页端（ShiYanPlatform.mode === 'web'）生效；桌面端、iOS 不受影响。
// 变清晰 / 定时任务 / 空间 / 知识库 的左侧面板与原来完全一致：它们也放在同一个 #leftContainer 里，
// 所以只在对话类视图（dots / agent）隐藏该容器，切到这四个功能时恢复原样。
// 不删除任何原有代码；删除 index.html 中引用本文件和 web-dots-home.css 的两行即可完全恢复。
(() => {
  'use strict';
  if (window.ShiYanPlatform?.mode !== 'web') return;

  const CHAT_VIEWS = new Set(['dots', 'agent']);
  const currentView = () => { try { return window.shiyan?.getView?.() || ''; } catch (_) { return ''; } };
  const sync = () => document.body.classList.toggle('web-dots-only', CHAT_VIEWS.has(currentView()));
  const goDots = () => { try { window.shiyan?.navigate?.('dots'); } catch (_) {} };

  window.addEventListener('shiyan-view', () => { sync(); queueMicrotask(sync); });

  // 左侧竖向导航栏外观和按钮保持原样；仅“首页”按钮在网页端打开 Dots（原来打开普通聊天）。
  const bindHome = () => {
    const home = document.getElementById('railHome');
    if (!home || home.dataset.webDotsHome) return;
    home.dataset.webDotsHome = '1';
    home.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); goDots(); }, true);
  };

  // app.js now selects Dots as the web initial view after the Dots module
  // confirms installation. This small poll only waits for the workbench rail
  // to exist so its Home button can be rebound; it never changes the view.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    bindHome(); sync();
    if (document.getElementById('railHome')?.dataset.webDotsHome || tries > 150) clearInterval(timer);
  }, 100);
})();
