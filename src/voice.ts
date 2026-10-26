import type { OneBotClient } from './onebot-client.ts';

export interface VoiceCharacter {
  id: string;
  name: string;
  previewUrl?: string;
}

export interface VoiceCategory {
  type: string;
  characters: VoiceCharacter[];
}

type VoiceClient = Pick<OneBotClient, 'raw'>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function groupNumber(groupId: string): number {
  if (typeof groupId !== 'string' || !/^\d+$/.test(groupId) || !Number.isSafeInteger(Number(groupId)) || Number(groupId) < 1) {
    throw new Error('AI 语音群号必须是正整数。');
  }
  return Number(groupId);
}

function messageNumber(messageId: number): number {
  if (!Number.isSafeInteger(messageId) || messageId === 0 || messageId < -2_147_483_648 || messageId > 2_147_483_647) {
    throw new Error('语音消息 ID 必须是非零的 32 位整数。');
  }
  return messageId;
}

/** The group supplies QQ's available voices; the caller retains conversation ownership checks. */
export async function listVoiceCharacters(client: VoiceClient, groupId: string, signal?: AbortSignal): Promise<VoiceCategory[]> {
  const group = groupNumber(groupId);
  signal?.throwIfAborted();
  const result: unknown = await client.raw('get_ai_characters', { group_id: group }, { signal });
  if (!Array.isArray(result)) throw new Error('SnowLuma 返回了无效的 AI 语音角色列表。');
  return result.map(category => {
    if (!object(category) || typeof category.type !== 'string' || !Array.isArray(category.characters)) {
      throw new Error('SnowLuma 返回了无效的 AI 语音分类。');
    }
    return {
      type: category.type,
      characters: category.characters.map((character: unknown): VoiceCharacter => {
        if (!object(character) || typeof character.character_id !== 'string' || !character.character_id.trim()
          || typeof character.character_name !== 'string'
          || (character.preview_url !== undefined && typeof character.preview_url !== 'string')) {
          throw new Error('SnowLuma 返回了无效的 AI 语音角色。');
        }
        return {
          id: character.character_id,
          name: character.character_name,
          ...(character.preview_url ? { previewUrl: character.preview_url as string } : {}),
        };
      }),
    };
  });
}

/** This single action both synthesizes and sends the voice; it is never retried here. */
export async function sendAiVoice(
  client: VoiceClient, groupId: string, text: string, characterId: string, signal?: AbortSignal,
): Promise<{ messageId: string }> {
  const group = groupNumber(groupId);
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI 语音需要非空文字。');
  if (typeof characterId !== 'string' || !characterId.trim()) throw new Error('请选择 AI 语音角色。');
  signal?.throwIfAborted();
  const result: unknown = await client.raw('send_group_ai_record', { group_id: group, character: characterId, text }, { signal });
  const receipt = object(result) ? result.message_id : undefined;
  if ((typeof receipt !== 'number' && typeof receipt !== 'string')
    || (typeof receipt === 'string' && !/^-?\d+$/.test(receipt))) {
    throw new Error('SnowLuma 返回了无效的 AI 语音消息回执。');
  }
  messageNumber(Number(receipt));
  return { messageId: String(Number(receipt)) };
}

/** QQ performs recognition. The caller must first verify message ownership and its record segment. */
export async function transcribeVoice(client: VoiceClient, messageId: number, signal?: AbortSignal): Promise<{ text: string }> {
  const message = messageNumber(messageId);
  signal?.throwIfAborted();
  const result: unknown = await client.raw('fetch_ptt_text', { message_id: message }, { signal });
  if (!object(result) || typeof result.text !== 'string') throw new Error('SnowLuma 返回了无效的语音转文字结果。');
  if (!result.text.trim()) throw new Error('QQ 暂未返回语音文字，可稍后重试。');
  return { text: result.text };
}
