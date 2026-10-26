import { setTimeout as delay } from 'node:timers/promises';
import { compareCursors, messageCursor, type ConversationEvent, type HistoryCursor } from './transport.ts';
import { conversationKey, validateConversation, type Conversation } from './conversations.ts';

export interface HistoryStore {
  freezeHistoryCursor(conversation: Conversation): Promise<HistoryCursor | null>;
  saveHistoryCursor(conversation: Conversation, cursor: HistoryCursor | null): Promise<void>;
  append(event: ConversationEvent): Promise<boolean>;
}

export interface HistoryOptions {
  conversation: Conversation;
  store: HistoryStore;
  fetch(cursor: HistoryCursor | null, count: number, signal: AbortSignal): Promise<ConversationEvent[]>;
  changed(): void;
  error(error: unknown): void;
  /** Tests can reduce these; production work is paced in batches. */
  pageSize?: number;
  batchPages?: number;
  batchDelayMs?: number;
}

function sameMessage(left: HistoryCursor, right: HistoryCursor): boolean {
  return left.messageId === right.messageId && (
    left.messageSeq === undefined || right.messageSeq === undefined || left.messageSeq === right.messageSeq
  );
}

/** Catch up to a snapshot, then let the live socket advance the durable cursor. */
export class HistorySync {
  private readonly options: HistoryOptions;
  private controller?: AbortController;
  private task?: Promise<void>;
  private connected = false;
  private synchronized = false;
  private latestLive?: HistoryCursor;
  private generation = 0;
  private currentCursor: HistoryCursor | null = null;
  running = false;

  constructor(options: HistoryOptions) {
    this.options = { ...options, conversation: validateConversation(options.conversation) };
  }

  private compare(left: HistoryCursor, right: HistoryCursor): number {
    return compareCursors(left, right, this.options.conversation.type);
  }

  private reached(cursor: HistoryCursor, target: HistoryCursor): boolean {
    return sameMessage(cursor, target) || this.compare(cursor, target) > 0;
  }

  private async fetch(cursor: HistoryCursor | null, count: number, signal: AbortSignal): Promise<ConversationEvent[]> {
    const events = await this.options.fetch(cursor, count, signal);
    const key = conversationKey(this.options.conversation);
    if (events.some(event => conversationKey(event.conversation) !== key)) {
      throw new Error(`历史接口返回了不属于 ${key} 的消息，已保留补拉位置。`);
    }
    return events;
  }

  connect(): void {
    this.disconnect();
    this.connected = true;
    this.retry();
  }

  disconnect(): void {
    this.generation++;
    this.connected = false;
    this.synchronized = false;
    this.running = false;
    this.latestLive = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  close(): void { this.disconnect(); }

  retry(): void {
    if (!this.connected || this.running) return;
    this.running = true;
    this.synchronized = false;
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    this.task = this.catchUp(controller.signal).then(() => {
      if (generation === this.generation) this.synchronized = true;
    }).catch(error => {
      if (!controller.signal.aborted && generation === this.generation) this.options.error(error);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.running = false;
      this.options.changed();
    });
  }

  async receive(event: ConversationEvent): Promise<void> {
    if (conversationKey(event.conversation) !== conversationKey(this.options.conversation)) return;
    const generation = this.generation;
    await this.options.store.append(event);
    if (generation !== this.generation || !this.connected) return;
    const cursor = messageCursor(event);
    if (!this.latestLive || this.compare(cursor, this.latestLive) >= 0) this.latestLive = cursor;
    if (this.connected && this.synchronized && !this.running) {
      if (!this.currentCursor || this.compare(this.latestLive, this.currentCursor) >= 0) {
        this.currentCursor = this.latestLive;
        await this.options.store.saveHistoryCursor(this.options.conversation, this.currentCursor);
      }
    }
    this.options.changed();
  }

  /** Exposed for deterministic shutdown/integration tests, not an extra agent tool. */
  async wait(): Promise<void> { await this.task; }

  private async catchUp(signal: AbortSignal): Promise<void> {
    let cursor = await this.options.store.freezeHistoryCursor(this.options.conversation);
    signal.throwIfAborted();
    if (this.options.conversation.type === 'temporary') {
      // QQ group temporary sessions have no dependable friend-history endpoint.
      // Existing local records still participate in the ordinary pending signal.
      this.currentCursor = cursor;
      return;
    }
    // A fixed target prevents an active group from extending this job forever.
    const recent = await this.fetch(null, 20, signal);
    signal.throwIfAborted();
    const target = recent.at(-1);
    if (cursor && !target) throw new Error('SnowLuma 暂未返回可获取历史，已保留补拉位置；运行 /piq sync 可重试。');
    if (!cursor) {
      for (const event of recent) {
        signal.throwIfAborted();
        await this.options.store.append(event);
      }
      cursor = target ? messageCursor(target) : null;
      await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
    } else if (target && !this.reached(cursor, target)) {
      let pages = 0;
      let complete = false;
      while (!complete && !this.reached(cursor, target)) {
        signal.throwIfAborted();
        const page = await this.fetch(cursor, this.options.pageSize ?? 100, signal);
        signal.throwIfAborted();
        const anchor = page.findIndex(event => sameMessage(event, cursor!));
        if (anchor < 0) throw new Error('离线历史锚点暂不可获取，已保留补拉位置。可在 SnowLuma 历史同步完成后运行 /piq sync 重试。');
        const newer = page.slice(anchor + 1).filter(event => !sameMessage(event, cursor!) && this.compare(event, cursor!) >= 0);
        if (!newer.length) throw new Error('SnowLuma 历史页暂未前进，已保留补拉位置；运行 /piq sync 可继续。');
        for (const event of newer) {
          signal.throwIfAborted();
          await this.options.store.append(event);
          complete ||= sameMessage(event, target);
        }
        cursor = messageCursor(newer.at(-1)!);
        signal.throwIfAborted();
        await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
        // Bound each burst of API work, while continuing automatically to the snapshot.
        if (++pages % (this.options.batchPages ?? 10) === 0 && !complete && !this.reached(cursor, target)) {
          await delay(this.options.batchDelayMs ?? 1_000, undefined, { signal });
        }
      }
    }
    signal.throwIfAborted();
    if (this.latestLive && (!cursor || this.compare(this.latestLive, cursor) > 0)) cursor = this.latestLive;
    this.currentCursor = cursor;
    await this.options.store.saveHistoryCursor(this.options.conversation, cursor);
  }
}
