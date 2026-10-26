import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { OneBotApiError, OneBotClient, type OneBotSocket } from '../src/onebot-client.ts';

type Packet = { action: string; params: Record<string, unknown>; echo: string };

class FakeSocket extends EventTarget implements OneBotSocket {
  static instances: FakeSocket[] = [];
  static autoOpen = true;
  readonly url: string;
  readyState = 0;
  sent: Packet[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
    if (FakeSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(data: unknown) { this.frame(JSON.stringify(data)); }
  frame(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function fake(options: Partial<ConstructorParameters<typeof OneBotClient>[0]> = {}) {
  const client = new OneBotClient({ url: 'ws://127.0.0.1:9/', webSocket: FakeSocket, reconnect: false, ...options });
  const socket = () => FakeSocket.instances.at(-1)!;
  return { client, socket };
}

function receipt(socket: FakeSocket, index: number, data: unknown = { index }) {
  socket.receive({ status: 'ok', retcode: 0, data, echo: socket.sent[index].echo });
}

// A small independent WebSocket test endpoint. It implements only the text frames
// used here and does not use a QQ backend or a third-party protocol SDK.
function textFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(body.length < 126 ? 2 : 4);
  head[0] = 0x81;
  if (body.length < 126) head[1] = body.length;
  else { head[1] = 126; head.writeUInt16BE(body.length, 2); }
  return Buffer.concat([head, body]);
}

test('native WebSocket authenticates and correlates interleaved receipts and events', async t => {
  const server = createServer();
  const sockets = new Set<Socket>();
  const requests: Packet[] = [];
  let requestUrl = '';
  server.on('upgrade', (request, socket) => {
    const peer = socket as Socket;
    sockets.add(peer);
    peer.on('close', () => sockets.delete(peer));
    peer.on('error', () => {});
    requestUrl = request.url!;
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let input = Buffer.alloc(0);
    peer.on('data', chunk => {
      input = Buffer.concat([input, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (input.length >= 2) {
        const opcode = input[0] & 15;
        const masked = (input[1] & 128) !== 0;
        let length = input[1] & 127;
        let offset = 2;
        if (length === 126) { if (input.length < 4) return; length = input.readUInt16BE(2); offset = 4; }
        assert.notEqual(length, 127, 'test messages fit in a 16-bit frame');
        const maskLength = masked ? 4 : 0;
        if (input.length < offset + maskLength + length) return;
        const payload = Buffer.from(input.subarray(offset + maskLength, offset + maskLength + length));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= input[offset + i % 4];
        input = input.subarray(offset + maskLength + length);
        if (opcode === 8) { peer.end(); return; }
        if (opcode !== 1) continue;
        requests.push(JSON.parse(payload.toString('utf8')));
        if (requests.length === 2) {
          peer.write(textFrame({ post_type: 'message', message_type: 'group', raw_message: 'fixture' }));
          for (const packet of [...requests].reverse()) peer.write(textFrame({
            status: 'ok', retcode: 0, data: { action: packet.action }, echo: packet.echo,
          }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const client = new OneBotClient({ url: `ws://127.0.0.1:${port}/?existing=yes`, accessToken: 'fake token&value', reconnect: false });
  t.after(() => client.close());
  const events: unknown[] = [];
  client.on('message', event => events.push(event));
  await client.connect();
  const [login, status] = await Promise.all([client.raw('get_login_info'), client.raw('get_status')]);
  assert.deepEqual(login, { action: 'get_login_info' });
  assert.deepEqual(status, { action: 'get_status' });
  assert.equal(new URL(requestUrl, 'http://localhost').searchParams.get('access_token'), 'fake token&value');
  assert.equal(new URL(requestUrl, 'http://localhost').searchParams.get('existing'), 'yes');
  assert.equal(events.length, 1);
  assert.notEqual(requests[0].echo, requests[1].echo);
});

test('concurrent connects share one socket and event subscriptions can be removed', async t => {
  const f = fake(); t.after(() => f.client.close());
  const events: unknown[] = [];
  const unsubscribe = f.client.on('message', event => events.push(event));
  const first = f.client.connect();
  const socket = f.socket();
  assert.equal(f.client.connect(), first);
  await first;
  assert.equal(f.client.isConnected, true);
  socket.receive({ status: 'ok', retcode: 0, data: {}, echo: 'unrelated' });
  socket.receive({ post_type: 'notice', notice_type: 'fixture' });
  unsubscribe();
  socket.receive({ post_type: 'message' });
  assert.deepEqual(events, [{ post_type: 'notice', notice_type: 'fixture' }]);
  await f.client.connect();
  assert.equal(f.socket(), socket);
});

test('API failure reports retcode without exposing untrusted server messages', async t => {
  const f = fake(); t.after(() => f.client.close()); await f.client.connect();
  const failed = f.client.raw('send_group_msg', { group_id: 123 });
  f.socket().receive({ status: 'failed', retcode: 1403, data: null, message: 'fake-secret', echo: f.socket().sent[0].echo });
  await assert.rejects(failed, error => error instanceof OneBotApiError
    && error.retcode === 1403 && error.action === 'send_group_msg' && !error.message.includes('fake-secret'));
  const accepted = f.client.raw('send_group_msg');
  f.socket().receive({ status: 'async', retcode: 1, data: null, echo: f.socket().sent[1].echo });
  await assert.rejects(accepted, error => error instanceof Error && !(error instanceof OneBotApiError) && /unknown/.test(error.message));
});

test('malformed correlated receipts fail only their request', async t => {
  const f = fake(); t.after(() => f.client.close()); await f.client.connect();
  const invalid = f.client.raw('get_status');
  const valid = f.client.raw('get_login_info');
  f.socket().receive({ status: 'ok', retcode: '0', data: {}, echo: f.socket().sent[0].echo });
  receipt(f.socket(), 1, { user_id: 123 });
  await assert.rejects(invalid, /invalid API receipt/);
  assert.deepEqual(await valid, { user_id: 123 });
  assert.equal(f.client.isConnected, true);
});

test('non-JSON frames close the connection and settle outstanding requests', async t => {
  const f = fake(); t.after(() => f.client.close()); await f.client.connect();
  const errors: Error[] = [];
  f.client.on('error', error => errors.push(error));
  const pending = f.client.raw('get_status');
  f.socket().frame('{bad json including fake-secret');
  await assert.rejects(pending, /invalid JSON frame/);
  assert.equal(f.client.isConnected, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message.includes('fake-secret'), false);
});

test('abort, timeout and late receipts clean up without replaying requests', async t => {
  const f = fake({ requestTimeoutMs: 20 }); t.after(() => f.client.close()); await f.client.connect();
  const abort = new AbortController();
  const aborted = f.client.raw('send_group_msg', {}, { signal: abort.signal });
  abort.abort(new Error('cancelled by fixture'));
  await assert.rejects(aborted, /cancelled by fixture/);
  receipt(f.socket(), 0);
  await assert.rejects(f.client.raw('get_status', {}, { signal: abort.signal }), /cancelled by fixture/);
  assert.equal(f.socket().sent.length, 1, 'a pre-aborted request never reaches the socket');
  await assert.rejects(f.client.raw('send_private_msg'), /timed out.*unknown/);
  receipt(f.socket(), 1);
  assert.equal(f.socket().sent.length, 2);
  const fresh = f.client.raw('get_status');
  receipt(f.socket(), 2, { online: true });
  assert.deepEqual(await fresh, { online: true });
});

test('disconnect rejects pending actions; reconnect never replays them', async t => {
  const f = fake(); t.after(() => f.client.close()); await f.client.connect();
  const before = f.socket();
  const pending = f.client.raw('send_group_msg');
  before.close();
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(f.client.raw('send_group_msg'), /disconnected/);
  await f.client.connect();
  const after = f.socket();
  assert.notEqual(after, before);
  assert.equal(after.sent.length, 0);
  const next = f.client.raw('get_status');
  receipt(after, 0);
  await next;
  assert.notEqual(after.sent[0].echo, before.sent[0].echo);
});

test('automatic reconnect opens a fresh connection and close cancels future reconnects', async t => {
  const f = fake({ reconnect: true }); t.after(() => f.client.close()); await f.client.connect();
  const before = f.socket();
  before.close();
  await delay(550);
  assert.notEqual(f.socket(), before);
  assert.equal(f.client.isConnected, true);
  const last = f.socket();
  f.client.close();
  await delay(550);
  assert.equal(f.socket(), last);
  assert.equal(last.readyState, 3);
  await assert.rejects(f.client.connect(), /closed/);
});

test('connection timeout and explicit close settle in-flight handshakes', async t => {
  FakeSocket.autoOpen = false;
  t.after(() => { FakeSocket.autoOpen = true; });
  const timed = fake({ connectionTimeoutMs: 20 }); t.after(() => timed.client.close());
  await assert.rejects(timed.client.connect(), /connection timed out/);
  assert.equal(timed.socket().readyState, 3);
  const closed = fake();
  const connecting = closed.client.connect();
  closed.client.close();
  await assert.rejects(connecting, /closed/);
  closed.socket().open();
  await immediate();
  assert.equal(closed.client.isConnected, false);
});

test('configuration and socket construction errors hide URL credentials', async () => {
  assert.throws(() => new OneBotClient({ url: 'http://localhost/?fake-secret' }), /requires a ws/);
  assert.throws(() => new OneBotClient({ url: 'ws://name:fake-secret@localhost/' }), /without user info/);
  const throwing = class extends FakeSocket { constructor(_url: string) { throw new Error('fake-secret'); super(''); } };
  const client = new OneBotClient({ url: 'ws://localhost/?access_token=fake-secret', webSocket: throwing, reconnect: false });
  await assert.rejects(client.connect(), error => error instanceof Error && !String(error).includes('fake-secret'));
  client.close();
});
