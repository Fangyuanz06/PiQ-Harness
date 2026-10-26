import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Conversation } from '../src/conversations.ts';
import type { ResourceContext } from '../src/resource-tools.ts';
import { readMessageMedia, registerMessageMediaTool } from '../src/message-media.ts';

const conversation: Conversation = { type: 'group', id: '123456' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=', 'base64');
const CDN = 'https://multimedia.nt.qq.com.cn/image?rkey=PRIVATE_SIGNATURE';
function record(url = CDN, changes: Record<string, unknown> = {}) {
  return { v: 2, seq: 1, receivedAt: 1793000000000, messageId: '-123', conversation,
    userId: '88888', selfId: '99999', sender: 'Member', time: 1793000000,
    rawText: '[图片]', segments: [{ type: 'image', data: { url, file: 'ignored.png' } }], outgoing: false, ...changes };
}
async function removeLink(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'EPERM' && code !== 'EISDIR') throw error;
    try { await rmdir(path); }
    catch (fallback) { if ((fallback as NodeJS.ErrnoException).code !== 'ENOENT') throw fallback; }
  }
}
async function fixture(t: TestContext, rows = [record()]) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'message-media-'));
  const cwd = join(root, 'group');
  const directory = join(cwd, 'messages', 'group', conversation.id);
  await mkdir(directory, { recursive: true });
  const journal = join(directory, '2026-10-26.jsonl');
  await writeFile(journal, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const links: string[] = [];
  t.after(async () => {
    for (const link of links) await removeLink(link);
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, journal, directory, links };
}
async function noPartial(cwd: string) {
  assert.deepEqual(await readdir(join(cwd, 'assets', 'incoming')).catch(() => []), []);
}

test('media tool returns a real logged PNG directly to vision and saves a new local file', async t => {
  const { cwd } = await fixture(t);
  const calls = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), CDN);
    assert.equal(options?.redirect, 'manual');
    return new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } });
  });
  let registered: unknown;
  const pi = { registerTool(definition: unknown) { registered = definition; } } as unknown as ExtensionAPI;
  registerMessageMediaTool(pi, (_ctx, key, signal) => {
    assert.equal(key, 'group:123456');
    return { cwd, conversation, signal: signal ?? new AbortController().signal, transport: {} as ResourceContext['transport'] };
  });
  const tool = registered as { name: string; execute(id: string, params: { conversation: string; messageId: number }, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ type: string; data?: string; mimeType?: string }>; details: { path: string; bytes: number; messageId: number; index: number } }> };
  assert.equal(tool.name, 'qq_read_media');
  const result = await tool.execute('test', { conversation: 'group:123456', messageId: -123 }, undefined, undefined, {} as ExtensionContext);
  assert.equal(result.content[1]!.type, 'image');
  assert.equal(result.content[1]!.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(result.content[1]!.data!, 'base64'), PNG);
  assert.match(result.details.path, /^assets\/incoming\/[0-9a-f-]+\.png$/);
  assert.equal(result.details.bytes, PNG.length);
  assert.equal(result.details.messageId, -123);
  assert.equal(result.details.index, 0);
  assert.deepEqual(await readFile(join(cwd, result.details.path)), PNG);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SIGNATURE/);
  assert.equal(calls.mock.callCount(), 1);
});

test('missing messages, wrong conversations, bad indices and path jumps make no network request', async t => {
  const { cwd } = await fixture(t);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
  await assert.rejects(readMessageMedia(cwd, conversation, -999), /找不到/);
  await assert.rejects(readMessageMedia(cwd, { type: 'private', id: conversation.id }, -123), /没有/);
  await assert.rejects(readMessageMedia(cwd, conversation, -123, 1), /没有/);
  await assert.rejects(readMessageMedia(cwd, conversation, -123, 10), /index/);
  await assert.rejects(readMessageMedia(cwd, { type: 'group', id: '../escape' }, -123));
  assert.equal(calls.mock.callCount(), 0); await noPartial(cwd);
});

test('a journal cannot substitute a message from another conversation or an incomplete record', async t => {
  const f = await fixture(t, [record(CDN, { conversation: { type: 'group', id: '987654' } })]);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123), /其他对话/);
  await writeFile(f.journal, JSON.stringify(record()));
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123), /找不到/);
  assert.equal(calls.mock.callCount(), 0);
});

