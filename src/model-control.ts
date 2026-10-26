import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';

export interface ModelSelection {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

export interface ModelStatus extends ModelSelection {
  requestId?: string;
  pid: number;
  status: 'ready' | 'applied' | 'error';
  updatedAt: number;
  error?: string;
}

interface Owner { version: 1; pid: number; token: string }
interface Request extends ModelSelection {
  version: 1;
  requestId: string;
  targetPid: number;
  ownerToken: string;
}
interface StoredStatus extends ModelStatus { version: 1; ownerToken: string }

const levels = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function controlPath(cwd: string, file: string): Promise<string> {
  const root = await realpath(cwd);
  const folder = join(root, '.piq');
  if (!within(root, await realpath(folder))) throw new Error('模型控制文件必须位于本群目录内。');
  const path = join(folder, file);
  try {
    if ((await lstat(path)).isSymbolicLink() || !within(root, await realpath(path))) {
      throw new Error('请使用本群目录内的普通模型控制文件。');
    }
  } catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function readJson(cwd: string, file: string): Promise<Record<string, unknown> | null> {
  try {
    const path = await controlPath(cwd, file);
    if ((await lstat(path)).size > 16_384) throw new Error('模型控制文件过大。');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value)) throw new Error('模型控制文件格式无效。');
    return value;
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function writeJson(cwd: string, file: string, value: unknown): Promise<void> {
  const path = await controlPath(cwd, file);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await controlPath(cwd, file);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        // Windows readers/scanners can briefly deny replacement. Retry only the
        // same prepared file, never the model change which already happened.
        await delay(15 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

async function readOwner(cwd: string): Promise<Owner | null> {
  const value = await readJson(cwd, 'owner.lock');
  if (!value) return null;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !value.token) {
    throw new Error('本群运行锁无效，请检查 .piq/owner.lock。');
  }
  return { version: 1, pid: Number(value.pid), token: value.token };
}

function optional(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('模型选择格式无效。');
  return value;
}

function selection(value: ModelSelection): ModelSelection {
  const provider = optional(value.provider);
  const model = optional(value.model);
  const thinkingLevel = optional(value.thinkingLevel);
  if (Boolean(provider) !== Boolean(model)) throw new Error('请同时选择模型提供方和模型。');
  if (thinkingLevel && !levels.has(thinkingLevel as ThinkingLevel)) throw new Error('思考强度无效。');
  return { provider, model, thinkingLevel };
}

/** A request is addressed to the current group owner, never to a later Pi instance. */
export async function requestModelChange(cwd: string, input: ModelSelection): Promise<{ requestId: string }> {
  const selected = selection(input);
  const owner = await readOwner(cwd);
  if (!owner) throw new Error('本群 Pi 当前未运行，设置会在下次启动时应用。');
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('本群 Pi 已退出，设置会在下次启动时应用。'); }
  const requestId = randomUUID();
  await writeJson(cwd, 'model-request.json', {
    version: 1, requestId, targetPid: owner.pid, ownerToken: owner.token, ...selected,
  } satisfies Request);
  return { requestId };
}

/** Return only public state; stale owner state and internal owner tokens are omitted. */
export async function readModelStatus(cwd: string): Promise<ModelStatus | null> {
  const [owner, value] = await Promise.all([readOwner(cwd), readJson(cwd, 'model-status.json')]);
  if (!owner || !value || value.ownerToken !== owner.token || value.pid !== owner.pid) return null;
  if (value.version !== 1 || !['ready', 'applied', 'error'].includes(String(value.status)) || !Number.isFinite(value.updatedAt)) {
    throw new Error('本群模型状态格式无效。');
  }
  return {
    pid: owner.pid, status: value.status as ModelStatus['status'], updatedAt: Number(value.updatedAt),
    provider: optional(value.provider), model: optional(value.model), thinkingLevel: optional(value.thinkingLevel),
    requestId: optional(value.requestId), error: optional(value.error),
  };
}

interface Binding {
  ctx: ExtensionContext;
  cwd: string;
  owner: Owner;
  timer?: ReturnType<typeof setInterval>;
  tail: Promise<void>;
  checking: boolean;
  applying: boolean;
  closed: boolean;
  lastRequestId?: string;
  lastBadRequest?: string;
}

/** Register after PiQ's session_start handler has acquired the group's owner lock. */
export function registerModelControl(pi: ExtensionAPI, options: { pollMs?: number } = {}): void {
  let binding: Binding | undefined;

  function enqueue(current: Binding, work: () => Promise<void>): Promise<void> {
    const task = current.tail.then(async () => { if (!current.closed) await work(); });
    current.tail = task.catch(() => {});
    return task;
  }

  async function publish(current: Binding, status: ModelStatus['status'], error?: string): Promise<void> {
    if (current.closed) return;
    const model = current.ctx.model;
    const value: StoredStatus = {
      version: 1, ownerToken: current.owner.token, pid: current.owner.pid,
      status, requestId: current.lastRequestId, updatedAt: Date.now(),
      provider: model?.provider, model: model?.id, thinkingLevel: pi.getThinkingLevel(), error,
    };
    await writeJson(current.cwd, 'model-status.json', value);
  }

  async function check(current: Binding): Promise<void> {
    const owner = await readOwner(current.cwd);
    if (current.closed || owner?.pid !== current.owner.pid || owner.token !== current.owner.token) return;
    const value = await readJson(current.cwd, 'model-request.json');
    if (current.closed || !value || value.targetPid !== owner.pid || value.ownerToken !== owner.token) return;
    if (typeof value.requestId !== 'string' || !value.requestId || value.requestId === current.lastRequestId) return;
    current.lastRequestId = value.requestId;
    let errorMessage = 'Pi 未能应用模型设置，请检查模型认证或终端提示。';
    try {
      if (value.version !== 1) throw new Error();
      let chosen: ModelSelection;
      try { chosen = selection(value); }
      catch (error) { errorMessage = error instanceof Error ? error.message : errorMessage; throw error; }
      current.applying = true;
      if (chosen.provider && chosen.model) {
        const model = current.ctx.modelRegistry.find(chosen.provider, chosen.model);
        if (!model) { errorMessage = '当前 Pi 会话无法找到所选模型，请检查模型配置。'; throw new Error(); }
        if (!(await pi.setModel(model))) { errorMessage = '所选模型尚未配置可用认证。'; throw new Error(); }
      }
      if (current.closed) return;
      if (chosen.thinkingLevel) pi.setThinkingLevel(chosen.thinkingLevel as ThinkingLevel);
      await publish(current, 'applied');
    } catch {
      if (!current.closed) await publish(current, 'error', errorMessage);
    } finally { current.applying = false; }
  }

  function poll(current: Binding): void {
    if (current.closed || current.checking) return;
    current.checking = true;
    void enqueue(current, () => check(current)).catch(error => {
      if (current.closed) return;
      const message = error instanceof Error ? error.message : '模型控制读取失败。';
      if (message !== current.lastBadRequest) {
        current.lastBadRequest = message;
        current.ctx.ui.notify(`PiQ 模型控制：${message}`, 'error');
      }
    }).finally(() => { current.checking = false; });
  }

  async function stop(): Promise<void> {
    const current = binding;
    binding = undefined;
    if (!current) return;
    current.closed = true;
    clearInterval(current.timer);
    await current.tail;
  }

  pi.on('session_start', async (_event, ctx) => {
    await stop();
    if (!await loadConfig(ctx.cwd)) return;
    const owner = await readOwner(ctx.cwd);
    if (!owner || owner.pid !== process.pid) return;
    const previous = await readModelStatus(ctx.cwd);
    const current: Binding = {
      ctx, cwd: ctx.cwd, owner, tail: Promise.resolve(), checking: false,
      applying: false, closed: false, lastRequestId: previous?.requestId,
    };
    binding = current;
    await publish(current, 'ready');
    current.timer = setInterval(() => poll(current), options.pollMs ?? 750);
    current.timer.unref?.();
    poll(current);
  });
  pi.on('session_shutdown', stop);

  const manualChange = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    const current = binding;
    if (!current || current.closed || current.applying) return;
    current.ctx = ctx;
    await enqueue(current, () => publish(current, 'ready'));
  };
  pi.on('model_select', manualChange);
  pi.on('thinking_level_select', manualChange);
}
