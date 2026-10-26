import { randomUUID } from 'node:crypto';

export interface OneBotSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface OneBotClientOptions {
  url: string;
  accessToken?: string;
  reconnect?: boolean;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  webSocket?: new (url: string) => OneBotSocket;
}

interface ClientEvents {
  open: undefined;
  close: undefined;
  error: Error;
  message: Record<string, unknown>;
}

interface PendingRequest {
  action: string;
  finish: (error?: unknown, value?: unknown) => void;
}

interface Connection {
  socket: OneBotSocket;
  promise: Promise<void>;
  finish: (error?: Error) => void;
  removeListeners: () => void;
  opened: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timeout(value: number | undefined, fallback: number): number {
  const checked = value ?? fallback;
  if (!Number.isSafeInteger(checked) || checked < 1 || checked > 300_000) {
    throw new Error('OneBot timeout must be an integer between 1 and 300000 milliseconds.');
  }
  return checked;
}

/** A failed API response confirms failure; transport errors leave the outcome unknown. */
export class OneBotApiError extends Error {
  readonly retcode: number;
  readonly action: string;

  constructor(action: string, retcode: number) {
    // Server messages can contain echoed credentials, so keep diagnostics local.
    super(`OneBot action ${action} failed (retcode ${retcode}).`);
    this.name = 'OneBotApiError';
    this.action = action;
    this.retcode = retcode;
  }
}

/** Independent OneBot 11 forward-WebSocket client. Requests are never replayed. */
export class OneBotClient {
  private readonly url: string;
  private readonly Socket: new (url: string) => OneBotSocket;
  private readonly reconnect: boolean;
  private readonly requestTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly listeners = new Map<keyof ClientEvents, Set<(value: never) => void>>();
  private readonly pending = new Map<string, PendingRequest>();
  private connection?: Connection;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private closed = false;

  constructor(options: OneBotClientOptions) {
    let endpoint: URL;
    try { endpoint = new URL(options.url); }
    catch { throw new Error('Invalid OneBot WebSocket URL.'); }
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('OneBot requires a ws:// or wss:// URL without user info or a fragment.');
    }
    if (options.accessToken !== undefined) endpoint.searchParams.set('access_token', options.accessToken);
    this.url = endpoint.href;
    this.Socket = options.webSocket ?? WebSocket;
    this.reconnect = options.reconnect ?? true;
    this.requestTimeoutMs = timeout(options.requestTimeoutMs, 30_000);
    this.connectionTimeoutMs = timeout(options.connectionTimeoutMs, 10_000);
  }

  get isConnected(): boolean {
    return !this.closed && this.connection?.opened === true && this.connection.socket.readyState === 1;
  }

