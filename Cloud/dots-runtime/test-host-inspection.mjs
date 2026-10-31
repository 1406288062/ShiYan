import test from 'node:test';
import assert from 'node:assert/strict';
import {executeHostInspection, isHostInspectionAction, HOST_INSPECTION_TIMEOUT_MS, HOST_INSPECTION_MAX_BUFFER} from './host-inspection.mjs';

const action = command => ({type:'inspect_host', command, path:'', content:'', reason:'Read-only inspection'});
function fakeExec(responses, calls = []) {
  return (binary, args, options, callback) => {
    calls.push({binary, args, options});
    const reply = responses.shift();
    assert.ok(reply, 'Unexpected execution');
    callback(reply.error || null, reply.stdout || '', reply.stderr || '');
  };
}

test('classifies only inspect_host without accepting other action types', () => {
  assert.equal(isHostInspectionAction(action('disk_usage')), true);
  assert.equal(isHostInspectionAction({type:'run_command'}), false);
  assert.equal(isHostInspectionAction(null), false);
});

test('rejects command injection, unknown commands, path/content and extra targets before executing', async () => {
  let calls = 0;
  const execFile = () => { calls++; throw new Error('Must not execute'); };
  for (const invalid of [
    {...action('disk_usage'), command:'disk_usage; touch /tmp/x'},
    {...action('disk_usage'), command:'$(id)'},
    {...action('disk_usage'), command:'toString'},
    {...action('disk_usage'), command:'__proto__'},
    {...action('disk_usage'), command:'ssh'},
    {...action('disk_usage'), command:['disk_usage']},
    {...action('disk_usage'), path:'/home/ubuntu'},
    {...action('disk_usage'), content:' '},
    {...action('disk_usage'), path:undefined},
    {...action('disk_usage'), args:['/etc/shadow']},
    {...action('disk_usage'), target:'another-host'},
    {...action('disk_usage'), env:{LD_PRELOAD:'/tmp/code'}},
    {...action('disk_usage'), type:'run_command'}
  ]) await assert.rejects(executeHostInspection(invalid, {execFile}));
  assert.equal(calls, 0);
});

test('fixed absolute commands and resource limits use no shell or inherited credential environment', async () => {
  const expected = [
    ['disk_usage', '/usr/bin/df', ['-hP', '/', '/home/ubuntu']],
    ['disk_inodes', '/usr/bin/df', ['-iP', '/']],
    ['network_interfaces', '/sbin/ifconfig', []],
    ['system_uptime', '/usr/bin/uptime', []]
  ];
  for (const [command, binary, args] of expected) {
    const calls = [];
    const result = await executeHostInspection(action(command), {execFile:fakeExec([{stdout:'actual output\n', stderr:'warning\n'}], calls)});
    assert.equal(result.ok, true); assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'actual output\n'); assert.equal(result.stderr, 'warning\n');
    assert.equal(result.scope, 'runtime_host'); assert.equal(result.host.namespace, 'same_as_runtime_process');
    assert.equal(result.host.platform, 'linux'); assert.equal(typeof result.host.hostname, 'string');
    assert.equal(calls.length, 1); assert.equal(calls[0].binary, binary); assert.deepEqual(calls[0].args, args);
    const options = calls[0].options;
    assert.equal(options.shell, false); assert.equal(options.cwd, '/');
    assert.equal(options.timeout, HOST_INSPECTION_TIMEOUT_MS); assert.equal(options.maxBuffer, HOST_INSPECTION_MAX_BUFFER);
    assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  }
});

test('only missing ifconfig falls back to fixed ip addr show, retaining both receipts', async () => {
  const calls = [];
  const error = Object.assign(new Error('ifconfig not found'), {code:'ENOENT'});
  const result = await executeHostInspection(action('network_interfaces'), {execFile:fakeExec([{error}, {stdout:'2: eth0\n'}], calls)});
  assert.equal(result.ok, true); assert.equal(result.stdout, '2: eth0\n');
  assert.equal(result.attempts.length, 2); assert.equal(result.attempts[0].errorCode, 'ENOENT');
  assert.equal(calls[1].binary, '/sbin/ip'); assert.deepEqual(calls[1].args, ['addr', 'show']);
});

test('permission errors and nonzero exits never trigger a fallback and preserve real output', async () => {
  for (const code of ['EACCES', 1, 127]) {
    const calls = [];
    const error = Object.assign(new Error('command failed'), {code});
    const result = await executeHostInspection(action('network_interfaces'), {execFile:fakeExec([{error, stdout:'partial\n', stderr:'failure\n'}], calls)});
    assert.equal(calls.length, 1); assert.equal(result.ok, false);
    assert.equal(result.exitCode, typeof code === 'number' ? code : null);
    assert.equal(result.stdout, 'partial\n'); assert.equal(result.stderr, 'failure\n');
  }
});

test('timeout returns bounded partial output, signal and failure without fallback', async () => {
  const calls = [];
  const error = Object.assign(new Error('command timed out'), {code:null, signal:'SIGTERM', killed:true});
  const result = await executeHostInspection(action('network_interfaces'), {execFile:fakeExec([{error, stdout:'partial output'}], calls)});
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.exitCode, null); assert.equal(result.stdout, 'partial output'); assert.equal(calls.length, 1);
});

test('output limit failure is separate from timeout and caps each captured stream', async () => {
  const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed:true, signal:'SIGTERM'});
  const result = await executeHostInspection(action('disk_usage'), {execFile:fakeExec([{error, stdout:'x'.repeat(HOST_INSPECTION_MAX_BUFFER+100), stderr:'y'.repeat(HOST_INSPECTION_MAX_BUFFER+10)}])});
  assert.equal(result.ok, false); assert.equal(result.outputLimited, true); assert.equal(result.timedOut, false);
  assert.equal(Buffer.byteLength(result.stdout), HOST_INSPECTION_MAX_BUFFER);
  assert.equal(Buffer.byteLength(result.stderr), HOST_INSPECTION_MAX_BUFFER);
});

test('fallback failure remains a failure with no third attempt', async () => {
  const missing = Object.assign(new Error('missing'), {code:'ENOENT'});
  const calls = [];
  const result = await executeHostInspection(action('network_interfaces'), {execFile:fakeExec([{error:missing}, {error:missing}], calls)});
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'ENOENT'); assert.equal(result.attempts.length, 2);
  assert.equal(calls.length, 2);
});

test('synchronous spawn exception produces a failed receipt without executing arbitrary alternatives', async () => {
  const result = await executeHostInspection(action('disk_inodes'), {execFile:() => { throw Object.assign(new Error('denied'), {code:'EACCES'}); }});
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'EACCES'); assert.equal(result.attempts.length, 1);
});
