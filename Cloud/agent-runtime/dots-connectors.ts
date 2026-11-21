// 连接器目录：三端共用同一份目录和状态，客户端只负责展示。
// kind: subscription（凭据走对话里的填写卡片）、sponge（海绵宝宝配对）、builtin（内置能力）、planned（规划中）。
const CATALOG = [
  { id: 'email', provider: 'email', kind: 'subscription', category: 'mail', name: '邮箱', icon: 'envelope',
    summary: '新邮件提醒、摘要和回复',
    detail: '支持 QQ、163、Gmail、iCloud 等，需使用邮箱授权码。',
    capabilities: [], prompt: '我想连接我的邮箱' },
  { id: 'google-calendar', provider: 'google-calendar', kind: 'subscription', category: 'calendar', name: 'Google 日历', icon: 'calendar',
    summary: '日程变化提醒', detail: '需要 Google 账号授权。', capabilities: [], prompt: '我想连接 Google 日历' },
  { id: 'github', provider: 'github', kind: 'subscription', category: 'dev', name: 'GitHub', icon: 'chevron.left.forwardslash.chevron.right',
    summary: '仓库推送、发布和构建提醒', detail: '私有仓库需要只读令牌。', capabilities: [], prompt: '我想订阅一个 GitHub 仓库的动态' },
  { id: 'rss', provider: 'rss', kind: 'subscription', category: 'feeds', name: 'RSS', icon: 'dot.radiowaves.up.forward',
    summary: '网站和博客更新提醒', detail: '最多 20 个源。', capabilities: [], prompt: '我想关注一个网站的 RSS 更新' },
  { id: 'sponge', kind: 'sponge', category: 'devices', name: '海绵宝宝设备', icon: 'desktopcomputer',
    summary: '查看和操作你的电脑', detail: '仅限本账号配对的设备。', capabilities: [] },
  { id: 'wechat', kind: 'weixin', category: 'messaging', name: '微信', icon: 'message',
    summary: '在微信里和 Dots 对话', detail: '扫码绑定，需微信 8.0.70 以上。', capabilities: [],
    abilities: ['在微信里直接和 Dots 聊天：文字、语音、图片和文件都可以发', '每日简报、邮件和订阅提醒同步推送到微信（可以关掉）'],
    howto: '点「连接」后用手机微信扫描二维码并确认即可。只有你本人能和它对话，不能拉进群。' },
  { id: 'memory', kind: 'builtin', category: 'builtin', name: '记忆', icon: 'brain', summary: '记住你的偏好和项目', capabilities: [] },
  { id: 'web', kind: 'builtin', category: 'builtin', name: '联网搜索', icon: 'globe', summary: '搜索最新信息', capabilities: [] },
  { id: 'files', kind: 'builtin', category: 'builtin', name: '文件', icon: 'doc.on.doc', summary: '收发文件', capabilities: [] },
  { id: 'qq-bot', kind: 'planned', category: 'messaging', name: 'QQ', icon: 'bubble.left.and.bubble.right', summary: '在 QQ 里对话', capabilities: [] },
  { id: 'feishu', kind: 'planned', category: 'messaging', name: '飞书', icon: 'paperplane', summary: '在飞书里对话', capabilities: [] },
  { id: 'telegram', kind: 'planned', category: 'messaging', name: 'Telegram', icon: 'paperplane.circle', summary: '在 Telegram 里对话', capabilities: [] },
  { id: 'caldav', kind: 'planned', category: 'calendar', name: 'iCloud 日历', icon: 'calendar.badge.clock', summary: '日程提醒', capabilities: [] },
  { id: 'notion', kind: 'planned', category: 'docs', name: 'Notion', icon: 'square.text.square', summary: '读写页面', capabilities: [] },
  { id: 'mcp', kind: 'planned', category: 'custom', name: 'MCP', icon: 'puzzlepiece.extension', summary: '接入自定义工具', capabilities: [] },
  { id: 'webhook', kind: 'planned', category: 'custom', name: 'Webhook', icon: 'arrow.down.circle', summary: '接收外部事件', capabilities: [] },
];
export const CATEGORIES = [
  { id: 'mail', name: '邮件' }, { id: 'calendar', name: '日历' }, { id: 'dev', name: '开发' },
  { id: 'feeds', name: '订阅源' }, { id: 'devices', name: '设备' }, { id: 'messaging', name: '聊天软件' },
  { id: 'docs', name: '文档' }, { id: 'custom', name: '自定义' }, { id: 'builtin', name: '内置能力' },
];

