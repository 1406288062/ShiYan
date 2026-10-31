// OpenAI Codex provider（@openai/codex-sdk）。行为与接入前的 server.mjs 内联实现一致。
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Codex } from '@openai/codex-sdk';
import { refreshModels } from '../model-capabilities.mjs';
import { runIsolatedJob } from '../member-agent.mjs';

const CODEX_BIN = process.env.SHIYAN_CODEX_BIN || '/home/ubuntu/.local/bin/codex';

// 统一 MCP 描述 -> Codex config。secretEnv 只经子进程环境传递，不写进命令行与配置。
export function codexMcpConfig(mcpServers = {}) {
  const secret = {}, servers = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    Object.assign(secret, spec.secretEnv || {});
    servers[name] = { command: spec.command, args: spec.args || [], env: spec.env || {},
      env_vars: Object.keys(spec.secretEnv || {}), ...(spec.timeoutSec ? { tool_timeout_sec: spec.timeoutSec } : {}) };
  }
  return { secret, servers };
}

export default {
  id: 'openai',
  label: 'GPT',
  sdk: '@openai/codex-sdk',
  features: { images: true, files: true, imageGeneration: true },
  available: () => true,
  listModels: () => refreshModels(),
  async runTurn({ model, reasoning, cwd, resume, input, mcpServers, signal }) {
    const { secret, servers } = codexMcpConfig(mcpServers);
    const codex = new Codex({ codexPathOverride: CODEX_BIN, env: { ...process.env, ...secret }, config: { mcp_servers: servers } });
    const options = { model, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'danger-full-access', approvalPolicy: 'never',
      networkAccessEnabled: false, webSearchMode: 'disabled', modelReasoningEffort: reasoning };
    // 每轮新建/恢复 Thread，切换推理档位即时生效。
    const thread = resume ? codex.resumeThread(resume, options) : codex.startThread(options);
    return thread.runStreamed(input, { signal });
  },
  // 普通账号：Responses API + 隔离沙箱工具（member-agent.mjs）。
  runIsolatedJob,

  // 纯推理：只读沙箱、无网络、无工具调用需求。供模型中枢（RAG、Dots 的推理类调用）使用。
  // images: [{data: base64, suffix}]；schema: JSON Schema（Codex 原生 outputSchema）；resume: 上一轮的 threadId。
  // webSearch=true 时开启联网与实时检索（仅用于调用方明确依赖联网核验的场景）。
  async infer({ model, reasoning, prompt, images = [], schema, resume, webSearch = false, signal }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiyan-infer-'));
    try {
      const items = [];
      const text = String(prompt || '').trim();
      if (text) items.push({ type: 'text', text });
      for (let i = 0; i < images.length; i++) {
        const suffix = ['.png', '.jpg', '.jpeg', '.webp'].includes(String(images[i]?.suffix || '.png').toLowerCase()) ? String(images[i]?.suffix || '.png').toLowerCase() : '.png';
        if (!images[i]?.data) continue;
        const file = path.join(dir, `image-${i + 1}${suffix}`);
        await fs.writeFile(file, Buffer.from(String(images[i].data), 'base64'), { mode: 0o600 });
        items.push({ type: 'local_image', path: file });
      }
      if (!items.length) throw Object.assign(new Error('prompt or image is required'), { status: 400 });
      const options = { model, sandboxMode: 'read-only', approvalPolicy: 'never', workingDirectory: dir, skipGitRepoCheck: true,
        modelReasoningEffort: reasoning, networkAccessEnabled: webSearch === true, webSearchMode: webSearch === true ? 'live' : 'disabled' };
      const codex = new Codex({ codexPathOverride: CODEX_BIN });
      const thread = resume ? codex.resumeThread(resume, options) : codex.startThread(options);
      const input = items.length === 1 && items[0].type === 'text' ? items[0].text : items;
      const turn = await thread.run(input, { ...(schema ? { outputSchema: schema } : {}), signal });
      return { text: turn.finalResponse || '', usage: turn.usage || null, threadId: thread.id || null };
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  },
};