  on<K extends keyof ClientEvents>(type: K, listener: (value: ClientEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    const callback = listener as (value: never) => void;
    set.add(callback);
    return () => { set.delete(callback); };
  }

  private emit<K extends keyof ClientEvents>(type: K, value: ClientEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(value as never);
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('OneBot client is closed.'));
    if (this.isConnected) return Promise.resolve();
    if (this.connection) return this.connection.promise;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    let socket: OneBotSocket;
    try { socket = new this.Socket(this.url); }
    catch {
      const error = new Error('OneBot WebSocket connection could not be created.');
      this.scheduleReconnect();
      this.emit('error', error);
      return Promise.reject(error);
    }
    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const connection: Connection = {
      socket, promise, opened: false,
      finish: error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectConnection(error); else resolveConnection();
      },
      removeListeners: () => {
        for (const [type, listener] of Object.entries(handlers)) socket.removeEventListener(type, listener);
      },
    };
    const handlers: Record<string, EventListener> = {
      open: () => {
        if (this.connection !== connection || this.closed) return;
        connection.opened = true;
        this.retry = 0;
        connection.finish();
        this.emit('open', undefined);
      },
      close: () => this.disconnect(connection, new Error('OneBot WebSocket disconnected.')),
      error: () => {
        const error = new Error('OneBot WebSocket connection failed.');
        this.disconnect(connection, error);
        this.emit('error', error);
      },
      message: event => {
        if (this.connection === connection && connection.opened) this.receive((event as MessageEvent).data, connection);
      },
    };
    this.connection = connection;
    for (const [type, listener] of Object.entries(handlers)) socket.addEventListener(type, listener);
    timer = setTimeout(() => {
      const error = new Error('OneBot WebSocket connection timed out.');
      this.disconnect(connection, error);
      this.emit('error', error);
    }, this.connectionTimeoutMs);
    return promise;
  }

  private disconnect(connection: Connection, error: Error): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    connection.removeListeners();
    connection.finish(error);
    for (const request of this.pending.values()) request.finish(error);
    // Remove listeners first: closing a fake or native socket can synchronously fire close.
    try { connection.socket.close(); } catch { /* The connection is already unusable. */ }
    this.scheduleReconnect();
    this.emit('close', undefined);
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.reconnect || this.reconnectTimer) return;
    const wait = Math.min(30_000, 500 * 2 ** Math.min(this.retry++, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {});
    }, wait);
    this.reconnectTimer.unref();
  }

  private receive(data: unknown, connection: Connection): void {
    let packet: unknown;
    try {
      if (typeof data !== 'string') throw new Error();
      packet = JSON.parse(data);
      if (!isObject(packet)) throw new Error();
    } catch {
      const error = new Error('OneBot sent an invalid JSON frame.');
      this.disconnect(connection, error);
      this.emit('error', error);
      return;
    }
    if (typeof packet.post_type === 'string') {
      this.emit('message', packet);
      return;
    }
    if (typeof packet.echo !== 'string') return;
    const request = this.pending.get(packet.echo);
    if (!request) return; // Late, duplicate, or unrelated receipts have no owner.
    const retcode = packet.retcode;
    if (!Number.isSafeInteger(retcode) || !['ok', 'failed', 'async'].includes(String(packet.status)) || !('data' in packet)) {
      request.finish(new Error('OneBot sent an invalid API receipt.'));
    } else if (packet.status === 'ok' && retcode === 0) {
      request.finish(undefined, packet.data);
    } else if (packet.status === 'failed' && retcode !== 0 && retcode !== 1) {
      request.finish(new OneBotApiError(request.action, retcode as number));
    } else if (packet.status === 'async' && retcode === 1) {
      request.finish(new Error('OneBot accepted the action asynchronously; its result is unknown.'));
    } else {
      request.finish(new Error('OneBot sent an inconsistent API receipt.'));
    }
  }

  raw<T = Record<string, unknown>>(
    action: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!/^[a-zA-Z0-9_]+$/.test(action)) return Promise.reject(new Error('Invalid OneBot action name.'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('OneBot request aborted.'));
    const connection = this.connection;
    if (!this.isConnected || !connection) return Promise.reject(new Error('OneBot WebSocket is disconnected.'));
    const echo = randomUUID();
    let serialized: string;
    try { serialized = JSON.stringify({ action, params, echo }); }
    catch { return Promise.reject(new Error('OneBot request parameters must be JSON serializable.')); }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish: PendingRequest['finish'] = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.pending.delete(echo);
        if (error !== undefined) reject(error); else resolve(value as T);
      };
      const abort = () => finish(options.signal?.reason ?? new Error('OneBot request aborted.'));
      this.pending.set(echo, { action, finish });
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error(`OneBot action ${action} timed out; its result is unknown.`)), this.requestTimeoutMs);
      if (options.signal?.aborted) { abort(); return; }
      try { connection.socket.send(serialized); }
      catch { finish(new Error(`OneBot action ${action} could not be sent; its result is unknown.`)); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const error = new Error('OneBot client is closed.');
    if (this.connection) this.disconnect(this.connection, error);
    for (const request of this.pending.values()) request.finish(error);
    this.listeners.clear();
  }
}