function subscriptionState(sub) {
  if (!sub?.configured) return { state: 'available', status: '未连接' };
  if (!sub.enabled) return { state: 'paused', status: '已暂停' };
  if (['backoff', 'error', 'failed', 'waiting_authorization'].includes(sub.status)) return { state: 'error', status: sub.status === 'waiting_authorization' ? '需要重新授权' : '连接异常' };
  return { state: 'connected', status: '已连接' };
}
function subscriptionAccount(sub) {
  if (!sub?.configured) return '';
  if (sub.address) return sub.address;
  if (sub.repository) return sub.repository;
  if (Array.isArray(sub.feeds)) return sub.feeds.length + ' 个订阅源';
  if (sub.calendarId) return sub.calendarId === 'primary' ? '主日历' : sub.calendarId;
  return '';
}

interface BuildConnectorsOptions { subscriptions?: any[]; sponge?: any; spongeError?: boolean; weixin?: any; }
export function buildConnectors({ subscriptions = [], sponge = null, spongeError = false, weixin = null }: BuildConnectorsOptions = {}) {
  const subs = new Map(subscriptions.map(s => [s.provider, s]));
  const connectors = CATALOG.map(entry => {
    const base = { ...entry };
    if (entry.kind === 'subscription') {
      const sub = subs.get(entry.provider);
      return { ...base, ...subscriptionState(sub), account: subscriptionAccount(sub),
        lastSuccessAt: sub?.lastSuccessAt || null, actions: sub?.configured ? ['configure', sub.enabled ? 'pause' : 'resume', 'disconnect'] : ['connect'] };
    }
    if (entry.kind === 'sponge') {
      const devices = Array.isArray(sponge?.devices) ? sponge.devices : [];
      const online = devices.filter(d => d.online === true || d.status === 'online').length;
      const state = spongeError ? 'error' : sponge?.connected ? (devices.length ? 'connected' : 'available') : 'available';
      return { ...base, state, status: spongeError ? '状态未知' : !sponge?.connected ? '未连接' : devices.length ? `${devices.length} 台设备 · ${online} 台在线` : '未配对设备',
        account: sponge?.accountName || '', devices: devices.slice(0, 10).map(d => ({ name: d.name || d.deviceId || '设备', platform: d.platform || '', online: d.online === true || d.status === 'online' })),
        actions: sponge?.connected ? ['manage'] : ['connect'] };
    }
    if (entry.kind === 'weixin') {
      const state = weixin?.state === 'connected' ? 'connected' : weixin?.state === 'expired' ? 'error' : 'available';
      return { ...base, state, status: weixin?.state === 'connected' ? '已连接' : weixin?.state === 'expired' ? '需重新扫码' : '未连接',
        pushProactive: Boolean(weixin?.pushProactive), actions: weixin?.state === 'connected' ? [weixin.pushProactive ? 'push_off' : 'push_on', 'disconnect'] : ['connect'] };
    }
    if (entry.kind === 'builtin') return { ...base, state: 'connected', status: '已开启', actions: [] };
    return { ...base, state: 'planned', status: '即将支持', actions: [] };
  });
  const connected = connectors.filter(c => c.state === 'connected' && c.kind !== 'builtin').length;
  // 内置能力和尚未支持的连接器不在列表里展示。
  return { ok: true, categories: CATEGORIES, connectors: connectors.filter(c => c.kind !== 'builtin' && c.kind !== 'planned'), summary: { connected, total: connectors.filter(c => c.kind !== 'builtin' && c.kind !== 'planned').length } };
}
