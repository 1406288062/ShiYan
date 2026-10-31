// Claude 订阅额度：读取服务器 Claude CLI 的 OAuth 登录凭据，查询订阅用量（5 小时 / 每周窗口）。
// 只读，不刷新凭据（刷新交给 Claude CLI 自己），失败时返回 null 由上层降级。
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const CREDENTIALS = process.env.SHIYAN_CLAUDE_CREDENTIALS || path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PLAN_NAMES = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' };
const WINDOWS = [
  ['five_hour', '5 小时'],
  ['seven_day', '每周'],
  ['seven_day_opus', '每周 · Opus'],
  ['seven_day_sonnet', '每周 · Sonnet'],
];

export async function readClaudeCredentials(file = CREDENTIALS) {
  try {
    const oauth = JSON.parse(await fs.readFile(file, 'utf8'))?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || null, plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null };
  } catch { return null; }
}

const seconds = value => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? Math.round(time / 1000) : null;
};

export function claudeWindows(usage, plan = null) {
  if (!usage || typeof usage !== 'object') return [];
  const bucket = PLAN_NAMES[plan] || 'Claude';
  return WINDOWS.flatMap(([key, period]) => {
    const w = usage[key];
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return [];
    return [{ bucket, period, remainingPercent: Math.max(0, Math.min(100, 100 - w.utilization)), resetsAt: seconds(w.resets_at) }];
  });
}

export function claudeExtraUsage(usage) {
  const extra = usage?.extra_usage;
  if (!extra || extra.is_enabled !== true) return null;
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { utilization: number(extra.utilization), usedCredits: number(extra.used_credits), monthlyLimit: number(extra.monthly_limit), currency: typeof extra.currency === 'string' ? extra.currency : null };
}

export async function readClaudeUsage({ credentials = readClaudeCredentials, fetchImpl = fetch } = {}) {
  const auth = await credentials();
  if (!auth) throw Object.assign(new Error('服务器未登录 Claude'), { code: 'not_logged_in' });
  if (auth.expiresAt && auth.expiresAt <= Date.now()) throw Object.assign(new Error('Claude 登录已过期'), { code: 'expired' });
  const response = await fetchImpl(USAGE_URL, {
    headers: { Authorization: `Bearer ${auth.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json', 'User-Agent': 'shiyan-quota/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Claude 登录无效'), { code: 'unauthorized' });
  if (!response.ok) throw new Error('Claude 额度查询失败');
  const usage = await response.json();
  return { plan: auth.plan, usage };
}

export function createClaudeQuotaReader(read = readClaudeUsage) {
  let cached, pending;
  return async () => {
    if (cached && Date.now() - cached.fetchedAt < 60000) return cached;
    if (!pending) pending = read().then(({ plan, usage }) => {
      const windows = claudeWindows(usage, plan);
      if (!windows.length) throw new Error('Claude 账户未提供可显示的额度');
      return cached = { available: true, plan: PLAN_NAMES[plan] || (plan ? `Claude ${plan}` : 'Claude'), windows, extraUsage: claudeExtraUsage(usage), fetchedAt: Date.now() };
    }).finally(() => { pending = null; });
    return pending;
  };
}

const CLAUDE_ERRORS = { not_logged_in: '服务器尚未登录 Claude', expired: 'Claude 登录已过期，等待 Claude CLI 自动续期', unauthorized: 'Claude 登录无效' };

// 合并 Codex 与 Claude：任一可用即返回，二者独立降级。
export function createAccountQuotaReader({ codex, claude = createClaudeQuotaReader() }) {
  return async () => {
    const [c, a] = await Promise.allSettled([codex(), claude()]);
    if (c.status === 'rejected' && a.status === 'rejected') throw new Error('暂时无法获取账户额度');
    const claudePart = a.status === 'fulfilled' ? a.value : { available: false, windows: [], error: CLAUDE_ERRORS[a.reason?.code] || '暂时无法获取 Claude 额度' };
    const codexPart = c.status === 'fulfilled' ? c.value : { available: false, windows: [], resetCredits: null, error: '暂时无法获取 Codex 额度' };
    return { ...codexPart, claude: claudePart };
  };
}
