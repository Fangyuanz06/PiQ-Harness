import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { OneBotClient } from '../src/onebot-client.ts';
import { SnowLumaTransport, normalizeMessageEvent, compareCursors, type ConversationEvent } from '../src/transport.ts';

const GROUP = { type: 'group', id: '20001' } as const;
const PRIVATE = { type: 'private', id: '10002' } as const;
const TEMPORARY = { type: 'temporary', id: '10002', sourceGroupId: '30001' } as const;

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  respond = true;
  response = { status: 'ok', retcode: 0, data: { message_id: -42 } };
  dataForAction?: (action: string, params: Record<string, unknown>) => unknown;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(data: string) {
    const packet = JSON.parse(data);
    this.sent.push(packet);
    if (this.respond) queueMicrotask(() => this.receive({ ...this.response,
      ...(this.dataForAction ? { data: this.dataForAction(packet.action, packet.params) } : {}), echo: packet.echo }));
  }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function fixture(timeoutMs = 100) {
  const messages: ConversationEvent[] = [];
  const statuses: string[] = [];
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:3001/', accessToken: 'test-token',
    webSocket: FakeWebSocket, reconnect: false, requestTimeoutMs: timeoutMs,
  });
  const transport = new SnowLumaTransport({
    url: 'ws://127.0.0.1:3001/', onMessage: event => messages.push(event),
    onStatus: status => statuses.push(status),
  }, client);
  return { transport, client, messages, statuses, socket: () => FakeWebSocket.instances.at(-1)! };
}

function event(overrides: Record<string, unknown> = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 10001, group_id: 20001,
    user_id: 10002, message_id: -7, message_seq: 9, time: 1_700_000_000,
    sender: { card: '群名片', nickname: '昵称' },
    message: [{ type: 'text', data: { text: 'hello' } }], raw_message: 'hello', ...overrides };
}

test('normalizes group and private messages with distinct conversation identities', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  assert.equal(new URL(f.socket().url).searchParams.get('access_token'), 'test-token');
  f.socket().receive(event());
  f.socket().receive(event({ post_type: 'message_sent', user_id: 10001 }));
  f.socket().receive(event({ message_type: 'private' }));
  f.socket().receive(event({ group_id: '../escape' }));
  f.socket().receive({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
  await immediate();
  assert.equal(f.messages.length, 3);
  assert.equal(f.messages[0].conversation.id, '20001');
  assert.equal(f.messages[0].messageId, '-7');
  assert.equal(f.messages[0].messageSeq, '9');
  assert.equal(f.messages[0].sender, '群名片');
  assert.equal(f.messages[0].outgoing, false);
  assert.equal(f.messages[1].outgoing, true);
  assert.deepEqual(f.messages[0].conversation, GROUP);
  assert.deepEqual(f.messages[2].conversation, PRIVATE);
  assert.deepEqual(f.statuses, ['connected']);
});

test('private self echoes use their peer and temporary messages retain their source group', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  f.socket().receive(event({ message_type: 'private', post_type: 'message_sent', user_id: 10001, target_id: 20001 }));
  f.socket().receive(event({ message_type: 'private', post_type: 'message_sent', user_id: 10001, session_id: 20002 }));
  f.socket().receive(event({ message_type: 'private', post_type: 'message_sent', user_id: 10001 }));
  f.socket().receive(event({ message_type: 'private', sub_type: 'group', group_id: undefined,
    sender: { nickname: 'Temporary peer', group_id: 30001 } }));
  f.socket().receive(event({ message_type: 'private', sub_type: 'group', group_id: undefined,
    sender: { nickname: 'Missing source group' } }));
  await immediate();
  assert.equal(f.messages.length, 3, 'an unattributed self echo must not become a private chat with ourselves');
  assert.deepEqual(f.messages.map(message => message.conversation), [
    { type: 'private', id: '20001' }, { type: 'private', id: '20002' }, TEMPORARY,
  ]);
  assert.equal(f.messages[0].userId, '10001');
  assert.equal(f.messages[0].outgoing, true);
  assert.equal('sourceGroupId' in f.messages[2], false);
  assert.equal(normalizeMessageEvent(event({ message_type: 'guild' })), undefined);
  assert.equal(normalizeMessageEvent(event({ post_type: 'notice' })), undefined);
});

