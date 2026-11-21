import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobDeadline, jobFailure, jobTimeouts } from './job-deadline.ts';

function clock(): any {
  let now = 0, nextID = 0;
  const pending = new Map();
  return { schedule(callback: any, delay: any) { const id = ++nextID; pending.set(id, { at: now + delay, callback }); return id; },
    unschedule(id: any) { pending.delete(id); },
    advance(value: any) {
      const until = now + value;
      while (true) {
        const next = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      now = until;
    }, get count() { return pending.size; } };
}

test('defaults retain 15-minute inactivity without a total runtime limit', () => {
  assert.deepEqual(jobTimeouts({}), { idleTimeoutMs: 900000, maxRuntimeMs: 0 });
  assert.deepEqual(jobTimeouts({ SHIYAN_JOB_IDLE_TIMEOUT_MS: '1200000', SHIYAN_JOB_MAX_RUNTIME_MS: '10800000' }), { idleTimeoutMs: 1200000, maxRuntimeMs: 10800000 });
  for (const value of ['0', '-1', '', 'not-a-number', 'Infinity', '1.5', '9999999999999']) {
    assert.deepEqual(jobTimeouts({ SHIYAN_JOB_IDLE_TIMEOUT_MS: value, SHIYAN_JOB_MAX_RUNTIME_MS: value }), { idleTimeoutMs: 900000, maxRuntimeMs: 0 });
  }
});

test('default deadline schedules only inactivity and continuous progress survives eight hours', () => {
  const time = clock(), errors: any[] = [];
  const deadline = createJobDeadline({ schedule: time.schedule, unschedule: time.unschedule, onExpire: error => errors.push(error) });
  assert.equal(time.count, 1);
  for (let minute = 0; minute < 480; minute++) {
    time.advance(60000); assert.equal(deadline.touch(), true);
    assert.equal(deadline.expiration, null); assert.equal(time.count, 1);
  }
  assert.equal(errors.length, 0);
  deadline.dispose(); assert.equal(time.count, 0);
});

test('explicit positive runtime limit still expires despite continuous progress', () => {
  const time = clock(), errors: any[] = [];
  const deadline = createJobDeadline({ ...jobTimeouts({ SHIYAN_JOB_MAX_RUNTIME_MS: '7200000' }), schedule: time.schedule, unschedule: time.unschedule, onExpire: error => errors.push(error) });
  assert.equal(time.count, 2);
  for (let minute = 0; minute < 119; minute++) { time.advance(60000); assert.equal(deadline.touch(), true); }
  assert.equal(deadline.expiration, null); assert.equal(errors.length, 0);
  time.advance(60000);
  assert.equal((deadline.expiration as any).kind, 'runtime'); assert.equal(errors.length, 1);
  assert.match(errors[0].message, /2 小时/); assert.equal(time.count, 0);
  assert.equal(deadline.touch(), false);
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  assert.deepEqual(jobFailure(abort, { expiration: deadline.expiration }), { status: 'failed', error: errors[0].message });
  assert.deepEqual(jobFailure(abort, { expiration: deadline.expiration, cancelRequested: true }), { status: 'cancelled', error: '已停止处理' });
});

test('inactivity resets on progress and expires only after the renewed full interval', () => {
  const time = clock(), errors: any[] = [];
  const deadline = createJobDeadline({ idleTimeoutMs: 1000, maxRuntimeMs: 0, schedule: time.schedule, unschedule: time.unschedule, onExpire: error => errors.push(error) });
  time.advance(900); deadline.touch(); time.advance(999);
  assert.equal(deadline.expiration, null); time.advance(1);
  assert.equal((deadline.expiration as any).kind, 'idle'); assert.equal(errors[0].code, 'SHIYAN_IDLE_TIMEOUT');
  assert.match(errors[0].message, /没有新进展/); time.advance(20000); assert.equal(errors.length, 1);
  assert.equal(time.count, 0); assert.equal(deadline.touch(), false);
});

test('finished or manually cancelled jobs dispose every timer with or without a runtime limit', () => {
  for (const maxRuntimeMs of [0, 5000]) {
    const time = clock(), errors: any[] = [];
    const deadline = createJobDeadline({ idleTimeoutMs: 1000, maxRuntimeMs, schedule: time.schedule, unschedule: time.unschedule, onExpire: error => errors.push(error) });
    assert.equal(time.count, maxRuntimeMs > 0 ? 2 : 1);
    time.advance(800); deadline.dispose(); time.advance(10000);
    assert.equal(time.count, 0); assert.equal(errors.length, 0); assert.equal(deadline.touch(), false);
  }
});

test('timeouts fail with specific Chinese reason even when SDK only throws generic AbortError', () => {
  const time = clock();
  const deadline = createJobDeadline({ idleTimeoutMs: 1000, maxRuntimeMs: 5000, schedule: time.schedule, unschedule: time.unschedule });
  time.advance(1000);
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const failure = jobFailure(abort, { expiration: deadline.expiration });
  assert.equal(failure.status, 'failed'); assert.match(failure.error, /没有新进展/); assert.equal(failure.error.includes('aborted'), false);
  assert.deepEqual(jobFailure(abort, { expiration: deadline.expiration, cancelRequested: true }), { status: 'cancelled', error: '已停止处理' });
});

test('unexpected abort is localized without hiding ordinary diagnostic errors', () => {
  assert.deepEqual(jobFailure(new Error('The operation was aborted')), { status: 'failed', error: '处理意外中断，请重试；已接收的内容会保留。' });
  assert.deepEqual(jobFailure(new Error('Disk is full')), { status: 'failed', error: 'Disk is full' });
});
