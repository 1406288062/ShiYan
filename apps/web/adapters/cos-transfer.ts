/* Browser-only image transport. Account authentication stays on our own origin. */
(() => {
  'use strict';
  if (window.ShiYanPlatform?.mode !== 'web') return;
  const fail = (message, status) => Object.assign(new Error(message),
    {code: 'COS_UPLOAD_FAILED', ...(status ? {status} : {})});
  function validateUpload(upload, file) {
    let url;
    try { url = new URL(upload?.url); } catch (_) {}
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash ||
        (url.port && url.port !== '443') ||
        !/^[a-z0-9][a-z0-9-]*-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(url.hostname) ||
        !url.searchParams.get('q-signature') || upload.method !== 'PUT' ||
        typeof upload.ticketId !== 'string' || !upload.ticketId) {
      throw fail('图片上传地址无效，请刷新页面后重试');
    }
    const headers = upload.headers;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers))
      throw fail('图片上传凭证不完整，请重试');
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (!['content-type', 'content-length', 'x-cos-acl', 'x-cos-security-token'].includes(key) ||
          typeof value !== 'string' || /[\r\n]/.test(value) ||
          (key === 'content-length' && value !== String(file.size)) ||
          (key === 'x-cos-acl' && value !== 'private')) {
        throw fail('图片上传凭证无效，请重试');
      }
    }
    if (!Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'x-cos-acl' && value === 'private'))
      throw fail('图片上传凭证缺少隐私保护，请重试');
  }
  function put(upload, file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false, timer;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const alive = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(fail('图片上传长时间没有进展，请检查网络后重试', 408));
          xhr.abort();
        }, 120000);
      };
      xhr.open('PUT', upload.url);
      xhr.withCredentials = false;
      // No application cookies, Authorization or X-Shiyan-Local on the COS request.
      for (const [name, value] of Object.entries(upload.headers)) {
        if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = event => {
        if (settled) return;
        alive(); progress(Math.min(file.size, Math.max(0, event.loaded)), false);
      };
      xhr.upload.onload = () => { if (!settled) { alive(); progress(file.size, true); } };
      xhr.onprogress = () => { if (!settled) alive(); };
      xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? null :
        fail(xhr.status === 403 ? '图片上传授权已过期，请重试' : '图片上传未成功，请检查网络后重试', xhr.status));
      xhr.onerror = () => finish(fail('图片上传连接中断，请检查网络后重试'));
      xhr.onabort = () => finish(fail('图片上传已中断'));
      alive();
      try { xhr.send(file); } catch (_) { finish(fail('图片上传未能开始，请检查网络后重试')); }
    });
  }
  async function upload(files, kind, api, onProgress, purpose) {
    if (window.ShiYanPlatform?.mode !== 'web' || kind !== 'input' || purpose !== 'enhance') return null;
    const items = Array.from(files);
    if (!items.length || items.length > 10) throw fail('一次最多上传 10 张增强图片');
    const plan = await api('/api/assets/cos/upload', 'POST', {kind, purpose, files: items.map(file =>
      ({name: file.name || 'image.png', size: file.size, type: file.type || ''}))});
    // Legacy upload is allowed only before any bytes went to COS and only when unconfigured.
    if (plan.available === false) return null;
    if (plan.available !== true || !Array.isArray(plan.uploads) || plan.uploads.length !== items.length || !items.length)
      throw fail('图片上传凭证不完整，请重试');
    plan.uploads.forEach((entry, index) => validateUpload(entry, items[index]));
    const total = items.reduce((sum, file) => sum + file.size, 0);
    let uploaded = 0;
    for (let index = 0; index < items.length; index++) {
      await put(plan.uploads[index], items[index], (loaded, sent) => {
        try { onProgress?.({loaded: uploaded + loaded, total,
          percent: total ? Math.min(100, Math.floor((uploaded + loaded) / total * 100)) : null,
          sent: sent && index === items.length - 1}); } catch (_) {}
      });
      uploaded += items[index].size;
    }
    const data = await api('/api/assets/cos/complete', 'POST', {ticketIds: plan.uploads.map(entry => entry.ticketId)});
    if (!Array.isArray(data.assets) || data.assets.length !== items.length)
      throw fail('图片已发送，但保存结果未确认，请重试');
    return data;
  }
  window.ShiYanCosTransfer = {upload};
})();
