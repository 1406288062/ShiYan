// Dots 只读访问“本账号”配对的海绵宝宝设备。
// 走拾燕的海绵宝宝连接（每个账号独立授权），设备归属由中继强制校验，跨账号会被拒绝。
import { createSpongeClient } from '/home/ubuntu/boss-codex-service/shiyan-v2/sponge-client.mjs';

export const DEVICE_READ_OPS = ['list_devices', 'list_directory', 'read_file', 'get_file_info'];
let client: any = null;
const sleep = (ms: any) => new Promise(resolve => setTimeout(resolve, ms));
const textOf = (result: any) => (result?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') || JSON.stringify(result ?? null);

export function parseDeviceRead(action: any) {
  const op = String(action?.command || '').trim();
  if (!DEVICE_READ_OPS.includes(op)) throw new Error('device_read 只支持 ' + DEVICE_READ_OPS.join('、'));
  if (op === 'list_devices') return { op, args: {} };
  const raw = String(action?.path || ''), split = raw.indexOf('|');
  if (split < 1) throw new Error('device_read 的 path 需写成 “设备ID|绝对路径”，设备ID 先用 list_devices 查');
  const deviceId = raw.slice(0, split).trim(), target = raw.slice(split + 1).trim();
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(deviceId) || !target) throw new Error('设备 ID 或路径无效');
  return { op, args: { deviceId, path: target, ...(op === 'read_file' ? { length: 400 } : {}) } };
}

export async function deviceRead(owner: any, action: any, { sponge = null, timeoutMs = 30_000 } = {}) {
  const { op, args } = parseDeviceRead(action);
  client ||= sponge || createSpongeClient({ timeoutMs });
  const call = (name: any, input: any) => client.rpc(owner, 'tools/call', { name, arguments: input }, { signal: AbortSignal.timeout(timeoutMs) });
  let text = textOf(await call(op, args));
  // 长任务会先返回 call_id，稍后取结果。只读操作重复查询结果是安全的。
  for (let i = 0; i < 4; i++) {
    let pending; try { pending = JSON.parse(text); } catch { break; }
    if (!pending?.call_id || !['accepted', 'pending', 'executing'].includes(pending.state)) break;
    await sleep(1500 * (i + 1));
    text = textOf(await call('get_tool_result', { call_id: pending.call_id }));
  }
  return `${op} ${(args as any).deviceId ? (args as any).deviceId + ' ' + ((args as any).path || '') : ''}\n${text}`.slice(0, 20_000);
}
