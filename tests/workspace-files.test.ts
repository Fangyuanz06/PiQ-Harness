import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { saveWorkspaceDownload, stageWorkspaceFile, workspaceFile } from '../src/workspace-files.ts';
import type { ResourceRequest } from '../src/resource-tools.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'workspace-files-'));
  const cwd = join(root, 'one'); const sibling = join(root, 'two');
  await mkdir(join(cwd, 'assets'), { recursive: true }); await mkdir(sibling);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, sibling };
}

async function endpoint(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('workspace files resolve within their group and reject directories, siblings and invalid paths', async t => {
  const { cwd, sibling } = await fixture(t);
  await writeFile(join(cwd, 'assets', 'file.txt'), 'fixture');
  await writeFile(join(sibling, 'secret.txt'), 'private fixture');
  assert.equal(await workspaceFile(cwd, 'assets/file.txt'), await realpath(join(cwd, 'assets', 'file.txt')));
  await assert.rejects(workspaceFile(cwd, '../two/secret.txt'), /当前对话组目录/);
  await assert.rejects(workspaceFile(cwd, join(sibling, 'secret.txt')), /当前对话组目录/);
  await assert.rejects(workspaceFile(cwd, 'assets'), /普通文件/);
  await assert.rejects(workspaceFile(cwd, 'assets/file.txt:hidden'), /当前对话组目录/);
  await assert.rejects(workspaceFile(cwd, 'assets/invalid\nname'), /有效路径/);
});

test('downloads stream into a new group file, follow safe redirects and refuse overwrites', async t => {
  const { cwd } = await fixture(t);
  let requests = 0;
  const url = await endpoint(t, (request, response) => {
    requests++;
    if (request.url === '/redirect') { response.writeHead(302, { location: '/bytes' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.write('first'); response.end('second');
  });
  const saved = await saveWorkspaceDownload(cwd, 'assets/downloads/file.bin', `${url}/redirect`);
  assert.equal(saved.path, join(await realpath(cwd), 'assets', 'downloads', 'file.bin'));
  assert.equal(saved.bytes, 11); assert.equal(await readFile(saved.path, 'utf8'), 'firstsecond');
  assert.equal(requests, 2);
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/downloads/file.bin', `${url}/bytes`), /已存在/);
  assert.equal(requests, 2, 'an existing file is rejected before any network request');
  assert.equal(await readFile(saved.path, 'utf8'), 'firstsecond');
});

test('downloads reject unsafe URLs and paths without exposing credentials', async t => {
  const { cwd, sibling } = await fixture(t);
  const url = await endpoint(t, (_request, response) => { response.writeHead(302, { location: 'file:///secret' }); response.end(); });
  await assert.rejects(saveWorkspaceDownload(cwd, '../two/file.bin', url), /当前对话组目录/);
  for (const source of ['file:///secret', 'https://private-user:private-password@example.com/asset?secret-token']) {
    await assert.rejects(saveWorkspaceDownload(cwd, 'assets/file.bin', source), error => {
      assert.match(String(error), /HTTP/); assert.doesNotMatch(String(error), /private-user|private-password|secret-token/); return true;
    });
  }
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/file.bin', url), /重定向到了不支持/);
  await assert.rejects(readFile(join(cwd, 'assets', 'file.bin')), /ENOENT/);
  await assert.rejects(readFile(join(sibling, 'file.bin')), /ENOENT/);
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/file.bin', url, undefined, 0), /正整数/);
});

test('size limits cover declared and streamed bytes and remove partial files', async t => {
  const { cwd } = await fixture(t);
  const url = await endpoint(t, (request, response) => {
    if (request.url === '/declared') response.writeHead(200, { 'content-length': '12' });
    else response.writeHead(200);
    response.write('123456'); response.end('789012');
  });
  for (const suffix of ['declared', 'streamed']) {
    await assert.rejects(saveWorkspaceDownload(cwd, `assets/${suffix}.bin`, `${url}/${suffix}`, undefined, 8), /超过大小上限/);
    await assert.rejects(readFile(join(cwd, 'assets', `${suffix}.bin`)), /ENOENT/);
  }
});

test('cancelled downloads and failed HTTP requests leave no partial file or signed URL in errors', async t => {
  const { cwd } = await fixture(t);
  const abort = new AbortController();
  const url = await endpoint(t, (request, response) => {
    if (request.url?.startsWith('/failed')) { response.writeHead(503); response.end('unavailable'); return; }
    response.writeHead(200); response.write('partial');
    const timer = setTimeout(() => response.end('rest'), 1000);
    response.once('close', () => clearTimeout(timer));
    setTimeout(() => abort.abort(), 20);
  });
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/cancelled.bin', `${url}/slow?private-token`, abort.signal), error => {
    assert.match(String(error), /取消/); assert.doesNotMatch(String(error), /private-token/); return true;
  });
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/failed.bin', `${url}/failed?private-token`), error => {
    assert.match(String(error), /HTTP 503/); assert.doesNotMatch(String(error), /private-token/); return true;
  });
  for (const name of ['cancelled.bin', 'failed.bin']) await assert.rejects(readFile(join(cwd, 'assets', name)), /ENOENT/);
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/not-started.bin', url, AbortSignal.abort()));
  await assert.rejects(readFile(join(cwd, 'assets', 'not-started.bin')), /ENOENT/);
});