test('sends literal text and quoted replies once, with correlated receipt', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  assert.deepEqual(await f.transport.send(GROUP, { text: '[CQ:at,qq=all]', replyTo: -7 }), { messageId: '-42' });
  assert.equal(f.socket().sent.length, 1);
  assert.deepEqual(f.socket().sent[0].params, {
    group_id: 20001, message: [
      { type: 'reply', data: { id: '-7' } },
      { type: 'text', data: { text: '[CQ:at,qq=all]' } },
    ],
  });
});

test('private and temporary-private replies dispatch to the selected peer rather than its group', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  await f.transport.send({ type: 'private', id: GROUP.id }, { text: '[CQ:at,qq=all]' });
  assert.equal(f.socket().sent[0].action, 'send_private_msg');
  assert.deepEqual(f.socket().sent[0].params, {
    user_id: Number(GROUP.id), message: [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }],
  });
  await f.transport.send(TEMPORARY, { text: 'temp reply', replyTo: -7 });
  assert.equal(f.socket().sent[1].action, 'send_private_msg');
  assert.deepEqual(f.socket().sent[1].params, {
    user_id: Number(PRIVATE.id), group_id: 30001,
    message: [{ type: 'reply', data: { id: '-7' } }, { type: 'text', data: { text: 'temp reply' } }],
  });
  await assert.rejects(f.transport.send({ ...TEMPORARY, sourceGroupId: '../escape' }, { text: 'bad' }));
  assert.equal(f.socket().sent.length, 2);
});

test('the same peer has separate normal-private and source-scoped temporary conversations', () => {
  const ordinary = normalizeMessageEvent(event({ message_type: 'private', sub_type: 'friend' }))!;
  const temporary = normalizeMessageEvent(event({ message_type: 'private', sub_type: 'group', group_id: 30001 }))!;
  const otherGroup = normalizeMessageEvent(event({ message_type: 'private', sub_type: 'group', group_id: 30002 }))!;
  assert.deepEqual(ordinary.conversation, PRIVATE);
  assert.deepEqual(temporary.conversation, TEMPORARY);
  assert.deepEqual(otherGroup.conversation, { ...TEMPORARY, sourceGroupId: '30002' });
  assert.notDeepEqual(ordinary.conversation, temporary.conversation);
});

test('temporary history is rejected before any friend-history or login action', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  await assert.rejects(f.transport.fetchHistory(TEMPORARY, null, 20), /临时会话不支持历史补拉/);
  assert.equal(f.socket().sent.length, 0);
});

test('history uses inclusive forward anchors and normalizes own records without self_id', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  let loginCalls = 0;
  const calls: unknown[] = [];
  f.socket().dataForAction = (action, params) => {
    if (action === 'get_login_info') { loginCalls++; return { user_id: 10001, nickname: 'Bot' }; }
    assert.equal(action, 'get_group_msg_history');
    calls.push(params);
    return { messages: [
      { ...event({ message_id: -8, message_seq: 10, user_id: 10001 }), self_id: undefined, post_type: undefined },
      { ...event(), self_id: undefined, post_type: undefined },
    ] };
  };
  const records = await f.transport.fetchHistory(GROUP, { messageId: '-7', messageSeq: '9', time: 1_700_000_000 }, 100);
  assert.deepEqual(calls[0], { group_id: 20001, count: 100, message_id: -7, reverse_order: false });
  assert.deepEqual(records.map(record => record.messageSeq), ['9', '10']);
  assert.equal(records[1]!.outgoing, true);
  assert.equal(records[1]!.selfId, '10001');
  await f.transport.fetchHistory(GROUP, null, 20);
  assert.equal(loginCalls, 1);
  assert.deepEqual(calls[1], { group_id: 20001, count: 20 });
  f.transport.close();
  await assert.rejects(f.transport.fetchHistory(GROUP, null, 20), /disconnected/);
});

