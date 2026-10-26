import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, validateGroupId, type GroupConfig } from './config.ts';
import { conversationKey, parseConversationKey } from './conversations.ts';
import { SlangStore, type PortableSlangEntry, type SlangEntry } from './slang.ts';

export interface SharedSlangEntry {
  id: string;
  fromGroup: string;
  entry: PortableSlangEntry;
  reason: string;
  updatedAt: number;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const optedIn = (config: GroupConfig | null) => config?.slang?.enabled !== false && config?.slang?.autoMigrate === true;

function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${name} 必须是文字。`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) {
    throw new Error(`${name} 最多 ${max} 个字符，${required ? '不能为空，' : ''}且不含控制字符。`);
  }
  return result;
}

function portable(value: unknown): PortableSlangEntry {
  if (!object(value) || Object.keys(value).some(name => !['term', 'meaning', 'usage', 'example', 'cautions', 'sources'].includes(name))) {
    throw new Error('迁移词条只接受 term、meaning、usage、example、cautions、sources。');
  }
  const term = text(typeof value.term === 'string' ? value.term.normalize('NFKC') : value.term, 'term', 50, true);
  if (/[\r\n\t]/.test(term)) throw new Error('term 必须是单行短语。');
  if (!Array.isArray(value.sources) || value.sources.length > 5) throw new Error('sources 最多包含 5 个来源。');
  const sources = value.sources.map(item => {
    if (!object(item) || Object.keys(item).some(name => !['title', 'url'].includes(name))) throw new Error('来源只接受 title 和 url。');
    const title = text(item.title, 'title', 200, true);
    const url = text(item.url, 'url', 2_048, true);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('来源须为 HTTP(S) URL。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('来源须为无凭据的 HTTP(S) URL。');
    return { title, url };
  });
  return {
    term, meaning: text(value.meaning, 'meaning', 1_000), usage: text(value.usage, 'usage', 1_000),
    example: text(value.example, 'example', 500), cautions: text(value.cautions, 'cautions', 500), sources,
  };
}

function shared(value: unknown, owner: string): SharedSlangEntry {
  if (!object(value) || Object.keys(value).some(name => !['id', 'fromGroup', 'entry', 'reason', 'updatedAt'].includes(name))
    || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || value.fromGroup !== owner
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    throw new Error('共享词条格式或来源对话组无效。');
  }
  const entry = portable(value.entry);
  if (!entry.meaning || !entry.usage) throw new Error('共享词条必须包含含义和使用场景。');
  return { id: value.id, fromGroup: owner, entry, reason: text(value.reason, 'reason', 500, true), updatedAt: value.updatedAt };
}

async function ordinary(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  const requested = resolve(path);
  const actual = resolve(await realpath(path));
  // Some Windows Node builds report junctions as ordinary directories in lstat.
  const samePath = process.platform === 'win32'
    ? requested.toLowerCase() === actual.toLowerCase() : requested === actual;
  if (!samePath || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`迁移路径须为普通${directory ? '目录' : '文件'}：${path}`);
  }
  if (!directory && info.size > 5_000_000) throw new Error('迁移文件过大，请检查原文件。');
}

/** Each group publishes its own outbox; only the recipient writes its own library. */
export class SlangMigration {
  private readonly cwd: string;
  private readonly root: string;
  private readonly id: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly store: SlangStore;

  constructor(cwd: string, store: SlangStore) {
    this.cwd = resolve(cwd);
    this.root = dirname(this.cwd);
    this.id = validateGroupId(basename(this.cwd));
    this.store = store;
  }

  private async configuration(id: string): Promise<GroupConfig | null> {
    validateGroupId(id);
    await ordinary(this.root, true);
    const cwd = join(this.root, id);
    try { await ordinary(cwd, true); await ordinary(join(cwd, 'PIQ.md'), false); }
    catch (error) { if (missing(error)) return null; throw error; }
    const config = await loadConfig(cwd);
    if (config && config.id !== id) throw new Error('迁移来源目录与 PIQ.md 标识不一致。');
    return config;
  }

  private async enabled(conversation?: string): Promise<GroupConfig> {
    const config = await this.configuration(this.id);
    if (!config || !optedIn(config)) throw new Error('本组尚未开启群梗自动迁移，请在 PIQ.md 设置 slang.autoMigrate=true 且保持 enabled 开启。');
    if (conversation !== undefined) {
      const key = conversationKey(parseConversationKey(conversation));
      if (!config.conversations.some(item => conversationKey(item) === key)) throw new Error('迁移目标或来源对话不属于当前对话组。');
    }
    return config;
  }

  private async directory(create: boolean): Promise<string | undefined> {
    await ordinary(this.root, true);
    const directory = join(this.root, '.piq-slang');
    if (create) await mkdir(directory, { recursive: true });
    try { await ordinary(directory, true); }
    catch (error) { if (!create && missing(error)) return undefined; throw error; }
    return directory;
  }

  private async read(directory: string, owner: string): Promise<SharedSlangEntry[]> {
    const path = join(directory, `${validateGroupId(owner)}.json`);
    try {
      await ordinary(path, false);
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!object(raw) || Object.keys(raw).some(name => !['version', 'entries'].includes(name))
        || raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 300) throw new Error('共享词库格式或容量无效。');
      const entries = raw.entries.map(item => shared(item, owner));
      if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('共享词库包含重复标识。');
      return entries;
    } catch (cause) {
      if (missing(cause)) return [];
      throw new Error(`共享词库 ${owner}.json 读取失败；原文件已保留。`, { cause });
    }
  }

  private async write(directory: string, entries: SharedSlangEntry[]): Promise<void> {
    await ordinary(directory, true);
    const path = join(directory, `${this.id}.json`);
    try { await ordinary(path, false); } catch (error) { if (!missing(error)) throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, entries }, null, 2) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await delay(15 * (attempt + 1));
        }
      }
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  async publish(conversation: string, terms: string[], reason: string): Promise<SharedSlangEntry[]> {
    const explanation = text(reason, 'reason', 500, true);
    if (!Array.isArray(terms) || !terms.length || terms.length > 50) throw new Error('每次发布须选择 1 到 50 个词条。');
    const result = this.tail.then(async () => {
      await this.enabled(conversation);
      const selected = await this.store.exportEntries(conversation, terms);
      const learned = await this.store.list(conversation);
      const verified = selected.map(item => {
        const existing = learned.find(candidate => candidate.conversation === conversation
          && normalize(candidate.term) === normalize(item.term) && candidate.status === 'learned');
        if (!existing) throw new Error('只有本来源已 learned 的词条可以发布；候选或拒绝词条不能迁移。');
        return portable({ term: existing.term, meaning: existing.meaning, usage: existing.usage,
          example: existing.example, cautions: existing.cautions, sources: existing.sources });
      });
      const additions = verified.map(item => shared({
        id: createHash('sha256').update(`${this.id}\0${conversation}\0${normalize(item.term)}`).digest('hex').slice(0, 32),
        fromGroup: this.id, entry: item, reason: explanation, updatedAt: Date.now(),
      }, this.id));
      const directory = (await this.directory(true))!;
      const previous = await this.read(directory, this.id);
      const replacements = new Map(additions.map(item => [item.id, item]));
      const entries = previous.map(item => replacements.get(item.id) ?? item);
      entries.push(...additions.filter(item => !previous.some(existing => existing.id === item.id)));
      if (entries.length > 300) throw new Error('本组共享词库已达 300 词的容量限制。');
      await this.enabled(conversation);
      await this.write(directory, entries);
      return additions;
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async revoke(ids: string[]): Promise<number> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
      || new Set(ids).size !== ids.length) throw new Error('每次撤回须选择 1 到 50 个不同的本组共享词条标识。');
    const result = this.tail.then(async () => {
      await this.enabled();
      const directory = await this.directory(false);
      if (!directory) throw new Error('所选标识不属于本组共享词库。');
      const entries = await this.read(directory, this.id);
      if (ids.some(id => !entries.some(item => item.id === id))) throw new Error('所选标识不属于本组共享词库。');
      const selected = new Set(ids);
      await this.enabled();
      await this.write(directory, entries.filter(item => !selected.has(item.id)));
      return selected.size;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async discover(): Promise<SharedSlangEntry[]> {
    await this.enabled();
    const directory = await this.directory(false);
    if (!directory) return [];
    const entries: SharedSlangEntry[] = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!name.endsWith('.json')) continue;
      const owner = validateGroupId(name.slice(0, -5));
      if (owner === this.id) continue;
      await ordinary(join(directory, name), false);
      if (!optedIn(await this.configuration(owner))) continue;
      entries.push(...await this.read(directory, owner));
    }
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('不同来源共享词条的标识冲突，请检查共享文件。');
    return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 100);
  }

  async adopt(conversation: string, ids: string[]): Promise<SlangEntry[]> {
    await this.enabled(conversation);
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
      || new Set(ids).size !== ids.length) throw new Error('每次采用须选择 1 到 50 个不同的共享词条标识。');
    const available = new Map((await this.discover()).map(item => [item.id, item]));
    const selected = ids.map(id => {
      const found = available.get(id);
      if (!found) throw new Error('所选共享词条不可用，来源可能已关闭自动迁移，请重新发现。');
      return found;
    });
    for (const source of new Set(selected.map(item => item.fromGroup))) {
      if (!optedIn(await this.configuration(source))) throw new Error('来源已关闭自动迁移，请重新发现。');
    }
    await this.enabled(conversation);
    return this.store.importEntries(conversation, selected.map(item => item.entry));
  }
}
