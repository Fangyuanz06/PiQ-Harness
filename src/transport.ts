import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { OneBotApiError, OneBotClient } from './onebot-client.ts';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';
import { listVoiceCharacters, sendAiVoice, transcribeVoice, type VoiceCategory } from './voice.ts';
import type { ResourceRequest } from './resource-tools.ts';

export interface ConversationEvent {
  conversation: Conversation;
  selfId: string;
  userId: string;
  messageId: string;
  messageSeq?: string;
  time: number;
  sender: string;
  segments: Array<{ type: string; data: Record<string, unknown> }>;
  rawText: string;
  outgoing: boolean;
}

export interface PokeEvent {
  kind: 'poke';
  eventId: string;
  source: 'notice' | 'action';
  conversation: Conversation;
  selfId: string;
  userId: string;
  targetId: string;
  time: number;
  sender: string;
  rawText: string;
  segments: Array<{ type: string; data: Record<string, unknown> }>;
  outgoing: boolean;
}

export interface HistoryCursor {
  messageId: string;
  messageSeq?: string;
  time: number;
}

export function messageCursor(event: HistoryCursor): HistoryCursor {
  return { messageId: event.messageId, messageSeq: event.messageSeq, time: event.time };
}

export function compareCursors(left: HistoryCursor, right: HistoryCursor, type: Conversation['type'] = 'group'): number {
  if (type === 'group' && left.messageSeq !== undefined && right.messageSeq !== undefined) {
    return Number(left.messageSeq) - Number(right.messageSeq);
  }
  return left.time - right.time;
}

export interface TransportOptions {
  url: string;
  accessToken?: string;
  /** Maximum time to wait for the socket before dispatching a new message. */
  connectionTimeoutMs?: number;
  onMessage: (event: ConversationEvent) => void;
  onPoke?: (event: PokeEvent) => void;
  onStatus: (status: 'connected' | 'disconnected' | 'error', error?: unknown) => void;
}

export interface SendInput {
  text?: string;
  images?: string[];
  replyTo?: number;
}

function id(value: unknown, signed = false): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0 || (!signed && number < 0)) return undefined;
  return String(number);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageId(value: number): number {
  if (!id(value, true) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error('Message ID must be a non-zero signed 32-bit integer.');
  }
  return value;
}

function emojiId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Emoji ID must be a non-empty string without control characters.');
  }
  return value;
}

export function normalizePokeEvent(event: Record<string, unknown>): PokeEvent | undefined {
  if (event.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'poke') return;
  const selfId = id(event.self_id);
  const targetId = id(event.target_id);
  const reportedUser = id(event.user_id);
  if (!selfId || !reportedUser || !targetId || typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time < 0) return;
  const groupId = id(event.group_id);
  if (!groupId && event.group_id !== undefined && event.group_id !== 0 && event.group_id !== '0') return;
  let conversation: Conversation;
  let userId: string;
  if (groupId) {
    conversation = { type: 'group', id: groupId };
    userId = reportedUser;
  } else {
    // SnowLuma's private notice uses user_id for the peer, sender_id for the actor.
    if (reportedUser === selfId) return;
    const actor = event.sender_id === undefined ? (targetId === selfId ? reportedUser : undefined) : id(event.sender_id);
    if (!actor || ![selfId, reportedUser].includes(actor) || ![selfId, reportedUser].includes(targetId)) return;
    conversation = { type: 'private', id: reportedUser };
    userId = actor;
  }
  const sender = object(event.sender) ? event.sender.card || event.sender.nickname : undefined;
  return {
    kind: 'poke', eventId: randomUUID(), source: 'notice', conversation, selfId, userId, targetId,
    time: event.time, sender: typeof sender === 'string' ? sender : userId,
    rawText: `${userId} 戳了戳 ${targetId}`, segments: [], outgoing: userId === selfId,
  };
}

