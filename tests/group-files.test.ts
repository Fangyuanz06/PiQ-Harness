import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { executeGroupFile, type GroupFileInput } from '../src/group-files.ts';
import type { ResourceRequest } from '../src/resource-tools.ts';

const conversation = { type: 'group', id: '123456' } as const;
const input = (action: GroupFileInput['action'], changes: Partial<GroupFileInput> = {}): GroupFileInput => ({ action, conversation: 'group:123456', ...changes });

async function temporary(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'group-files-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function endpoint(data: unknown = null) {
  const calls: Array<{ action: string; params: Record<string, unknown>; mutating: boolean }> = [];
  const request: ResourceRequest = async (action, params, mutating = false) => { calls.push({ action, params, mutating }); return data; };
  return { calls, request };
}

test('group files list the selected group root or a selected folder only', async t => {
  const cwd = await temporary(t);
  const f = endpoint({ files: [{ file_id: 'file-1', file_name: '资料.txt', group_id: 123456 }], folders: [{ folder_id: 'folder-1', folder_name: '资料', group_id: 123456 }] });
  const root = await executeGroupFile(cwd, conversation, f.request, input('list'));
  assert.equal((root.files as unknown[]).length, 1);
  await executeGroupFile(cwd, conversation, f.request, input('list', { folderId: 'folder-1' }));
  assert.deepEqual(f.calls, [
    { action: 'get_group_root_files', params: { group_id: 123456 }, mutating: false },
    { action: 'get_group_files_by_folder', params: { group_id: 123456, folder_id: 'folder-1' }, mutating: false },
  ]);
  await assert.rejects(executeGroupFile(cwd, conversation, endpoint({ files: [{ file_id: 'foreign', file_name: 'x', group_id: 999999 }], folders: [] }).request, input('list')), /其他群/);
  await assert.rejects(executeGroupFile(cwd, conversation, endpoint({ files: [], folders: 'bad' }).request, input('list')), /无效/);
});

test('directory changes use explicit QQ identifiers and documented action parameters', async t => {
  const cwd = await temporary(t);
  const f = endpoint();
  await executeGroupFile(cwd, conversation, f.request, input('mkdir', { name: '资料', parentId: 'parent-1' }));
  await executeGroupFile(cwd, conversation, f.request, input('move', { fileId: 'file-1', parentId: '/', targetFolderId: 'folder-1' }));
  await executeGroupFile(cwd, conversation, f.request, input('rename_file', { fileId: 'file-1', name: '新资料.txt' }));
  await executeGroupFile(cwd, conversation, f.request, input('rename_folder', { folderId: 'folder-1', name: '新目录' }));
  await executeGroupFile(cwd, conversation, f.request, input('delete_file', { fileId: 'file-1' }));
  await executeGroupFile(cwd, conversation, f.request, input('delete_folder', { folderId: 'folder-1' }));
  assert.deepEqual(f.calls, [
    { action: 'create_group_file_folder', params: { group_id: 123456, name: '资料', parent_id: 'parent-1' }, mutating: true },
    { action: 'move_group_file', params: { group_id: 123456, file_id: 'file-1', parent_directory: '/', target_directory: 'folder-1' }, mutating: true },
    { action: 'rename_group_file', params: { group_id: 123456, file_id: 'file-1', current_parent_directory: '/', new_name: '新资料.txt' }, mutating: true },
    { action: 'rename_group_file_folder', params: { group_id: 123456, folder_id: 'folder-1', new_folder_name: '新目录' }, mutating: true },
    { action: 'delete_group_file', params: { group_id: 123456, file_id: 'file-1' }, mutating: true },
    { action: 'delete_group_file_folder', params: { group_id: 123456, folder_id: 'folder-1' }, mutating: true },
  ]);
});

