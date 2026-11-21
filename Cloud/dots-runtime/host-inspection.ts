import {execFile as nodeExecFile} from 'node:child_process';
import {hostname} from 'node:os';

export const HOST_INSPECTION_TIMEOUT_MS = 5000;
export const HOST_INSPECTION_MAX_BUFFER = 128 * 1024;
const specifications = Object.freeze({
  disk_usage: {binary:'/usr/bin/df', args:['-hP', '/', '/home/ubuntu']},
  disk_inodes: {binary:'/usr/bin/df', args:['-iP', '/']},
  network_interfaces: {binary:'/sbin/ifconfig', args:[], fallback:{binary:'/sbin/ip', args:['addr', 'show']}},
  system_uptime: {binary:'/usr/bin/uptime', args:[]}
});
const allowedKeys = new Set(['type', 'command', 'path', 'content', 'reason']);

export const isHostInspectionAction = action => action?.type === 'inspect_host';

function validate(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || !isHostInspectionAction(action)) throw new Error('Expected inspect_host action');
  if (Object.keys(action).some(key => !allowedKeys.has(key))) throw new Error('inspect_host does not accept additional arguments or targets');
  if (action.path !== '' || action.content !== '') throw new Error('inspect_host requires empty path and content');
  if (typeof action.command !== 'string' || !Object.hasOwn(specifications, action.command)) throw new Error('Unknown host inspection command');
  if (action.reason !== undefined && typeof action.reason !== 'string') throw new Error('inspect_host reason must be a string');
  if (process.platform !== 'linux') throw new Error('inspect_host is limited to the current Linux runtime host');
  return specifications[action.command];
}

function boundedOutput(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  return {text:bytes.subarray(0, HOST_INSPECTION_MAX_BUFFER).toString('utf8'), truncated:bytes.length > HOST_INSPECTION_MAX_BUFFER};
}

function inspect(specification, execFile) {
  return new Promise(resolve => {
    const finish = (error, stdout, stderr) => {
      const out = boundedOutput(stdout), err = boundedOutput(stderr);
      const outputLimited = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || out.truncated || err.truncated;
      resolve({
        binary:specification.binary, args:[...specification.args],
        ok:!error && !outputLimited, stdout:out.text, stderr:err.text,
        exitCode:error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        errorCode:error && typeof error.code === 'string' ? error.code : null,
        error:error ? String(error.message || error) : null,
        signal:error?.signal || null, timedOut:Boolean(error?.killed && !outputLimited), outputLimited
      });
    };
    try {
      execFile(specification.binary, [...specification.args], {
        cwd:'/', shell:false, encoding:'utf8', timeout:HOST_INSPECTION_TIMEOUT_MS,
        maxBuffer:HOST_INSPECTION_MAX_BUFFER, killSignal:'SIGTERM',
        env:{LANG:'C.UTF-8', LC_ALL:'C.UTF-8', PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}
      }, finish);
    } catch (error) { finish(error, '', ''); }
  });
}

// Runs in the existing server process's host namespace. This does not invoke
// Codex shell tools, Docker, SSH, Mac execution, or arbitrary command strings.
export async function executeHostInspection(action, {execFile = nodeExecFile} = {}) {
  const specification = validate(action);
  const startedAt = new Date().toISOString();
  const attempts = [await inspect(specification, execFile)];
  if (specification.fallback && (attempts[0] as any).errorCode === 'ENOENT') attempts.push(await inspect(specification.fallback, execFile));
  const result = attempts.at(-1);
  return {
    ...(result as any), command:action.command, scope:'runtime_host',
    host:{hostname:hostname(), platform:process.platform, uid:process.getuid?.() ?? null, namespace:'same_as_runtime_process'},
    attempts, startedAt, finishedAt:new Date().toISOString()
  };
}