test('untrusted hosts, credentials and redirects are rejected without leaking the signed URL', async t => {
  const f = await fixture(t);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/PRIVATE_SIGNATURE' } }));
  for (const url of ['http://127.0.0.1/a', 'http://localhost/a', 'https://evil.test/a', 'https://qpic.cn.evil.test/a', 'https://user:password@qpic.cn/a', 'file:///secret']) {
    await writeFile(f.journal, JSON.stringify(record(url)) + '\n');
    await assert.rejects(readMessageMedia(f.cwd, conversation, -123), /QQ 图片/);
  }
  assert.equal(calls.mock.callCount(), 0);
  await writeFile(f.journal, JSON.stringify(record()) + '\n');
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123), error => error instanceof Error && /QQ 图片/.test(error.message) && !error.message.includes('PRIVATE_SIGNATURE'));
  assert.equal(calls.mock.callCount(), 1); await noPartial(f.cwd);
});

test('trusted redirects and image indices use only the selected recorded image', async t => {
  const second = 'https://c2cpicdw.qpic.cn/second';
  const f = await fixture(t, [record(CDN, { segments: [{ type: 'image', data: { url: 'https://evil.test/not-selected' } }, { type: 'image', data: { file: second } }] })]);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests++;
    if (requests === 1) { assert.equal(String(url), second); return new Response(null, { status: 302, headers: { location: 'https://img.gtimg.cn/final' } }); }
    assert.equal(String(url), 'https://img.gtimg.cn/final'); return new Response(PNG);
  });
  const result = await readMessageMedia(f.cwd, conversation, -123, 1);
  assert.equal(result.index, 1); assert.equal(requests, 2);
});

test('oversized declared and streamed bodies, bad image magic and network errors leave no partial file', async t => {
  const { cwd } = await fixture(t);
  const responses = [new Response(PNG, { headers: { 'content-length': String(11 * 1024 * 1024) } }),
    new Response(new Uint8Array(10 * 1024 * 1024 + 1)), new Response('<html>not an image</html>')];
  t.mock.method(globalThis, 'fetch', async () => {
    if (responses.length) return responses.shift()!;
    throw new Error('Network failed at ' + CDN);
  });
  await assert.rejects(readMessageMedia(cwd, conversation, -123), /10 MiB/);
  await assert.rejects(readMessageMedia(cwd, conversation, -123), /10 MiB/);
  await assert.rejects(readMessageMedia(cwd, conversation, -123), /不是支持/);
  await assert.rejects(readMessageMedia(cwd, conversation, -123), error => error instanceof Error && /读取失败/.test(error.message) && !error.message.includes('PRIVATE_SIGNATURE'));
  await noPartial(cwd);
});

test('cancellation before or during streaming prevents local output', async t => {
  const { cwd } = await fixture(t);
  const before = new AbortController(); before.abort();
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
  await assert.rejects(readMessageMedia(cwd, conversation, -123, 0, before.signal), /取消/);
  assert.equal(calls.mock.callCount(), 0);
  const active = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(PNG); queueMicrotask(() => active.abort()); },
  })));
  await assert.rejects(readMessageMedia(cwd, conversation, -123, 0, active.signal), /取消/);
  await noPartial(cwd);
});

test('symlinked journal and incoming directories cannot escape the workspace', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  const calls = t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
  await mkdir(join(f.cwd, 'assets'));
  try { await symlink(outside, join(f.cwd, 'assets', 'incoming'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('This environment cannot create symlinks or junctions.'); return; }
    throw error;
  }
  f.links.push(join(f.cwd, 'assets', 'incoming'));
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123), /普通文件或目录/);
  assert.deepEqual(await readdir(outside), []);
  await removeLink(join(f.cwd, 'assets', 'incoming'));
  await rm(f.directory, { recursive: true });
  await writeFile(join(outside, '2026-10-26.jsonl'), JSON.stringify(record()) + '\n');
  await symlink(outside, f.directory, 'junction');
  f.links.push(f.directory);
  const before = calls.mock.callCount();
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123), /普通文件或目录/);
  assert.equal(calls.mock.callCount(), before);
});

