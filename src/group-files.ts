import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';
import type { ResolveResourceContext, ResourceRequest } from './resource-tools.ts';
import { saveWorkspaceDownload, stageWorkspaceFile } from './workspace-files.ts';

export interface GroupFileInput {
  action: 'list' | 'upload' | 'download' | 'mkdir' | 'move' | 'rename_file' | 'rename_folder' | 'delete_file' | 'delete_folder';
  conversation: string;
  folderId?: string;
  fileId?: string;
  parentId?: string;
  targetFolderId?: string;
  name?: string;
  path?: string;
  busid?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}须为非空标识。`);
  }
  return value;
}

function name(value: unknown): string {
  const checked = identifier(value, '名称');
  if (checked.length > 255 || /[\\/]/.test(checked) || checked === '.' || checked === '..') throw new Error('名称须为不含路径分隔符的文件名。');
  return checked;
}

function listing(value: unknown, groupId: string) {
  if (!object(value) || !Array.isArray(value.files) || !Array.isArray(value.folders)) throw new Error('SnowLuma 返回了无效的群文件列表。');
  for (const [items, idField, nameField] of [[value.files, 'file_id', 'file_name'], [value.folders, 'folder_id', 'folder_name']] as const) {
    for (const entry of items) {
      if (!object(entry) || typeof entry[nameField] !== 'string') throw new Error('SnowLuma 返回了无效的群文件条目。');
      identifier(entry[idField], '文件或目录 ID');
      if (entry.group_id !== undefined && String(entry.group_id) !== groupId) throw new Error('群文件列表含其他群的条目，已拒绝。');
    }
  }
  return { files: value.files, folders: value.folders };
}

function mutationResult(value: unknown): Record<string, unknown> {
  if (value === null) return { ok: true };
  if (!object(value) || value.ok === false) throw new Error('SnowLuma 返回了无效的群文件操作结果。请先查看群文件状态。');
  if (object(value.result) && value.result.retCode !== undefined && Number(value.result.retCode) !== 0) {
    throw new Error('QQ 未完成群文件操作，请检查权限和文件状态。');
  }
  return { ok: true, result: value };
}

/** The only remote scope is the explicitly selected member group. */
export async function executeGroupFile(
  cwd: string, conversationInput: Conversation, request: ResourceRequest, input: GroupFileInput, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const conversation = validateConversation(conversationInput);
  if (conversation.type !== 'group' || conversationKey(conversation) !== input.conversation) throw new Error('群文件操作须指定本对话组内的群聊。');
  const group_id = Number(conversation.id);
  signal?.throwIfAborted();
  switch (input.action) {
    case 'list': {
      const result = input.folderId === undefined || input.folderId === '/'
        ? await request('get_group_root_files', { group_id })
        : await request('get_group_files_by_folder', { group_id, folder_id: identifier(input.folderId, '目录 ID') });
      return listing(result, conversation.id);
    }
    case 'upload': {
      const source = identifier(input.path, '本地文件路径');
      const folder = input.folderId === undefined ? undefined : identifier(input.folderId, '目录 ID');
      const remoteName = input.name === undefined ? undefined : name(input.name);
      const staged = await stageWorkspaceFile(request, cwd, source, signal);
      signal?.throwIfAborted();
      const result = await request('upload_group_file', { group_id, file: staged.file,
        name: remoteName ?? staged.name, ...(folder === undefined ? {} : { folder_id: folder }) }, true);
      if (!object(result) || typeof result.file_id !== 'string' || !result.file_id.trim()) {
        throw new Error('上传结果未知：后端未返回 file_id，请先查询群文件列表再决定是否重试。');
      }
      return { fileId: result.file_id, name: remoteName ?? staged.name, bytes: staged.bytes };
    }
    case 'download': {
      const fileId = identifier(input.fileId, '文件 ID');
      if (input.busid !== undefined && (!Number.isSafeInteger(input.busid) || input.busid < 0)) throw new Error('busid 须为非负整数。');
      const result = await request('get_group_file_url', { group_id, file_id: fileId,
        ...(input.busid === undefined ? {} : { busid: input.busid }) });
      if (!object(result) || typeof result.url !== 'string' || !result.url) throw new Error('SnowLuma 未返回有效的群文件下载链接。');
      const target = input.path === undefined ? `assets/downloads/${randomUUID()}.bin` : identifier(input.path, '保存路径');
      const saved = await saveWorkspaceDownload(cwd, target, result.url, signal);
      return { fileId, ...saved };
    }
    case 'mkdir':
      return mutationResult(await request('create_group_file_folder', { group_id, name: name(input.name),
        parent_id: input.parentId === undefined ? '/' : identifier(input.parentId, '父目录 ID') }, true));
    case 'move':
      return mutationResult(await request('move_group_file', { group_id, file_id: identifier(input.fileId, '文件 ID'),
        parent_directory: input.parentId === undefined ? '/' : identifier(input.parentId, '当前父目录 ID'),
        target_directory: identifier(input.targetFolderId, '目标目录 ID') }, true));
    case 'rename_file':
      return mutationResult(await request('rename_group_file', { group_id, file_id: identifier(input.fileId, '文件 ID'),
        current_parent_directory: input.parentId === undefined ? '/' : identifier(input.parentId, '当前父目录 ID'), new_name: name(input.name) }, true));
    case 'rename_folder':
      return mutationResult(await request('rename_group_file_folder', { group_id, folder_id: identifier(input.folderId, '目录 ID'),
        new_folder_name: name(input.name) }, true));
    case 'delete_file':
      return mutationResult(await request('delete_group_file', { group_id, file_id: identifier(input.fileId, '文件 ID') }, true));
    case 'delete_folder': {
      const folder = identifier(input.folderId, '目录 ID');
      if (folder === '/') throw new Error('不能删除群文件根目录。');
      return mutationResult(await request('delete_group_file_folder', { group_id, folder_id: folder }, true));
    }
    default: throw new Error('未知群文件操作。');
  }
}

export function registerGroupFileTool(pi: ExtensionAPI, resolve: ResolveResourceContext): void {
  pi.registerTool({
    name: 'qq_group_files', label: 'QQ 群文件',
    description: '管理指定群聊的群文件：list 查看根或 folderId 目录；upload 上传本组内 path 文件；download 保存 fileId 到本组 path（默认 assets/downloads）；mkdir、move、rename_file、rename_folder、delete_file、delete_folder 管理文件和目录。上传最大 32 MiB，下载最大 128 MiB，下载不覆盖已有文件。文件与目录 ID 来自列表，权限由 QQ 决定。',
    parameters: Type.Object({
      action: Type.Union(['list', 'upload', 'download', 'mkdir', 'move', 'rename_file', 'rename_folder', 'delete_file', 'delete_folder'].map(value => Type.Literal(value))),
      conversation: Type.String(), folderId: Type.Optional(Type.String()), fileId: Type.Optional(Type.String()),
      parentId: Type.Optional(Type.String()), targetFolderId: Type.Optional(Type.String()), name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()), busid: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const bound = resolve(ctx, params.conversation, signal);
      const result = await bound.transport.resources(request => executeGroupFile(bound.cwd, bound.conversation, request, params as GroupFileInput, bound.signal), bound.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { conversation: bound.conversation, action: params.action, ...result } };
    },
  });
}