test('links cannot escape uploads or redirect a download into another group', async t => {
  const { cwd, sibling } = await fixture(t);
  await writeFile(join(sibling, 'secret.bin'), 'private fixture');
  try { await symlink(sibling, join(cwd, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('The current OS sandbox does not permit symlink creation.'); return; }
    throw error;
  }
  await assert.rejects(workspaceFile(cwd, 'assets/linked/secret.bin'), /当前对话组目录/);
  let requested = false;
  const url = await endpoint(t, (_request, response) => { requested = true; response.end('fixture'); });
  await assert.rejects(saveWorkspaceDownload(cwd, 'assets/linked/download.bin', url), /普通目录/);
  assert.equal(requested, false);
  await assert.rejects(readFile(join(sibling, 'download.bin')), /ENOENT/);
});

test('backend staging sends local bytes with the documented action and validates its receipt', async t => {
  const { cwd, sibling } = await fixture(t);
  await writeFile(join(cwd, 'assets', 'upload.bin'), 'upload bytes');
  await writeFile(join(sibling, 'secret.bin'), 'private fixture');
  const calls: unknown[] = [];
  const request: ResourceRequest = async (...args) => { calls.push(args); return { file: '/backend/fixture-upload.bin' }; };
  assert.deepEqual(await stageWorkspaceFile(request, cwd, 'assets/upload.bin'), { file: '/backend/fixture-upload.bin', name: 'upload.bin', bytes: 12 });
  const [action, params, mutating] = calls[0] as [string, Record<string, unknown>, boolean];
  assert.equal(action, 'download_file'); assert.equal(mutating, true);
  assert.equal(params.base64, Buffer.from('upload bytes').toString('base64'));
  assert.match(String(params.name), /^piq-[0-9a-f-]{36}\.bin$/);
  await stageWorkspaceFile(request, cwd, 'assets/upload.bin');
  assert.notEqual((calls[1] as [string, Record<string, unknown>])[1].name, params.name, 'backend staging names do not collide across calls or conversation groups');
  await assert.rejects(stageWorkspaceFile(request, cwd, '../two/secret.bin'), /当前对话组目录/);
  await assert.rejects(stageWorkspaceFile(request, cwd, 'assets/upload.bin', undefined, 2), /超过大小上限/);
  await assert.rejects(stageWorkspaceFile(request, cwd, 'assets/upload.bin', AbortSignal.abort()));
  assert.equal(calls.length, 2);
  await assert.rejects(stageWorkspaceFile(async () => ({ file: '' }), cwd, 'assets/upload.bin'), /有效的暂存文件/);
  await assert.rejects(stageWorkspaceFile(async () => { throw new Error('https://backend.invalid/private-token'); }, cwd, 'assets/upload.bin'), error => {
    assert.match(String(error), /暂存失败或结果未知/); assert.doesNotMatch(String(error), /backend.invalid|private-token/); return true;
  });
});
