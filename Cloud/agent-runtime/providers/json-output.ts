// 纯推理的 JSON 输出支持。
// Codex 原生支持 outputSchema；Claude 的结构化输出只支持 JSON Schema 的一个子集，
// 而 RAG、Dots 的 schema 是按 Codex 写的（含 minLength、maxItems 等）。
// 因此对 Claude：把 schema 写进提示词 -> 从回复中提取 JSON -> 用 ajv 按完整 schema 校验 -> 不通过时带着错误重试一次。
import { createHash } from 'node:crypto';

let ajvInstance, ajvTried = false;
async function getAjv() {
  if (ajvTried) return ajvInstance;
  ajvTried = true;
  try {
    const mod = await import('ajv');
    const Ajv = mod.default?.default || mod.default || mod.Ajv;
    ajvInstance = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  } catch (error) {
    console.warn('[json-output] ajv 不可用，跳过 schema 校验：', String((error as any)?.message || error).slice(0, 120));
    ajvInstance = null;
  }
  return ajvInstance;
}

const compiled = new Map();
export async function validateJson(schema, value) {
  const ajv = await getAjv();
  if (!ajv) return { ok: true, skipped: true };
  const { $schema, $id, ...rest } = schema || {};
  const key = createHash('sha1').update(JSON.stringify(rest)).digest('hex');
  let fn = compiled.get(key);
  if (fn === undefined) {
    try { fn = ajv.compile(rest); } catch { fn = null; }
    if (compiled.size > 64) compiled.clear();
    compiled.set(key, fn);
  }
  if (!fn) return { ok: true, skipped: true };
  if (fn(value)) return { ok: true };
  return { ok: false, errors: ajv.errorsText(fn.errors, { separator: '；', dataVar: '输出' }).slice(0, 800) };
}

export function schemaInstruction(schema) {
  return '请只输出一个 JSON 值，不要使用 Markdown 代码块，不要附加任何解释文字，并严格符合下面的 JSON Schema：\n' + JSON.stringify(schema);
}

export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('模型没有返回内容');
  const attempts = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) attempts.push(fence[1]);
  for (const candidate of attempts) { try { return JSON.parse(candidate); } catch {} }
  const start = raw.search(/[{[]/);
  if (start >= 0) {
    const open = raw[start], close = open === '{' ? '}' : ']';
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; } }
    }
  }
  throw new Error('模型输出不是有效的 JSON');
}

export function addUsage(total, usage) {
  if (!usage) return total;
  const next = { ...(total || {}) };
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    if (Number.isSafeInteger(usage[key])) next[key] = (next[key] || 0) + usage[key];
  }
  return Object.keys(next).length ? next : total;
}
