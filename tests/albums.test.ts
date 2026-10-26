import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { albumAction, registerAlbumTool, type AlbumInput } from '../src/albums.ts';
import type { ResourceContext, ResourceRequest } from '../src/resource-tools.ts';

function fixture(response: unknown | ((action: string, params: Record<string, unknown>) => unknown)) {
  const calls: Array<{ action: string; params: Record<string, unknown>; mutating: boolean }> = [];
  const request: ResourceRequest = async (action, params, mutating = false) => {
    calls.push({ action, params, mutating });
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(action, params) : response;
  };
  return { request, calls };
}

test('album and media queries retain paging and usable resource identifiers', async () => {
  const albums = fixture({ album_list: [{ album_id: 'album-1', name: '日常', upload_number: '3', ignored: 'drop' }],
    attach_info: 'next-albums', has_more: true });
  assert.deepEqual(await albumAction(albums.request, '123456', '.', { action: 'list', cursor: 'page-1' }), {
    albums: [{ albumId: 'album-1', name: '日常', mediaCount: '3' }], cursor: 'next-albums', hasMore: true,
  });
  assert.deepEqual(albums.calls, [{ action: 'get_qun_album_list', params: { group_id: 123456, attach_info: 'page-1' }, mutating: false }]);

  const image = { name: '照片', lloc: 'photo-location', defaultUrl: { url: 'https://example.com/picture.jpg' } };
  const media = fixture({ mediaList: [{ type: 0, image, batch_id: 'batch-1', ignored: 'drop' }], nextAttachInfo: 'next-media' });
  assert.deepEqual(await albumAction(media.request, '123456', '.', { action: 'media', albumId: 'album-1' }), {
    media: [{ type: 0, image, name: '照片', lloc: 'photo-location', batchId: 'batch-1', url: 'https://example.com/picture.jpg' }], cursor: 'next-media',
  });
  assert.deepEqual(media.calls[0].params, { group_id: 123456, album_id: 'album-1', attach_info: '' });
});

test('comments, media deletion and likes carry the selected group and have no retry', async () => {
  const f = fixture(null);
  await albumAction(f.request, '123456', '.', { action: 'comment', albumId: 'a', lloc: 'photo', content: '真好看' });
  await albumAction(f.request, '123456', '.', { action: 'delete_media', albumId: 'a', lloc: 'video-1' });
  await albumAction(f.request, '123456', '.', { action: 'like', albumId: 'a', batchId: 'batch', lloc: 'photo' });
  await albumAction(f.request, '123456', '.', { action: 'like', albumId: 'a', batchId: 'batch', set: false });
  assert.deepEqual(f.calls, [
    { action: 'do_group_album_comment', params: { group_id: 123456, album_id: 'a', lloc: 'photo', content: '真好看' }, mutating: true },
    { action: 'del_group_album_media', params: { group_id: 123456, album_id: 'a', lloc: 'video-1' }, mutating: true },
    { action: 'set_group_album_media_like', params: { group_id: 123456, album_id: 'a', batch_id: 'batch', lloc: 'photo' }, mutating: true },
    { action: 'cancel_group_album_media_like', params: { group_id: 123456, album_id: 'a', batch_id: 'batch' }, mutating: true },
  ]);
  const failed = fixture(new Error('Action result is unknown'));
  await assert.rejects(albumAction(failed.request, '123456', '.', { action: 'delete_media', albumId: 'a', lloc: 'photo' }), /result is unknown/);
  assert.equal(failed.calls.length, 1);
});

test('image and video uploads stage local bytes before using a backend file path', async t => {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'albums-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'photo.png'), 'picture-bytes');
  await writeFile(join(cwd, 'clip.mp4'), 'video-bytes');
  const f = fixture((action: string) => action === 'download_file' ? { file: '/remote/downloads/staged' }
    : action === 'upload_video_to_qun_album' ? { id: 'new-video' } : null);
  assert.deepEqual(await albumAction(f.request, '123456', cwd, { action: 'upload_image', albumId: 'a', albumName: '相册', path: 'photo.png' }),
    { uploaded: true, albumId: 'a', fileName: 'photo.png' });
  assert.deepEqual(await albumAction(f.request, '123456', cwd, { action: 'upload_video', albumId: 'a', albumName: '相册', path: 'clip.mp4' }),
    { uploaded: true, albumId: 'a', mediaId: 'new-video', fileName: 'clip.mp4' });
  assert.deepEqual(f.calls.map(call => call.action), ['download_file', 'upload_image_to_qun_album', 'download_file', 'upload_video_to_qun_album']);
  assert.equal(Buffer.from(String(f.calls[0].params.base64), 'base64').toString(), 'picture-bytes');
  assert.equal(Buffer.from(String(f.calls[2].params.base64), 'base64').toString(), 'video-bytes');
  assert.deepEqual(f.calls[1], { action: 'upload_image_to_qun_album', params: { group_id: 123456, album_id: 'a', album_name: '相册', file: '/remote/downloads/staged' }, mutating: true });
  assert.equal(f.calls[3].params.file, '/remote/downloads/staged');
  const missingReceipt = fixture((action: string) => action === 'download_file' ? { file: '/remote/staged' } : {});
  await assert.rejects(albumAction(missingReceipt.request, '123456', cwd,
    { action: 'upload_video', albumId: 'a', albumName: '相册', path: 'clip.mp4' }), /上传结果未知/);
  assert.equal(missingReceipt.calls.length, 2, 'an uncertain upload is not repeated');
  const missingImageReceipt = fixture((action: string) => action === 'download_file' ? { file: '/remote/staged' } : {});
  await assert.rejects(albumAction(missingImageReceipt.request, '123456', cwd,
    { action: 'upload_image', albumId: 'a', albumName: '相册', path: 'photo.png' }), /图片上传结果未知.*先核对相册状态/);
  assert.equal(missingImageReceipt.calls.length, 2, 'an image upload with an invalid receipt is not repeated');
});