export function normalizeMessageEvent(event: Record<string, unknown>): ConversationEvent | undefined {
  if (!['message', 'message_sent'].includes(String(event.post_type)) || !['group', 'private'].includes(String(event.message_type))) return;
  const selfId = id(event.self_id);
  const userId = id(event.user_id);
  const messageId = id(event.message_id, true);
  if (!selfId || !userId || !messageId || typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time < 0) return;
  const outgoing = event.post_type === 'message_sent' || userId === selfId;
  const peerId = event.message_type === 'group' ? id(event.group_id)
    : outgoing ? id(event.target_id) ?? id(event.session_id) : userId;
  // A private self echo without a destination cannot be attributed to a peer safely.
  if (!peerId) return;
  const senderObject = object(event.sender) ? event.sender : {};
  let conversation: Conversation;
  if (event.message_type === 'private' && event.sub_type === 'group') {
    const sourceGroupId = id(senderObject.group_id) ?? id(event.group_id);
    if (!sourceGroupId) return;
    conversation = { type: 'temporary', id: peerId, sourceGroupId };
  } else {
    conversation = { type: event.message_type as 'group' | 'private', id: peerId };
  }
  const segments: ConversationEvent['segments'] = Array.isArray(event.message)
    ? event.message.flatMap(segment => object(segment) && typeof segment.type === 'string' && object(segment.data)
      ? [{ type: segment.type, data: segment.data }] : []) : [];
  const sender = senderObject.card || senderObject.nickname || userId;
  const rawText = typeof event.raw_message === 'string' ? event.raw_message
    : typeof event.message === 'string' ? event.message
      : segments.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('');
  return {
    conversation, selfId, userId, messageId, messageSeq: id(event.message_seq), time: event.time,
    sender: typeof sender === 'string' ? sender : userId, segments, rawText,
    outgoing,
  };
}

/** One connection serves the conversations assigned to one Pi workspace. */
export class SnowLumaTransport {
  private readonly client: OneBotClient;
  private readonly unsubscribe: Array<() => void>;
  private readonly shutdown = new AbortController();
  private readonly connectionTimeoutMs: number;
  private readonly endpoint: string;
  private closed = false;
  private selfId?: string;
  private connectionVersion = 0;

