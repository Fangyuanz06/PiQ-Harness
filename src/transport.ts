import { readFile } from 'node:fs/promises';
import { OneBotApiError, OneBotClient } from './onebot-client.ts';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';

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
    };
    this.unsubscribe = [
      this.client.on('open', () => { this.selfId = undefined; options.onStatus('connected'); }),
      this.client.on('close', () => options.onStatus('disconnected')),
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

  /** The anchor is inclusive. No anchor requests the most recent available records. */
  async fetchHistory(conversationInput: Conversation, cursor: HistoryCursor | null, count: number, signal?: AbortSignal): Promise<ConversationEvent[]> {
    const conversation = validateConversation(conversationInput);
    if (conversation.type === 'temporary') throw new Error('临时会话不支持历史补拉。');
    if ((cursor && !id(cursor.messageId, true)) || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid history cursor or count.');
    if (this.closed || !this.client.isConnected) throw new Error('SnowLuma is disconnected; history is unavailable.');
    const requestSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    requestSignal.throwIfAborted();
    if (!this.selfId) {
      this.selfId = id((await this.client.raw('get_login_info', {}, { signal: requestSignal })).user_id);
      if (!this.selfId) throw new Error('SnowLuma returned an invalid login account.');
    }
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