test('private history uses the peer API and preserves sender-local sequence ordering', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  const calls: unknown[] = [];
  f.socket().dataForAction = (action, params) => {
    if (action === 'get_login_info') return { user_id: 10001, nickname: 'Bot' };
    assert.equal(action, 'get_friend_msg_history');
    calls.push(params);
    return { messages: [
      { ...event({ message_type: 'private', message_id: -11, message_seq: 10000, time: 100 }), self_id: undefined },
      { ...event({ message_type: 'private', message_id: -12, message_seq: 4, user_id: 10001, time: 101 }), self_id: undefined, post_type: undefined },
      { ...event({ message_type: 'private', sub_type: 'group', message_id: -99, time: 101, sender: { group_id: 30001 } }), self_id: undefined },
      { ...event({ message_type: 'private', message_id: -13, message_seq: 10001, time: 101 }), self_id: undefined },
    ] };
  };
  const records = await f.transport.fetchHistory(PRIVATE, { messageId: '-11', messageSeq: '10000', time: 100 }, 100);
  assert.deepEqual(calls[0], { user_id: 10002, count: 100, message_id: -11, reverse_order: false });
  assert.deepEqual(records.map(record => record.messageId), ['-11', '-12', '-13']);
  assert.deepEqual(records.map(record => record.conversation), [PRIVATE, PRIVATE, PRIVATE]);
  assert.equal(records[1].outgoing, true);
  assert.equal(compareCursors(records[1], records[2], 'private'), 0);
  await f.transport.fetchHistory(PRIVATE, null, 20);
  assert.deepEqual(calls[1], { user_id: 10002, count: 20 });
  f.socket().dataForAction = () => ({ messages: [event({ message_type: 'private', user_id: 99998 })] });
  await assert.rejects(f.transport.fetchHistory(PRIVATE, null, 20), /another conversation/);
});

test('sends local image bytes as standard base64 image segments in one message', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const directory = await mkdtemp(join(tmpdir(), 'piq-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sticker.png');
  await writeFile(path, 'image-bytes');
  await f.transport.connect();
  await f.transport.send(GROUP, { text: '贴图', images: [path] });
  assert.equal(f.socket().sent.length, 1);
  const encodedImage = `base64://${Buffer.from('image-bytes').toString('base64')}`;
  assert.equal(f.socket().sent[0].action, 'send_group_msg');
  assert.deepEqual(f.socket().sent[0].params.message, [
    { type: 'text', data: { text: '贴图' } },
    { type: 'image', data: { file: encodedImage } },
  ]);
  await f.transport.send(PRIVATE, { text: '私聊图片', images: [path] });
  assert.equal(f.socket().sent.length, 2);
  assert.equal(f.socket().sent[1].action, 'send_private_msg');
  assert.deepEqual(f.socket().sent[1].params, {
    user_id: Number(PRIVATE.id), message: [
      { type: 'text', data: { text: '私聊图片' } },
      { type: 'image', data: { file: encodedImage } },
    ],
  });
});

test('timeout is an unknown result and does not resend', async t => {
  const f = fixture(15); t.after(() => f.transport.close());
  await f.transport.connect();
  f.socket().respond = false;
  await assert.rejects(f.transport.send(GROUP, { text: 'only once' }), /result is unknown/);
  assert.equal(f.socket().sent.length, 1);
});

test('image preparation failures and cancellation prevent the message action', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  await assert.rejects(f.transport.send(GROUP, { text: 'with image', images: [join(tmpdir(), 'piq-missing-directory', 'missing.png')] }), /ENOENT/);
  await assert.rejects(f.transport.send(GROUP, { text: 'cancelled' }, AbortSignal.abort()), /aborted/i);
  assert.equal(f.socket().sent.length, 0);
});

test('closing while opening a local image prevents sending and reconnecting', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const directory = await mkdtemp(join(tmpdir(), 'piq-transport-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sticker.png');
  await writeFile(path, 'image-bytes');
  await f.transport.connect();
  const socketsBefore = FakeWebSocket.instances.length;
  const sending = f.transport.send(GROUP, { images: [path] });
  f.transport.close();
  await assert.rejects(sending, /aborted|closed/);
  assert.equal(FakeWebSocket.instances.length, socketsBefore);
  assert.equal(f.socket().sent.length, 0);
});

