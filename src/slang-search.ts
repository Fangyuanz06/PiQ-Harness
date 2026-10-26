export interface SlangSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

function searchTerm(value: string): string {
  if (typeof value !== 'string') throw new Error('搜索词须为 1 到 50 个字符。');
  const term = value.normalize('NFKC').trim();
  if (!term || term.length > 50 || /[\x00-\x1f\x7f\u2028\u2029]/.test(value)
    || /\[CQ:|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(term)) {
    throw new Error('搜索词须为 1 到 50 个字符，不能包含控制字符、CQ 消息段或网址。');
  }
  return term;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const hex = entity.slice(0, 2).toLowerCase() === '#x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '\ufffd';
  });
}

function text(value: string): string {
  return decodeEntities(decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')))
    .replace(/<[^>]*>/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function field(item: string, name: string): string {
  return text(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(item)?.[1] ?? '');
}

function parseResults(xml: string, term: string): SlangSearchResult[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b[^>]*>/i.test(xml) || !/<\/rss>\s*$/i.test(xml)
    || !/<channel\b[^>]*>[\s\S]*<\/channel>/i.test(xml)) {
    throw new Error('黑话搜索返回的 RSS 格式无效。');
  }
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if ((xml.match(/<item\b[^>]*>/gi) ?? []).length !== items.length) {
    throw new Error('黑话搜索返回的 RSS 不完整。');
  }
  const results: SlangSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const title = field(item[1]!, 'title').slice(0, 300);
    const link = field(item[1]!, 'link');
    if (!title || !link || link.length > 2048) continue;
    let url: URL;
    try { url = new URL(link); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || seen.has(url.href)) continue;
    const snippet = field(item[1]!, 'description').slice(0, 800);
    if (!(title + ' ' + snippet).normalize('NFKC').toLowerCase().includes(term.normalize('NFKC').toLowerCase())) continue;
    seen.add(url.href);
    results.push({ title, url: url.href, snippet });
    if (results.length === 5) break;
  }
  return results;
}

async function limitedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('黑话搜索响应超过 256 KiB。');
  }
  if (!response.body) throw new Error('黑话搜索返回空响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let contents = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('黑话搜索响应超过 256 KiB。');
      }
      contents += decoder.decode(value, { stream: true });
    }
    return contents + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Search clues only: the caller checks these against the source group's own messages. */
export async function searchSlang(term: string, signal?: AbortSignal): Promise<SlangSearchResult[]> {
  const query = searchTerm(term);
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('黑话搜索超时（8 秒）。')), TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', `${query} 梗 含义 用法`);
  url.searchParams.set('format', 'rss');
  try {
    const response = await fetch(url, { redirect: 'error', signal: requestSignal, headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`黑话搜索失败（HTTP ${response.status}）。`);
    }
    return parseResults(await limitedText(response), query);
  } finally { clearTimeout(timer); }
}
