// 把 Claude Agent SDK 的消息流转换为拾燕统一事件协议（与 @openai/codex-sdk ThreadEvent 同构）：
// thread.started / item.started / item.updated / item.completed / turn.completed / turn.failed
// item 类型：agent_message, reasoning, command_execution, mcp_tool_call, file_change, todo_list, web_search
const FILE_TOOLS = { Write: 'add', Edit: 'update', MultiEdit: 'update', NotebookEdit: 'update' };

export function toolItem(block, { isolatedServer } = {}) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const id = String(block.id || '');
  const name = String(block.name || '');
  if (name === 'Bash') return { id, type: 'command_execution', command: String(input.command || ''), aggregated_output: '', status: 'in_progress' };
  if (FILE_TOOLS[name]) {
    const file = input.file_path || input.notebook_path;
    return { id, type: 'file_change', changes: typeof file === 'string' ? [{ path: file, kind: FILE_TOOLS[name] }] : [], status: 'in_progress' };
  }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return { id, type: 'todo_list', items: todos.filter(t => typeof t?.content === 'string').map(t => ({ text: t.content, completed: t.status === 'completed' })), status: 'in_progress' };
  }
  if (name === 'WebSearch') return { id, type: 'web_search', query: String(input.query || ''), status: 'in_progress' };
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const tool = rest.join('__');
    // 普通账号的沙箱工具：exec_command 按终端命令展示，与 GPT 隔离路径一致。
    if (isolatedServer && server === isolatedServer && tool === 'exec_command')
      return { id, type: 'command_execution', command: String(input.command || ''), aggregated_output: '', status: 'in_progress' };
    return { id, type: 'mcp_tool_call', server: isolatedServer && server === isolatedServer ? 'workspace' : server, tool, arguments: input, status: 'in_progress' };
  }
  return { id, type: 'mcp_tool_call', server: 'claude', tool: name, arguments: input, status: 'in_progress' };
}

function resultParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
    else if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string')
      parts.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type || 'image/png' });
  }
  return parts;
}

export function completeTool(item, block) {
  const failed = block?.is_error === true;
  const parts = resultParts(block?.content);
  const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n').slice(0, 128000);
  const status = failed ? 'failed' : 'completed';
  if (item.type === 'command_execution') {
    // 沙箱 exec_command 返回 JSON {stdout,stderr,exitCode}；内置 Bash 返回纯文本。
    let output = text, exit = failed ? 1 : 0;
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && ('stdout' in value || 'stderr' in value)) { output = String(value.stdout || '') + String(value.stderr || ''); if (Number.isSafeInteger(value.exitCode)) exit = value.exitCode; } } catch {}
    return { ...item, aggregated_output: output, exit_code: exit, status };
  }
  if (item.type === 'mcp_tool_call') return { ...item, result: { content: parts }, ...(failed ? { error: { message: text.slice(0, 1000) || '工具执行失败' } } : {}), status };
  return { ...item, status };
}

export function claudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const cached = n(usage.cache_read_input_tokens);
  return { input_tokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + cached, cached_input_tokens: cached, output_tokens: n(usage.output_tokens) };
}

export function createClaudeEventMapper({ isolatedServer } = {}) {
  const tools = new Map();          // tool_use_id -> item
  const partial = new Map();        // 流式块 index -> {id,type,text}
  const streamCounts = new Map();   // message.id -> {t,r} 流式阶段已见文本/思考块数
  const finalCounts = new Map();    // message.id -> {t,r} 完整消息阶段已见块数
  let messageId = null, started = false, finished = false;
  const nextId = (counts, id, kind) => { const c = counts.get(id) || { t: 0, r: 0 }; counts.set(id, c); return `${id}:${kind}${c[kind]++}`; };
  return {
    get finished() { return finished; },
    map(message) {
      const out = [];
      if (!message || typeof message !== 'object' || finished) return out;
      if (message.type === 'system' && message.subtype === 'init') {
        if (!started && message.session_id) { started = true; out.push({ type: 'thread.started', thread_id: message.session_id }); }
        return out;
      }
      if (message.parent_tool_use_id) return out; // 子代理内部过程不展示，结果由父工具调用汇总
      if (message.type === 'stream_event') {
        const e = message.event || {};
        if (e.type === 'message_start') { messageId = e.message?.id || messageId; partial.clear(); }
        else if (e.type === 'content_block_start' && messageId) {
          const block = e.content_block || {};
          if (block.type === 'text') partial.set(e.index, { id: nextId(streamCounts, messageId, 't'), type: 'agent_message', text: block.text || '' });
          else if (block.type === 'thinking') {
            const entry = { id: nextId(streamCounts, messageId, 'r'), type: 'reasoning', text: '' };
            partial.set(e.index, entry); out.push({ type: 'item.started', item: { id: entry.id, type: 'reasoning', text: '' } });
          }
        } else if (e.type === 'content_block_delta') {
          const entry = partial.get(e.index), delta = e.delta || {};
          if (entry?.type === 'agent_message' && delta.type === 'text_delta' && typeof delta.text === 'string') {
            entry.text += delta.text; out.push({ type: 'item.updated', item: { id: entry.id, type: 'agent_message', text: entry.text } });
          } else if (entry?.type === 'reasoning' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            entry.text += delta.thinking;
            // 思考过程边生成边展示；按段推送，避免每个字都触发一次刷新。
            if (entry.text.length - (entry.shown || 0) >= 120 || /[。！？.!?\n]$/.test(delta.thinking) && entry.text.length - (entry.shown || 0) >= 24) {
              entry.shown = entry.text.length; out.push({ type: 'item.updated', item: { id: entry.id, type: 'reasoning', text: entry.text } });
            }
          }
        }
        return out;
      }
      if (message.type === 'assistant') {
        const m = message.message || {}, id = m.id || message.uuid || 'msg';
        for (const block of Array.isArray(m.content) ? m.content : []) {
          if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'item.completed', item: { id: nextId(finalCounts, id, 't'), type: 'agent_message', text: block.text } });
          else if (block?.type === 'thinking') out.push({ type: 'item.completed', item: { id: nextId(finalCounts, id, 'r'), type: 'reasoning', text: String(block.thinking || '') } });
          else if (block?.type === 'tool_use' && block.id) {
            const item = toolItem(block, { isolatedServer }); tools.set(block.id, item);
            out.push({ type: 'item.started', item: { ...item } });
          }
        }
        return out;
      }
      if (message.type === 'user') {
        const content = message.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block?.type !== 'tool_result') continue;
          const item = tools.get(block.tool_use_id); if (!item) continue;
          tools.delete(block.tool_use_id); out.push({ type: 'item.completed', item: completeTool(item, block) });
        }
        return out;
      }
      if (message.type === 'result') {
        finished = true;
        for (const item of tools.values()) out.push({ type: 'item.completed', item: { ...item, status: 'interrupted' } });
        tools.clear();
        if (message.subtype === 'success' && !message.is_error) out.push({ type: 'turn.completed', usage: claudeUsage(message.usage) });
        else {
          const detail = (Array.isArray(message.errors) ? message.errors.join('；') : '') || (typeof message.result === 'string' ? message.result : '');
          out.push({ type: 'turn.failed', error: { message: (detail || 'Claude 处理失败').slice(0, 1000) } });
        }
      }
      return out;
    },
  };
}
