import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { getRunningOwner, openGroupTerminal, resolveGroupEnvironment, type CredentialOptions } from './web-terminal.ts';
import { getTerminalReturnError } from './terminal-monitor.ts';

interface Worker {
  version: 1;
  mode: 'background';
  pid: number;
  launchId: string;
  startedAt: number;
  state: 'starting' | 'running' | 'stopped' | 'error';
  ownerToken?: string;
  error?: string;
  lastError?: string;
}

interface PendingLaunch {
  version: 1;
  pid: number;
  launchId: string;
  startedAt: number;
}

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  mode: 'background' | 'terminal' | null;
  starting: boolean;
  error?: string;
}

const queues = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function localPath(cwd: string, file: string, create = false): Promise<string> {
  const root = await realpath(cwd);
  const directory = join(root, '.piq');
  if (create) await mkdir(directory, { recursive: true });
  if (!within(root, await realpath(directory))) throw new Error('Pi 运行记录必须位于本群目录。');
  const path = join(directory, file);
  try {
    if ((await lstat(path)).isSymbolicLink() || !within(root, await realpath(path))) throw new Error('请使用本群目录内的普通运行记录文件。');
  } catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function worker(cwd: string): Promise<Worker | null> {
  try {
    const path = await localPath(cwd, 'worker.json');
    if ((await lstat(path)).size > 16_384) throw new Error();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || value.mode !== 'background' || !Number.isSafeInteger(value.pid)
      || Number(value.pid) <= 0 || typeof value.launchId !== 'string' || !Number.isFinite(value.startedAt)
      || !['starting', 'running', 'stopped', 'error'].includes(String(value.state))) throw new Error();
    return value as unknown as Worker;
  } catch (error) { if (missing(error)) return null; throw new Error('后台运行记录无效，请检查本群 .piq/worker.json。'); }
}

async function pendingLaunch(cwd: string): Promise<PendingLaunch | null> {
  // New releases publish worker-launch.json; retain read compatibility with earlier PiQ launches.
  for (const file of ['worker-launch.json', 'launch.json']) {
    try {
      const path = await localPath(cwd, file);
      if ((await lstat(path)).size > 16_384) throw new Error();
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
        || typeof value.launchId !== 'string' || !value.launchId || typeof value.startedAt !== 'number'
        || !Number.isFinite(value.startedAt) || value.startedAt < 0) throw new Error();
      return value as unknown as PendingLaunch;
    } catch (error) { if (!missing(error)) throw new Error(`后台启动记录无效，请检查本群 .piq/${file}。`); }
  }
  return null;
}
async function savePendingLaunch(cwd: string, launch: PendingLaunch): Promise<void> {
  const path = await localPath(cwd, 'worker-launch.json', true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(launch) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await localPath(cwd, 'worker-launch.json'); await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

/** The startup lock is still held, so another launcher cannot replace this record. */
async function forgetPendingLaunch(cwd: string, launchId: string): Promise<void> {
  if ((await pendingLaunch(cwd))?.launchId !== launchId) return;
  await unlink(await localPath(cwd, 'worker-launch.json')).catch(error => { if (!missing(error)) throw error; });
}

async function ownerToken(cwd: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(await localPath(cwd, 'owner.lock'), 'utf8'));
    return object(value) && typeof value.token === 'string' ? value.token : undefined;
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

export async function getProcessStatus(cwd: string): Promise<ProcessStatus> {
  const owner = await getRunningOwner(cwd);
  const record = await worker(cwd);
  if (owner.running) {
    const background = record?.pid === owner.pid && record.ownerToken === await ownerToken(cwd)
      && record.state === 'running';
    return { ...owner, mode: background ? 'background' : 'terminal', starting: false,
      ...(background && record.lastError ? { error: '后台 Pi 扩展运行出现错误；进程仍在运行，可切换到终端查看。' } : {}) };
  }
  const pending = await pendingLaunch(cwd);
  // The parent publishes this before the child has imported its modules or
  // written worker.json. A matching ready/terminal record supersedes it.
  if (pending && alive(pending.pid) && (!record
    || (record.launchId !== pending.launchId && record.startedAt < pending.startedAt))) {
    return { running: false, pid: pending.pid, mode: 'background', starting: true };
  }
  if (record && record.state === 'starting' && alive(record.pid)) {
    return { running: false, pid: record.pid, mode: 'background', starting: true };
  }
  const terminalError = await getTerminalReturnError(cwd);
  return { running: false, pid: null, mode: null, starting: false,
    ...(terminalError ? { error: terminalError }
      : record?.state === 'error' ? { error: '后台 Pi 启动失败，请检查本群模型配置和扩展加载情况。' } : {}) };
}

async function exclusive<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(cwd) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  queues.set(cwd, task);
  try { return await task; } finally { if (queues.get(cwd) === task) queues.delete(cwd); }
}

async function startupLock(cwd: string): Promise<() => Promise<void>> {
  const filename = await localPath(cwd, 'start.lock', true);
  const token = randomUUID();
  const write = async () => {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8'); }
    finally { await handle.close(); }
  };
  try { await write(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!object(existing) || !Number.isSafeInteger(existing.pid) || Number(existing.pid) <= 0 || alive(Number(existing.pid))) {
      throw new Error('本群正在启动，请稍候再试。');
    }
    // One short-lived recovery lease prevents concurrent stale-lock replacement.
    const recovery = `${filename}.recover`;
    const handle = await open(recovery, 'wx', 0o600).catch(() => { throw new Error('本群启动锁正在恢复，请稍候再试。'); });
    try {
      const current = JSON.parse(await readFile(filename, 'utf8')) as { pid?: number; token?: string };
      if (current.token !== existing.token || !current.pid || alive(current.pid)) throw new Error('本群正在启动，请稍候再试。');
      await unlink(filename);
      await write();
    } finally { await handle.close(); await unlink(recovery); }
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(filename, 'utf8')) as { token?: string };
      if (current.token === token) await unlink(filename);
    } catch (error) { if (!missing(error)) throw error; }
  };
}

