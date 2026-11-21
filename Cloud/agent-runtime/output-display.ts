// A compact, factual projection for rendering Codex execution details.
// Keep raw SDK items unchanged; arguments, structured results and binary data
// belong to the execution record, not to this display payload.
import { generatedOutputs } from './generated-output.ts';
const MAX_ITEMS = 128;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const statuses = new Set(['in_progress', 'completed', 'failed', 'cancelled', 'interrupted']);

function cleanText(value) {
  if (typeof value !== 'string' || value.includes('\0') || /data:[^,\s]{0,100};base64,/i.test(value)) return '';
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function text(value, limit) {
  const clean = cleanText(value);
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…';
}

function outputText(value, limit) {
  const clean = cleanText(value);
  if (clean.length <= limit) return clean;
  const marker = '\n…\n', head = Math.floor((limit - marker.length) / 2), tail = limit - marker.length - head;
  return clean.slice(0, head) + marker + clean.slice(-tail);
}

function itemStatus(item, lifecycle) {
  if (statuses.has(item.status)) return item.status;
  return lifecycle === 'item.completed' ? 'completed' : 'in_progress';
}

export function projectDisplayItem(item, lifecycle = 'item.completed') {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 160) return null;
  const base = { id: item.id, type: item.type, status: itemStatus(item, lifecycle) };
  switch (item.type) {
    case 'command_execution':
      return { ...base, command: text(item.command, 1000), aggregated_output: outputText(item.aggregated_output, 4000),
        ...(Number.isSafeInteger(item.exit_code) ? { exit_code: item.exit_code } : {}) };
    case 'mcp_tool_call': {
      const parts = Array.isArray(item.result?.content) ? item.result.content : [];
      const resultText = typeof item.result_text === 'string' ? outputText(item.result_text, 4000)
        : parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => outputText(part.text, 4000)).filter(Boolean).join('\n\n');
      return { ...base, server: text(item.server, 160), tool: text(item.tool, 160),
        ...(resultText ? { result_text: outputText(resultText, 4000) } : {}),
        ...(typeof item.error?.message === 'string' ? { error: { message: text(item.error.message, 1000) } } : {}) };
    }
    case 'todo_list':
      return { ...base, items: (Array.isArray(item.items) ? item.items : []).slice(0, 32)
        .filter(step => typeof step?.text === 'string').map(step => ({ text: text(step.text, 256), completed: step.completed === true })) };
    case 'web_search':
      return { ...base, query: text(item.query, 1000) };
    case 'file_change':
      return { ...base, changes: (Array.isArray(item.changes) ? item.changes : []).slice(0, 32)
        .filter(change => typeof change?.path === 'string')
        .map(change => ({ path: text(change.path, 512), kind: ['add', 'delete', 'update'].includes(change.kind) ? change.kind : 'update' })) };
    case 'collab_tool_call':
      return { ...base, tool: text(item.tool, 160), count: Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.length
        : Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : 0 };
    case 'image_generation':
      return base;
    case 'reasoning': {
      // 思考链：只保留文字，过长时保留首尾。
      const thought = outputText(item.text, 8000).trim();
      return thought ? { ...base, text: thought } : null;
    }
    case 'error':
      return { ...base, status: 'failed', message: text(item.message, 1000) };
    default:
      // Agent/reasoning text already has its own presentation. Do not invent
      // a display schema when a newer Codex introduces an unknown item type.
      return null;
  }
}

function boundItems(items) {
  const bounded = items.slice(-MAX_ITEMS);
  const sizes = bounded.map(item => Buffer.byteLength(JSON.stringify(item)));
  let bytes = 2 + Math.max(0, bounded.length - 1) + sizes.reduce((sum, size) => sum + size, 0);
  // Preserve factual status rows before old verbose command/tool output.
  for (let i = 0; i < bounded.length && bytes > MAX_PAYLOAD_BYTES; i++) {
    const item = bounded[i];
    if (item.aggregated_output || item.result_text) {
      bounded[i] = { ...item,
        ...(item.aggregated_output ? { aggregated_output: '…' } : {}),
        ...(item.result_text ? { result_text: '…' } : {}) };
      const size = Buffer.byteLength(JSON.stringify(bounded[i]));
      bytes += size - sizes[i]; sizes[i] = size;
    }
  }
  while (bounded.length && bytes > MAX_PAYLOAD_BYTES) {
    bounded.shift(); bytes -= sizes.shift() + (bounded.length ? 1 : 0);
  }
  return bounded;
}

export function upsertDisplayItem(existing, item, lifecycle, startOrder = []) {
  const previous = Array.isArray(existing) ? existing : [];
  const projected = projectDisplayItem(item, lifecycle);
  if (!projected) return { displayItems: previous, displayItemOrder: startOrder };
  const order = startOrder.length ? [...startOrder] : previous.map(value => value.id);
  if (!order.includes(projected.id)) order.push(projected.id);
  const rank = new Map(order.map((id, index) => [id, index]));
  const next = previous.filter(value => value.id !== projected.id).concat(projected)
    .sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return { displayItems: boundItems(next), displayItemOrder: order };
}

export function displayItemsForJob(job) {
  if (Array.isArray(job.displayItems)) return boundItems(job.displayItems);
  let items = [], order = [];
  for (const item of job.items || []) {
    const next = upsertDisplayItem(items, item, 'item.completed', order);
    items = next.displayItems; order = next.displayItemOrder;
  }
  return items;
}

export function projectUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

export function jobSnapshot(job) {
  return { ok: true, id: job.id, status: job.status, text: job.text || '', assets: generatedOutputs(job.assets),
    threadId: job.threadId || null, events: job.events || [], error: job.error || null, reasoning: job.reasoning,
    displayItems: displayItemsForJob(job), fileChanges: job.fileChanges || [], usage: projectUsage(job.usage) };
}

export function terminalJobStatus(status) { return terminalStatuses.has(status); }
