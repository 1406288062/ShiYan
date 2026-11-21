// Per-account Docker sandboxes for Dots agents.
//
// Every account gets ONE long-lived container (`shiyan-agent-<hash>`). Agent SDK processes run in it
// with their full built-in tools (shell, files, code, web): the Claude Code CLI through the Agent
// SDK's spawnClaudeCodeProcess, the Codex app-server through the Codex transport's spawnProcess.
// The container is the security boundary, so agents run without per-command approvals inside it.
//
// Host paths that survive the container:
//   workspace -> the account's files (Dots task folders live at /workspace/dots/<id>)
//   home      -> /home/agent: agent sessions (~/.claude, ~/.codex), caches, user-installed tools
//   rpc       -> /run/shiyan: per-session host tool sockets (see agent-tools.mjs)
// Agent binaries are mounted read-only from the host; a host upgrade changes the container spec and
// the container is recreated on next use (sessions live in the mounted home and are kept).
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, realpathSync, chmodSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const fail = (message, status = 500) => Object.assign(new Error(message), { status });
export const ownerHash = owner => createHash('sha256').update(String(owner)).digest('hex');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function dockerRunner(command = (process.env.SHIYAN_AGENT_DOCKER || 'sudo -n docker').split(/\s+/)) {
  const [bin, ...prefix] = command;
  return {
    command, run(args, { timeoutMs = 120_000, input = null } = {}) {
      return new Promise((resolve, reject) => {
        const child = execFile(bin, [...prefix, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(new Error(String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(0, 600)), { code: error.code, stdout, stderr }));
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
        if (input !== null) child.stdin!.end(input);
      });
    },
    spawn(args, options = {}) { return spawn(bin, [...prefix, ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...options }); },
  };
}

function resolveCodexBinary(value) {
  try { const real = realpathSync(value); return { dir: path.dirname(real), name: path.basename(real) }; } catch { return null; }
}

export interface SandboxLayout {
  workspace: string;
  workspaceTarget: string;
  home: string;
  rpc: string;
  readonly?: Array<[string, string]>;
}
export interface SandboxManagerOptions {
  image?: string;
  docker?: any;
  layoutFor: (owner: string) => SandboxLayout;
  claudeBinary?: string;
  codexBinary?: string;
  relayScript?: string;
  skillsDir?: string;
  credentials?: { claude: string; claudeEnv: string; codex: string };
  limits?: { memory: string; cpus: string; pids: string };
  uid?: number;
  gid?: number;
  idleMs?: number;
  logger?: any;
}
export function createSandboxManager({
  image = process.env.SHIYAN_AGENT_IMAGE || 'shiyan-agent:1',
  docker = dockerRunner(),
  layoutFor,                                   // owner -> { workspace, workspaceTarget, home, rpc }
  claudeBinary = process.env.SHIYAN_CLAUDE_BIN || '/home/ubuntu/boss-codex-service/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  codexBinary = process.env.CODEX_PATH || '/home/ubuntu/.local/bin/codex',
  relayScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-sandbox', 'mcp-relay.mjs'),
  // Dots 技能库（可复用工作流程），只读挂到 Claude Code 与 Codex 各自的技能目录。
  skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills'),
  credentials = { claude: path.join(os.homedir(), '.claude', '.credentials.json'), claudeEnv: path.join(os.homedir(), '.config', 'shiyan', 'claude.env'), codex: path.join(os.homedir(), '.codex', 'auth.json') },
  limits = { memory: process.env.SHIYAN_AGENT_MEMORY || '1536m', cpus: process.env.SHIYAN_AGENT_CPUS || '1.5', pids: process.env.SHIYAN_AGENT_PIDS || '1024' },
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
  idleMs = Number(process.env.SHIYAN_AGENT_IDLE_MS) || 30 * 60_000,
  logger = console,
}: SandboxManagerOptions) {
  if (typeof layoutFor !== 'function') throw new Error('layoutFor is required');
  const state = new Map();        // owner -> { ready: Promise, active, lastUsed }
  const codex = resolveCodexBinary(codexBinary);
  const name = owner => 'shiyan-agent-' + ownerHash(owner).slice(0, 16);
  const paths = { claude: '/opt/shiyan/bin/claude', codex: codex ? '/opt/shiyan/codex/' + codex.name : '/opt/shiyan/bin/codex', relay: '/opt/shiyan/mcp-relay.mjs' };

  function layout(owner) {
    const value = layoutFor(owner);
    for (const dir of [value.workspace, value.home, value.rpc]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    // 技能目录的挂载点先由服务用户建好，避免 Docker 以 root 身份在账号 home 里创建。
    for (const dir of [path.join(value.home, '.claude', 'skills'), path.join(value.home, '.codex', 'skills')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return value;
  }
  function runArgs(owner, l, spec) {
    const mounts = [
      ['-v', `${l.workspace}:${l.workspaceTarget || '/workspace'}`], ['-v', `${l.home}:/home/agent`], ['-v', `${l.rpc}:/run/shiyan`],
      ['-v', `${relayScript}:${paths.relay}:ro`],
      ...(existsSync(claudeBinary) ? [['-v', `${claudeBinary}:${paths.claude}:ro`]] : []),
      ...(codex ? [['-v', `${codex.dir}:/opt/shiyan/codex:ro`]] : []),
      ...(existsSync(skillsDir) ? [['-v', `${skillsDir}:/home/agent/.claude/skills:ro`], ['-v', `${skillsDir}:/home/agent/.codex/skills:ro`]] : []),
      // Extra read-only inputs of this account (e.g. its uploaded chat attachments), at the paths the
      // Dots conversation refers to them by.
      ...(l.readonly || []).filter(([host]) => existsSync(host)).map(([host, target]) => ['-v', `${host}:${target || host}:ro`]),
    ].flat();
    return ['run', '-d', '--name', name(owner), '--label', 'shiyan.agent=1', '--label', 'shiyan.spec=' + spec, '--hostname', 'dots-agent',
      '--user', `${uid}:${gid}`, '--memory', limits.memory, '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--add-host', 'host.docker.internal:host-gateway',
      '--restart', 'unless-stopped', '-e', 'HOME=/home/agent', '-w', '/workspace', ...mounts, image, 'sleep', 'infinity'];
  }
  async function create(owner) {
    const l = layout(owner);
    const spec = createHash('sha256').update(JSON.stringify([image, l, limits, uid, gid, codex, existsSync(claudeBinary) ? statSync(claudeBinary).mtimeMs : 0, relayScript, existsSync(skillsDir) ? skillsDir : ''])).digest('hex').slice(0, 16);
    let current = null;
    try { current = (await docker.run(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "shiyan.spec"}}', name(owner)])).stdout.trim().split(' '); } catch { current = null; }
    if (current && current[1] !== spec) { logger.info?.(`[agent-sandbox] recreating ${name(owner)} (spec changed)`); await docker.run(['rm', '-f', name(owner)]).catch(() => {}); current = null; }
    if (!current) await docker.run(runArgs(owner, l, spec), { timeoutMs: 180_000 });
    else if (current[0] !== 'true') await docker.run(['start', name(owner)]);
    return l;
  }
  // Fresh model credentials are copied into the agent home at each session start (the container
  // never reads host files directly). Claude also reads the env file values passed on exec.
  function syncCredentials(l) {
    const put = (from, to) => { if (!from || !existsSync(from)) return; mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); copyFileSync(from, to); chmodSync(to, 0o600); };
    put(credentials.claude, path.join(l.home, '.claude', '.credentials.json'));
    put(credentials.codex, path.join(l.home, '.codex', 'auth.json'));
  }
  function claudeEnv() {
    const out = {};
    try {
      for (const line of readFileSync(credentials.claudeEnv, 'utf8').split(/\r?\n/)) {
        const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) continue;
        out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      }
    } catch {}
    return out;
  }
  async function ensure(owner) {
    let entry = state.get(owner);
    if (!entry) { entry = { ready: null, active: 0, lastUsed: Date.now() }; state.set(owner, entry); }
    if (!entry.ready) entry.ready = create(owner).catch(error => { entry.ready = null; throw fail('智能体沙箱启动失败：' + error.message, 503); });
    const l = await entry.ready;
    syncCredentials(l);
    entry.lastUsed = Date.now();
    return { name: name(owner), layout: l, paths };
  }
  // Spawns a process inside the account's container. Returns a ChildProcess-like object for the
  // Agent SDK / Codex transport. Secrets go through an --env-file (never on a command line), and the
  // in-container pid is recorded so kill() really stops the agent process, not only `docker exec`.
  interface SpawnInOptions { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; }
  function spawnIn(owner, { command, args = [], cwd = '/workspace', env = {} }: SpawnInOptions) {
    const entry = state.get(owner);
    if (!entry?.ready) throw fail('沙箱尚未准备好', 503);
    const proc = randomBytes(8).toString('hex');
    const envFile = path.join(os.tmpdir(), `shiyan-agent-env-${proc}`);
    const lines = Object.entries({ ...claudeEnv(), ...env, HOME: '/home/agent', SHIYAN_PROC: proc })
      .filter(([key, value]) => ENV_NAME.test(key) && value !== undefined && value !== null && !/[\r\n]/.test(String(value)))
      .map(([key, value]) => `${key}=${value}`);
    writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
    const wrapped = ['/bin/sh', '-c', 'echo $$ > "/run/shiyan/$SHIYAN_PROC.pid"; exec "$@"', 'agent', command, ...args];
    const child = docker.spawn(['exec', '-i', '--env-file', envFile, '-w', cwd, name(owner), ...wrapped]);
    entry.active++; entry.lastUsed = Date.now();
    const cleanup = () => { try { unlinkSync(envFile); } catch {} };
    setTimeout(cleanup, 15_000).unref?.();
    let exited = false;
    child.once('exit', () => { exited = true; cleanup(); entry.active = Math.max(0, entry.active - 1); entry.lastUsed = Date.now(); void docker.run(['exec', name(owner), 'rm', '-f', `/run/shiyan/${proc}.pid`]).catch(() => {}); });
    child.once('error', () => cleanup());
    const kill = child.kill.bind(child);
    child.kill = (signal = 'SIGTERM') => {
      if (!exited) void docker.run(['exec', name(owner), '/bin/sh', '-c', `kill -${String(signal).replace(/^SIG/, '')} "$(cat /run/shiyan/${proc}.pid)" 2>/dev/null; true`]).catch(() => {});
      return kill(signal);
    };
    child.stderr?.on('data', chunk => { if (process.env.SHIYAN_AGENT_DEBUG === '1') logger.warn?.('[agent-sandbox:' + proc + '] ' + String(chunk).trim().slice(0, 500)); });
    return child;
  }
  async function exec(owner, argv, { timeoutMs = 60_000 } = {}) { await ensure(owner); return docker.run(['exec', name(owner), ...argv], { timeoutMs }); }
  // Idle containers are stopped (not removed); the next run starts them again.
  const reaper = setInterval(() => {
    for (const [owner, entry] of state) if (entry.ready && entry.active === 0 && Date.now() - entry.lastUsed > idleMs) {
      entry.ready = null; void docker.run(['stop', '-t', '5', name(owner)]).catch(() => {});
    }
  }, 60_000);
  reaper.unref?.();
  return { ensure, spawn: spawnIn, exec, name, paths, close() { clearInterval(reaper); }, state };
}
// A stdio-only stand-in for tests: behaves like a spawned process.
export function fakeProcess() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); return true; };
  return child;
}
