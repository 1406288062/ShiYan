(() => {
  'use strict';
  // Native SF Symbols: books.vertical / books.vertical.fill, rendered at 4x for the 22px rail.
  const glyph = '<svg viewBox="0 0 24 24" aria-hidden="true" data-sf-symbol="books.vertical"><defs><mask id="knowledgeBooksOutlineMask" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><image href="data:image/png;base64,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" width="24" height="24"/></mask><mask id="knowledgeBooksFilledMask" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><image href="data:image/png;base64,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" width="24" height="24"/></mask></defs><rect class="rail-glyph-outline" width="24" height="24" mask="url(#knowledgeBooksOutlineMask)"/><rect class="rail-glyph-filled" width="24" height="24" mask="url(#knowledgeBooksFilledMask)"/></svg>';
  let root: any, frame: any, opened = false, restoreFocus: any, inertElements: any[] = [], previousActive: any[] = [];
  function syncRail() {
    if (!opened) return;
    const entry = document.getElementById('railKnowledge');
    for (const button of document.querySelectorAll('#activityRail > button.is-active')) {
      if (button !== entry) button.classList.remove('is-active');
    }
    if (entry && !entry.classList.contains('is-active')) entry.classList.add('is-active');
  }
  function restoreRail() {
    const view = window.shiyan?.getView?.();
    const id = ({agent:'railHome', search:'railHome', dots:'railHome', home:'railEnhance', history:'railHistory', schedules:'railSchedules'} as any)[view];
    const restored = id ? [id] : previousActive;
    for (const button of document.querySelectorAll('#activityRail > button')) {
      button.classList.toggle('is-active', restored.includes(button.id));
    }
    previousActive = [];
  }
  function fit() {
    const rail = document.getElementById('activityRail');
    root.style.setProperty('--knowledge-rail', rail?.getClientRects().length ? rail.getBoundingClientRect().right+'px' : '0px');
  }
  function syncAppearance() {
    if (!root) return;
    const preferred = document.body.dataset.theme;
    const theme = preferred === 'dark' || preferred === 'light' ? preferred
      : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.style.backgroundColor = getComputedStyle(document.body).getPropertyValue('--canvas').trim()
      || (theme === 'dark' ? '#202124' : '#ffffff');
    root.style.colorScheme = theme;
    frame.style.colorScheme = theme;
    const child = frame.contentDocument;
    if (child) {
      child.documentElement.style.colorScheme = theme;
      child.body?.classList.toggle('light-theme', theme === 'light');
    }
  }
  function build() {
    if (root) return;
    root = document.createElement('section');
    root.id = 'knowledgeView';
    root.className = 'knowledge-shell wb-modal';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '知识库');
    root.hidden = true;
    frame = document.createElement('iframe');
    frame.id = 'knowledgeFrame';
    frame.title = '知识库';
    frame.dataset.loading = 'true';
    frame.addEventListener('load', () => {
      syncAppearance();
      delete frame.dataset.loading;
    });
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    syncAppearance();
    frame.src = '/assets/knowledge-ui/index.html?v=20261026-task-copy-19049585';
    root.append(frame);
    document.body.append(root);
  }
  function open() {
    build();
    if (opened) return;
    syncAppearance();
    window.ShiYanSettings?.close?.(false);
    restoreFocus = document.activeElement;
    opened = true;
    root.hidden = false;
    fit();
    const rail: any = document.getElementById('activityRail');
    previousActive = [...rail.querySelectorAll('button.is-active')].map(button => button.id);
    const collect = (element: any): any => {
      if (element === root || element === rail || ['SCRIPT','STYLE','LINK'].includes(element.tagName)) return [];
      if (rail && element.contains(rail)) return [...element.children].flatMap(collect);
      return [[element, element.inert]];
    };
    inertElements = [...document.body.children].flatMap(collect);
    for (const [element] of inertElements) element.inert = true;
    const entry = document.getElementById('railKnowledge');
    syncRail();
    entry?.setAttribute('aria-expanded', 'true');
    window.workbench?.refreshOverlays?.();
    frame.focus();
  }
  function close(restore = true) {
    if (!opened) return;
    opened = false;
    root.hidden = true;
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements = [];
    const entry = document.getElementById('railKnowledge');
    restoreRail();
    entry?.setAttribute('aria-expanded', 'false');
    window.workbench?.refreshOverlays?.();
    if (restore && restoreFocus?.isConnected) restoreFocus.focus();
  }
  function install() {
    const appearanceObserver = new MutationObserver(syncAppearance);
    appearanceObserver.observe(document.body, {attributes:true, attributeFilter:['data-theme','class','style']});
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncAppearance);
    const attach = () => {
      const rail = document.getElementById('activityRail');
      if (!rail) return false;
      if (!document.getElementById('railKnowledge')) {
        const button = document.createElement('button');
        button.id = 'railKnowledge';
        button.type = 'button';
        button.className = 'wb-icon-button';
        button.title = '知识库';
        button.setAttribute('aria-label', '知识库');
        button.setAttribute('aria-expanded', 'false');
        button.innerHTML = glyph;
        button.onclick = () => opened ? close() : open();
        rail.insertBefore(button, rail.querySelector('#railHistory,.rail-spacer'));
      }
      const observer = new MutationObserver(syncRail);
      observer.observe(rail, {subtree:true, attributes:true, attributeFilter:['class']});
      return true;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => { if (attach()) observer.disconnect(); });
      observer.observe(document.body, {childList:true,subtree:true});
    }
    document.addEventListener('click', event => {
      if (opened && (event.target as any).closest('#activityRail button:not(#railKnowledge)')) close(false);
    }, true);
    window.addEventListener('resize', () => { if (opened) fit(); });
    window.addEventListener('shiyan-view', () => { if (opened) close(false); });
    window.addEventListener('shiyan-native', event => {
      if (opened && (event as CustomEvent).detail?.type === 'browserNewTab') close(false);
    });
  }
  window.ShiYanKnowledge = {open,close,isOpen:()=>opened};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
