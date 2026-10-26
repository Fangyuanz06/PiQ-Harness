import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationKey, parseConversationKey, validateConversation, type Conversation } from './conversations.ts';

export interface GroupConfig {
  id: string;
  name: string;
  conversations: Conversation[];
  wsUrl: string;
  accessTokenEnv: string;
  quietMs: number;
  maxWaitMs: number;
  minIntervalMs: number;
  slang?: { enabled: boolean; webResearch: boolean; autoMigrate?: boolean };
  permissions?: { commands?: boolean; fileRead?: boolean; fileWrite?: boolean; qq?: boolean; network?: boolean; otherTools?: boolean };
}

export const DEFAULTS: Omit<GroupConfig, 'id' | 'name' | 'conversations'> = {
  wsUrl: 'ws://127.0.0.1:3001/', accessTokenEnv: 'SNOWLUMA_ACCESS_TOKEN',
  quietMs: 1_500, maxWaitMs: 10_000, minIntervalMs: 15_000,
};
export class ConfigError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error('对话组标识须为 1 到 64 位小写字母、数字、下划线或连字符，不能使用系统保留名称。');
  }
  return value;
}

export function validateConfig(value: unknown): GroupConfig {
  if (!object(value)) throw new Error('PIQ.md 的 JSON 必须是配置对象。');
  const allowed = new Set(['id', 'name', 'conversations', 'slang', 'permissions', ...Object.keys(DEFAULTS)]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('PIQ.md 含未知配置项；请使用对话组配置格式。');
  const id = validateGroupId(value.id);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80
    || /[\x00-\x1f\x7f]/.test(value.name)) throw new Error('对话组名称须为 1 到 80 个字符。');
  if (!Array.isArray(value.conversations)) throw new Error('conversations 必须是对话数组。');
  const conversations = value.conversations.map(validateConversation);
  if (new Set(conversations.map(conversationKey)).size !== conversations.length) throw new Error('同一对话在对话组中只能出现一次。');
  let slang: GroupConfig['slang'];
  if (value.slang !== undefined) {
    if (!object(value.slang) || Object.keys(value.slang).some(key => !['enabled', 'webResearch', 'autoMigrate'].includes(key))
      || ['enabled', 'webResearch', 'autoMigrate'].some(key => value.slang && object(value.slang) && value.slang[key] !== undefined && typeof value.slang[key] !== 'boolean')) {
      throw new Error('slang 仅支持布尔配置 enabled、webResearch 和 autoMigrate。');
    }
    slang = { enabled: value.slang.enabled !== false, webResearch: value.slang.webResearch === true,
      ...(value.slang.autoMigrate === undefined ? {} : { autoMigrate: value.slang.autoMigrate === true }) };
  }
  let permissions: GroupConfig['permissions'];
  if (value.permissions !== undefined) {
    const allowedPermissions = ['commands', 'fileRead', 'fileWrite', 'qq', 'network', 'otherTools'];
    if (!object(value.permissions) || Object.keys(value.permissions).some(key => !allowedPermissions.includes(key))
      || Object.values(value.permissions).some(setting => typeof setting !== 'boolean')) {
      throw new Error('permissions 仅支持 commands、fileRead、fileWrite、qq、network、otherTools 布尔开关。');
    }
    permissions = { ...value.permissions };
  }  const merged = { ...DEFAULTS, ...value };
  if (typeof merged.wsUrl !== 'string') throw new Error('wsUrl 必须是 WebSocket 地址。');
  let url: URL;
  try { url = new URL(merged.wsUrl); } catch { throw new Error('wsUrl 必须是有效的 ws:// 或 wss:// 地址。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) throw new Error('wsUrl 必须使用 ws:// 或 wss://。');
  if (url.username || url.password || url.search || url.hash) throw new Error('wsUrl 请只填写端点地址；凭据使用 accessTokenEnv 环境变量。');
  if (typeof merged.accessTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(merged.accessTokenEnv)) throw new Error('accessTokenEnv 必须是有效的环境变量名。');
  for (const key of ['quietMs', 'maxWaitMs', 'minIntervalMs'] as const) {
    if (typeof merged[key] !== 'number' || !Number.isInteger(merged[key]) || merged[key] < 0 || merged[key] > 3_600_000) throw new Error(`${key} 必须是 0 到 3600000 的整数毫秒。`);
  }
  if (merged.maxWaitMs === 0 || merged.quietMs > merged.maxWaitMs) throw new Error('maxWaitMs 必须大于 0，且不小于 quietMs。');
  return { id, name: value.name.trim(), conversations, wsUrl: merged.wsUrl, accessTokenEnv: merged.accessTokenEnv,
    quietMs: merged.quietMs, maxWaitMs: merged.maxWaitMs, minIntervalMs: merged.minIntervalMs,
    ...(slang === undefined ? {} : { slang }), ...(permissions === undefined ? {} : { permissions }) };
}

function parseMarkdown(markdown: string): GroupConfig {
  const blocks = [...markdown.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error('PIQ.md 必须包含且只包含一个 json 代码块。');
  let value: unknown;
  try { value = JSON.parse(blocks[0]![1]!); } catch { throw new Error('PIQ.md 的 json 代码块格式无效。'); }
  return validateConfig(value);
}

export async function loadConfig(cwd: string): Promise<GroupConfig | null> {
  try { return parseMarkdown(await readFile(join(cwd, 'PIQ.md'), 'utf8')); }
  catch (error) { if (missing(error)) return null; throw error; }
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}

async function localFile(cwd: string, relativeFile: string): Promise<string> {
  const path = join(cwd, relativeFile);
  const parent = dirname(path);
  try { if (!contained(cwd, await realpath(parent))) throw new ConfigError(400, '配置文件须位于当前对话组目录。'); }
  catch (error) { if (!missing(error)) throw error; }
  try { if ((await lstat(path)).isSymbolicLink() || !contained(cwd, await realpath(path))) throw new ConfigError(400, '配置文件须为当前目录中的普通文件。'); }
  catch (error) { if (!missing(error)) throw error; }
  return path;
}

async function groupDirectory(cwd: string): Promise<{ root: string; path: string; id: string }> {
  const requested = resolve(cwd);
  const id = validateGroupId(basename(requested));
  const root = await realpath(dirname(requested));
  const path = await realpath(requested);
  if ((await lstat(requested)).isSymbolicLink() || !contained(root, path) || relative(root, path) !== id) throw new ConfigError(400, '对话组目录必须直接位于根目录中。');
  await localFile(path, 'PIQ.md');
  return { root, path, id };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (codeIs(error, 'ESRCH')) return false; if (codeIs(error, 'EPERM')) return true; throw error; }
}
interface Owner { pid: number; token: string }

async function owner(cwd: string): Promise<Owner | null> {
  try {
    const path = await localFile(cwd, '.piq/owner.lock');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !value.token) throw new Error('对话组运行锁无效。');
    return { pid: Number(value.pid), token: value.token };
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function exclusiveFile(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function atomicFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await exclusiveFile(temporary, text);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(15 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

/** One root lease covers config edits and runtime conversation claims. */
async function withRootLock<T>(rootInput: string, operation: (root: string) => Promise<T>): Promise<T> {
  await mkdir(rootInput, { recursive: true });
  const root = await realpath(rootInput);
  const path = await localFile(root, '.piq-config.lock');
  const token = randomUUID();
  const text = JSON.stringify({ pid: process.pid, token });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await exclusiveFile(path, text); break; }
    catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
    let current: unknown;
    try { current = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (missing(error)) continue; if (!(error instanceof SyntaxError)) throw error; }
    if (object(current) && Number.isSafeInteger(current.pid) && Number(current.pid) > 0 && typeof current.token === 'string' && !alive(Number(current.pid))) {
      const recovery = `${path}.recover`;
      let handle;
      try { handle = await open(recovery, 'wx', 0o600); }
      catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
      if (handle) {
        try {
          try {
            const latest = JSON.parse(await readFile(path, 'utf8'));
            if (latest.pid === current.pid && latest.token === current.token && !alive(latest.pid)) await unlink(path);
          } catch (error) { if (!missing(error)) throw error; }
        } finally { await handle.close(); await unlink(recovery); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new ConfigError(409, '对话组配置正在被其他操作使用，请稍后重试。');
    await delay(25);
  }
  try { return await operation(root); }
  finally {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.token === token) await unlink(path);
  }
}

export interface GroupListing { id: string; path: string; config: GroupConfig }

async function scanGroups(root: string): Promise<GroupListing[]> {
  const groups: GroupListing[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(root, entry.name);
    try { await lstat(join(path, 'PIQ.md')); }
    catch (error) {
      if (!missing(error)) throw error;
      // A running process retains its loaded members even if its document was
      // removed. Resolve that owner before another group can claim its chats.
      if (!entry.isSymbolicLink()) {
        const running = await owner(path);
        if (running && alive(running.pid)) throw new ConfigError(409, `运行中的对话组 ${entry.name} 缺少 PIQ.md，请恢复配置或先停止该会话。`);
      }
      continue;
    }
    const checked = await groupDirectory(path);
    const config = await loadConfig(checked.path);
    if (!config || config.id !== checked.id) throw new ConfigError(400, `目录 ${entry.name} 与 PIQ.md 的对话组标识不一致。`);
    groups.push({ id: config.id, path: checked.path, config });
  }
  return groups;
}

async function activeClaims(cwd: string): Promise<string[]> {
  const lock = await owner(cwd);
  if (!lock || !alive(lock.pid)) return [];
  let value: unknown;
  try { value = JSON.parse(await readFile(await localFile(cwd, '.piq/conversations.json'), 'utf8')); }
  catch (error) { if (missing(error)) return []; throw error; }
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || typeof value.ownerToken !== 'string' || !Array.isArray(value.keys)) throw new ConfigError(409, '活动对话归属记录无效，请先停止对应 Pi 会话。');
  if (value.pid !== lock.pid || value.ownerToken !== lock.token) return [];
  return value.keys.map(key => conversationKey(parseConversationKey(key)));
}

async function checkAssignments(root: string, candidate?: GroupConfig): Promise<GroupListing[]> {
  const groups = await scanGroups(root);
  const owners = new Map<string, string>();
  const claim = (key: string, id: string) => {
    const previous = owners.get(key);
    if (previous && previous !== id) throw new ConfigError(409, `对话 ${key} 同时分配给 ${previous} 和 ${id}；每个对话只能属于一个对话组。`);
    owners.set(key, id);
  };
  for (const group of groups) {
    const config = group.id === candidate?.id ? candidate : group.config;
    for (const item of config.conversations) claim(conversationKey(item), group.id);
    for (const key of await activeClaims(group.path)) claim(key, group.id);
  }
  if (candidate && !groups.some(group => group.id === candidate.id)) {
    for (const item of candidate.conversations) claim(conversationKey(item), candidate.id);
  }
  return groups;
}

export async function listGroupConfigs(root: string): Promise<GroupListing[]> {
  return withRootLock(root, async resolved => checkAssignments(resolved));
}

export async function assertAssignments(cwd: string, config: GroupConfig): Promise<void> {
  const checked = await groupDirectory(cwd);
  const candidate = validateConfig(config);
  if (checked.id !== candidate.id) throw new ConfigError(400, '目录与对话组标识不一致。');
  await withRootLock(checked.root, async root => { await checkAssignments(root, candidate); });
}

export interface InitializeOptions {
  name: string;
  conversations: Conversation[];
  wsUrl?: string;
  accessTokenEnv?: string;
  extensionPath?: string;
}

async function createIfMissing(path: string, content: string): Promise<void> {
  try { await exclusiveFile(path, content); }
  catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
}

export async function initializeGroup(rootInput: string, idInput: string, options: InitializeOptions): Promise<string> {
  const id = validateGroupId(idInput);
  const requested = validateConfig({ id, name: options?.name, conversations: options?.conversations, ...DEFAULTS,
    ...(options?.wsUrl === undefined ? {} : { wsUrl: options.wsUrl }),
    ...(options?.accessTokenEnv === undefined ? {} : { accessTokenEnv: options.accessTokenEnv }),
  });
  return withRootLock(resolve(rootInput), async root => {
    const cwd = join(root, id);
    try { if ((await lstat(cwd)).isSymbolicLink()) throw new ConfigError(400, '对话组目录不能是符号链接。'); }
    catch (error) { if (!missing(error)) throw error; }
    const existing = await loadConfig(cwd);
    if (existing && existing.id !== id) throw new ConfigError(400, '目录与 PIQ.md 的对话组标识不一致。');
    await checkAssignments(root, existing ?? requested);
    const settingsPath = await localFile(cwd, '.pi/settings.json');
    let original: string | undefined; let settings: Record<string, unknown> = {};
    try {
      original = await readFile(settingsPath, 'utf8');
      const parsed: unknown = JSON.parse(original);
      if (!object(parsed)) throw new Error();
      settings = parsed;
    } catch (error) { if (!missing(error)) throw new Error('现有 .pi/settings.json 无效，请先修复该文件。'); }
    if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error('现有 .pi/settings.json 的 packages 必须是数组。');
    const packagePath = resolve(options.extensionPath ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const packages = (settings.packages ?? []) as unknown[];
    const configured = packages.some(entry => entry === packagePath || (object(entry) && entry.source === packagePath));
    await mkdir(join(cwd, '.pi', 'sessions'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await mkdir(join(cwd, 'messages'), { recursive: true });
    await createIfMissing(join(root, 'AGENTS.md'), await readFile(new URL('../templates/AGENTS.md', import.meta.url), 'utf8'));
    await createIfMissing(join(cwd, 'PIQ.md'), [
      `# 对话组 ${requested.name}`, '', '本目录中的对话共用一个 Pi 会话和一套配置。修改对话归属前先停止本组。', '',
      '```json', JSON.stringify(requested, null, 2), '```', '',
      'quietMs：静默聚合等待；maxWaitMs：连续发言的最长聚合等待；minIntervalMs：两次通知的最小间隔。', '',
    ].join('\n'));
    await createIfMissing(join(cwd, 'AGENTS.md'), [
      `# 对话组 ${requested.name}`, '',
      '本目录内的对话共用会话、人设、记忆和资料，成员对话见 PIQ.md。',
      'PERSONA.md 可记录人设；需要时自行读取、维护 MEMORY.md 或其他 Markdown。',
      '群聊、好友私聊、群临时私聊的日志分别保存在 messages/group/<群号>/、messages/private/<QQ号>/、messages/temporary/<来源群>/<QQ号>/，各自按日期使用 JSONL。',
      '新出现的群临时私聊默认归入来源群所在的对话组；已有归属优先，不自动添加好友。',
      'PiQ 通知只表示有新消息。自行阅读记录，判断是否回应，也可以保持沉默。',
      '发消息时调用 qq_send，并明确指定本组中的目标对话。普通 Pi 回答只显示在当前会话。',
      '回复以目标对话的上下文为准；其他对话尤其私聊的内容，不因属于同组而自动转述。',
      '可在本组目录内整理记忆、保存表情包和其他资料，assets/ 可存放媒体。', '',
    ].join('\n'));
    await createIfMissing(join(cwd, 'PERSONA.md'), '# 人设\n\n在这里填写本对话组的人设、语气和偏好。\n');
    if (!configured) {
      const updated = JSON.stringify({ ...settings, packages: [...packages, packagePath] }, null, 2) + '\n';
      if (original !== undefined) {
        if (await readFile(settingsPath, 'utf8') !== original) throw new ConfigError(409, '.pi/settings.json 在初始化期间被修改，请重试。');
        await createIfMissing(`${settingsPath}.before-piq`, original);
        await atomicFile(settingsPath, updated);
      } else await exclusiveFile(settingsPath, updated);
    }
    return cwd;
  });
}

export async function saveGroupConfig(cwd: string, input: GroupConfig, expectedRevision: string): Promise<{ config: GroupConfig; revision: string }> {
  const checked = await groupDirectory(cwd);
  const candidate = validateConfig(input);
  if (candidate.id !== checked.id) throw new ConfigError(400, '此处不能更改对话组标识。');
  return withRootLock(checked.root, async root => {
    const path = await localFile(checked.path, 'PIQ.md');
    const original = await readFile(path, 'utf8');
    if (typeof expectedRevision !== 'string' || revision(original) !== expectedRevision) throw new ConfigError(409, '配置已在其他位置修改，请重新加载后再保存。');
    const before = parseMarkdown(original);
    const keys = (config: GroupConfig) => config.conversations.map(conversationKey).sort().join('\n');
    if (keys(before) !== keys(candidate)) {
      const running = await owner(checked.path);
      if (running && alive(running.pid)) throw new ConfigError(409, '修改对话归属前，请先停止此对话组的 Pi 会话。');
    }
    await checkAssignments(root, candidate);
    const updated = original.replace(/^```json[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?$/m, '```json\n' + JSON.stringify(candidate, null, 2) + '\n```');
    if (await readFile(path, 'utf8') !== original) throw new ConfigError(409, '配置在保存期间被修改，请重试。');
    await atomicFile(path, updated);
    return { config: candidate, revision: revision(updated) };
  });
}

/** Runtime claims retain membership even if someone edits an active PIQ.md by hand. */
export async function claimConversations(cwd: string, input: GroupConfig): Promise<() => Promise<void>> {
  const checked = await groupDirectory(cwd);
  const config = validateConfig(input);
  if (config.id !== checked.id) throw new ConfigError(400, '目录与对话组标识不一致。');
  const claimed = await withRootLock(checked.root, async root => {
    const disk = await loadConfig(checked.path);
    if (JSON.stringify(disk) !== JSON.stringify(config)) throw new ConfigError(409, '对话组配置已变更，请重新加载。');
    const lock = await owner(checked.path);
    if (!lock || lock.pid !== process.pid) throw new ConfigError(409, '当前进程尚未取得此对话组运行锁。');
    await checkAssignments(root, config);
    const path = await localFile(checked.path, '.piq/conversations.json');
    await atomicFile(path, JSON.stringify({ version: 1, id: config.id, pid: lock.pid, ownerToken: lock.token, keys: config.conversations.map(conversationKey) }, null, 2) + '\n');
    return { path, token: lock.token };
  });
  let released = false;
  return async () => {
    if (released) return;
    await withRootLock(checked.root, async () => {
      try {
        await localFile(checked.path, '.piq/conversations.json');
        const value = JSON.parse(await readFile(claimed.path, 'utf8'));
        if (value.ownerToken === claimed.token) await unlink(claimed.path);
      } catch (error) { if (!missing(error)) throw error; }
    });
    released = true;
  };
}

/** A new incoming temporary chat follows its source group unless already assigned. */
export async function adoptTemporaryConversation(cwd: string, input: Conversation): Promise<GroupConfig | null> {
  const temporary = validateConversation(input);
  if (temporary.type !== 'temporary') throw new Error('自动归属只接受群临时私聊。');
  const checked = await groupDirectory(cwd);
  return withRootLock(checked.root, async root => {
    const groups = await checkAssignments(root);
    const current = groups.find(group => group.id === checked.id);
    if (!current) return null;
    const lock = await owner(checked.path);
    if (!lock || lock.pid !== process.pid) return null;
    const held = await activeClaims(checked.path);
    const key = conversationKey(temporary);
    for (const group of groups) {
      if (group.id === checked.id) continue;
      if (group.config.conversations.some(item => conversationKey(item) === key)
        || (await activeClaims(group.path)).includes(key)) return null;
    }
    const configured = current.config.conversations.some(item => conversationKey(item) === key);
    if (configured && held.includes(key)) return current.config;
    const sourceKey = conversationKey({ type: 'group', id: temporary.sourceGroupId! });
    if (!held.includes(sourceKey) || !current.config.conversations.some(item => conversationKey(item) === sourceKey)) return null;
    const path = await localFile(checked.path, 'PIQ.md');
    const original = await readFile(path, 'utf8');
    if (JSON.stringify(parseMarkdown(original)) !== JSON.stringify(current.config)) throw new ConfigError(409, '对话组配置在自动归属期间变更，请重试。');
    const candidate = configured ? current.config : validateConfig({ ...current.config, conversations: [...current.config.conversations, temporary] });
    await checkAssignments(root, candidate);
    const claimPath = await localFile(checked.path, '.piq/conversations.json');
    const oldClaim = await readFile(claimPath, 'utf8');
    const claim = JSON.parse(oldClaim);
    if (claim.pid !== lock.pid || claim.ownerToken !== lock.token) return null;
    const currentOwner = await owner(checked.path);
    if (currentOwner?.pid !== lock.pid || currentOwner.token !== lock.token) return null;
    const newClaim = JSON.stringify({ ...claim, keys: [...new Set([...held, key])] }, null, 2) + '\n';
    const updated = original.replace(/^```json[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?$/m, '```json\n' + JSON.stringify(candidate, null, 2) + '\n```');
    await atomicFile(claimPath, newClaim);
    try {
      if (await readFile(path, 'utf8') !== original) throw new ConfigError(409, '配置在自动归属期间被修改，请重试。');
      if (updated !== original) await atomicFile(path, updated);
    } catch (error) {
      await atomicFile(claimPath, oldClaim);
      throw error;
    }
    return candidate;
  });
}

function sameLocalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

async function ordinaryGroupPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !sameLocalPath(path, await realpath(path))
    || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new ConfigError(400, '对话组操作只接受普通目录和文件，不能通过符号链接或目录联接访问。');
  }
}

interface StoppedGroup {
  root: string;
  path: string;
  id: string;
  config: GroupConfig;
  relocated(path: string): void;
}

/** The same launch/owner leases used by Pi also protect stopped-group operations. */
async function withStoppedGroup<T>(cwd: string, operation: (group: StoppedGroup) => Promise<T>): Promise<T> {
  const requested = resolve(cwd);
  const id = validateGroupId(basename(requested));
  const requestedRoot = dirname(requested);
  await ordinaryGroupPath(requestedRoot, true);
  return withRootLock(requestedRoot, async root => {
    await ordinaryGroupPath(requested, true);
    const checked = await groupDirectory(requested);
    if (checked.id !== id || !sameLocalPath(checked.root, root)) throw new ConfigError(400, '对话组必须直接位于当前根目录中。');
    await ordinaryGroupPath(join(checked.path, 'PIQ.md'), false);
    const config = await loadConfig(checked.path);
    if (!config || config.id !== id) throw new ConfigError(400, '目录与 PIQ.md 的对话组标识不一致。');
    const runtimeDirectory = join(checked.path, '.piq');
    try { await ordinaryGroupPath(runtimeDirectory, true); }
    catch (error) { if (!missing(error)) throw error; await mkdir(runtimeDirectory); }
    for (const file of ['owner.lock', 'start.lock', 'start.lock.recover', 'recovery.lock', 'terminal-return.lock', 'terminal-return.lock.recover']) {
      try { await ordinaryGroupPath(join(runtimeDirectory, file), false); }
      catch (error) { if (missing(error)) continue; throw error; }
      throw new ConfigError(409, '对话组正在运行、启动或保留运行锁；请先停止会话，确认残留锁已处理后重试。');
    }
    let workerState: { launchId: string; startedAt: number; state: string } | undefined;
    try {
      const workerPath = join(runtimeDirectory, 'worker.json');
      await ordinaryGroupPath(workerPath, false);
      if ((await lstat(workerPath)).size > 16_384) throw new Error();
      const worker: unknown = JSON.parse(await readFile(workerPath, 'utf8'));
      if (!object(worker) || worker.version !== 1 || worker.mode !== 'background' || !Number.isSafeInteger(worker.pid)
        || Number(worker.pid) < 1 || typeof worker.launchId !== 'string' || !Number.isFinite(worker.startedAt)
        || !['starting', 'running', 'stopped', 'error'].includes(String(worker.state))) throw new Error();
      workerState = { launchId: worker.launchId, startedAt: worker.startedAt as number, state: String(worker.state) };
      if (['starting', 'running'].includes(String(worker.state)) && alive(Number(worker.pid))) throw new ConfigError(409, '对话组正在运行或启动，请先停止后重试。');
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (!missing(error)) throw new ConfigError(409, '后台运行记录无效，请先检查 .piq/worker.json。');
    }
    for (const file of ['worker-launch.json', 'launch.json']) {
      try {
        const launchPath = join(runtimeDirectory, file);
        await ordinaryGroupPath(launchPath, false);
        if ((await lstat(launchPath)).size > 16_384) throw new Error();
        const launch: unknown = JSON.parse(await readFile(launchPath, 'utf8'));
        if (!object(launch) || launch.version !== 1 || !Number.isSafeInteger(launch.pid) || Number(launch.pid) < 1
          || typeof launch.launchId !== 'string' || !launch.launchId || typeof launch.startedAt !== 'number'
          || !Number.isFinite(launch.startedAt) || launch.startedAt < 0) throw new Error();
        // A matching child state, or a later worker, supersedes its parent's pending marker.
        if (alive(Number(launch.pid)) && (!workerState
          || (workerState.launchId !== launch.launchId && workerState.startedAt < launch.startedAt))) {
          throw new ConfigError(409, '对话组进程正在启动，请先停止后重试。');
        }
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        if (!missing(error)) throw new ConfigError(409, `后台启动记录无效，请检查 .piq/${file}。`);
      }
    }
    try {
      const terminalPath = join(runtimeDirectory, 'terminal-return.json');
      await ordinaryGroupPath(terminalPath, false);
      if ((await lstat(terminalPath)).size > 16_384) throw new Error();
      const terminal: unknown = JSON.parse(await readFile(terminalPath, 'utf8'));
      const validPid = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
      if (!object(terminal) || terminal.version !== 1 || typeof terminal.token !== 'string' || !terminal.token
        || !validPid(terminal.launcherPid) || typeof terminal.createdAt !== 'number' || !Number.isFinite(terminal.createdAt)
        || !['starting', 'watching', 'recovering', 'error'].includes(String(terminal.state))
        || [terminal.monitorPid, terminal.wrapperPid, terminal.piPid].some(value => value !== undefined && !validPid(value))) throw new Error();
      const liveTerminal = [terminal.wrapperPid, terminal.piPid].some(value => validPid(value) && alive(Number(value)));
      const pendingReturn = terminal.state !== 'error'
        && [terminal.monitorPid, terminal.launcherPid].some(value => validPid(value) && alive(Number(value)));
      if (liveTerminal || pendingReturn) throw new ConfigError(409, '终端 Pi 或后台恢复仍在运行，请先停止本对话组后重试。');
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (!missing(error)) throw new ConfigError(409, '终端恢复记录无效，请检查 .piq/terminal-return.json。');
    }    const token = randomUUID();
    let leaseDirectory = checked.path;
    const acquired: string[] = [];
    try {
      for (const file of ['start.lock', 'owner.lock']) {
        try {
          await exclusiveFile(join(runtimeDirectory, file), JSON.stringify({ ...(file === 'owner.lock' ? { version: 1 } : {}), pid: process.pid, token }));
        } catch (error) {
          if (codeIs(error, 'EEXIST')) throw new ConfigError(409, '对话组刚开始运行或启动，请先停止后重试。');
          throw error;
        }
        acquired.push(file);
      }
      return await operation({ ...checked, config, relocated: path => { leaseDirectory = path; } });
    } finally {
      for (const file of acquired.reverse()) {
        const path = join(leaseDirectory, '.piq', file);
        try {
          const value: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (object(value) && value.token === token) await unlink(path);
        } catch (error) { if (!missing(error)) throw error; }
      }
    }
  });
}

/** Remove a stopped group from the registry while retaining its complete directory. */
export async function deleteGroup(cwd: string): Promise<{ deleted: true; id: string; recoveryPath: string }> {
  return withStoppedGroup(cwd, async group => {
    const trash = join(group.root, '.trash');
    await mkdir(trash, { recursive: true });
    await ordinaryGroupPath(trash, true);
    const recoveryPath = join(trash, `${group.id}-${Date.now()}-${randomUUID()}`);
    if (!contained(group.root, recoveryPath) || dirname(recoveryPath) !== trash) throw new ConfigError(400, '回收目录无效。');
    await ordinaryGroupPath(group.path, true);
    const exchangeDirectory = join(group.root, '.piq-slang');
    const exchangePath = join(exchangeDirectory, `${group.id}.json`);
    let retainedExchange: string | undefined;
    try {
      await ordinaryGroupPath(exchangeDirectory, true);
      await ordinaryGroupPath(exchangePath, false);
      retainedExchange = join(group.path, '.piq', `shared-slang-${randomUUID()}.json`);
      await rename(exchangePath, retainedExchange);
    } catch (error) { if (!missing(error)) throw error; }
    try { await rename(group.path, recoveryPath); }
    catch (error) {
      // The stopped source is the only writer of its outbox; restore it if the directory move fails.
      if (retainedExchange) await rename(retainedExchange, exchangePath);
      throw error;
    }
    group.relocated(recoveryPath);
    return { deleted: true, id: group.id, recoveryPath };
  });
}

async function copyKnowledgeDirectory(source: string, destination: string): Promise<void> {
  await ordinaryGroupPath(source, true);
  await mkdir(destination);
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (['.pi', '.piq', 'sessions', 'messages', 'runtime'].includes(item.name.toLowerCase())
      || /^auth(?:\.|$)|^\.env(?:\.|$)/i.test(item.name)) continue;
    const from = join(source, item.name), to = join(destination, item.name);
    // realpath checks also reject Windows junctions reported as ordinary directories.
    const info = await lstat(from);
    await ordinaryGroupPath(from, info.isDirectory());
    if (info.isDirectory()) await copyKnowledgeDirectory(from, to);
    else if (info.isFile() && info.nlink === 1) await copyFile(from, to);
    else throw new ConfigError(400, '复制只接受无硬链接的普通资料文件。');
  }
}

/** Copy reusable knowledge and settings, leaving conversation ownership and runtime behind. */
export async function copyGroup(cwd: string, name: string): Promise<{ id: string; name: string; path: string }> {
  return withStoppedGroup(cwd, async group => {
    const id = validateGroupId(`${group.id.slice(0, 49)}-copy-${randomUUID().replaceAll('-', '').slice(0, 8)}`);
    const config = validateConfig({ ...group.config, id, name, conversations: [] });
    await checkAssignments(group.root, config);
    const temporary = join(group.root, `.copy-${randomUUID()}`);
    const path = join(group.root, id);
    await mkdir(temporary);
    // Partial copies remain hidden and inspectable if validation or an I/O operation fails.
    for (const item of await readdir(group.path, { withFileTypes: true })) {
      if (!item.name.toLowerCase().endsWith('.md') || item.name.toLowerCase() === 'piq.md') continue;
      const from = join(group.path, item.name);
      await ordinaryGroupPath(from, false);
      if ((await lstat(from)).nlink !== 1) throw new ConfigError(400, '复制只接受无硬链接的普通文档。');
      await copyFile(from, join(temporary, item.name));
    }
    await exclusiveFile(join(temporary, 'PIQ.md'), `# 对话组 ${config.name}\n\n复制的资料不附带对话归属，请先添加本组对话。\n\n` + '```json\n' + JSON.stringify(config, null, 2) + '\n```\n');
    for (const directory of ['assets', 'memory']) {
      try { await ordinaryGroupPath(join(group.path, directory), true); }
      catch (error) { if (missing(error)) continue; throw error; }
      await copyKnowledgeDirectory(join(group.path, directory), join(temporary, directory));
    }
    const settingsDirectory = join(group.path, '.pi');
    try {
      await ordinaryGroupPath(settingsDirectory, true);
      const settingsPath = join(settingsDirectory, 'settings.json');
      await ordinaryGroupPath(settingsPath, false);
      const original: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (!object(original)) throw new ConfigError(400, '源组 Pi 设置无效。');
      const settings = Object.fromEntries(['packages', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel']
        .filter(key => original[key] !== undefined).map(key => [key, original[key]]));
      if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new ConfigError(400, '源组 packages 设置无效。');
      for (const field of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel']) {
        if (settings[field] !== undefined && typeof settings[field] !== 'string') throw new ConfigError(400, '源组模型设置无效。');
      }
      await mkdir(join(temporary, '.pi'));
      await exclusiveFile(join(temporary, '.pi', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    } catch (error) { if (!missing(error)) throw error; }
    try { await lstat(path); throw new ConfigError(409, '副本目录已存在，请重试。'); }
    catch (error) { if (!missing(error)) throw error; }
    await rename(temporary, path);
    return { id, name: config.name, path };
  });
}
