import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { manageSticker, type StickerManagementInput } from '../src/sticker-management.ts';
import type { ResourceRequest } from '../src/resource-tools.ts';
import { OneBotApiError } from '../src/onebot-client.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'stickers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'first');
  await mkdir(join(cwd, 'assets'), { recursive: true });
  await writeFile(join(cwd, 'assets', '晚安.png'), 'sticker-bytes');
  const calls: Array<{ action: string; params: Record<string, unknown>; mutating: boolean }> = [];
  const responses = new Map<string, unknown>([
    ['download_file', { file: '/server/data/downloads/sticker.png' }],
    ['add_custom_face', { emoji_id: 'emoji-1' }],
    ['delete_custom_face', null], ['modify_custom_face', null], ['move_custom_face_to_front', null],
  ]);
  const request: ResourceRequest = async (action, params, mutating = false) => {
    calls.push({ action, params, mutating });
    const result = responses.get(action);
    if (result instanceof Error) throw result;
    return result;
  };
  return { cwd, root, calls, responses, request };
}

test('favorite addition stages workspace bytes before using the backend file path', async t => {
  const f = await fixture(t);
  assert.deepEqual(await manageSticker(f.request, f.cwd, { action: 'add', path: 'assets/晚安.png' }), {
    action: 'add', scope: 'account', emojiId: 'emoji-1',
  });
  const stagedName = f.calls[0]?.params.name;
  assert.equal(typeof stagedName, 'string');
  assert.match(stagedName as string, /^piq-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i);
  assert.deepEqual(f.calls, [
    { action: 'download_file', params: { base64: Buffer.from('sticker-bytes').toString('base64'), name: stagedName }, mutating: true },
    { action: 'add_custom_face', params: { file: '/server/data/downloads/sticker.png' }, mutating: true },
  ]);
});

test('favorite removal, rename and promotion use their precise mutation actions', async t => {
  const f = await fixture(t);
  assert.deepEqual(await manageSticker(f.request, f.cwd, { action: 'remove', emojiId: 'emoji-1' }), { action: 'remove', scope: 'account', emojiId: 'emoji-1' });
  assert.deepEqual(await manageSticker(f.request, f.cwd, { action: 'rename', emojiId: 'emoji-2', name: '晚安' }), { action: 'rename', scope: 'account', emojiId: 'emoji-2', name: '晚安' });
  await manageSticker(f.request, f.cwd, { action: 'rename', emojiId: 'emoji-2', name: '' });
  await manageSticker(f.request, f.cwd, { action: 'promote', emojiId: 'emoji-3' });
  assert.deepEqual(f.calls, [
    { action: 'delete_custom_face', params: { emoji_id: 'emoji-1' }, mutating: true },
    { action: 'modify_custom_face', params: { emoji_id: 'emoji-2', desc: '晚安' }, mutating: true },
    { action: 'modify_custom_face', params: { emoji_id: 'emoji-2', desc: '' }, mutating: true },
    { action: 'move_custom_face_to_front', params: { emoji_id: 'emoji-3' }, mutating: true },
  ]);
});

test('invalid favorite inputs and sibling files fail before dispatch', async t => {
  const f = await fixture(t);
  const sibling = join(f.root, 'second.png'); await writeFile(sibling, 'private-image');
  const invalid = [
    { action: 'unknown' }, { action: 'add' }, { action: 'add', path: '' },
    { action: 'add', path: sibling }, { action: 'add', path: '../second.png' },
    { action: 'add', path: 'assets/晚安.png', name: 'ignored' },
    { action: 'remove', emojiId: '' }, { action: 'promote', emojiId: 'bad\nidentifier' },
    { action: 'rename', emojiId: 'emoji-1' }, { action: 'rename', emojiId: 'emoji-1', name: 'bad\nname' },
  ];
  for (const input of invalid) await assert.rejects(manageSticker(f.request, f.cwd, input as StickerManagementInput));
  assert.deepEqual(f.calls, []);
});

test('cancellation before or after staging prevents the QQ favorite mutation', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const request: ResourceRequest = async (action, params, mutating) => {
    const result = await f.request(action, params, mutating);
    controller.abort(new Error('paused'));
    return result;
  };
  await assert.rejects(manageSticker(request, f.cwd, { action: 'add', path: 'assets/晚安.png' }, controller.signal), /paused/);
  assert.deepEqual(f.calls.map(call => call.action), ['download_file']);
  await assert.rejects(manageSticker(f.request, f.cwd, { action: 'remove', emojiId: 'emoji-1' }, controller.signal), /paused/);
  assert.equal(f.calls.length, 1);
});

test('favorite API failures and unknown receipts are never retried', async t => {
  const f = await fixture(t);
  const rejected = new OneBotApiError('delete_custom_face', 1400);
  f.responses.set('delete_custom_face', rejected);
  await assert.rejects(manageSticker(f.request, f.cwd, { action: 'remove', emojiId: 'emoji-1' }), error => error === rejected);
  assert.equal(f.calls.length, 1);
  f.responses.set('modify_custom_face', {});
  await assert.rejects(manageSticker(f.request, f.cwd, { action: 'rename', emojiId: 'emoji-1', name: '新备注' }), /结果未知/);
  assert.equal(f.calls.length, 2);
  f.responses.set('add_custom_face', {});
  await assert.rejects(manageSticker(f.request, f.cwd, { action: 'add', path: 'assets/晚安.png' }), /添加收藏表情结果未知/);
  assert.deepEqual(f.calls.slice(2).map(call => call.action), ['download_file', 'add_custom_face']);
});