test('an unsuccessful first connection can recover automatically and closes cleanly', async t => {
  let attempts = 0;
  class RetrySocket extends EventTarget {
    readyState = 0;
    constructor(_url: string) {
      super();
      const attempt = ++attempts;
      queueMicrotask(() => {
        if (attempt === 1) this.close();
        else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(_data: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const statuses: string[] = [];
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:9/', webSocket: RetrySocket,
    reconnect: true,
  });
  const transport = new SnowLumaTransport({
    url: 'ws://127.0.0.1:9/', onMessage() {}, onStatus: status => statuses.push(status),
  }, client);
  t.after(() => transport.close());
  await assert.rejects(transport.connect(), /disconnected/);
  const deadline = Date.now() + 3000;
  while (!client.isConnected && Date.now() < deadline) await delay(5);
  assert.equal(client.isConnected, true);
  assert.deepEqual(statuses, ['disconnected', 'connected']);
  assert.equal(attempts, 2);
  transport.close();
  await delay(10);
  assert.equal(attempts, 2);
});

test('an initial send waits for connection and a disconnect after dispatch is not replayed', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.send(GROUP, { text: 'wait for startup' });
  assert.equal(f.transport.isConnected, true);
  assert.equal(f.socket().sent.length, 1);
  f.socket().respond = false;
  const pending = f.transport.send(GROUP, { text: 'disconnected' });
  await immediate();
  f.socket().close();
  await assert.rejects(pending, /result is unknown/);
  assert.deepEqual(f.statuses, ['connected', 'disconnected']);
  assert.equal(f.socket().sent.length, 2);
});

test('a send after a dropped connection reconnects before dispatching once', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  const oldSocket = f.socket();
  oldSocket.close();
  assert.equal(f.transport.isConnected, false);
  await f.transport.send(GROUP, { text: 'new message after reconnect' });
  assert.notEqual(f.socket(), oldSocket);
  assert.equal(oldSocket.sent.length, 0);
  assert.equal(f.socket().sent.length, 1);
  assert.equal(f.transport.isConnected, true);
});

test('unavailable endpoint fails before dispatch with bounded, credential-free diagnostics', async t => {
  let sends = 0;
  class UnavailableSocket extends EventTarget {
    readyState = 0;
    constructor(_url: string) { super(); queueMicrotask(() => this.close()); }
    send() { sends++; }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:9/', webSocket: UnavailableSocket, reconnect: false,
  });
  const transport = new SnowLumaTransport({
    url: 'ws://person:private-password@127.0.0.1:9/?access_token=private-token',
    connectionTimeoutMs: 20, onMessage() {}, onStatus() {},
  }, client);
  t.after(() => transport.close());
  await assert.rejects(transport.send(GROUP, { text: 'should not leave' }), error => {
    assert.match(String(error), /无法连接 SnowLuma.*127\.0\.0\.1:9.*消息未发送/);
    assert.doesNotMatch(String(error), /private-password|private-token|person/);
    return true;
  });
  assert.equal(sends, 0);
});

test('waiting for connection is cancelled by the caller and by session closure', async t => {
  let sends = 0;
  class OpeningSocket extends EventTarget {
    readyState = 0;
    constructor(_url: string) { super(); }
    send() { sends++; }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const client = new OneBotClient({ url: 'ws://127.0.0.1:9/', webSocket: OpeningSocket, reconnect: false });
  const transport = new SnowLumaTransport({
    url: 'ws://127.0.0.1:9/', connectionTimeoutMs: 1000, onMessage() {}, onStatus() {},
  }, client);
  t.after(() => transport.close());
  const caller = new AbortController();
  const first = transport.send(GROUP, { text: 'cancelled' }, caller.signal);
  caller.abort(new Error('cancelled by caller'));
  await assert.rejects(first, /cancelled by caller/);
  const second = transport.send(GROUP, { text: 'closed' });
  transport.close();
  await assert.rejects(second, /closed/);
  assert.equal(sends, 0);
});

test('API rejection stays an explicit rejection; closing removes listeners', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  await f.transport.connect();
  f.socket().response = { status: 'failed', retcode: 403, data: { message_id: 0 } };
  await assert.rejects(f.transport.send(GROUP, { text: 'rejected' }), /retcode 403/);
  f.transport.close();
  f.socket().receive(event());
  await immediate();
  assert.equal(f.messages.length, 0);
  await assert.rejects(f.transport.connect(), /closed/);
});
