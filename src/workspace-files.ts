import { lstat, mkdir, open, readFile, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OneBotApiError } from './onebot-client.ts';
import type { ResourceRequest } from './resource-tools.ts';

class WorkspaceFileError extends Error {}

function inside(root: string, file: string): boolean {
  const part = relative(root, file);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function localPath(root: string, value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkspaceFileError('文件路径必须是本对话组内的有效路径。');
  }
  const target = resolve(root, value);
  if (!inside(root, target) || relative(root, target).split(/[\\/]/).some(part => part.includes(':'))) {
    throw new WorkspaceFileError('文件必须位于当前对话组目录内。');
  }
  return target;
}

function byteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceFileError('文件大小上限必须是正整数。');
  return value;
}

/** Local resources stay in the current group even when an input follows a link. */
export async function workspaceFile(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const target = await realpath(localPath(root, path));
  if (!inside(root, target) || !(await stat(target)).isFile()) {
    throw new WorkspaceFileError('文件必须是当前对话组目录内的普通文件。');
  }
  return target;
}

function downloadUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WorkspaceFileError('下载链接无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new WorkspaceFileError('下载链接必须是没有账号密码的 HTTP 或 HTTPS 地址。');
  }
  return url;
}

async function downloadResponse(url: string, signal: AbortSignal): Promise<Response> {
  let target = downloadUrl(url);
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    const response = await fetch(target, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirect === 5) throw new WorkspaceFileError('下载链接重定向无效或次数过多。');
    try { target = downloadUrl(new URL(location, target)); }
    catch { throw new WorkspaceFileError('下载链接重定向到了不支持的地址。'); }
  }
  throw new WorkspaceFileError('下载链接重定向次数过多。');
}

async function downloadTarget(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const target = localPath(root, path);
  let directory = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    directory = resolve(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !inside(root, await realpath(directory))) {
      throw new WorkspaceFileError('下载目录必须是当前对话组内的普通目录。');
    }
  }
  return target;
}

/** Stream into a new local file; a failed transfer never leaves a partial journal resource. */
export async function saveWorkspaceDownload(
  cwd: string, path: string, url: string, signal?: AbortSignal, maxBytes = 128 * 1024 * 1024,
): Promise<{ path: string; bytes: number }> {
  byteLimit(maxBytes);
  downloadUrl(url);
  signal?.throwIfAborted();
  const target = await downloadTarget(cwd, path);
  const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
  let handle: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    try { handle = await open(target, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceFileError('下载目标已存在，请选择新的文件名。');
      throw error;
    }
    identity = await handle.stat();
    const response = await downloadResponse(url, downloadSignal);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new WorkspaceFileError(`文件下载失败（HTTP ${response.status}）。`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body.cancel();
      throw new WorkspaceFileError('下载文件超过大小上限。');
    }
    let bytes = 0;
    reader = response.body.getReader();
    while (true) {
      downloadSignal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new WorkspaceFileError('下载文件超过大小上限。');
      await handle.writeFile(chunk.value);
    }
    downloadSignal.throwIfAborted();
    await handle.sync();
    await handle.close();
    handle = undefined;
    completed = true;
    return { path: target, bytes };
  } catch (error) {
    if (downloadSignal.aborted) throw new WorkspaceFileError('文件下载已取消或超时。');
    if (error instanceof WorkspaceFileError) throw error;
    // Network errors can include signed URLs. Return a local diagnostic without their causes.
    throw new WorkspaceFileError('文件下载失败，未保留不完整文件。');
  } finally {
    try { await reader?.cancel(); } catch { /* The body may already have failed or been cancelled. */ }
    try { reader?.releaseLock(); } catch { /* A failed body can still own an interrupted read. */ }
    await handle?.close().catch(() => {});
    if (!completed && identity) {
      try {
        const current = await lstat(target);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(target);
      } catch { /* Do not remove a replacement file or mask the transfer error. */ }
    }
  }
}

/** Stage bytes on the backend so later actions never assume it can read our filesystem. */
export async function stageWorkspaceFile(
  request: ResourceRequest, cwd: string, path: string, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024,
): Promise<{ file: string; name: string; bytes: number }> {
  byteLimit(maxBytes);
  signal?.throwIfAborted();
  const file = await workspaceFile(cwd, path);
  const entry = await stat(file);
  if (entry.size > maxBytes) throw new WorkspaceFileError('上传文件超过大小上限。');
  const bytes = await readFile(file, { signal });
  signal?.throwIfAborted();
  if (bytes.byteLength > maxBytes) throw new WorkspaceFileError('上传文件超过大小上限。');
  const name = basename(file);
  const stagedName = `piq-${randomUUID()}${extname(name).slice(0, 32)}`;
  let result: unknown;
  try { result = await request('download_file', { base64: bytes.toString('base64'), name: stagedName }, true); }
  catch (error) {
    if (error instanceof OneBotApiError) throw error;
    throw new WorkspaceFileError('QQ 后端暂存失败或结果未知，后续操作尚未执行。');
  }
  if (!result || typeof result !== 'object' || !('file' in result) || typeof result.file !== 'string' || !result.file.trim()) {
    throw new WorkspaceFileError('QQ 后端未返回有效的暂存文件。');
  }
  signal?.throwIfAborted();
  return { file: result.file, name, bytes: bytes.byteLength };
}
