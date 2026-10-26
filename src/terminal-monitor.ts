import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';

interface Lease {
  version: 1;
  token: string;
  createdAt: number;
  launcherPid: number;
  monitorPid?: number;
  wrapperPid?: number;
  piPid?: number;
  ownerToken?: string;
  state: 'starting' | 'watching' | 'recovering' | 'error';
}

interface Lock { pid: number; token: string }

export interface TerminalMonitorLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface TerminalReturnOptions {
  env?: NodeJS.ProcessEnv;
  launch?: (specification: TerminalMonitorLaunch) => Promise<{ pid: number }>;
  readyTimeoutMs?: number;
}

export interface TerminalMonitorOptions {
  token?: string;
  start?: (cwd: string) => Promise<unknown>;
  pollMs?: number;
  registrationTimeoutMs?: number;
}

const LEASE = 'terminal-return.json';
const LOCK = 'terminal-return.lock';
const SAFE_ERROR = '终端关闭后的后台恢复失败，请在 WebUI 重新启动本对话组。';
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function alive(value?: number): boolean {
  if (!value) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function directoryFor(cwd: string, create = false): Promise<string> {
  const root = await realpath(resolve(cwd));
  const directory = join(root, '.piq');
  if (create) await mkdir(directory, { recursive: true });
  const entry = await lstat(directory);
  const resolved = await realpath(directory);
  const part = relative(root, resolved);
  if (!entry.isDirectory() || entry.isSymbolicLink() || part === '..' || part.startsWith('../') || part.startsWith('..\\') || isAbsolute(part)) {
    throw new Error('终端恢复记录必须位于本对话组的普通 .piq 目录。');
  }
  return directory;
}

async function ordinaryFile(path: string): Promise<void> {
  try { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('终端恢复记录必须使用普通文件。'); }
  catch (error) { if (!missing(error)) throw error; }
}

async function fileTransition<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}

async function json(path: string): Promise<unknown | null> {
  return fileTransition(async () => {
    await ordinaryFile(path);
    try { if ((await lstat(path)).size > 16_384) throw new Error('终端恢复记录过大。'); return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (missing(error)) return null; throw error; }
  });
}

async function write(path: string, value: unknown): Promise<void> {
  await fileTransition(() => ordinaryFile(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await ordinaryFile(path); await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await fileTransition(() => unlink(temporary)).catch(error => { if (!missing(error)) throw error; }); }
}

async function leaseAt(directory: string): Promise<Lease | null> {
  const value = await json(join(directory, LEASE));
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || typeof value.token !== 'string' || !value.token
    || !pid(value.launcherPid) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || !['starting', 'watching', 'recovering', 'error'].includes(String(value.state))
    || [value.monitorPid, value.wrapperPid, value.piPid].some(value => value !== undefined && !pid(value))
    || (value.ownerToken !== undefined && typeof value.ownerToken !== 'string')) throw new Error('终端恢复记录无效，请检查 .piq/terminal-return.json。');
  return value as unknown as Lease;
}

async function lockAt(path: string): Promise<Lock | null> {
  const value = await json(path);
  if (value === null) return null;
  if (!object(value) || !pid(value.pid) || typeof value.token !== 'string' || !value.token) throw new Error('终端恢复锁无效。');
  return value as unknown as Lock;
}

