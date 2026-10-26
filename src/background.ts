#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';
import { getRunningOwner, resolveGroupEnvironment } from './web-terminal.ts';
import { getModelPreference } from './web-models.ts';

type ExtensionBindings = Parameters<AgentSession['bindExtensions']>[0];

export interface BackgroundSession {
  abort(): Promise<void>;
  bindExtensions(bindings: ExtensionBindings): Promise<void>;
  extensionRunner: { emit(event: { type: 'session_shutdown'; reason: 'quit' }): Promise<unknown> };
  dispose(): void;
}

export interface BackgroundOptions {
  sessionFactory?: (cwd: string) => Promise<BackgroundSession>;
  signal?: AbortSignal;
  launchId?: string;
}

export interface WorkerState {
  version: 1;
  mode: 'background';
  pid: number;
  launchId: string;
  startedAt: number;
  updatedAt: number;
  state: 'starting' | 'running' | 'stopped' | 'error';
  ownerToken?: string;
  error?: string;
  lastError?: string;
  lastErrorAt?: number;
}

class BackgroundStartError extends Error {}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

interface HttpSettings {
  getGlobalSettings(): { httpProxy?: string };
  getHttpIdleTimeoutMs(): number;
}

interface PiHttpSetup {
  applyHttpProxySettings(proxy: string | undefined): void;
  configureHttpDispatcher(timeoutMs?: number): void;
}

/** Match Pi CLI's proxy/dispatcher setup before extensions or providers do network work. */
export async function configureBackgroundHttp(
  settings: HttpSettings,
  load: () => Promise<PiHttpSetup> = async () => import(
    new URL('./core/http-dispatcher.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
  ),
): Promise<void> {
  // Pi 1.4 ships this CLI helper beside its SDK entry. Reuse its exact Undici
  // setup, including NO_PROXY and Node 26's fetch/dispatcher pairing.
  const http = await load();
  http.applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
  http.configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function statePath(cwd: string): Promise<string> {
  const folder = join(cwd, '.piq');
  await mkdir(folder, { recursive: true });
  if (!within(cwd, await realpath(folder))) throw new BackgroundStartError('本群状态目录指向了其他位置。');
  const file = join(folder, 'worker.json');
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new BackgroundStartError('后台状态文件必须是本群目录中的普通文件。');
  } catch (error) { if (!missing(error)) throw error; }
  return file;
}

async function writeState(path: string, value: WorkerState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

/** Use Pi's normal resources, conversation storage and current group choices. */
export async function createBackgroundSession(cwd: string): Promise<AgentSession> {
  const { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  await configureBackgroundHttp(settingsManager);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new BackgroundStartError('Pi 扩展加载失败，请在终端检查本群配置。');
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false,
  });
  const selected = await getModelPreference(cwd);
  const model = selected.provider && selected.model ? modelRuntime.getModel(selected.provider, selected.model) : undefined;
  if (selected.provider && selected.model && !model) throw new BackgroundStartError('本群所选模型不在 Pi 模型配置中，请重新选择。');
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model,
    thinkingLevel: selected.thinkingLevel as ThinkingLevel | undefined,
    sessionManager: SessionManager.continueRecent(cwd, join(cwd, '.pi', 'sessions')),
  });
  if (!session.model) { session.dispose(); throw new BackgroundStartError('Pi 尚未配置可用模型，请先在模型页面选择。'); }
  return session;
}