test('uploads stage local bytes before sending a backend file path once', async t => {
  const cwd = await temporary(t);
  await mkdir(join(cwd, 'assets'));
  await writeFile(join(cwd, 'assets', '资料.txt'), '本组资料');
  const calls: Array<{ action: string; params: Record<string, unknown>; mutating?: boolean }> = [];
  const request: ResourceRequest = async (action, params, mutating) => {
    calls.push({ action, params, mutating });
    return action === 'download_file' ? { file: '/backend/data/downloads/staged.txt' } : { file_id: 'uploaded-file' };
  };
  const result = await executeGroupFile(cwd, conversation, request, input('upload', { path: 'assets/资料.txt', name: '分享.txt', folderId: 'folder-1' }));
  assert.equal(result.fileId, 'uploaded-file');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'download_file');
  assert.equal(Buffer.from(String(calls[0].params.base64), 'base64').toString(), '本组资料');
  assert.deepEqual(calls[1], { action: 'upload_group_file', params: { group_id: 123456, file: '/backend/data/downloads/staged.txt', name: '分享.txt', folder_id: 'folder-1' }, mutating: true });
  let uploads = 0;
  const failing: ResourceRequest = async action => { if (action === 'upload_group_file') uploads++; throw new Error('staging failed'); };
  await assert.rejects(executeGroupFile(cwd, conversation, failing, input('upload', { path: 'assets/资料.txt' })), /暂存失败|结果未知/);
  assert.equal(uploads, 0);
  const noReceipt: ResourceRequest = async action => action === 'download_file' ? { file: '/backend/staged' } : null;
  await assert.rejects(executeGroupFile(cwd, conversation, noReceipt, input('upload', { path: 'assets/资料.txt' })), /上传结果未知/);
});

test('downloads the selected group file into its own workspace without returning the signed URL', async t => {
  const cwd = await temporary(t);
  const server = createServer((_request, response) => { response.end('QQ file bytes'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const remote = `http://127.0.0.1:${address.port}/file?signature=private-fixture`;
  const f = endpoint({ url: remote });
  const result = await executeGroupFile(cwd, conversation, f.request, input('download', { fileId: 'file-1', path: 'assets/downloads/资料.txt', busid: 102 }));
  assert.equal(await readFile(join(cwd, 'assets/downloads/资料.txt'), 'utf8'), 'QQ file bytes');
  assert.equal(result.bytes, Buffer.byteLength('QQ file bytes'));
  assert.doesNotMatch(JSON.stringify(result), /signature|private-fixture/);
  assert.deepEqual(f.calls, [{ action: 'get_group_file_url', params: { group_id: 123456, file_id: 'file-1', busid: 102 }, mutating: false }]);
});

test('bad scope, missing identifiers and cancelled actions cannot mutate group files', async t => {
  const cwd = await temporary(t);
  const f = endpoint();
  await assert.rejects(executeGroupFile(cwd, { type: 'private', id: '123456' }, f.request, input('delete_file', { fileId: 'x' })), /群聊/);
  await assert.rejects(executeGroupFile(cwd, conversation, f.request, input('delete_file', { conversation: 'group:999999', fileId: 'x' })), /群聊/);
  for (const bad of [input('delete_file'), input('delete_folder', { folderId: '/' }), input('rename_folder', { folderId: 'folder-1', name: '../escape' }), input('move', { fileId: 'file-1' })]) {
    await assert.rejects(executeGroupFile(cwd, conversation, f.request, bad));
  }
  await assert.rejects(executeGroupFile(cwd, conversation, f.request, input('mkdir', { name: 'new' }), AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.equal(f.calls.length, 0);
});

test('resource failures stay visible and are not automatically retried', async t => {
  const cwd = await temporary(t);
  let calls = 0;
  const request: ResourceRequest = async () => { calls++; throw new Error('Action result is unknown'); };
  await assert.rejects(executeGroupFile(cwd, conversation, request, input('delete_file', { fileId: 'file-1' })), /result is unknown/);
  assert.equal(calls, 1);
  await assert.rejects(executeGroupFile(cwd, conversation, endpoint({ result: { retCode: 99 } }).request, input('mkdir', { name: 'new' })), /未完成/);
});
