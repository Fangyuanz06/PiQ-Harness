import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { validateQQId } from './conversations.ts';
import type { ResourceRequest, ResolveResourceContext } from './resource-tools.ts';
import { stageWorkspaceFile } from './workspace-files.ts';

export interface AlbumInput {
  action: 'list' | 'media' | 'upload_image' | 'upload_video' | 'delete_media' | 'comment' | 'like';
  albumId?: string;
  albumName?: string;
  path?: string;
  cursor?: string;
  lloc?: string;
  batchId?: string;
  content?: string;
  set?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}须为有效的非空字符串。`);
  }
  return value;
}

function cursor(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('相册分页游标无效。');
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function confirmNullReceipt(value: unknown, action: string): void {
  if (value !== null) throw new Error(`${action}结果未知：SnowLuma 返回了无效回执，请先核对相册状态再决定是否重试。`);
}

function mediaSummary(item: unknown): Record<string, unknown> {
  if (!object(item)) throw new Error('SnowLuma 返回了无效的相册媒体条目。');
  const image = object(item.image) ? item.image : undefined;
  const video = object(item.video) ? item.video : undefined;
  const defaultUrl = image && object(image.defaultUrl) ? image.defaultUrl : undefined;
  const videoUrl = video && object(video.url) ? video.url : undefined;
  return {
    ...(typeof item.type === 'string' || typeof item.type === 'number' ? { type: item.type } : {}),
    ...(optionalText(item.id ?? video?.id) ? { id: item.id ?? video?.id } : {}),
    ...(optionalText(item.lloc ?? image?.lloc) ? { lloc: item.lloc ?? image?.lloc } : {}),
    ...(optionalText(item.batch_id ?? item.batchId) ? { batchId: item.batch_id ?? item.batchId } : {}),
    ...(optionalText(item.name ?? image?.name ?? video?.name) ? { name: item.name ?? image?.name ?? video?.name } : {}),
    ...(optionalText(item.url ?? defaultUrl?.url ?? videoUrl?.url ?? video?.url)
      ? { url: item.url ?? defaultUrl?.url ?? videoUrl?.url ?? video?.url } : {}),
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  };
}

/** Every action keeps the group selected by the extension's current conversation context. */
export async function albumAction(
  request: ResourceRequest, groupId: string, cwd: string, input: AlbumInput, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const group = Number(validateQQId(groupId));
  signal?.throwIfAborted();
  if (input.action === 'list') {
    const result = await request('get_qun_album_list', { group_id: group, attach_info: cursor(input.cursor) });
    if (!object(result) || !Array.isArray(result.album_list) || typeof result.attach_info !== 'string' || typeof result.has_more !== 'boolean') {
      throw new Error('SnowLuma 返回了无效的群相册列表。');
    }
    const albums = result.album_list.map(item => {
      if (!object(item)) throw new Error('SnowLuma 返回了无效的相册条目。');
      return { albumId: text(item.album_id, '相册 ID'), name: text(item.name, '相册名称'),
        ...(typeof item.upload_number === 'string' || typeof item.upload_number === 'number' ? { mediaCount: item.upload_number } : {}),
        ...(typeof item.create_time === 'string' || typeof item.create_time === 'number' ? { createdAt: item.create_time } : {}),
        ...(typeof item.last_upload_time === 'string' || typeof item.last_upload_time === 'number' ? { lastUploadAt: item.last_upload_time } : {}),
        ...(object(item.cover) ? { cover: item.cover } : {}),
      };
    });
    return { albums, cursor: result.attach_info, hasMore: result.has_more };
  }

  const albumId = text(input.albumId, '相册 ID');
  const params = { group_id: group, album_id: albumId };
  if (input.action === 'media') {
    const result = await request('get_group_album_media_list', { ...params, attach_info: cursor(input.cursor) });
    if (!object(result) || !Array.isArray(result.mediaList) || typeof result.nextAttachInfo !== 'string') {
      throw new Error('SnowLuma 返回了无效的相册媒体列表。');
    }
    return { media: result.mediaList.map(mediaSummary), cursor: result.nextAttachInfo };
  }
  if (input.action === 'upload_image' || input.action === 'upload_video') {
    const name = text(input.albumName, '相册名称');
    const filePath = text(input.path, '本组文件路径', 32768);
    const staged = await stageWorkspaceFile(request, cwd, filePath, signal);
    signal?.throwIfAborted();
    const result = await request(input.action === 'upload_image' ? 'upload_image_to_qun_album' : 'upload_video_to_qun_album',
      { ...params, album_name: name, file: staged.file }, true);
    if (input.action === 'upload_video') {
      if (!object(result) || !optionalText(result.id)) throw new Error('视频上传结果未知：SnowLuma 未返回媒体 ID，请先查看相册再决定是否重试。');
      return { uploaded: true, albumId, mediaId: result.id, fileName: staged.name };
    }
    confirmNullReceipt(result, '图片上传');
    return { uploaded: true, albumId, fileName: staged.name };
  }
  if (input.action === 'delete_media') {
    const result = await request('del_group_album_media', { ...params, lloc: text(input.lloc, '媒体 lloc 或视频 ID') }, true);
    confirmNullReceipt(result, '删除媒体');
    return { deleted: true, albumId, lloc: input.lloc };
  }
  if (input.action === 'comment') {
    const result = await request('do_group_album_comment', { ...params, lloc: text(input.lloc, '媒体 lloc'), content: text(input.content, '评论内容', 10000) }, true);
    confirmNullReceipt(result, '评论');
    return { commented: true, albumId, lloc: input.lloc };
  }
  if (input.action === 'like') {
    if (input.set !== undefined && typeof input.set !== 'boolean') throw new Error('点赞 set 须为布尔值。');
    const set = input.set ?? true;
    const result = await request(set ? 'set_group_album_media_like' : 'cancel_group_album_media_like', {
      ...params, batch_id: text(input.batchId, '媒体 batchId'),
      ...(input.lloc === undefined ? {} : { lloc: text(input.lloc, '媒体 lloc') }),
    }, true);
    confirmNullReceipt(result, set ? '点赞' : '取消点赞');
    return { liked: set, albumId, batchId: input.batchId };
  }
  throw new Error('未知群相册操作。');
}

export function registerAlbumTool(pi: ExtensionAPI, resolve: ResolveResourceContext): void {
  pi.registerTool({
    name: 'qq_album', label: 'QQ 群相册',
    description: '查询群相册与媒体、上传本组图片或视频、评论、点赞或取消赞、删除指定媒体。先按返回的 albumId、lloc、batchId 操作；cursor 用于下一页。本地上传路径须在当前对话组内，相册创建不在可用接口中。',
    parameters: Type.Object({
      action: Type.Union(['list', 'media', 'upload_image', 'upload_video', 'delete_media', 'comment', 'like'].map(value => Type.Literal(value))),
      conversation: Type.String({ description: '本组已配置的 group:群号。' }),
      albumId: Type.Optional(Type.String()), albumName: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: '上传图片或视频的本组文件路径。' })),
      cursor: Type.Optional(Type.String()), lloc: Type.Optional(Type.String()), batchId: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()), set: Type.Optional(Type.Boolean({ description: 'like 默认 true，false 取消赞。' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const current = resolve(ctx, params.conversation, signal);
      if (current.conversation.type !== 'group') throw new Error('群相册仅支持群聊。');
      const result = await current.transport.resources(request => albumAction(request, current.conversation.id, current.cwd,
        params as AlbumInput, current.signal), current.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { conversation: current.conversation, ...result } };
    },
  });
}
