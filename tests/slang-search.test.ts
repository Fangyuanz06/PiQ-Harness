import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSlang } from '../src/slang-search.ts';

const rss = (items = '') => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const item = (title: string, url: string, description = '') => `<item><title>${title}</title><link>${url}</link><description>${description}</description></item>`;

test('slang search sends only the normalized term to a fixed endpoint and returns bounded clues', async t => {
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(input.origin + input.pathname, 'https://www.bing.com/search');
    assert.deepEqual([...input.searchParams], [['q', 'yyds 梗 含义 用法'], ['format', 'rss']]);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers!), ['Accept']);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(rss(Array.from({ length: 9 }, (_, i) => item(`yyds词条${i}`, `https://example.com/${i}`, '用法')).join('')));
  });
  const results = await searchSlang(' ｙｙｄｓ ');
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { title: 'yyds词条0', url: 'https://example.com/0', snippet: '用法' });
});

test('RSS clues decode CDATA and entities, strip markup, and omit invalid and duplicate links', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(rss([
    item('<![CDATA[<b>梗</b> &amp; 用法]]>', 'https://example.com/?a=1&amp;b=2', '&lt;p&gt;使用&#x573A;景&#33;&lt;/p&gt;'),
    item('重复', 'https://example.com/?a=1&amp;b=2'), item('本地', 'file:///secret'),
    item('执行', 'javascript:alert(1)'), item('凭据', 'https://name:pass@example.com/'),
    item('坏地址', 'not a URL'), item('', 'https://example.org/'),
  ].join(''))));
  assert.deepEqual(await searchSlang('梗'), [{ title: '梗 & 用法', url: 'https://example.com/?a=1&b=2', snippet: '使用场景!' }]);
});

test('invalid terms fail before network access', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  for (const term of ['', ' '.repeat(4), '梗'.repeat(51), '梗\n', '\0梗', '[CQ:reply,id=1]', 'https://example.com', 'www.example.com']) {
    await assert.rejects(searchSlang(term), /搜索词/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('search fails clearly for HTTP errors, malformed RSS and incomplete items', async t => {
  const fetch = t.mock.method(globalThis, 'fetch');
  fetch.mock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(searchSlang('梗'), /HTTP 503/);
  for (const bad of ['<html>blocked</html>', '<rss><channel>', rss('<item><title>梗</title>'), '<!DOCTYPE rss [<!ENTITY x "a">]>' + rss()]) {
    fetch.mock.mockImplementation(async () => new Response(bad));
    await assert.rejects(searchSlang('梗'), /RSS/);
  }
  fetch.mock.mockImplementation(async () => new Response(rss()));
  assert.deepEqual(await searchSlang('梗'), []);
});

test('search limits both declared and streamed response sizes and cancels excess streams', async t => {
  const fetch = t.mock.method(globalThis, 'fetch');
  let cancelled = 0;
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(256 * 1024 + 1) } }));
  await assert.rejects(searchSlang('梗'), /256 KiB/);
  assert.equal(cancelled, 1);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(200 * 1024)); controller.enqueue(new Uint8Array(70 * 1024)); },
    cancel() { cancelled++; },
  })));
  await assert.rejects(searchSlang('梗'), /256 KiB/);
  assert.equal(cancelled, 2);
});

test('caller cancellation and an eight second deadline abort the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = t.mock.method(globalThis, 'fetch', async (_input: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const cancelled = new AbortController();
  const first = searchSlang('梗', cancelled.signal);
  const firstResult = assert.rejects(first, /caller cancelled/);
  cancelled.abort(new Error('caller cancelled'));
  await firstResult;
  const second = searchSlang('梗');
  const secondResult = assert.rejects(second, /8 秒/);
  t.mock.timers.tick(8_000);
  await secondResult;
  const preAborted = AbortSignal.abort(new Error('already cancelled'));
  await assert.rejects(searchSlang('梗', preAborted), /already cancelled/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('search omits unrelated RSS results and keeps clues mentioning the normalized term', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(rss([
    item('上海电力大学图书馆', 'https://example.com/library', '开放时间'),
    item('Windows Bluetooth', 'https://example.com/bluetooth', 'Fix connection problems'),
  ].join(''))));
  assert.deepEqual(await searchSlang('绷不住了'), []);
  fetch.mock.mockImplementation(async () => new Response(rss([
    ...Array.from({ length: 6 }, (_, i) => item(`Unrelated ${i}`, `https://example.com/unrelated/${i}`)),
    item('网络流行语解释', 'https://example.com/relevant', 'ＹＹＤＳ 是拼音缩写'),
    item('yYdS 用法', 'https://example.com/title-match', '使用场景'),
  ].join(''))));
  assert.deepEqual((await searchSlang('yyds')).map(result => result.url), ['https://example.com/relevant', 'https://example.com/title-match']);
});