  constructor(options: TransportOptions, client?: OneBotClient) {
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.connectionTimeoutMs) || this.connectionTimeoutMs <= 0 || this.connectionTimeoutMs > 60_000) {
      throw new Error('Connection timeout must be between 1 and 60000 milliseconds.');
    }
    // Diagnostics never include credentials or query parameters from an endpoint.
    const endpoint = new URL(options.url);
    this.endpoint = `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
    this.client = client ?? new OneBotClient({
      url: options.url,
      accessToken: options.accessToken,
      reconnect: true,
      requestTimeoutMs: 30_000,
    });
    const receive = (event: Record<string, unknown>) => {
      const normalized = normalizeMessageEvent(event);
      if (normalized) { this.selfId = normalized.selfId; options.onMessage(normalized); }
      const poke = normalizePokeEvent(event);
      if (poke) { this.selfId = poke.selfId; options.onPoke?.(poke); }
    };
    this.unsubscribe = [
      this.client.on('open', () => { this.connectionVersion++; this.selfId = undefined; options.onStatus('connected'); }),
      this.client.on('close', () => { this.connectionVersion++; this.selfId = undefined; options.onStatus('disconnected'); }),
      this.client.on('error', error => options.onStatus('error', error)),
      this.client.on('message', receive),
    ];
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('SnowLuma transport is closed.');
    await this.client.connect();
  }

  get isConnected(): boolean {
    return !this.closed && this.client.isConnected;
  }

  /** Wait only before dispatch. Once a message action is sent it is never replayed. */
  async waitForConnection(signal?: AbortSignal): Promise<void> {
    const waitingSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    waitingSignal.throwIfAborted();
    if (this.isConnected) return;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        waitingSignal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(waitingSignal.reason ?? new Error('SnowLuma connection wait aborted.'));
      unsubscribe = this.client.on('open', () => { if (this.isConnected) finish(); });
      waitingSignal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish(new Error(
        `无法连接 SnowLuma（${this.endpoint}），消息未发送。请确认 SnowLuma 服务和 QQ 已运行、WebSocket 已启用，且地址与 token 正确。`,
      )), this.connectionTimeoutMs);
      if (waitingSignal.aborted) { aborted(); return; }
      // An explicit send can connect immediately while automatic reconnect is backing off.
      void this.client.connect().then(() => {
        if (this.isConnected) finish();
      }).catch(() => {});
    });
  }

  close(): void {
    this.closed = true;
    this.shutdown.abort(new Error('SnowLuma transport is closed.'));
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.client.close();
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    combined.throwIfAborted();
    return combined;
  }

  private async getSelfId(signal: AbortSignal): Promise<string> {
    if (this.selfId) return this.selfId;
    const version = this.connectionVersion;
    const result = await this.client.raw('get_login_info', {}, { signal });
    const account = object(result) ? id(result.user_id) : undefined;
    if (!account) throw new Error('SnowLuma returned an invalid login account.');
    signal.throwIfAborted();
    if (version !== this.connectionVersion || !this.isConnected) throw new Error('SnowLuma connection changed while reading the login account.');
    this.selfId = account;
    return account;
  }

  /** Resource tools retain their explicit scope; the connection owns cancellation and receipts. */
  async resources<T>(operation: (request: ResourceRequest) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const requestSignal = this.requestSignal(signal);
    await this.waitForConnection(requestSignal);
    const version = this.connectionVersion;
    const request: ResourceRequest = async (action, params, mutating = false) => {
      requestSignal.throwIfAborted();
      this.assertConnection(version);
      if (mutating) return this.mutate(action, params, requestSignal, version);
      const result = await this.client.raw<unknown>(action, params, { signal: requestSignal });
      this.assertConnection(version);
      return result;
    };
    return operation(request);
  }

  private assertConnection(version: number): void {
    if (version !== this.connectionVersion || !this.isConnected) throw new Error('核验消息后连接已变化，请重新确认消息归属。');
  }

  private async mutate<T = unknown>(action: string, params: Record<string, unknown>, signal: AbortSignal, version?: number): Promise<T> {
    await this.waitForConnection(signal);
    signal.throwIfAborted();
    if (version !== undefined) this.assertConnection(version);
    try {
      return await this.client.raw<T>(action, params, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000 + this.connectionTimeoutMs)]),
      });
    } catch (cause) {
      if (cause instanceof OneBotApiError) throw cause;
      throw new Error(`Action ${action} result is unknown. Check the conversation before deciding to retry.`, { cause });
    }
  }

  /** Fetch a message only when its routing fields prove the explicitly selected conversation. */
  private async scopedMessage(conversation: Conversation, value: number, signal: AbortSignal): Promise<{ record: Record<string, unknown>; selfId: string; senderId: string; version: number }> {
    await this.waitForConnection(signal);
    const version = this.connectionVersion;
    const selfId = await this.getSelfId(signal);
    const result = await this.client.raw('get_msg', { message_id: value }, { signal });
    if (!object(result) || id(result.message_id, true) !== String(value)) throw new Error('无法确认消息归属：get_msg 返回的消息 ID 无效。');
    const sender = object(result.sender) ? result.sender : {};
    const senderId = id(result.user_id) ?? id(sender.user_id);
    if (!senderId || (result.user_id !== undefined && !id(result.user_id)) || (sender.user_id !== undefined && !id(sender.user_id))
      || (id(result.user_id) && id(sender.user_id) && id(result.user_id) !== id(sender.user_id))
      || (result.self_id !== undefined && id(result.self_id) !== selfId)) {
      throw new Error('无法确认消息归属：发件者或账号信息无效。');
    }
    let belongs = false;
    if (conversation.type === 'group') {
      belongs = result.message_type === 'group' && id(result.group_id) === conversation.id;
    } else if (result.message_type === 'private') {
      const sourceGroup = id(sender.group_id) ?? id(result.group_id);
      const temporary = result.sub_type === 'group';
      const peer = senderId === selfId ? id(result.target_id) ?? id(result.session_id) : senderId;
      const target = id(result.target_id);
      const contradictorySource = id(sender.group_id) && id(result.group_id) && id(sender.group_id) !== id(result.group_id);
      const contradictoryPeer = id(result.target_id) && id(result.session_id) && senderId === selfId && id(result.target_id) !== id(result.session_id);
      const endpointsMatch = peer === conversation.id && !contradictorySource && !contradictoryPeer
        && (result.target_id === undefined || (target !== undefined && target === (senderId === selfId ? peer : selfId)));
      belongs = endpointsMatch && (conversation.type === 'temporary'
        ? temporary && sourceGroup === conversation.sourceGroupId
        : !temporary && !sourceGroup);
    }
    if (!belongs) throw new Error('无法确认消息属于指定对话，已拒绝操作。');
    signal.throwIfAborted();
    this.assertConnection(version);
    return { record: result, selfId, senderId, version };
  }

  async poke(conversationInput: Conversation, userId?: string, signal?: AbortSignal): Promise<{ selfId: string; userId: string }> {
    const conversation = validateConversation(conversationInput);
    if (conversation.type === 'temporary') throw new Error('临时会话不支持戳一戳。');
    const target = userId === undefined && conversation.type === 'private' ? conversation.id : id(userId);
    if (!target || (conversation.type === 'private' && target !== conversation.id)) throw new Error('群聊必须指定有效目标；私聊只能戳当前对话的对方。');
    const requestSignal = this.requestSignal(signal);
    await this.waitForConnection(requestSignal);
    const selfId = await this.getSelfId(requestSignal);
    const version = this.connectionVersion;
    await this.mutate(conversation.type === 'group' ? 'group_poke' : 'friend_poke',
      conversation.type === 'group' ? { group_id: Number(conversation.id), user_id: Number(target) } : { user_id: Number(target) }, requestSignal, version);
    return { selfId, userId: target };
  }

  async react(conversationInput: Conversation, value: number, reaction: string, set = true, signal?: AbortSignal): Promise<void> {
    const conversation = validateConversation(conversationInput);
    messageId(value); emojiId(reaction);
    if (typeof set !== 'boolean') throw new Error('Reaction set must be a boolean.');
    if (conversation.type !== 'group') throw new Error('SnowLuma 仅支持为群聊消息添加表情回应。');
    const requestSignal = this.requestSignal(signal);
    const message = await this.scopedMessage(conversation, value, requestSignal);
    await this.mutate('set_msg_emoji_like', { message_id: value, emoji_id: reaction, set }, requestSignal, message.version);
  }

  async recall(conversationInput: Conversation, value: number, signal?: AbortSignal): Promise<void> {
    const conversation = validateConversation(conversationInput);
    messageId(value);
    const requestSignal = this.requestSignal(signal);
    const message = await this.scopedMessage(conversation, value, requestSignal);
    if (message.senderId !== message.selfId) throw new Error('只能撤回当前 QQ 账号发送的消息。');
    await this.mutate('delete_msg', { message_id: value }, requestSignal, message.version);
  }

  async listStickers(count = 48, signal?: AbortSignal): Promise<Array<{ emojiId: string; md5?: string; description?: string; url?: string }>> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Sticker count must be a non-negative safe integer.');
    const requestSignal = this.requestSignal(signal);
    await this.waitForConnection(requestSignal);
    const result = await this.client.raw<unknown>('fetch_custom_face_detail', { count }, { signal: requestSignal });
    if (!Array.isArray(result)) throw new Error('SnowLuma returned an invalid sticker list.');
    return result.map(item => {
      if (!object(item)) throw new Error('SnowLuma returned an invalid sticker entry.');
      const identity = typeof item.emoji_id === 'number' && Number.isSafeInteger(item.emoji_id) ? String(item.emoji_id) : item.emoji_id;
      return { emojiId: emojiId(identity),
        ...(typeof item.md5 === 'string' ? { md5: item.md5 } : {}),
        ...(typeof item.desc === 'string' ? { description: item.desc } : {}),
        ...(typeof item.url === 'string' ? { url: item.url } : {}),
      };
    });
  }

  async sendSticker(conversationInput: Conversation, sticker: string, replyTo?: number, signal?: AbortSignal): Promise<{ messageId: string }> {
    const conversation = validateConversation(conversationInput);
    emojiId(sticker);
    if (replyTo !== undefined) messageId(replyTo);
    if (conversation.type === 'temporary') throw new Error('临时会话不支持发送收藏表情。');
    const requestSignal = this.requestSignal(signal);
    const result = await this.mutate<Record<string, unknown> | null>('send_custom_face', {
      emoji_id: sticker,
      ...(conversation.type === 'group' ? { group_id: Number(conversation.id) } : { user_id: Number(conversation.id) }),
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    }, requestSignal);
    const receiptId = id(result?.message_id, true);
    if (!receiptId || Number(receiptId) < -2_147_483_648 || Number(receiptId) > 2_147_483_647) {
      throw new Error('Sticker send result is unknown: SnowLuma returned an invalid message receipt.');
    }
    return { messageId: receiptId };
  }

  async getVoices(conversationInput: Conversation, signal?: AbortSignal): Promise<VoiceCategory[]> {
    const conversation = validateConversation(conversationInput);
    if (conversation.type !== 'group') throw new Error('QQ AI 语音仅支持群聊。');
    const requestSignal = this.requestSignal(signal);
    await this.waitForConnection(requestSignal);
    return listVoiceCharacters(this.client, conversation.id, requestSignal);
  }

  async speak(conversationInput: Conversation, text: string, characterId: string, signal?: AbortSignal): Promise<{ messageId: string }> {
    const conversation = validateConversation(conversationInput);
    if (conversation.type !== 'group') throw new Error('QQ AI 语音仅支持群聊。');
    if (!text?.trim() || !characterId?.trim()) throw new Error('AI 语音需要非空文字和语音角色。');
    const requestSignal = this.requestSignal(signal);
    await this.waitForConnection(requestSignal);
    requestSignal.throwIfAborted();
    try {
      return await sendAiVoice(this.client, conversation.id, text, characterId,
        AbortSignal.any([requestSignal, AbortSignal.timeout(30_000 + this.connectionTimeoutMs)]));
    } catch (cause) {
      if (cause instanceof OneBotApiError) throw cause;
      throw new Error('AI voice send result is unknown. Check the conversation before deciding to retry.', { cause });
    }
  }

  async transcribe(conversationInput: Conversation, value: number, signal?: AbortSignal): Promise<{ text: string }> {
    const conversation = validateConversation(conversationInput);
    messageId(value);
    const requestSignal = this.requestSignal(signal);
    const { record, version } = await this.scopedMessage(conversation, value, requestSignal);
    if (!Array.isArray(record.message) || !record.message.some(segment => object(segment) && segment.type === 'record' && object(segment.data))) {
      throw new Error('指定消息不包含 QQ 语音。');
    }
    this.assertConnection(version);
    return transcribeVoice(this.client, value, requestSignal);
  }

  /** The anchor is inclusive. No anchor requests the most recent available records. */
  async fetchHistory(conversationInput: Conversation, cursor: HistoryCursor | null, count: number, signal?: AbortSignal): Promise<ConversationEvent[]> {
    const conversation = validateConversation(conversationInput);
    if (conversation.type === 'temporary') throw new Error('临时会话不支持历史补拉。');
    if ((cursor && !id(cursor.messageId, true)) || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid history cursor or count.');
    if (this.closed || !this.client.isConnected) throw new Error('SnowLuma is disconnected; history is unavailable.');
    const requestSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    requestSignal.throwIfAborted();
    await this.getSelfId(requestSignal);
    requestSignal.throwIfAborted();
    const paging = { count, ...(cursor ? { message_id: Number(cursor.messageId), reverse_order: false } : {}) };
    // History paging is a backend extension to the OneBot 11 action envelope.
    const result = conversation.type === 'group'
      ? await this.client.raw('get_group_msg_history', { group_id: Number(conversation.id), ...paging }, { signal: requestSignal })
      : await this.client.raw('get_friend_msg_history', { user_id: Number(conversation.id), ...paging }, { signal: requestSignal });
    if (!Array.isArray(result?.messages)) throw new Error('SnowLuma returned invalid conversation history.');
    return result.messages.flatMap(record => {
      if (!object(record)) throw new Error('SnowLuma returned an invalid history record.');
      const normalized = normalizeMessageEvent({ ...record,
        message_type: record.message_type ?? conversation.type,
        post_type: record.post_type ?? (id(record.user_id) === this.selfId ? 'message_sent' : 'message'),
        ...(conversation.type === 'group' ? { group_id: record.group_id ?? Number(conversation.id) }
          : { target_id: record.target_id ?? record.session_id ?? Number(conversation.id) }),
        self_id: this.selfId,
      });
      // SnowLuma's local private-history cache can also contain incoming
      // temporary sessions. They have their own source-scoped conversation.
      if (conversation.type === 'private' && normalized?.conversation.type === 'temporary'
        && normalized.conversation.id === conversation.id) return [];
      if (!normalized || conversationKey(normalized.conversation) !== conversationKey(conversation)) throw new Error('SnowLuma returned a history record for another conversation.');
      return [normalized];
    }).sort((left, right) => compareCursors(left, right, conversation.type));
  }

  async send(conversationInput: Conversation, input: SendInput, signal?: AbortSignal): Promise<{ messageId: string }> {
    const conversation = validateConversation(conversationInput);
    if (input.replyTo !== undefined && (!id(input.replyTo, true)
      || input.replyTo < -2_147_483_648 || input.replyTo > 2_147_483_647)) {
      throw new Error('Reply message ID must be a non-zero signed 32-bit integer.');
    }
    if (!input.text && !input.images?.length) throw new Error('A message needs text or an image.');
    const requestSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    requestSignal.throwIfAborted();
    await this.waitForConnection(requestSignal);
    const segments: ConversationEvent['segments'] = [];
    if (input.replyTo !== undefined) segments.push({ type: 'reply', data: { id: String(input.replyTo) } });
    if (input.text) segments.push({ type: 'text', data: { text: input.text } });
    // OneBot's base64 image form works even when the backend runs on another machine.
    for (const path of input.images ?? []) {
      const bytes = await readFile(path, { signal: requestSignal });
      requestSignal.throwIfAborted();
      segments.push({ type: 'image', data: { file: `base64://${bytes.toString('base64')}` } });
    }
    requestSignal.throwIfAborted();
    await this.waitForConnection(requestSignal);
    try {
      const dispatchSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000 + this.connectionTimeoutMs)]);
      const result = conversation.type === 'group'
        ? await this.client.raw('send_group_msg', { group_id: Number(conversation.id), message: segments }, { signal: dispatchSignal })
        : conversation.type === 'temporary'
          ? await this.client.raw('send_private_msg', { user_id: Number(conversation.id), group_id: Number(conversation.sourceGroupId), message: segments }, { signal: dispatchSignal })
          : await this.client.raw('send_private_msg', { user_id: Number(conversation.id), message: segments }, { signal: dispatchSignal });
      const messageId = id(result?.message_id, true);
      if (!messageId) throw new Error('SnowLuma returned an invalid message receipt.');
      return { messageId };
    } catch (cause) {
      if (cause instanceof OneBotApiError) throw cause;
      throw new Error('Send result is unknown. Check the group message history before deciding to send again.', { cause });
    }
  }
}
