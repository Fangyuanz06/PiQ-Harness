import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { OneBotApiError, OneBotClient } from '../src/onebot-client.ts';
import { SnowLumaTransport, normalizeMessageEvent, normalizePokeEvent, compareCursors, type ConversationEvent, type PokeEvent } from '../src/transport.ts';

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
  const pokes: PokeEvent[] = [];
  const statuses: string[] = [];
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:3001/', accessToken: 'test-token',
    webSocket: FakeWebSocket, reconnect: false, requestTimeoutMs: timeoutMs,
  });
  const transport = new SnowLumaTransport({
    url: 'ws://127.0.0.1:3001/', onMessage: event => messages.push(event),
    onPoke: event => pokes.push(event),
    onStatus: status => statuses.push(status),
  }, client);
  return { transport, client, messages, pokes, statuses, socket: () => FakeWebSocket.instances.at(-1)! };
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

function pokeNotice(overrides: Record<string, unknown> = {}) {
  return { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 10001,
    group_id: 20001, user_id: 10002, target_id: 10001, time: 1_700_000_000, ...overrides };
}

test('poke notices retain real actor, peer and source without inventing message IDs', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().receive(pokeNotice());
  f.socket().receive(pokeNotice());
  f.socket().receive(pokeNotice({ group_id: 0, sender_id: 10001, target_id: 10002 }));
  f.socket().receive(pokeNotice({ group_id: undefined }));
  f.socket().receive(pokeNotice({ group_id: 0, sender_id: 10002, target_id: 10002 }));
  assert.equal(f.messages.length, 0);
  assert.equal(f.pokes.length, 5, 'same-second repeated notices each remain a distinct event');
  assert.deepEqual(f.pokes.map(poke => poke.conversation), [GROUP, GROUP, PRIVATE, PRIVATE, PRIVATE]);
  assert.deepEqual(f.pokes.map(poke => poke.userId), ['10002', '10002', '10001', '10002', '10002']);
  assert.deepEqual(f.pokes.map(poke => poke.outgoing), [false, false, true, false, false]);
  assert.equal(new Set(f.pokes.map(poke => poke.eventId)).size, 5);
  for (const poke of f.pokes) {
    assert.match(poke.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(poke.source, 'notice');
    assert.equal('messageId' in poke, false);
    assert.equal('messageSeq' in poke, false);
  }
  f.transport.close();
  f.socket().receive(pokeNotice());
  assert.equal(f.pokes.length, 5);
});

test('ambiguous private pokes and malformed identities are rejected', () => {
  for (const changes of [
    { group_id: 0, target_id: 10002 }, // No sender_id: outgoing and peer self-poke are ambiguous.
    { group_id: 0, sender_id: 99999 },
    { group_id: 0, sender_id: 10001, target_id: 99999 },
    { group_id: 0, user_id: 10001, sender_id: 10001 },
    { group_id: -1 }, { group_id: 'bad' }, { user_id: 0 }, { target_id: 0 },
    { self_id: 0 }, { time: Number.NaN }, { notice_type: 'group_recall' }, { post_type: 'message' },
  ]) assert.equal(normalizePokeEvent(pokeNotice(changes)), undefined);
});

test('poke actions accept null receipts and cache the login account until reconnect', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10001 } : null;
  assert.deepEqual(await f.transport.poke(GROUP, '10003'), { selfId: '10001', userId: '10003' });
  assert.deepEqual(await f.transport.poke(PRIVATE), { selfId: '10001', userId: '10002' });
  assert.deepEqual(f.socket().sent.map(packet => [packet.action, packet.params]), [
    ['get_login_info', {}], ['group_poke', { group_id: 20001, user_id: 10003 }], ['friend_poke', { user_id: 10002 }],
  ]);
  const old = f.socket(); old.close(); await f.transport.connect();
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10004 } : null;
  assert.deepEqual(await f.transport.poke(PRIVATE), { selfId: '10004', userId: '10002' });
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['get_login_info', 'friend_poke']);
});

