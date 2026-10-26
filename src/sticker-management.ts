import type { ResourceRequest } from './resource-tools.ts';
import { stageWorkspaceFile } from './workspace-files.ts';

export interface StickerManagementInput {
  action: 'add' | 'remove' | 'rename' | 'promote';
  path?: string;
  emojiId?: string;
  name?: string;
}

export interface StickerManagementResult {
  action: StickerManagementInput['action'];
  scope: 'account';
  emojiId: string;
  name?: string;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('收藏表情需要有效的 emojiId。');
  }
  return value;
}

function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('表情备注 name 须为不超过 512 字符的单行文字，可用空字符串清除。');
  }
  return value;
}

/** QQ favorites belong to the connected account; local asset paths remain workspace scoped. */
export async function manageSticker(
  request: ResourceRequest, cwd: string, input: StickerManagementInput, signal?: AbortSignal,
): Promise<StickerManagementResult> {
  signal?.throwIfAborted();
  if (!input || !['add', 'remove', 'rename', 'promote'].includes(input.action)) throw new Error('未知收藏表情管理操作。');
  if (input.action === 'add') {
    if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('添加收藏表情需要本组内图片的 path。');
    if (input.name !== undefined) throw new Error('添加时只提供 path；可用 rename 单独修改表情备注。');
    const staged = await stageWorkspaceFile(request, cwd, input.path, signal);
    signal?.throwIfAborted();
    const result = await request('add_custom_face', { file: staged.file }, true);
    const emojiId = result && typeof result === 'object' && !Array.isArray(result) && 'emoji_id' in result
      ? result.emoji_id : undefined;
    try {
      return { action: 'add', scope: 'account', emojiId: identifier(emojiId) };
    } catch (cause) {
      throw new Error('添加收藏表情结果未知：后端未返回有效表情 ID，请先检查收藏列表再决定是否重试。', { cause });
    }
  }
  const emojiId = identifier(input.emojiId);
  const name = input.action === 'rename' ? description(input.name) : undefined;
  const action = input.action === 'remove' ? 'delete_custom_face'
    : input.action === 'rename' ? 'modify_custom_face' : 'move_custom_face_to_front';
  const result = await request(action, { emoji_id: emojiId, ...(name === undefined ? {} : { desc: name }) }, true);
  if (result !== null) throw new Error('收藏表情操作结果未知：后端回执格式无效，请先核对收藏列表再决定是否重试。');
  return { action: input.action, scope: 'account', emojiId, ...(name === undefined ? {} : { name }) };
}