test('poke records coexist with image journals and private or temporary media stay scoped', async t => {
  const f = await fixture(t);
  const poke = { v: 2, seq: 2, receivedAt: 1793000001000, kind: 'poke', source: 'notice',
    eventId: '12345678-1234-4123-8123-123456789abc', conversation, userId: '88888', selfId: '99999',
    targetId: '99999', time: 1793000001, sender: 'Member', rawText: '戳了戳', segments: [], outgoing: false };
  await writeFile(f.journal, JSON.stringify(record()) + '\n' + JSON.stringify(poke) + '\n');
  t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
  assert.equal((await readMessageMedia(f.cwd, conversation, -123)).bytes, PNG.length);
  for (const target of [{ type: 'private', id: '55555' }, { type: 'temporary', sourceGroupId: '123456', id: '55555' }] as Conversation[]) {
    const directory = target.type === 'temporary' ? join(f.cwd, 'messages', 'temporary', target.sourceGroupId!, target.id)
      : join(f.cwd, 'messages', target.type, target.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '2026-10-26.jsonl'), JSON.stringify(record(CDN, { conversation: target })) + '\n');
    assert.equal((await readMessageMedia(f.cwd, target, -123)).bytes, PNG.length);
  }
});

test('expired signed images refresh the exact logged file once before downloading the replacement', async t => {
  const { cwd } = await fixture(t, [record(CDN, { segments: [{ type: 'image', data: { url: CDN, file: 'ABC123.jpg' } }] })]);
  const replacement = 'https://multimedia.nt.qq.com.cn/image?rkey=NEW_PRIVATE_SIGNATURE';
  let requests = 0, refreshed = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests++;
    if (requests === 1) { assert.equal(String(url), CDN); return new Response('{"retmsg":"download url has expired"}', { status: 400 }); }
    assert.equal(String(url), replacement); return new Response(PNG);
  });
  const result = await readMessageMedia(cwd, conversation, -123, 0, undefined, async (file, signal) => {
    refreshed++; assert.equal(file, 'ABC123.jpg'); assert.equal(signal.aborted, false);
    return { file, url: replacement, file_size: PNG.length };
  });
  assert.equal(refreshed, 1); assert.equal(requests, 2); assert.equal(result.bytes, PNG.length);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SIGNATURE/);
});

test('expired links remain explicit without refresh and repeated expiry gets only one refresh', async t => {
  const { cwd } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(readMessageMedia(cwd, conversation, -123), /过期|访问被拒/);
  let refreshed = 0;
  await assert.rejects(readMessageMedia(cwd, conversation, -123, 0, undefined, async () => {
    refreshed++; return { url: 'https://qpic.cn/still-expired' };
  }), /HTTP 403/);
  assert.equal(refreshed, 1); await noPartial(cwd);
});

test('refresh rejects unsafe source IDs and replacement hosts; unrelated HTTP failures do not refresh', async t => {
  const f = await fixture(t);
  let refreshed = 0;
  let status = 400;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
  const refresh = async () => { refreshed++; return { url: 'https://evil.test/PRIVATE_SIGNATURE' }; };
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123, 0, undefined, refresh), /QQ 图片/);
  assert.equal(refreshed, 1);
  for (const file of ['../outside.jpg', '/absolute.png', 'C:\\private.jpg', 'https://qpic.cn/path', 'bad..png']) {
    await writeFile(f.journal, JSON.stringify(record(CDN, { segments: [{ type: 'image', data: { url: CDN, file } }] })) + '\n');
    await assert.rejects(readMessageMedia(f.cwd, conversation, -123, 0, undefined, refresh), /安全刷新/);
  }
  assert.equal(refreshed, 1, 'only an ordinary file ID from the verified journal may be refreshed');
  await writeFile(f.journal, JSON.stringify(record()) + '\n');
  status = 500;
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123, 0, undefined, refresh), /HTTP 500/);
  assert.equal(refreshed, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readMessageMedia(f.cwd, conversation, -123, 0, abort.signal, refresh), /取消/);
  assert.equal(refreshed, 1); await noPartial(f.cwd);
});