test('poke validates target scope and temporary limitations before dispatch', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  await assert.rejects(f.transport.poke(GROUP), /指定有效目标/);
  await assert.rejects(f.transport.poke(GROUP, '0'), /指定有效目标/);
  await assert.rejects(f.transport.poke(PRIVATE, '10003'), /当前对话/);
  await assert.rejects(f.transport.poke(TEMPORARY), /临时会话/);
  assert.equal(f.socket().sent.length, 0);
  f.socket().receive(event()); // A verified event already identifies the account.
  f.socket().dataForAction = () => null;
  await f.transport.poke(PRIVATE, PRIVATE.id);
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['friend_poke']);
});

test('reactions verify the selected group before adding or removing a reaction', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10001 }
    : action === 'get_msg' ? event({ post_type: undefined, self_id: undefined }) : null;
  await f.transport.react(GROUP, -7, '76');
  await f.transport.react(GROUP, -7, '76', false);
  assert.deepEqual(f.socket().sent.filter(packet => packet.action === 'set_msg_emoji_like').map(packet => packet.params), [
    { message_id: -7, emoji_id: '76', set: true }, { message_id: -7, emoji_id: '76', set: false },
  ]);
  f.socket().dataForAction = () => event({ group_id: 20002 });
  await assert.rejects(f.transport.react(GROUP, -7, '76'), /指定对话/);
  await assert.rejects(f.transport.react(PRIVATE, -7, '76'), /仅支持.*群聊/);
  await assert.rejects(f.transport.react(TEMPORARY, -7, '76'), /仅支持.*群聊/);
  assert.equal(f.socket().sent.filter(packet => packet.action === 'set_msg_emoji_like').length, 2);
});

test('recall checks the message ID, sender and explicit conversation instead of trusting a numeric ID', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  let record = event({ user_id: 10001, post_type: undefined, self_id: undefined });
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10001 } : action === 'get_msg' ? record : null;
  await f.transport.recall(GROUP, -7);
  assert.deepEqual(f.socket().sent.at(-1)?.params, { message_id: -7 });
  record = event({ user_id: 10002 });
  await assert.rejects(f.transport.recall(GROUP, -7), /只能撤回/);
  record = event({ user_id: 10001, group_id: 20002 });
  await assert.rejects(f.transport.recall(GROUP, -7), /指定对话/);
  record = event({ user_id: 10001, message_id: -8 });
  await assert.rejects(f.transport.recall(GROUP, -7), /消息 ID/);
  record = event({ user_id: 10001, sender: { user_id: 10002 } });
  await assert.rejects(f.transport.recall(GROUP, -7), /发件者/);
  assert.equal(f.socket().sent.filter(packet => packet.action === 'delete_msg').length, 1);
});

test('private recall requires the real peer and temporary recall requires its source group', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  let record: Record<string, unknown> = event({ message_type: 'private', sub_type: 'friend', group_id: undefined,
    user_id: 10001, target_id: 10002, sender: { user_id: 10001 }, self_id: undefined, post_type: undefined });
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10001 } : action === 'get_msg' ? record : null;
  await f.transport.recall(PRIVATE, -7);
  record = { ...record, target_id: undefined };
  await assert.rejects(f.transport.recall(PRIVATE, -7), /指定对话/);
  record = { ...record, target_id: 10003 };
  await assert.rejects(f.transport.recall(PRIVATE, -7), /指定对话/);
  record = { ...record, target_id: 10002, sub_type: 'group', sender: { user_id: 10001, group_id: 30001 } };
  await assert.rejects(f.transport.recall(PRIVATE, -7), /指定对话/);
  await f.transport.recall(TEMPORARY, -7);
  record = { ...record, sender: { user_id: 10001, group_id: 30002 } };
  await assert.rejects(f.transport.recall(TEMPORARY, -7), /指定对话/);
  assert.equal(f.socket().sent.filter(packet => packet.action === 'delete_msg').length, 2);
});

