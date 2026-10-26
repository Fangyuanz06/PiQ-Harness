import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';

export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
}

export interface ModelCatalog {
  models: ModelChoice[];
  error?: string;
}

export interface ModelPreference {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  revision: string;
}

export class ModelPreferenceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface CatalogRuntime {
  getAvailableSnapshot(): readonly Model<Api>[];
  getError(): string | undefined;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const saves = new Map<string, Promise<unknown>>();
/** The native Pi 1.4 CLI union, also used when the model is inherited from a resumed session. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ModelThinkingLevel[];
let cachedCatalog: { expires: number; result: Promise<ModelCatalog> } | undefined;

/** Read Pi's local catalog/auth snapshot. This never loads or invokes agent extensions. */
export async function listModels(factory?: () => Promise<CatalogRuntime>): Promise<ModelCatalog> {
  if (!factory && cachedCatalog && cachedCatalog.expires > Date.now()) return cachedCatalog.result;
  const result = (async (): Promise<ModelCatalog> => {
    try {
      const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
      const runtime = factory
        ? await factory()
        : await (await import('@earendil-works/pi-coding-agent')).ModelRuntime.create({ allowModelNetwork: false });
      const models = runtime.getAvailableSnapshot().map(model => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model),
      })).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
      // Configuration errors may contain URLs or credential expressions. Only expose a summary.
      return { models, ...(runtime.getError() ? { error: '部分 Pi 模型配置读取失败，请在 Pi 中检查模型配置。' } : {}) };
    } catch {
      return { models: [], error: '无法读取 Pi 模型配置，请检查 Pi 的 models.json 和认证配置。' };
    }
  })();
  if (!factory) cachedCatalog = { expires: Date.now() + 30_000, result };
  return result;
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function settingsPath(cwd: string, createDirectory = false): Promise<string> {
  const root = await realpath(cwd);
  const directory = join(root, '.pi');
  if (createDirectory) await mkdir(directory, { recursive: true });
  try {
    if (!inside(root, await realpath(directory))) throw new ModelPreferenceError(400, 'Pi 设置目录必须属于当前群。');
  } catch (error) { if (!isMissing(error)) throw error; }
  const path = join(directory, 'settings.json');
  try {
    if ((await lstat(path)).isSymbolicLink() || !inside(root, await realpath(path))) {
      throw new ModelPreferenceError(400, '请使用本群内的普通 Pi 设置文件。');
    }
  } catch (error) { if (!isMissing(error)) throw error; }
  return path;
}

async function readSettings(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (isMissing(error)) return { text: '', value: {} }; throw error; }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { text, value: value as Record<string, unknown> };
  } catch { throw new ModelPreferenceError(400, '本群 .pi/settings.json 格式无效，请先修复。'); }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) {
    throw new ModelPreferenceError(400, `${name} 无效。`);
  }
  return value.trim() || undefined;
}

function preference(text: string, value: Record<string, unknown>): ModelPreference {
  return {
    provider: optionalString(value.defaultProvider, 'Provider'),
    model: optionalString(value.defaultModel, 'Model'),
    thinkingLevel: optionalString(value.defaultThinkingLevel, 'Thinking level'),
    revision: digest(text),
  };
}

/** Only project values are returned: an empty selection continues Pi's normal session/default behavior. */
export async function getModelPreference(cwd: string): Promise<ModelPreference> {
  const { text, value } = await readSettings(await settingsPath(cwd));
  return preference(text, value);
}

export async function saveModelPreference(
  cwd: string,
  input: { provider?: string; model?: string; thinkingLevel?: string; revision: string },
  catalog: () => Promise<ModelCatalog> = () => listModels(),
): Promise<ModelPreference> {
  const path = await settingsPath(cwd, true);
  const previous = saves.get(path) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const original = await readSettings(path);
    if (typeof input.revision !== 'string' || input.revision !== digest(original.text)) {
      throw new ModelPreferenceError(409, 'Pi 设置已在其他位置修改，请重新加载后再保存。');
    }
    const provider = optionalString(input.provider, 'Provider');
    const model = optionalString(input.model, 'Model');
    const thinkingLevel = optionalString(input.thinkingLevel, 'Thinking level');
    if (Boolean(provider) !== Boolean(model)) throw new ModelPreferenceError(400, '请同时选择模型提供方和模型。');
    if (thinkingLevel && !THINKING_LEVELS.includes(thinkingLevel as ModelThinkingLevel)) throw new ModelPreferenceError(400, '思考强度不属于 Pi 支持的选项。');
    if (provider && model) {
      const available = await catalog();
      const choice = available.models.find(candidate => candidate.provider === provider && candidate.id === model);
      if (!choice) throw new ModelPreferenceError(400, '所选模型不在 Pi 当前可用列表中，请刷新模型列表或在 Pi 中配置。');
      if (thinkingLevel && !choice.thinkingLevels.includes(thinkingLevel)) throw new ModelPreferenceError(400, '此模型不支持所选思考强度。');
    }
    const next = { ...original.value };
    for (const [field, value] of [
      ['defaultProvider', provider], ['defaultModel', model], ['defaultThinkingLevel', thinkingLevel],
    ] as const) {
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    const text = JSON.stringify(next, null, 2) + '\n';
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if ((await readSettings(path)).text !== original.text) throw new ModelPreferenceError(409, 'Pi 设置已在保存期间变更，请重新加载。');
      await settingsPath(cwd);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
    return preference(text, next);
  });
  saves.set(path, task);
  try { return await task; } finally { if (saves.get(path) === task) saves.delete(path); }
}

/** Explicit CLI choices override the restored session's previous model without editing its history. */
export async function modelArguments(cwd: string): Promise<string[]> {
  const selected = await getModelPreference(cwd);
  return [
    ...(selected.provider ? ['--provider', selected.provider] : []),
    ...(selected.model ? ['--model', selected.model] : []),
    ...(selected.thinkingLevel ? ['--thinking', selected.thinkingLevel] : []),
  ];
}
