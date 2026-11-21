// 子进程：读取 Claude Agent SDK 支持的模型并以一行 JSON 输出到 stdout。由 providers/claude.mjs 调用。
import os from 'node:os';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const timer = setTimeout(() => { write({ ok: false, error: 'timeout' }); process.exit(2); }, 22000);
process.on('unhandledRejection', () => {});
try {
  const { query } = await import(process.env.SHIYAN_CLAUDE_SDK || '@anthropic-ai/claude-agent-sdk');
  const controller = new AbortController();
  async function* idle() { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); }
  const q = query({ prompt: idle(), options: { abortController: controller, cwd: os.tmpdir(), settingSources: [], persistSession: false, tools: [] } });
  const models = await q.supportedModels();
  write({ ok: true, models: (models || []).map(m => ({ value: m.value, resolvedModel: m.resolvedModel, displayName: m.displayName,
    supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels })) });
  clearTimeout(timer); controller.abort(); setTimeout(() => process.exit(0), 50);
} catch (error) {
  write({ ok: false, error: String((error as any)?.message || error).slice(0, 300) });
  clearTimeout(timer); process.exit(1);
}
