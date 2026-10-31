import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {executeHostInspection} from './host-inspection.mjs';
import {canApplyGoalActions} from './goal-run-state.mjs';

const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const actionSource = source.slice(source.indexOf('async function executeSafeActions('), source.indexOf('async function runGoal('));
const action = command => ({type:'inspect_host', command, path:'', content:'', reason:'User requested a current-host read-only check'});
function fixture(execFile, durable = false) {
  let status = 'active';
  const receipts = [];
  const store = {
    isCurrent:() => true,
    beginAction:(_run, ordinal) => ({id:'inspection:'+ordinal, state:'started'}),
    finishAction:(id, result) => receipts.push({id, result})
  };
  const context = vm.createContext({
    canApplyGoalActions, getGoal:() => ({id:37, status}), addTimeline:() => {},
    executeHostInspection:input => executeHostInspection(input, {execFile}),
    json:JSON.stringify, ...(durable ? {managerStore:store} : {})
  });
  vm.runInContext(actionSource, context);
  return {
    run:actions => context.executeSafeActions({id:37, workspace:'/isolated-fixture'}, actions, durable ? {id:'worker-run'} : null),
    pause:() => {status = 'paused';}, receipts
  };
}
test('actual dispatcher returns a current-host receipt without an approval or workspace container', async () => {
  const commands = [];
  const f = fixture((binary,args,options,callback) => {
    commands.push({binary,args,options}); callback(null, 'actual fixed-command output', '');
  }, true);
  const result = (await f.run([action('disk_usage')]))[0];
  assert.equal(result.ok, true);
  const receipt = JSON.parse(result.detail);
  assert.equal(receipt.scope, 'runtime_host');
  assert.equal(receipt.stdout, 'actual fixed-command output');
  assert.equal(receipt.exitCode, 0);
  assert.equal(commands[0].binary, '/usr/bin/df');
  assert.deepEqual(commands[0].args, ['-hP','/','/home/ubuntu']);
  assert.equal(commands[0].options.shell, false);
  assert.equal(f.receipts[0].result.ok, true);
});
test('actual dispatcher preserves command failure as a failed durable action', async () => {
  const f = fixture((_binary,_args,_options,callback) => callback(Object.assign(new Error('denied'), {code:17}), '', 'permission denied'), true);
  const result = (await f.run([action('network_interfaces')]))[0];
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.detail).exitCode, 17);
  assert.equal(JSON.parse(result.detail).stderr, 'permission denied');
  assert.equal(f.receipts[0].result.ok, false);
});
test('actual dispatcher cannot turn invalid inspection fields into arbitrary host commands', async () => {
  let calls = 0;
  const f = fixture(() => {calls++;});
  for (const input of [{...action('network_interfaces'), command:'ifconfig; touch /tmp/escape'}, {...action('disk_usage'), path:'/etc'}, {...action('disk_usage'), args:['-a']}]) {
    assert.equal((await f.run([input]))[0].ok, false);
  }
  assert.equal(calls, 0);
});
test('read-only timeout keeps its real receipt and does not create an uncertain mutation lock', async () => {
  const f = fixture((_binary,_args,_options,callback) => callback(Object.assign(new Error('timeout'), {killed:true, signal:'SIGTERM'}), '', ''), true);
  const result = (await f.run([action('system_uptime')]))[0];
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.detail).timedOut, true);
  assert.equal(result.uncertain, undefined);
  assert.equal(f.receipts[0].result.ok, false);
});
test('user pause after an inspection prevents the next inspection from starting', async () => {
  let calls = 0;
  const f = fixture((_binary,_args,_options,callback) => {calls++; f.pause(); callback(null,'output','');});
  const results = await f.run([action('disk_usage'), action('disk_inodes')]);
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
});
