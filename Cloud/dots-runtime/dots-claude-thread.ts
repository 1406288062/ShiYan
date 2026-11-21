// Dots 总管对话与目标执行的“中枢感知”线程：模型中枢把调用方路由到非 GPT（如 Claude）时，经中枢推理；
// 路由是 GPT（或中枢不可用）时，沿用原来的 Codex 线程（含流式输出）。
// 动作（写文件、执行命令等）仍由 runtime 按结构化 JSON 执行，模型本身不获得工具。
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// 图片路径 → 中枢需要的 base64；单张不超过 8 MB。
const hubImages = paths => (paths || []).flatMap(file => { try { if (statSync(file).size > 8 * 1024 * 1024) return []; return [{ data: readFileSync(file).toString('base64'), suffix: path.extname(file).toLowerCase() || '.jpg' }]; } catch { return []; } });

// Dots 回复的提示词：分隔符前是固定的身份与规则，后面是每轮变化的状态。
// 经中枢走 Claude 时固定部分放进系统提示，和工具定义一起被缓存，每轮只有状态部分按全价计；
// 走 Codex 时把分隔符换回空行，内容不变。
export const DOTS_STATE_SPLIT = '\n\n<<DOTS_STATE>>\n\n';
const splitPrompt = prompt => { const text = String(prompt ?? ''), i = text.indexOf(DOTS_STATE_SPLIT); return i < 0 ? { prompt: text } : { system: text.slice(0, i), prompt: text.slice(i + DOTS_STATE_SPLIT.length) }; };
const joinPrompt = prompt => String(prompt ?? '').replace(DOTS_STATE_SPLIT, '\n\n');

// owner|consumer -> 最近一次经中枢完成的时间；用于避免与业务侧上报重复记一条。
export const lastHubCall = new Map();

// Dots 每轮提示词已自带最近对话、任务目录和记忆；不再让中枢按 threadKey 把前几轮的完整提示词再拼一遍（那会让同样的上下文重复好几份）。
export interface HubAwareThreadOptions {
  hub: any;
  owner: any;
  consumer: string;
  threadId?: string | null;
  options?: any;
  createInner: () => any;
}
export function hubAwareThread({ hub, owner, consumer, threadId = null, options = {}, createInner }: HubAwareThreadOptions) {
  let inner: any = null;
  const getInner = () => (inner ??= createInner());
  const key = createHash('sha256').update(consumer + '\0' + owner + '\0' + String(options.workingDirectory || '')).digest('hex').slice(0, 40);
  const viaHub = async () => { try { const route = await hub.route(consumer); return Boolean(route && route.provider !== 'openai'); } catch { return false; } };
  async function hubRun(prompt, { outputSchema, signal, images }: {outputSchema?: any; signal?: any; images?: any} = {}) {
    try {
      const attached = hubImages(images);
      const parts = splitPrompt(prompt);
      const out = await hub.infer(consumer, { ...parts, outputSchema, account: owner, ...(attached.length ? { images: attached } : {}), ...(options.mcpServers && Object.keys(options.mcpServers).length ? { mcpServers: options.mcpServers } : {}), ...(Array.isArray(options.mcpToolAllowlist) && options.mcpToolAllowlist.length ? { mcpToolAllowlist: options.mcpToolAllowlist } : {}) }, { signal, timeoutMs: 360000 });
      return { finalResponse: out.finalResponse, usage: out.usage || null, items: [] };
    } finally { lastHubCall.set(owner + '|' + consumer, Date.now()); }
  }
  const once = turn => ({ events: (async function* () {
    yield { type: 'item.completed', item: { id: 'hub-reply', type: 'agent_message', text: turn.finalResponse } };
    yield { type: 'turn.completed', usage: turn.usage };
  })() });
  return {
    get id() { return inner ? inner.id : threadId; },
    async run(prompt, opts = {}) { return (await viaHub()) ? hubRun(prompt, opts) : getInner().run(joinPrompt(prompt), opts); },
    async runStreamed(prompt, opts = {}) {
      if (await viaHub()) return once(await hubRun(prompt, opts));
      const thread = getInner();
      return typeof thread.runStreamed === 'function' ? thread.runStreamed(joinPrompt(prompt), opts) : once(await thread.run(joinPrompt(prompt), opts));
    },
  };
}
// 是否刚经中枢完成（中枢已记录，业务侧不再重复上报）。
export const recentlyViaHub = (owner, consumer, withinMs) => Date.now() - (lastHubCall.get(owner + '|' + consumer) || 0) < withinMs;