test('void album mutations require the documented null receipt and never retry uncertain actions', async () => {
  const actions: AlbumInput[] = [
    { action: 'delete_media', albumId: 'a', lloc: 'photo' },
    { action: 'comment', albumId: 'a', lloc: 'photo', content: '评论' },
    { action: 'like', albumId: 'a', batchId: 'batch' },
    { action: 'like', albumId: 'a', batchId: 'batch', set: false },
  ];
  for (const input of actions) {
    for (const result of [{}, undefined, [], { success: false }]) {
      const f = fixture(result);
      await assert.rejects(albumAction(f.request, '123456', '.', input), /结果未知.*先核对相册状态/);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('uploads reject sibling files and cancellation before touching QQ', async t => {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'albums-scope-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'own'); await mkdir(cwd); await writeFile(join(root, 'private.png'), 'private');
  const f = fixture(null);
  await assert.rejects(albumAction(f.request, '123456', cwd, { action: 'upload_image', albumId: 'a', albumName: '相册', path: '../private.png' }));
  assert.equal(f.calls.length, 0);
  await writeFile(join(cwd, 'own.png'), 'own');
  const controller = new AbortController();
  const cancelled = fixture(() => { controller.abort(new Error('cancelled by caller')); return { file: '/remote/staged' }; });
  await assert.rejects(albumAction(cancelled.request, '123456', cwd,
    { action: 'upload_image', albumId: 'a', albumName: '相册', path: 'own.png' }, controller.signal), /cancelled by caller/);
  assert.deepEqual(cancelled.calls.map(call => call.action), ['download_file']);
});

test('invalid inputs and malformed catalogs fail without guessed resource actions', async () => {
  const f = fixture(null);
  for (const input of [
    { action: 'media' }, { action: 'like', albumId: 'a' }, { action: 'comment', albumId: 'a', lloc: 'p', content: '' },
    { action: 'delete_media', albumId: 'a', lloc: '' }, { action: 'upload_image', albumId: 'a', path: 'p' },
  ] as AlbumInput[]) await assert.rejects(albumAction(f.request, '123456', '.', input));
  await assert.rejects(albumAction(f.request, '../123', '.', { action: 'list' }));
  await assert.rejects(albumAction(f.request, '123456', '.', { action: 'list', cursor: '\n' }));
  await assert.rejects(albumAction(f.request, '123456', '.', { action: 'list' }, AbortSignal.abort()));
  assert.equal(f.calls.length, 0);
  for (const response of [null, {}, { album_list: [], attach_info: '', has_more: 'true' }, { album_list: [{}], attach_info: '', has_more: false }]) {
    await assert.rejects(albumAction(fixture(response).request, '123456', '.', { action: 'list' }), /无效|须为有效/);
  }
  await assert.rejects(albumAction(fixture({ mediaList: ['bad'], nextAttachInfo: '' }).request, '123456', '.', { action: 'media', albumId: 'a' }), /无效/);
});

test('the registered album tool rejects non-group contexts before requesting resources', async () => {
  let definition: unknown;
  const pi = { registerTool(value: unknown) { definition = value; } } as ExtensionAPI;
  let requests = 0;
  registerAlbumTool(pi, () => ({ cwd: '.', conversation: { type: 'private', id: '123456' }, signal: new AbortController().signal,
    transport: { resources: async () => { requests++; } } } as unknown as ResourceContext));
  const tool = definition as { execute(id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> };
  await assert.rejects(tool.execute('x', { conversation: 'private:123456', action: 'list' }, undefined, undefined, {} as ExtensionContext), /仅支持群聊/);
  assert.equal(requests, 0);
});