test('favorite sticker catalog keeps account sticker IDs and sends with the dedicated action', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().dataForAction = action => action === 'fetch_custom_face_detail'
    ? [{ emoji_id: 'account-complete-id', resId: 'resource', md5: 'a'.repeat(32), desc: '收藏表情', url: 'https://example.com/sticker.gif' }]
    : { message_id: -42 };
  assert.deepEqual(await f.transport.listStickers(), [{
    emojiId: 'account-complete-id', md5: 'a'.repeat(32), description: '收藏表情', url: 'https://example.com/sticker.gif',
  }]);
  await f.transport.listStickers(0);
  assert.deepEqual(f.socket().sent[0].params, { count: 48 });
  assert.deepEqual(f.socket().sent[1].params, { count: 0 });
  assert.deepEqual(await f.transport.sendSticker(GROUP, 'account-complete-id', -7), { messageId: '-42' });
  assert.deepEqual(await f.transport.sendSticker(PRIVATE, 'a'.repeat(32)), { messageId: '-42' });
  assert.deepEqual(f.socket().sent.slice(2).map(packet => [packet.action, packet.params]), [
    ['send_custom_face', { emoji_id: 'account-complete-id', group_id: 20001, reply_to: -7 }],
    ['send_custom_face', { emoji_id: 'a'.repeat(32), user_id: 10002 }],
  ]);
  assert.equal(f.socket().sent.some(packet => packet.action === 'send_group_msg' || packet.action === 'send_private_msg'), false);
});

test('sticker and message action inputs are rejected before network access', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  await assert.rejects(f.transport.listStickers(-1), /non-negative/);
  await assert.rejects(f.transport.listStickers(1.5), /non-negative/);
  await assert.rejects(f.transport.sendSticker(TEMPORARY, 'face'), /临时会话/);
  await assert.rejects(f.transport.sendSticker(GROUP, ''), /Emoji ID/);
  await assert.rejects(f.transport.sendSticker(GROUP, 'face', 0), /Message ID/);
  await assert.rejects(f.transport.recall(GROUP, 2 ** 32), /Message ID/);
  await assert.rejects(f.transport.react(GROUP, -7, '\n'), /Emoji ID/);
  assert.equal(f.socket().sent.length, 0);
  f.socket().dataForAction = () => ({ messages: [] });
  await assert.rejects(f.transport.listStickers(), /invalid sticker list/);
  f.socket().dataForAction = () => [{ resId: 'incomplete-identity' }];
  await assert.rejects(f.transport.listStickers(), /Emoji ID/);
});

test('new mutating actions preserve explicit API failures and do not retry unknown outcomes', async t => {
  const f = fixture(15); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().receive(event());
  f.socket().response = { status: 'failed', retcode: 1403, data: { message_id: 0 } };
  await assert.rejects(f.transport.poke(GROUP, '10002'), error => error instanceof OneBotApiError && error.retcode === 1403);
  f.socket().respond = false;
  await assert.rejects(f.transport.poke(PRIVATE), /result is unknown/);
  await assert.rejects(f.transport.sendSticker(GROUP, 'face'), /result is unknown/);
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['group_poke', 'friend_poke', 'send_custom_face']);
});

test('cancellation and session closure prevent actions after read-only scope checks', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().receive(event());
  f.socket().respond = false;
  const controller = new AbortController();
  const recalling = f.transport.recall(GROUP, -7, controller.signal);
  await immediate(); controller.abort(new Error('cancelled fixture'));
  await assert.rejects(recalling, /cancelled fixture/);
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['get_msg']);
  await assert.rejects(f.transport.poke(PRIVATE, undefined, AbortSignal.abort()), /aborted/i);
  assert.equal(f.socket().sent.length, 1);
  const pending = f.transport.poke(PRIVATE);
  await immediate(); f.transport.close();
  await assert.rejects(pending, /result is unknown/);
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['get_msg', 'friend_poke']);
});

