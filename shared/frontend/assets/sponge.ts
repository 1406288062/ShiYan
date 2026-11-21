(() => {
  'use strict';
  const accountUrl = 'https://mcp.yandot.ai/account';
  const api = (action: any, method = 'GET') => {
    if (!window.ShiYanAccount?.request) throw new Error('\u8d26\u6237\u670d\u52a1\u5c1a\u672a\u5c31\u7eea\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u8fde\u63a5\u5668\u3002');
    return window.ShiYanAccount.request('/integrations/sponge/' + action, method, method === 'POST' ? {} : undefined);
  };
  const nativeAvailable = () => window.ShiYanPlatform?.adapter('native')?.available?.() === true;
  function openExternal(url: any) {
    if (nativeAvailable() && window.ShiYanPlatform.postNative('openExternal', {url}) === true) return true;
    try {
      const popup = window.open(url, '_blank');
      if (popup) popup.opener = null;
      return !!popup;
    } catch { return false; }
  }
  function authorizeUrl(value: any) {
    let url;
    try { url = new URL(value); } catch { throw new Error('\u8fde\u63a5\u5730\u5740\u65e0\u6548\uff0c\u8bf7\u91cd\u8bd5\u3002'); }
    if (url.origin !== 'https://mcp.yandot.ai' || url.pathname !== '/oauth/authorize' ||
        url.username || url.password || url.hash ||
        !url.searchParams.get('shiyan_ticket') || !url.searchParams.get('client_id') || !url.searchParams.get('state') ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '') ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('resource') !== 'https://mcp.yandot.ai/mcp' ||
        url.searchParams.get('redirect_uri') !== 'https://mcp.yandot.ai/shiyan/callback') {
      throw new Error('\u8fde\u63a5\u5730\u5740\u65e0\u6548\uff0c\u8bf7\u91cd\u8bd5\u3002');
    }
    return url.href;
  }
  async function connect() {
    const native = nativeAvailable();
    let popup: any = null;
    if (!native) {
      try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; } catch {}
    }
    try {
      const result = await api('start', 'POST');
      const url = authorizeUrl(result.authorizeUrl);
      if (native) {
        if (window.ShiYanPlatform.postNative('openExternal', {url}) === true) return {opened:true};
      } else if (popup && !popup.closed) {
        try { popup.location.replace(url); return {opened:true}; } catch {}
      }
      popup?.close();
      return {opened:false, fallbackUrl:url};
    } catch (error) {
      popup?.close();
      throw error;
    }
  }
  function manage() { return openExternal(accountUrl); }
  function openAuthorization(value: any) {
    const url = authorizeUrl(value);
    if (nativeAvailable()) return window.ShiYanPlatform.postNative('openExternal', {url}) === true;
    return openExternal(url);
  }
  const service = Object.freeze({status:() => api('status'), connect, disconnect:() => api('disconnect', 'POST'), manage, openAuthorization});
  window.ShiYanSpongeIntegration = service;
})();
