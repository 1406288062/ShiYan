// A progressing Codex job may legitimately take longer than 15 minutes.
// Bound inactivity while allowing progressing jobs to continue indefinitely
// by default. Explicit runtime limits remain separate from the user's stop action.
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_RUNTIME_MS = 0;
const MAX_TIMER_MS = 2 ** 31 - 1;

function timeoutValue(value: any, fallback: any) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_TIMER_MS ? number : fallback;
}

export function jobTimeouts(environment = process.env) {
  return { idleTimeoutMs: timeoutValue(environment.SHIYAN_JOB_IDLE_TIMEOUT_MS, DEFAULT_IDLE_MS),
    maxRuntimeMs: timeoutValue(environment.SHIYAN_JOB_MAX_RUNTIME_MS, DEFAULT_RUNTIME_MS) };
}

function duration(value: any) {
  if (value % 3600000 === 0) return `${value / 3600000} 小时`;
  if (value >= 60000) return `${Math.ceil(value / 60000)} 分钟`;
  return `${Math.ceil(value / 1000)} 秒`;
}

interface JobDeadlineOptions { idleTimeoutMs?: number; maxRuntimeMs?: number; onExpire?: (error: any) => void; schedule?: typeof setTimeout; unschedule?: typeof clearTimeout; }
export function createJobDeadline({ idleTimeoutMs = DEFAULT_IDLE_MS, maxRuntimeMs = DEFAULT_RUNTIME_MS,
  onExpire, schedule = setTimeout, unschedule = clearTimeout }: JobDeadlineOptions = {}) {
  idleTimeoutMs = timeoutValue(idleTimeoutMs, DEFAULT_IDLE_MS);
  maxRuntimeMs = timeoutValue(maxRuntimeMs, DEFAULT_RUNTIME_MS);
  let idleTimer: any, runtimeTimer: any, expiration: any = null, disposed = false;
  function clear() { unschedule(idleTimer); unschedule(runtimeTimer); }
  function expire(kind: any, limit: any) {
    if (expiration || disposed) return;
    const error = new Error(kind === 'idle'
      ? `任务连续 ${duration(limit)} 没有新进展，处理已超时，请重试。`
      : `任务处理超过 ${duration(limit)}，已达到本次时限，请重试继续。`);
    (error as any).code = kind === 'idle' ? 'SHIYAN_IDLE_TIMEOUT' : 'SHIYAN_RUNTIME_TIMEOUT';
    expiration = { kind, timeoutMs: limit, error };
    clear(); onExpire?.(error);
  }
  function renewIdle() {
    if (expiration || disposed) return false;
    unschedule(idleTimer);
    idleTimer = schedule(() => expire('idle', idleTimeoutMs), idleTimeoutMs);
    idleTimer?.unref?.();
    return true;
  }
  if (maxRuntimeMs > 0) {
    runtimeTimer = schedule(() => expire('runtime', maxRuntimeMs), maxRuntimeMs);
    runtimeTimer?.unref?.();
  }
  renewIdle();
  return { touch: renewIdle, get expiration() { return expiration; },
    dispose() { disposed = true; clear(); } };
}

interface JobFailureOptions { expiration?: any; cancelRequested?: boolean; }
export function jobFailure(error: any, { expiration, cancelRequested = false }: JobFailureOptions = {}) {
  if (cancelRequested) return { status: 'cancelled', error: '已停止处理' };
  if (expiration) return { status: 'failed', error: expiration.error.message };
  const message = String(error?.message || error);
  const unexpectedAbort = error?.name === 'AbortError' || /^The operation was aborted\.?$/i.test(message.trim());
  return { status: 'failed', error: unexpectedAbort ? '处理意外中断，请重试；已接收的内容会保留。' : message.slice(0, 2000) };
}
