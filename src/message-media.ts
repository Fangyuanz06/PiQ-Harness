import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { conversationDirectory, conversationKey, type Conversation } from './conversations.ts';
import type { ResolveResourceContext } from './resource-tools.ts';
import { parseStoredRecord } from './store.ts';

const MAX_BYTES = 10 * 1024 * 1024;
class MediaError extends Error {}
class MediaHttpError extends MediaError {
  readonly status: number;
  constructor(status: number) {
    super([400, 403].includes(status) ? `图片链接可能已过期或访问被拒（HTTP ${status}），需要从 QQ 刷新图片信息。` : `图片下载失败（HTTP ${status}）。`);
    this.status = status;
  }
}
export type RefreshMessageMedia = (file: string, signal: AbortSignal) => Promise<unknown>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function ordinary(root: string, path: string, directory: boolean): Promise<void> {
  const entry = await lstat(path);
  const part = relative(root, await realpath(path));
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1)
    || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new MediaError('图片资料路径必须是本组内的普通文件或目录。');
}

function trustedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new MediaError('消息中的图片链接无效。'); }
  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isIP(host)
    || !(host === 'multimedia.nt.qq.com.cn' || ['qpic.cn', 'qq.com', 'gtimg.cn', 'gtimg.com'].some(domain => host === domain || host.endsWith('.' + domain)))) {
    throw new MediaError('只允许读取已记录消息中的 QQ 图片 CDN 链接。');
  }
  return url;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MediaError('图片读取已取消或超时。'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function pictureUrl(cwd: string, conversation: Conversation, messageId: number, index: number, signal: AbortSignal): Promise<{ url: URL; file?: string }> {
  let directory = cwd;
  for (const part of conversationDirectory(conversation).split('/')) {
    directory = join(directory, part);
    try { await ordinary(cwd, directory, true); }
    catch (error) { if (missing(error)) throw new MediaError('该对话没有已保存的消息记录。'); throw error; }
  }
  const files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
  for (const name of files) {
    signal.throwIfAborted();
    const file = join(directory, name);
    await ordinary(cwd, file, false);
    const contents = await readFile(file, { encoding: 'utf8', signal });
    const committed = contents.slice(0, contents.lastIndexOf('\n') + 1);
    for (const line of committed.split('\n').filter(Boolean).reverse()) {
      const record = parseStoredRecord(line, name);
      if (conversationKey(record.conversation) !== conversationKey(conversation)) throw new MediaError('消息日志包含其他对话的记录。');
      if (record.kind === 'poke' || record.messageId !== String(messageId)) continue;
      const image = record.segments.filter(segment => segment.type === 'image')[index];
      if (!image) throw new MediaError('这条消息没有指定序号的图片。');
      const url = typeof image.data.url === 'string' && image.data.url ? image.data.url : image.data.file;
      if (typeof url !== 'string') throw new MediaError('图片记录没有可下载链接。');
      const file = typeof image.data.file === 'string' && /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(image.data.file)
        && !image.data.file.endsWith('.') ? image.data.file : undefined;
      return { url: trustedUrl(url), file };
    }
  }
  throw new MediaError('在该对话已保存的日志中找不到指定消息。');
}

async function download(url: URL, signal: AbortSignal): Promise<Buffer> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      const response = await abortable(fetch(url, { redirect: 'manual', signal }), signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new MediaError('图片链接重定向无效或次数过多。');
        url = trustedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new MediaHttpError(response.status); }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
        await response.body.cancel(); throw new MediaError('图片超过 10 MiB 上限。');
      }
      reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw new MediaError('图片超过 10 MiB 上限。');
        chunks.push(Buffer.from(chunk.value));
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, bytes);
    }
    throw new MediaError('图片链接重定向次数过多。');
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}

function imageType(bytes: Buffer): { ext: string; mimeType: string } {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mimeType: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mimeType: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return { ext: 'gif', mimeType: 'image/gif' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mimeType: 'image/webp' };
  throw new MediaError('下载内容不是支持的 PNG、JPEG、GIF 或 WebP 图片。');
}

/** Downloads only a URL already attached to a message in the selected conversation's journal. */
export async function readMessageMedia(cwd: string, conversation: Conversation, messageId: number, index = 0, signal?: AbortSignal, refresh?: RefreshMessageMedia) {
  if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(index) || index < 0 || index > 9) throw new MediaError('messageId 须为整数，index 须为 0 到 9。');
  const activeSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  let saved: string | undefined;
  try {
    activeSignal.throwIfAborted();
    await ordinary(cwd, cwd, true);
    const root = await realpath(cwd);
    const picture = await pictureUrl(root, conversation, messageId, index, activeSignal);
    let bytes: Buffer;
    try { bytes = await download(picture.url, activeSignal); }
    catch (error) {
      if (!(error instanceof MediaHttpError) || ![400, 403].includes(error.status) || !refresh) throw error;
      activeSignal.throwIfAborted();
      if (!picture.file) throw new MediaError('图片链接可能已过期，但记录缺少可安全刷新的图片 ID。');
      const fresh = await abortable(refresh(picture.file, activeSignal), activeSignal);
      if (!fresh || typeof fresh !== 'object' || !('url' in fresh) || typeof fresh.url !== 'string') {
        throw new MediaError('QQ 未返回可用的新图片链接，请稍后重试。');
      }
      // Refresh only this logged image once; the replacement has the same URL and content checks.
      bytes = await download(trustedUrl(fresh.url), activeSignal);
    }
    const { ext, mimeType } = imageType(bytes);
    let directory = root;
    for (const part of ['assets', 'incoming']) {
      directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await ordinary(root, directory, true);
    }
    activeSignal.throwIfAborted();
    const path = `assets/incoming/${randomUUID()}.${ext}`;
    const target = join(root, path);
    const handle = await open(target, 'wx', 0o600);
    saved = target;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    activeSignal.throwIfAborted();
    return { path, messageId, index, bytes: bytes.length, mimeType, data: bytes.toString('base64') };
  } catch (error) {
    if (saved) await unlink(saved).catch(() => {});
    if (activeSignal.aborted) throw new MediaError('图片读取已取消或超时。');
    if (error instanceof MediaError) throw error;
    // Signed CDN URLs may appear in network errors; never forward their causes.
    throw new MediaError('图片读取失败，请核对消息记录或重试；未保留不完整文件。');
  }
}

export function registerMessageMediaTool(pi: ExtensionAPI, resolve: ResolveResourceContext): void {
  pi.registerTool({
    name: 'qq_read_media', label: '读取 QQ 消息图片',
    description: '读取当前对话已保存消息中的图片并直接返回视觉内容，同时保存到本组 assets/incoming/。用真实 QQ messageId（可为负数），index 为图片序号默认 0；无需猜本地路径。仅下载可信 QQ CDN，最大 10 MiB，20 秒超时。',
    parameters: Type.Object({ conversation: Type.String(), messageId: Type.Integer(), index: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })) }),
    async execute(_id, params, signal, _update, ctx) {
      const bound = resolve(ctx, params.conversation, signal);
      const { data, ...details } = await readMessageMedia(bound.cwd, bound.conversation, params.messageId, params.index, bound.signal,
        (file, refreshSignal) => bound.transport.resources(request => request('get_image', { file }), refreshSignal));
      return { content: [{ type: 'text', text: `已获取消息 ${details.messageId} 的图片：${details.path}（${details.bytes} 字节）` },
        { type: 'image', data, mimeType: details.mimeType }], details };
    },
  });
}
