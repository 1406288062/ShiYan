/* Shared desktop composer keys. Callers retain their own IME/send guards. */
(() => {
  'use strict';
  function handleEnter(event: any, send: any) {
    if (!['Enter', 'NumpadEnter'].includes(event.key) && !['Enter', 'NumpadEnter'].includes(event.code)) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    const input = event.currentTarget || event.target;
    event.preventDefault();
    if (input?.readOnly || input?.disabled || event.repeat) return true;
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      // insertText participates in native textarea undo; setRangeText covers
      // WebKit environments where the editing command is unavailable.
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      if (input.maxLength >= 0 && input.value.length - (end - start) + 1 > input.maxLength) return true;
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, '\n'); } catch {}
      if (!inserted) {
        input.setRangeText('\n', start, end, 'end');
        input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertLineBreak', data:'\n'}));
      }
    } else {
      send();
    }
    return true;
  }
  window.ShiYanComposerKeys = {handleEnter};
})();