test('a connection change invalidates message ownership checks before recall dispatch', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().receive(event());
  const original = f.client.raw.bind(f.client);
  f.client.raw = async function <T>(action: string, params = {}, options = {}): Promise<T> {
    const result = await original<T>(action, params, options);
    if (action === 'get_msg') {
      f.socket().close();
      await f.transport.connect();
    }
    return result;
  };
  const old = f.socket();
  old.dataForAction = () => event({ user_id: 10001 });
  await assert.rejects(f.transport.recall(GROUP, -7), /连接已变化/);
  assert.deepEqual(old.sent.map(packet => packet.action), ['get_msg']);
  assert.equal(f.socket().sent.length, 0);
});

test('group AI speech uses native voice actions and unsupported conversations fail locally', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  f.socket().dataForAction = action => action === 'get_ai_characters'
    ? [{ type: '经典', characters: [{ character_id: 'voice-1', character_name: '示例音色' }] }]
    : { message_id: -77 };
  assert.deepEqual(await f.transport.getVoices(GROUP), [{ type: '经典', characters: [{ id: 'voice-1', name: '示例音色' }] }]);
  assert.deepEqual(await f.transport.speak(GROUP, '晚上好。', 'voice-1'), { messageId: '-77' });
  await assert.rejects(f.transport.getVoices(PRIVATE), /仅支持群聊/);
  await assert.rejects(f.transport.speak(TEMPORARY, 'hello', 'voice-1'), /仅支持群聊/);
  await assert.rejects(f.transport.speak(GROUP, ' ', 'voice-1'), /非空文字/);
  assert.deepEqual(f.socket().sent.map(packet => [packet.action, packet.params]), [
    ['get_ai_characters', { group_id: 20001 }],
    ['send_group_ai_record', { group_id: 20001, character: 'voice-1', text: '晚上好。' }],
  ]);
});

test('QQ transcription first proves the conversation and verifies a real voice segment', async t => {
  const f = fixture(); t.after(() => f.transport.close()); await f.transport.connect();
  let record: Record<string, unknown> = event({ message: [{ type: 'record', data: { file: 'voice.amr' } }] });
  f.socket().dataForAction = action => action === 'get_login_info' ? { user_id: 10001 }
    : action === 'get_msg' ? record : { text: '语音识别内容' };
  assert.deepEqual(await f.transport.transcribe(GROUP, -7), { text: '语音识别内容' });
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['get_login_info', 'get_msg', 'fetch_ptt_text']);
  record = event({ group_id: 20002, message: [{ type: 'record', data: { file: 'voice.amr' } }] });
  await assert.rejects(f.transport.transcribe(GROUP, -7), /指定对话/);
  record = event();
  await assert.rejects(f.transport.transcribe(GROUP, -7), /不包含 QQ 语音/);
  record = event({ message_type: 'private', sub_type: 'friend', group_id: undefined,
    message: [{ type: 'record', data: { file: 'private.amr' } }] });
  assert.deepEqual(await f.transport.transcribe(PRIVATE, -7), { text: '语音识别内容' });
  record = { ...record, sub_type: 'group', sender: { group_id: 30001 } };
  await assert.rejects(f.transport.transcribe(PRIVATE, -7), /指定对话/);
  assert.deepEqual(await f.transport.transcribe(TEMPORARY, -7), { text: '语音识别内容' });
  assert.equal(f.socket().sent.filter(packet => packet.action === 'fetch_ptt_text').length, 3);
});

test('AI voice cancellation, API failures and missing receipts do not trigger another send', async t => {
  const f = fixture(15); t.after(() => f.transport.close()); await f.transport.connect();
  await assert.rejects(f.transport.speak(GROUP, 'hello', 'voice-1', AbortSignal.abort()), /aborted/i);
  f.socket().response = { status: 'failed', retcode: 1403, data: { message_id: 0 } };
  await assert.rejects(f.transport.speak(GROUP, 'hello', 'voice-1'), error => error instanceof OneBotApiError);
  f.socket().respond = false;
  await assert.rejects(f.transport.speak(GROUP, 'hello', 'voice-1'), /result is unknown/);
  assert.deepEqual(f.socket().sent.map(packet => packet.action), ['send_group_ai_record', 'send_group_ai_record']);
});