/** One worker owns one existing Pi session. It never submits a startup prompt. */
export async function runBackground(cwdInput: string, options: BackgroundOptions = {}): Promise<void> {
  const cwd = await realpath(resolve(cwdInput));
  const config = await loadConfig(cwd);
  if (!config) throw new BackgroundStartError('该群尚未初始化。');
  if (!config.conversations.length) throw new BackgroundStartError('请先给对话组添加至少一个对话。');
  if ((await getRunningOwner(cwd)).running) throw new BackgroundStartError('本群 Pi 已在运行。');
  const file = await statePath(cwd);
  const startedAt = Date.now();
  const base = {
    version: 1 as const, mode: 'background' as const, pid: process.pid,
    launchId: options.launchId ?? process.env.PIQ_LAUNCH_ID ?? randomUUID(), startedAt,
  };
  let ownerToken: string | undefined;
  let session: BackgroundSession | undefined;
  let bound = false;
  let failure: string | undefined;
  let lastError: string | undefined;
  let lastErrorAt: number | undefined;
  let ready = false;
  let stopping = false;
  let publishQueue: Promise<void> = Promise.resolve();
  const previousRunMode = process.env.PIQ_RUN_MODE;
  process.env.PIQ_RUN_MODE = 'background';
  let stop!: () => void;
  const stopped = new Promise<void>(resolveStop => { stop = () => { stopping = true; resolveStop(); }; });
  const keepAlive = setInterval(() => {}, 30_000);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const publish = (state: WorkerState['state'], error?: string): Promise<void> => {
    const operation = publishQueue.catch(() => {}).then(async () => {
      // If another process acquired the group after this worker failed, preserve its status.
      const currentOwner = await getRunningOwner(cwd);
      if (currentOwner.running && currentOwner.pid !== process.pid) return;
      await writeState(file, { ...base, state, updatedAt: Date.now(), ownerToken,
        ...(error ? { error } : {}), ...(lastError ? { lastError, lastErrorAt } : {}) });
    });
    publishQueue = operation;
    return operation;
  };
  try {
    await publish('starting');
    if (stopping) return;
    const resolved = await resolveGroupEnvironment(cwd, config);
    if (resolved.env[config.accessTokenEnv] !== undefined) process.env[config.accessTokenEnv] = resolved.env[config.accessTokenEnv];
    session = await (options.sessionFactory ?? createBackgroundSession)(cwd);
    if (stopping) return;
    let bindingExtensions = true;
    let startupError = false;
    bound = true;
    await session.bindExtensions({
      mode: 'print', shutdownHandler: stop,
      onError: () => {
        if (bindingExtensions) { startupError = true; return; }
        if (stopping) return;
        // Keep an inspectable warning without treating a recoverable extension
        // error as a worker crash or storing provider responses/credentials.
        lastError = 'Pi 扩展运行出现错误；进程仍在运行，可切换到终端查看。';
        lastErrorAt = Date.now();
        if (ready) void publish('running').catch(() => {});
      },
    });
    bindingExtensions = false;
    let owner: { pid?: number; token?: string };
    try { owner = JSON.parse(await readFile(join(cwd, '.piq', 'owner.lock'), 'utf8')); }
    catch { throw new BackgroundStartError('PiQ 扩展未能接管本群，请检查本群配置。'); }
    if (owner.pid !== process.pid || typeof owner.token !== 'string') throw new BackgroundStartError('本群由其他 Pi 实例接管。');
    ownerToken = owner.token;
    if (startupError) throw new BackgroundStartError('Pi 扩展启动时出现错误，请在终端检查。');
    ready = true;
    if (!stopping) await publish('running');
    await stopped;
  } catch (error) {
    failure = error instanceof BackgroundStartError ? error.message : '后台 Pi 启动失败，请检查群目录权限、扩展与模型配置。';
    throw new BackgroundStartError(failure);
  } finally {
    stopping = true;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    let cleanupFailed = false;
    try {
      if (session) {
        try { await session.abort(); } catch { cleanupFailed = true; }
        try {
          if (bound) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        } catch { cleanupFailed = true; }
        try { session.dispose(); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed && !failure) failure = '后台 Pi 清理会话时出现错误，请检查群目录中的运行状态。';
      await publish(failure ? 'error' : 'stopped', failure);
    } finally {
      clearInterval(keepAlive);
      if (previousRunMode === undefined) delete process.env.PIQ_RUN_MODE;
      else process.env.PIQ_RUN_MODE = previousRunMode;
    }
    if (cleanupFailed) throw new BackgroundStartError(failure!);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('PiQ 后台进程需要一个群目录。');
    process.exitCode = 1;
  } else {
    runBackground(process.argv[2]!).catch(error => {
      console.error(error instanceof BackgroundStartError ? error.message : 'PiQ 后台进程启动失败。');
      process.exitCode = 1;
    });
  }
}
