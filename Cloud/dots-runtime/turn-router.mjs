// Dots 对话分流：决定这一轮用轻路（dots.chat.quick：便宜模型、少量上下文、不加载设备/浏览器/连接器工具，
// 但能联网搜索）还是重路（dots.chat：完整上下文和全部工具）。
// 1. 规则只处理确定无疑的情况：带图片、非用户消息（任务回报等）→ 重路；纯寒暄短语 → 轻路。
// 2. 其余交给一个小模型按“意图”判断（看最近几条对话和进行中的任务），不看字数和关键词。
// 3. 判断失败或超时一律走重路：宁可多花一点，也不让需要干活的消息落到没有工具的轻路。
export const ROUTE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['route', 'reason'],
  properties: { route: { type: 'string', enum: ['light', 'full'] }, reason: { type: 'string', maxLength: 200 } },
};

const TRIVIAL = /^(嗯+|嗯嗯+|哦+|噢+|喔+|好+|好的|好吧|好滴|行|可以|ok|okay|k|收到|知道了|明白了?|了解|谢谢你?|多谢|谢啦|感谢|thanks?|thx|哈+|呵+|嘿+|晚安|早安?|早上好|中午好|下午好|晚上好|午安|在吗|在不在|你好|您好|hi|hello|hey|拜拜|再见|bye|辛苦了?|棒|厉害|赞|👍|😂|🙏)[!！。.~～?？,，\s]*$/i;
export const isTrivial = text => TRIVIAL.test(String(text || '').trim());

const clip = (text, n) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export function buildRoutePrompt({ messages, recent = [], tasks = [] }) {
  return JSON.stringify({
    operation: 'route_dots_turn',
    instructions: [
      '你是拾燕 Dots 的分流器。根据用户新消息的意图，判断这一轮该走 light 还是 full。只看意图，不看字数和用了什么词。',
      'light（便宜模型，能联网搜索，只看到最近 10 条对话，不能操作设备和应用）适合：闲聊、情绪陪伴、打招呼、常识或知识问答、解释概念、给简单建议；需要联网查一个事实或实时数据（新闻、天气、股价、汇率、比分等）；设置一个简单提醒；对上一条回复的简单追问、确认或评价。',
      'full（更强的模型，完整上下文和全部工具）适合：要新建或继续一项后台任务；查看、催促、修改、暂停、取消已有任务，或问某个任务的进展和结果；操作电脑、手机、Mac、服务器或浏览器；读写文件、代码、部署；邮件、日历、GitHub、订阅等已连接的应用；写长文、做方案、复杂分析或多步推理；需要回顾更早对话或记忆中的细节。',
      '新消息很短但意思是“继续”“就按刚才说的办”“好，开始吧”这类接着让 Dots 干活的，走 full。消息很长但只是聊天、倾诉或问一个知识问题的，走 light。',
      '拿不准时选 full。reason 用一句中文说明依据。',
    ],
    recent_conversation: recent.map(m => ({ role: m.role, content: clip(m.content, 240) })),
    active_tasks: tasks.map(t => clip(t, 80)),
    new_user_messages: messages.map(m => clip(m, 1200)),
  });
}

export function createTurnRouter({ assess, timeoutMs = 12_000, logger = console, record = () => {} }) {
  return async function route({ events = [], hasImages = false, recent = [], tasks = [] }) {
    const started = Date.now();
    const done = (route, by, reason) => { const out = { route, by, reason, ms: Date.now() - started }; try { record(out); } catch {} return out; };
    if (!events.length) return done('full', 'rule', '没有待处理消息');
    if (hasImages) return done('full', 'rule', '带图片');
    const messages = [];
    for (const event of events) {
      if (event.type !== 'user_message') return done('full', 'rule', '包含非用户消息：' + event.type);
      let content = ''; try { content = String(JSON.parse(event.payload).content || ''); } catch {}
      if (!content.trim()) return done('full', 'rule', '消息为空');
      messages.push(content);
    }
    if (messages.every(isTrivial)) return done('light', 'rule', '纯寒暄');
    try {
      const result = await assess(buildRoutePrompt({ messages, recent, tasks }), ROUTE_SCHEMA, { source: 'dots-route', signal: AbortSignal.timeout(timeoutMs) });
      const route = result?.route === 'light' ? 'light' : 'full';
      return done(route, 'model', clip(result?.reason, 200));
    } catch (error) {
      logger.warn?.('[turn-router] ' + clip(error?.message || error, 200));
      return done('full', 'fallback', '分流判断失败：' + clip(error?.message || error, 120));
    }
  };
}
