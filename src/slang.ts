import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationDirectory, conversationKey, parseConversationKey, type Conversation } from './conversations.ts';
import { parseStoredRecord, type StoredMessage } from './store.ts';

export type SlangStatus = 'candidate' | 'learned' | 'rejected';
export interface SlangEntry {
  conversation: string;
  term: string;
  meaning: string;
  usage: string;
  example: string;
  cautions: string;
  status: SlangStatus;
  evidenceSeqs: number[];
  sources: Array<{ title: string; url: string }>;
  updatedAt: number;
}
export interface SlangInput {
  conversation: string;
  term: string;
  meaning?: string;
  usage?: string;
  example?: string;
  cautions?: string;
  status?: SlangStatus;
  evidenceSeqs: number[];
  sources?: Array<{ title: string; url: string }>;
}

export interface PortableSlangEntry {
  term: string;
  meaning: string;
  usage: string;
  example: string;
  cautions: string;
  sources: Array<{ title: string; url: string }>;
}

function portable(value: unknown): PortableSlangEntry {
  if (!object(value) || Object.keys(value).some(name => !['term', 'meaning', 'usage', 'example', 'cautions', 'sources'].includes(name))) {
    throw new Error('迁移词条只接受 term、meaning、usage、example、cautions、sources。');
  }
  return {
    term: termText(value.term), meaning: text(value.meaning, 'meaning', 1_000),
    usage: text(value.usage, 'usage', 1_000), example: text(value.example, 'example', 500),
    cautions: text(value.cautions, 'cautions', 500), sources: sources(value.sources),
  };
}

const MAX_ENTRIES = 300;
const MAX_EVIDENCE = 12;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = (value: string) => value.normalize('NFKC').trim();
const key = (value: string) => normalize(value).toLowerCase();