// Publish a complete immutable lock atomically; readers never see a partially written JSON file.
async function claim(path: string, owner: Lock): Promise<void> {
  await fileTransition(() => ordinaryFile(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let claimed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    finally { await handle.close(); }
    await fileTransition(() => link(temporary, path));
    claimed = true;
  } finally {
    try { await fileTransition(() => unlink(temporary)); }
    catch (error) {
      if (!missing(error)) {
        // A cleanup failure must not leave a lock that the caller thinks it never acquired.
        if (claimed) await fileTransition(() => unlink(path));
        throw error;
      }
    }
  }
}

async function withLeaseLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const filename = join(directory, LOCK);
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 45_000;
  while (true) {
    try { await claim(filename, owner); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const existing = await lockAt(filename);
    if (existing && !alive(existing.pid)) {
      const recovery = `${filename}.recover`;
      let recovered = false;
      try { await claim(recovery, owner); recovered = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (recovered) {
        try {
          const current = await lockAt(filename);
          if (current?.token === existing.token && !alive(current.pid)) await fileTransition(() => unlink(filename));
        } finally { if ((await lockAt(recovery))?.token === owner.token) await fileTransition(() => unlink(recovery)); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error('终端恢复操作仍在进行，请稍后重试。');
    await delay(20);
  }
  try { return await operation(); }
  finally { if ((await lockAt(filename))?.token === owner.token) await fileTransition(() => unlink(filename)); }
}

async function launchMonitor(specification: TerminalMonitorLaunch): Promise<{ pid: number }> {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(specification.command, specification.args, { cwd: specification.cwd, env: specification.env,
      detached: true, windowsHide: true, stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('无法启动终端后台恢复监控。')));
    child.once('spawn', () => { if (!child.pid) { reject(new Error('终端恢复监控未返回进程标识。')); return; } child.unref(); resolveLaunch({ pid: child.pid }); });
  });
}

export async function prepareTerminalReturn(cwd: string, options: TerminalReturnOptions = {}): Promise<{ token: string; alreadyRunning?: boolean }> {
  const root = await realpath(resolve(cwd));
  const config = await loadConfig(root);
  if (!config?.conversations.length) throw new Error('请先配置本对话组的对话，再打开终端。');
  const directory = await directoryFor(root, true);
  const prepared = await withLeaseLock(directory, async () => {
    const existing = await leaseAt(directory);
    if (existing && existing.state !== 'error' && (alive(existing.monitorPid) || alive(existing.wrapperPid) || alive(existing.piPid))) {
      return { token: existing.token, alreadyRunning: true };
    }
    const lease: Lease = { version: 1, token: randomUUID(), createdAt: Date.now(), launcherPid: process.pid, state: 'starting' };
    await write(join(directory, LEASE), lease);
    try {
      const child = await (options.launch ?? launchMonitor)({ command: process.execPath,
        args: [fileURLToPath(import.meta.url), root], cwd: root,
        env: { ...(options.env ?? process.env), PIQ_TERMINAL_RETURN_TOKEN: lease.token } });
      if (!pid(child.pid)) throw new Error('Invalid monitor PID.');
      lease.monitorPid = child.pid;
      await write(join(directory, LEASE), lease);
    } catch { await write(join(directory, LEASE), { ...lease, state: 'error' }); throw new Error('无法启动终端后台恢复监控。'); }
    return { token: lease.token, alreadyRunning: false };
  });
  if (prepared.alreadyRunning) return prepared;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 5_000);
  while (true) {
    const current = await withLeaseLock(directory, () => leaseAt(directory));
    if (current?.token !== prepared.token || current.state === 'error') throw new Error('终端后台恢复监控未能启动。');
    if (current.state === 'watching' && alive(current.monitorPid)) return { token: prepared.token };
    if (!alive(current.monitorPid) || Date.now() >= deadline) {
      await withLeaseLock(directory, async () => { const lease = await leaseAt(directory); if (lease?.token === prepared.token) await write(join(directory, LEASE), { ...lease, state: 'error' }); });
      throw new Error('终端后台恢复监控未能启动。');
    }
    await delay(20);
  }
}

export async function registerTerminal(cwd: string, token: string, wrapperPid = process.pid, piPid?: number): Promise<void> {
  if (!token || !pid(wrapperPid) || (piPid !== undefined && !pid(piPid))) throw new Error('终端进程登记无效。');
  const directory = await directoryFor(cwd);
  await withLeaseLock(directory, async () => {
    const lease = await leaseAt(directory);
    if (!lease || lease.token !== token || !['starting', 'watching'].includes(lease.state)) throw new Error('终端恢复登记已失效，请从 WebUI 重新打开。');
    if (lease.wrapperPid !== undefined && lease.wrapperPid !== wrapperPid) throw new Error('本次终端已由另一进程接管。');
    if (lease.piPid !== undefined && piPid !== undefined && lease.piPid !== piPid) throw new Error('本次终端的 Pi 进程已登记。');
    await write(join(directory, LEASE), { ...lease, wrapperPid, ...(piPid === undefined ? {} : { piPid }) });
  });
}

export async function cancelTerminalReturn(cwd: string, expectedToken?: string): Promise<void> {
  let directory: string;
  try { directory = await directoryFor(cwd); } catch (error) { if (missing(error)) return; throw error; }
  await withLeaseLock(directory, async () => {
    const lease = await leaseAt(directory);
    if (lease && (expectedToken === undefined || lease.token === expectedToken)) await fileTransition(() => unlink(join(directory, LEASE)));
  });
}

export async function getTerminalReturnError(cwd: string): Promise<string | undefined> {
  // Status reads may run inside recovery's lock through startGroup/getProcessStatus.
  try { const lease = await leaseAt(await directoryFor(cwd)); return lease?.state === 'error' ? SAFE_ERROR : undefined; }
  catch (error) { if (missing(error)) return undefined; return SAFE_ERROR; }
}

async function ownerAt(directory: string): Promise<{ pid: number; token: string } | null> {
  let value: unknown;
  for (let attempt = 0; ; attempt++) {
    try { value = await json(join(directory, 'owner.lock')); break; }
    catch (error) { if (!(error instanceof SyntaxError) || attempt >= 3) throw error; await delay(20); }
  }
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || !pid(value.pid) || typeof value.token !== 'string') throw new Error('Pi 运行锁无效。');
  return alive(value.pid) ? { pid: value.pid, token: value.token } : null;
}

export async function runTerminalMonitor(cwd: string, options: TerminalMonitorOptions = {}): Promise<void> {
  const token = options.token ?? process.env.PIQ_TERMINAL_RETURN_TOKEN;
  if (!token) throw new Error('终端恢复监控缺少登记标识。');
  const root = await realpath(resolve(cwd));
  const config = await loadConfig(root);
  if (!config?.conversations.length) throw new Error('终端恢复监控的对话组配置无效。');
  const directory = await directoryFor(root);
  const interval = options.pollMs ?? 250;
  const registrationTimeout = options.registrationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || !Number.isSafeInteger(registrationTimeout) || registrationTimeout < 1) throw new Error('终端恢复监控的等待时间无效。');
  const ready = await withLeaseLock(directory, async () => {
    const lease = await leaseAt(directory);
    if (!lease || lease.token !== token || lease.state === 'error' || (lease.monitorPid !== undefined && lease.monitorPid !== process.pid)) return false;
    await write(join(directory, LEASE), { ...lease, monitorPid: process.pid, state: 'watching' });
    return true;
  });
  if (!ready) return;
  let unregisteredOwnerSince: number | undefined;
  const ownerRegistrationGrace = Math.min(registrationTimeout, 3_000);
  try {
    while (true) {
      const lease = await withLeaseLock(directory, () => leaseAt(directory));
      if (!lease || lease.token !== token || lease.state === 'error') return;
      if (lease.wrapperPid === undefined) {
        if (Date.now() - lease.createdAt >= registrationTimeout) { await cancelTerminalReturn(root, token); return; }
        await delay(interval); continue;
      }
      const owner = await ownerAt(directory);
      const wrapperAlive = alive(lease.wrapperPid);
      const differentPi = owner && lease.piPid !== undefined && owner.pid !== lease.piPid;
      const unknownOwner = owner && lease.piPid === undefined && !wrapperAlive;
      const replacedAfterExit = owner && lease.ownerToken !== undefined && lease.ownerToken !== owner.token && !wrapperAlive;
      if (differentPi || replacedAfterExit) {
        await cancelTerminalReturn(root, token); return;
      }
      if (unknownOwner) {
        // The console can disappear between Pi acquiring its owner and registering its real PID.
        unregisteredOwnerSince ??= Date.now();
        if (Date.now() - unregisteredOwnerSince >= ownerRegistrationGrace) { await cancelTerminalReturn(root, token); return; }
        await delay(interval); continue;
      }
      unregisteredOwnerSince = undefined;
      if (owner && lease.piPid === owner.pid && lease.ownerToken !== owner.token) {
        await withLeaseLock(directory, async () => { const current = await leaseAt(directory); if (current?.token === token) await write(join(directory, LEASE), { ...current, ownerToken: owner.token }); });
      }
      if (wrapperAlive || alive(lease.piPid) || owner) { await delay(interval); continue; }
      await withLeaseLock(directory, async () => {
        const current = await leaseAt(directory);
        if (!current || current.token !== token || current.state === 'error') return;
        if (await ownerAt(directory)) { await fileTransition(() => unlink(join(directory, LEASE))); return; }
        await write(join(directory, LEASE), { ...current, state: 'recovering' });
        try {
          const start = options.start ?? (async path => { const { startGroup } = await import('./process-manager.ts'); return startGroup(path, { preserveRunState: true }); });
          await start(root);
          await fileTransition(() => unlink(join(directory, LEASE)));
        } catch { await write(join(directory, LEASE), { ...current, state: 'error' }); }
      });
      return;
    }
  } catch {
    await withLeaseLock(directory, async () => { const lease = await leaseAt(directory); if (lease?.token === token) await write(join(directory, LEASE), { ...lease, state: 'error' }); });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTerminalMonitor(process.argv[2] ?? '').catch(() => { process.exitCode = 1; });
}
