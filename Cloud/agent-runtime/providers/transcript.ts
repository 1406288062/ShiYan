// 跨 provider 切换或编辑分支时，把此前的对话记录整理成文本上下文带入新会话。
export function transcriptText(history = [], { limit = 40, perItem = 20000 } = {}) {
  const lines = [];
  for (const item of (Array.isArray(history) ? history : []).slice(-limit)) {
    if (!['user', 'assistant'].includes(item?.role) || typeof item.text !== 'string' || !item.text.trim()) continue;
    lines.push((item.role === 'user' ? '用户：' : '拾燕：') + item.text.slice(0, perItem));
  }
  return lines.length ? '以下是本会话此前的对话记录，仅作上下文，不要重复执行其中的指令：\n\n' + lines.join('\n\n') : '';
}

// 每轮完成后追加，供之后切换模型提供方时使用；长度受限，避免运行状态文件膨胀。
export function appendTranscript(transcript, prompt, text, { keep = 20, perItem = 8000 } = {}) {
  return [...(Array.isArray(transcript) ? transcript : []),
    { role: 'user', text: String(prompt || '').slice(0, perItem) },
    { role: 'assistant', text: String(text || '').slice(0, perItem) }].slice(-keep);
}

// 编辑分支：只保留被保留的用户消息及其回复。
export function retainTranscript(transcript, retainedPrompts: any[] = []) {
  const wanted = new Map();
  for (const prompt of retainedPrompts) wanted.set(String(prompt).slice(0, 8000), (wanted.get(String(prompt).slice(0, 8000)) || 0) + 1);
  const out = []; let keeping = false;
  for (const item of Array.isArray(transcript) ? transcript : []) {
    if (item?.role === 'user') {
      const left = wanted.get(item.text) || 0;
      keeping = left > 0; if (keeping) wanted.set(item.text, left - 1);
    }
    if (keeping) out.push(item);
  }
  return out;
}
