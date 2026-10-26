export interface Conversation {
  type: 'group' | 'private' | 'temporary';
  id: string;
  name?: string;
  sourceGroupId?: string;
}

export function validateQQId(value: unknown): string {
  const id = typeof value === 'number' ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new Error('QQ 号码必须是正整数。');
  }
  return id;
}

export function validateConversation(value: unknown): Conversation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话必须是对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['type', 'id', 'name', 'sourceGroupId'].includes(key))) throw new Error('对话含未知配置项。');
  if (!['group', 'private', 'temporary'].includes(String(input.type))) throw new Error('对话类型必须是 group、private 或 temporary。');
  const id = validateQQId(input.id);
  const sourceGroupId = input.type === 'temporary' ? validateQQId(input.sourceGroupId) : undefined;
  if (input.type !== 'temporary' && input.sourceGroupId !== undefined) throw new Error('只有群临时私聊可以指定来源群。');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()
    || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name))) throw new Error('对话名称须为 1 到 80 个字符。');
  return { type: input.type as Conversation['type'], id,
    ...(sourceGroupId === undefined ? {} : { sourceGroupId }),
    ...(input.name === undefined ? {} : { name: (input.name as string).trim() }) };
}

export function conversationKey(conversation: Pick<Conversation, 'type' | 'id' | 'sourceGroupId'>): string {
  const value = validateConversation(conversation);
  return value.type === 'temporary' ? `temporary:${value.sourceGroupId}:${value.id}` : `${value.type}:${value.id}`;
}

export function parseConversationKey(value: unknown): Conversation {
  if (typeof value !== 'string') throw new Error('对话标识须为 group:群号、private:QQ号 或 temporary:来源群:QQ号。');
  const temporary = /^temporary:([1-9]\d*):([1-9]\d*)$/.exec(value);
  if (temporary) return validateConversation({ type: 'temporary', sourceGroupId: temporary[1], id: temporary[2] });
  const matched = /^(group|private):([1-9]\d*)$/.exec(value);
  if (!matched) throw new Error('对话标识须为 group:群号、private:QQ号 或 temporary:来源群:QQ号。');
  return validateConversation({ type: matched[1], id: matched[2] });
}

export function conversationDirectory(conversation: Conversation): string {
  const value = validateConversation(conversation);
  return value.type === 'temporary' ? `messages/temporary/${value.sourceGroupId}/${value.id}` : `messages/${value.type}/${value.id}`;
}