function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${name} 必须是文字。`);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) {
    throw new Error(`${name} 最多 ${max} 个字符，${required ? '不能为空，' : ''}且不含控制字符。`);
  }
  return result;
}

function termText(value: unknown): string {
  const term = text(typeof value === 'string' ? normalize(value) : value, 'term', 50, true);
  if (/[\r\n\t]/.test(term)) throw new Error('term 必须是单行短语。');
  return term;
}

function sequences(value: unknown, allowEmpty = false): number[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > MAX_EVIDENCE
    || value.some(seq => !Number.isSafeInteger(seq) || seq < 1)) throw new Error('evidenceSeqs 须包含 1 到 12 个真实消息 seq。');
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function sources(value: unknown): SlangEntry['sources'] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('sources 最多包含 5 个来源。');
  return value.map(item => {
    if (!object(item) || Object.keys(item).some(name => !['title', 'url'].includes(name))) throw new Error('来源必须只包含 title 和 url。');
    const title = text(item.title, 'title', 200, true);
    const url = text(item.url, 'url', 2_048, true);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('来源须为有效的 HTTP(S) URL。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('来源须为无凭据的 HTTP(S) URL。');
    return { title, url };
  });
}

function sourceKey(value: unknown): string {
  return conversationKey(parseConversationKey(value));
}

function entry(value: unknown): SlangEntry {
  if (!object(value) || !['candidate', 'learned', 'rejected'].includes(String(value.status))
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw new Error('词条格式无效。');
  const result: SlangEntry = {
    conversation: sourceKey(value.conversation), term: termText(value.term),
    meaning: text(value.meaning, 'meaning', 1_000), usage: text(value.usage, 'usage', 1_000),
    example: text(value.example, 'example', 500), cautions: text(value.cautions, 'cautions', 500),
    status: value.status as SlangStatus, evidenceSeqs: sequences(value.evidenceSeqs, value.status === 'candidate'),
    sources: sources(value.sources), updatedAt: value.updatedAt,
  };
  if (result.status === 'learned' && (!result.meaning || !result.usage || result.evidenceSeqs.length < 2)) {
    throw new Error('learned 词条需要含义、使用场景及至少两条不同的聊天证据。');
  }
  return result;
}

/** Only the sender's own text is learning material, never raw quoted/CQ content. */
function ownText(message: StoredMessage): string | undefined {
  if (message.outgoing || message.userId === message.selfId) return;
  const body = message.segments.filter(segment => segment.type === 'text')
    .map(segment => typeof segment.data.text === 'string' ? segment.data.text : '').join('').trim();
  if (!body || /^[!/／]/.test(body)) return;
  return body;
}

async function ordinary(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  const requested = resolve(path);
  const actual = resolve(await realpath(path));
  // Some Windows Node builds report junctions as ordinary directories in lstat.
  const samePath = process.platform === 'win32'
    ? requested.toLowerCase() === actual.toLowerCase() : requested === actual;
  if (!samePath || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`群梗路径须为本组内的普通${directory ? '目录' : '文件'}：${path}`);
  }
}

/** One instance belongs to the running group's existing exclusive session. */
export class SlangStore {
  private readonly cwd: string;
  private readonly conversations: Set<string>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, conversations: Conversation[]) {
    this.cwd = resolve(cwd);
    this.conversations = new Set(conversations.map(conversationKey));
  }

  addConversation(conversation: Conversation): void {
    this.conversations.add(conversationKey(conversation));
  }

  private target(value: string): string {
    const result = sourceKey(value);
    if (!this.conversations.has(result)) throw new Error('目标对话不属于当前对话组。');
    return result;
  }

  private async location(create = false): Promise<string> {
    await ordinary(this.cwd, true);
    const directory = join(this.cwd, '.piq');
    if (create) await mkdir(directory, { recursive: true });
    await ordinary(directory, true);
    const path = join(directory, 'slang.json');
    try { await ordinary(path, false); } catch (error) { if (!missing(error)) throw error; }
    return path;
  }

  private async read(): Promise<SlangEntry[]> {
    try {
      const path = await this.location();
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error('词库格式无效。');
      const entries = raw.entries.map(entry);
      const ids = new Set<string>();
      const counts = new Map<string, number>();
      for (const item of entries) {
        const id = `${item.conversation}:${key(item.term)}`;
        if (ids.has(id)) throw new Error('词库包含重复词条。');
        ids.add(id);
        const count = (counts.get(item.conversation) ?? 0) + 1;
        if (count > MAX_ENTRIES) throw new Error('词库超出每个来源 300 词的容量限制。');
        counts.set(item.conversation, count);
      }
      return entries;
    } catch (cause) {
      if (missing(cause)) return [];
      throw new Error('群梗词库读取失败，请检查 .piq/slang.json；原文件已保留。', { cause });
    }
  }

  private async write(entries: SlangEntry[]): Promise<void> {
    const path = await this.location(true);
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

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private async messages(conversation: string, wanted?: Set<number>, limit = 80): Promise<StoredMessage[]> {
    const target = this.target(conversation);
    const parts = conversationDirectory(parseConversationKey(target)).split('/');
    await ordinary(this.cwd, true);
    let directory = this.cwd;
    try {
      for (const segment of parts) {
        directory = join(directory, segment);
        await ordinary(directory, true);
      }
    } catch (error) { if (missing(error)) return []; throw error; }
    const files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
    const records: StoredMessage[] = [];
    const seen = new Set<number>();
    for (const name of files) {
      const path = join(directory, name);
      await ordinary(path, false);
      const contents = await readFile(path, 'utf8');
      // An incomplete final line can be a concurrent append; never treat it as evidence.
      const lines = contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
      for (const line of lines.reverse()) {
        const record = parseStoredRecord(line, path);
        if (conversationKey(record.conversation) !== target) throw new Error('对话日志包含其他来源的消息。');
        if (seen.has(record.seq)) throw new Error('对话日志包含重复 seq。');
        seen.add(record.seq);
        if (record.kind === 'poke') continue;
        const body = ownText(record);
        if (body === undefined || (wanted && !wanted.has(record.seq))) continue;
        records.push({ ...record, rawText: body, segments: [{ type: 'text', data: { text: body } }] });
        if ((!wanted && records.length >= limit) || (wanted && records.length === wanted.size)) return records.sort((a, b) => a.seq - b.seq);
      }
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  /** Trusted local WebUI can inspect retained knowledge even after all members move away. */
  async listAll(): Promise<SlangEntry[]> {
    await this.tail;
    return (await this.read()).sort((a, b) => b.updatedAt - a.updatedAt || a.term.localeCompare(b.term));
  }
  async list(conversation: string, query = ''): Promise<SlangEntry[]> {
    const target = this.target(conversation);
    const search = key(text(query, 'query', 100));
    await this.tail;
    return (await this.read()).filter(item => !search || key(`${item.term}\n${item.meaning}\n${item.usage}`).includes(search))
      .sort((a, b) => Number(b.conversation === target) - Number(a.conversation === target)
        || b.updatedAt - a.updatedAt || a.term.localeCompare(b.term));
  }

  async context(conversation: string, limit = 40): Promise<StoredMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error('limit 须为 1 到 80 的整数。');
    return this.messages(conversation, undefined, limit);
  }

  async learn(input: SlangInput): Promise<SlangEntry> {
    const target = this.target(input.conversation);
    const term = termText(input.term);
    const supplied = sequences(input.evidenceSeqs);
    return this.serial(async () => {
      const entries = await this.read();
      const index = entries.findIndex(item => item.conversation === target && key(item.term) === key(term));
      const previous = entries[index];
      if (!previous && entries.filter(item => item.conversation === target).length >= MAX_ENTRIES) {
        throw new Error('本来源词库已达 300 词，请先移除不需要的词条。');
      }
      const allEvidence = [...new Set([...(previous?.evidenceSeqs ?? []), ...supplied])].sort((a, b) => a - b);
      const evidence = allEvidence.slice(-MAX_EVIDENCE);
      const records = await this.messages(target, new Set(allEvidence));
      if (records.length !== allEvidence.length || records.some(record => !key(record.rawText).includes(key(term)))) {
        throw new Error('证据必须是来源对话真实的普通入站消息，且消息自己的文字包含该词；引用、命令和自己发送的消息不能作为证据。');
      }
      const meaning = input.meaning ?? previous?.meaning ?? '';
      const usage = input.usage ?? previous?.usage ?? '';
      const status = input.status ?? (previous?.status === 'rejected' ? 'rejected'
        : meaning.trim() && usage.trim() && evidence.length >= 2 ? 'learned' : 'candidate');
      const learned = entry({
        conversation: target, term, meaning, usage, status,
        example: input.example ?? previous?.example ?? '', cautions: input.cautions ?? previous?.cautions ?? '',
        evidenceSeqs: evidence, sources: input.sources ?? previous?.sources ?? [], updatedAt: Date.now(),
      });
      if (index < 0) entries.push(learned); else entries[index] = learned;
      await this.write(entries);
      return learned;
    });
  }

  async exportEntries(conversation: string, terms: string[]): Promise<PortableSlangEntry[]> {
    const target = this.target(conversation);
    if (!Array.isArray(terms) || !terms.length || terms.length > 50) throw new Error('请显式选择 1 到 50 个要迁移的词条。');
    const selected = terms.map(term => key(termText(term)));
    if (new Set(selected).size !== selected.length) throw new Error('迁移词条不能重复。');
    await this.tail;
    const entries = await this.read();
    return selected.map(term => {
      const found = entries.find(item => item.conversation === target && key(item.term) === term && item.status !== 'rejected');
      if (!found) throw new Error('所选来源中找不到可迁移的词条，请检查词条是否存在或已被拒绝。');
      return portable({ term: found.term, meaning: found.meaning, usage: found.usage,
        example: found.example, cautions: found.cautions, sources: found.sources });
    });
  }

  async importEntries(conversation: string, input: PortableSlangEntry[]): Promise<SlangEntry[]> {
    const target = this.target(conversation);
    if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error('每次迁移须包含 1 到 50 个词条。');
    const incoming = input.map(portable);
    if (new Set(incoming.map(item => key(item.term))).size !== incoming.length) throw new Error('迁移词条不能重复。');
    return this.serial(async () => {
      const entries = await this.read();
      const existing = new Set(entries.filter(item => item.conversation === target).map(item => key(item.term)));
      const additions = incoming.filter(item => !existing.has(key(item.term))).map(item => entry({
        ...item, conversation: target, evidenceSeqs: [], status: 'candidate', updatedAt: Date.now(),
      }));
      if (existing.size + additions.length > MAX_ENTRIES) throw new Error('迁移后超出每个来源 300 词的容量限制，请先移除不需要的词条。');
      if (additions.length) await this.write([...entries, ...additions]);
      return additions;
    });
  }

  async remove(conversation: string, term: string): Promise<boolean> {
    const target = this.target(conversation);
    const normalized = key(termText(term));
    return this.serial(async () => {
      const entries = await this.read();
      const filtered = entries.filter(item => item.conversation !== target || key(item.term) !== normalized);
      if (filtered.length === entries.length) return false;
      await this.write(filtered);
      return true;
    });
  }
}
