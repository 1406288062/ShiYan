/* Stream image bytes into an uncompressed UTF-8 ZIP; pixels stay off the app server. */
(() => {
  'use strict';
  const encoder = new TextEncoder(), memoryLimit = 192 * 1024 * 1024;
  const crcTable = Uint32Array.from({length: 256}, (_, value) => {
    for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function header(length, signature) {
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
    view.setUint32(0, signature, true); return {bytes, view};
  }
  function filename(value, names) {
    const safe = String(value || '图片.jpg').replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0,180) || '图片.jpg';
    const dot = safe.lastIndexOf('.'), stem = dot > 0 ? safe.slice(0,dot) : safe, suffix = dot > 0 ? safe.slice(dot) : '';
    let result = safe, index = 1;
    while (names.has(result.toLocaleLowerCase())) result = stem + '_' + (++index) + suffix;
    names.add(result.toLocaleLowerCase()); return encoder.encode(result);
  }
  async function writeZip(items, sink, {onProgress, limit = 0xffffffff} = {}) {
    if (!items.length || items.length > 10) throw Error('一次最多下载 10 张增强图片');
    let offset = 0, totalBytes = 0; const entries = [], names = new Set();
    const write = async bytes => {
      if (offset + bytes.byteLength > limit) throw Error('图片总大小较大，请分别下载单张图片');
      await sink.write(bytes); offset += bytes.byteLength;
    };
    for (let index = 0; index < items.length; index++) {
      const item = items[index], name = filename(item.filename, names), start = offset;
      const local = header(30, 0x04034b50);
      local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x808, true); local.view.setUint16(12, 33, true);
      local.view.setUint16(26, name.length, true);
      await write(local.bytes); await write(name);
      let crc = 0xffffffff, size = 0;
      for await (const chunk of await item.chunks()) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
        size += bytes.byteLength; totalBytes += bytes.byteLength;
        if (size > 0xffffffff) throw Error('图片过大，请分别下载单张图片');
        await write(bytes);
        try { onProgress?.({completed: index, total: items.length, bytes: totalBytes}); } catch (_) {}
      }
      if (!size) throw Error('增强图片内容为空，未生成下载包');
      const descriptor = header(16, 0x08074b50); crc = (crc ^ 0xffffffff) >>> 0;
      descriptor.view.setUint32(4, crc, true); descriptor.view.setUint32(8, size, true); descriptor.view.setUint32(12, size, true);
      await write(descriptor.bytes); entries.push({name, start, crc, size});
      try { onProgress?.({completed: index + 1, total: items.length, bytes: totalBytes}); } catch (_) {}
    }
    const centralStart = offset;
    for (const entry of entries) {
      const central = header(46, 0x02014b50);
      central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true); central.view.setUint16(8, 0x808, true); central.view.setUint16(14, 33, true);
      central.view.setUint32(16, entry.crc, true); central.view.setUint32(20, entry.size, true); central.view.setUint32(24, entry.size, true);
      central.view.setUint16(28, entry.name.length, true); central.view.setUint32(42, entry.start, true);
      await write(central.bytes); await write(entry.name);
    }
    const end = header(22, 0x06054b50);
    end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, offset - centralStart, true); end.view.setUint32(16, centralStart, true);
    await write(end.bytes); return offset;
  }
  async function download(assets, {onProgress} = {}) {
    if (!assets.length || assets.length > 10) throw Error('一次最多下载 10 张增强图片');
    const name = '拾燕增强图片.zip', controller = new AbortController(), chunks = [];
    let writable = null;
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({suggestedName: name, types: [{description:'ZIP 压缩包',accept:{'application/zip':['.zip']}}]});
      writable = await handle.createWritable();
    } else if (assets.reduce((sum, asset) => sum + (Number(asset.bytes) || 0), 0) > memoryLimit) {
      throw Error('图片总大小较大，请分别下载单张图片，或使用支持直接保存文件的浏览器');
    }
    try {
      const entries = assets.map(asset => ({filename: asset.filename, chunks: async function* () {
        const url = new URL(asset.downloadUrl || '/api/assets/' + encodeURIComponent(asset.id) + '/file?download=1', location.href);
        if (url.origin !== location.origin || !/^\/api\/assets\/[^/]+\/file$/.test(url.pathname))
          throw Error('图片下载地址无效，请刷新后重试');
        const response = await fetch(url.href, {credentials:'same-origin', mode:'cors', signal:controller.signal});
        if (!response.ok || !response.body) throw Error('下载增强图片失败，请重试；未生成不完整的下载包');
        const contentType = response.headers?.get('content-type');
        if (contentType && !/^image\//i.test(contentType)) throw Error('图片下载内容异常，未生成下载包');
        const reader = response.body.getReader(); let received = 0;
        try { for (;;) { const {value, done} = await reader.read(); if (done) break; received += value.byteLength; yield value; } }
        finally { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
        if (Number(asset.bytes) > 0 && received !== Number(asset.bytes)) throw Error('图片下载不完整，请重试；未生成下载包');
      }}));
      await writeZip(entries, writable || {write: async bytes => chunks.push(bytes)}, {
        limit: writable ? 0xffffffff : memoryLimit, onProgress,
      });
      if (writable) await writable.close();
      else {
        const url = URL.createObjectURL(new Blob(chunks, {type:'application/zip'}));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (error) {
      controller.abort();
      if (writable) try { await writable.abort(); } catch (_) {}
      throw error;
    }
  }
  window.ShiYanPhotoArchive = {download, writeZip};
})();