export interface BackgroundLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface LaunchedProcess { pid: number; exited?: () => boolean }

export interface StartOptions extends CredentialOptions {
  launch?: (specification: BackgroundLaunch) => Promise<LaunchedProcess>;
  timeoutMs?: number;
  /** Automatic terminal return retains paused state and interrupted work. */
  preserveRunState?: boolean;
}

export interface ProcessResult { message: string; alreadyRunning?: boolean; starting?: boolean; pid?: number }

async function launchBackground(specification: BackgroundLaunch): Promise<LaunchedProcess> {
  return await new Promise((resolveLaunch, reject) => {
    const child = spawn(specification.command, specification.args, {
      cwd: specification.cwd, env: specification.env, shell: false,
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', () => reject(new Error('无法启动后台 Pi，请检查 Node.js 安装。')));
    child.once('spawn', () => {
      if (!child.pid) { reject(new Error('后台 Pi 没有返回进程标识。')); return; }
      child.unref();
      resolveLaunch({ pid: child.pid, exited: () => child.exitCode !== null || child.signalCode !== null });
    });
  });
}

/** Start a persistent hidden worker; restarting the WebUI does not own or kill it. */
export async function startGroup(cwd: string, options: StartOptions = {}): Promise<ProcessResult> {
  const directory = await realpath(resolve(cwd));
  return exclusive(directory, async () => {
    const config = await loadConfig(directory);
    if (!config) throw new Error('请先初始化本群目录。');
    if (!config.conversations.length) throw new Error('请先给对话组添加至少一个对话。');
    const existing = await getProcessStatus(directory);
    if (existing.running || existing.starting) return { message: existing.starting ? '本群 Pi 正在启动。' : '本群 Pi 已运行。', alreadyRunning: true, starting: existing.starting, pid: existing.pid ?? undefined };
    const release = await startupLock(directory);
    try {
      const afterLock = await getProcessStatus(directory);
      if (afterLock.running || afterLock.starting) return { message: '本群 Pi 已运行或正在启动。', alreadyRunning: true, starting: afterLock.starting, pid: afterLock.pid ?? undefined };
      const launchId = randomUUID();
      const startedAt = Date.now();
      const { env } = await resolveGroupEnvironment(directory, config, options);
      const launchEnv: NodeJS.ProcessEnv = { ...env, PIQ_LAUNCH_ID: launchId, PIQ_RUN_MODE: 'background' };
      if (options.preserveRunState) delete launchEnv.PIQ_START_RUNNING;
      else launchEnv.PIQ_START_RUNNING = '1';
      const childProcess = await (options.launch ?? launchBackground)({
        command: globalThis.process.execPath,
        args: [fileURLToPath(new URL('./background.ts', import.meta.url)), directory],
        cwd: directory,
        env: launchEnv,
      });
      if (!Number.isSafeInteger(childProcess.pid) || childProcess.pid <= 0) throw new Error('后台 Pi 没有返回有效进程标识。');
      await savePendingLaunch(directory, { version: 1, launchId, pid: childProcess.pid, startedAt });
      const deadline = Date.now() + (options.timeoutMs ?? 8_000);
      do {
        const record = await worker(directory);
        const owner = await getRunningOwner(directory);
        if (record?.launchId === launchId) {
          if (record.state === 'error' || record.state === 'stopped') {
            await forgetPendingLaunch(directory, launchId);
            throw new Error('后台 Pi 启动失败，请检查本群模型配置与扩展。');
          }
          if (record.state === 'running' && owner.running && owner.pid === childProcess.pid && record.ownerToken === await ownerToken(directory)) {
            await forgetPendingLaunch(directory, launchId);
            return { message: '本群 Pi 已在后台启动，并继续最近的会话。', pid: childProcess.pid };
          }
        }
        if (childProcess.exited?.()) {
          await forgetPendingLaunch(directory, launchId);
          throw new Error('后台 Pi 在启动完成前退出，请检查本群配置。');
        }
        if (Date.now() >= deadline) break;
        await delay(100);
      } while (true);
      return { message: '后台 Pi 正在启动，页面会继续更新状态。', starting: true, pid: childProcess.pid };
    } finally { await release(); }
  });
}

export interface HandoffOptions {
  shutdown?: (cwd: string) => Promise<unknown>;
  openTerminal?: typeof openGroupTerminal;
  timeoutMs?: number;
}

/** Gracefully release the background owner before the terminal resumes the same session files. */
export async function handoffToTerminal(cwd: string, options: HandoffOptions = {}): Promise<ProcessResult> {
  const directory = await realpath(resolve(cwd));
  return exclusive(directory, async () => {
    const status = await getProcessStatus(directory);
    if (status.starting) return { message: '后台 Pi 正在启动，请等启动完成后再切换到终端。', alreadyRunning: true, starting: true };
    if (status.running && status.mode === 'background') {
      const expectedToken = await ownerToken(directory);
      const shutdown = options.shutdown ?? (async path => {
        const { requestRunAction } = await import('./run-control.ts');
        return requestRunAction(path, 'handoff');
      });
      await shutdown(directory);
      const deadline = Date.now() + (options.timeoutMs ?? 8_000);
      while (true) {
        const owner = await getRunningOwner(directory);
        if (!owner.running) break;
        const token = await ownerToken(directory);
        // The owner may finish releasing its lock between these two reads.
        if (token === undefined && !(await getRunningOwner(directory)).running) break;
        if (owner.pid !== status.pid || token !== expectedToken) throw new Error('本群会话已由其他实例接管，请刷新状态。');
        if (Date.now() >= deadline) throw new Error('后台 Pi 尚未退出，请等待当前工作结束后重试。');
        await delay(100);
      }
    }
    return await (options.openTerminal ?? openGroupTerminal)(directory);
  });
}
