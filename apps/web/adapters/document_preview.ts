/* Runs only inside the opaque-origin DOCX preview frame, never the app frame. */
(() => {
  'use strict';
  const status = document.getElementById('documentStatus');
  const content = document.getElementById('documentContent');
  const source = document.getElementById('documentBytes');
  document.addEventListener('click', event => {
    // Document hyperlinks must not navigate the preview or the surrounding app.
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
  }, true);
  document.addEventListener('submit', event => event.preventDefault(), true);
  function fit() {
    const wrapper = content.querySelector('.docx-wrapper');
    const pages = [...content.querySelectorAll('section.docx')];
    if (!wrapper || !pages.length) return;
    const pageWidth = Math.max(...pages.map(page => page.offsetWidth));
    const scale = Math.min(1, Math.max(0.15, (document.documentElement.clientWidth - 20) / Math.max(1, pageWidth)));
    wrapper.style.zoom = String(scale);
  }
  async function render() {
    try {
      const encoded = source.content.textContent.trim();
      if (!encoded || encoded.length > 45 * 1024 * 1024) throw Error('文档内容无效或过大');
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
      source.remove();
      if (!window.docx?.renderAsync) throw Error('Word 预览组件未能加载');
      await window.docx.renderAsync(bytes, content, document.getElementById('documentStyles'), {
        inWrapper: true, ignoreWidth: false, ignoreHeight: false,
        breakPages: true, ignoreLastRenderedPageBreak: false,
        renderHeaders: true, renderFooters: true, renderFootnotes: true,
        renderEndnotes: true, renderAltChunks: false, renderComments: false,
        useBase64URL: true, experimental: false,
      });
      status.textContent = 'Word 预览；复杂分页和字体以原文件为准。';
      document.documentElement.dataset.previewReady = 'true';
      fit();
      window.addEventListener('resize', fit);
      content.querySelectorAll('img').forEach(image => image.addEventListener('load', fit, {once:true}));
      if (document.fonts?.ready) document.fonts.ready.then(fit);
    } catch (error) {
      status.textContent = (error instanceof Error ? error.message : 'Word 预览失败') + '，请下载原文件查看。';
      status.setAttribute('role', 'alert');
      document.documentElement.dataset.previewError = 'true';
    }
  }
  render();
})();
