import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionError } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  type FauxResponseStep } from '@earendil-works/pi-ai';
import { initializeGroup } from '../src/config.ts';
import { GroupStore } from '../src/store.ts';
import { normalizeMessageEvent } from '../src/transport.ts';
import { readRuntimeStatus, requestRunAction } from '../src/run-control.ts';

function message(id: number, text = 'The same text is allowed twice') {
  return { post_type: 'message', message_type: 'group', self_id: 99999, group_id: 123455,
    user_id: 88888, message_id: id, message_seq: id, time: 1_700_000_000,
    sender: { nickname: 'Local test' }, message: [{ type: 'text', data: { text } }], raw_message: text };
}

class LocalSocket extends EventTarget {
  static instances: LocalSocket[] = [];
  static autoOpen = true;
  static history: ReturnType<typeof message>[] = [];
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  constructor(_url: string) {
    super(); LocalSocket.instances.push(this);
    if (LocalSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(data: string) {
    const packet = JSON.parse(data); this.sent.push(packet);
    const index = LocalSocket.history.findIndex(record => record.message_id === packet.params.message_id);
    const records = packet.params.message_id ? LocalSocket.history.slice(Math.max(0, index)) : LocalSocket.history.slice(-20);
    const result = packet.action === 'get_login_info' ? { user_id: 99999 }
      : packet.action === 'get_group_msg_history' ? { messages: records } : { message_id: -900 };
    queueMicrotask(() => this.receive({ status: 'ok', retcode: 0, data: result, echo: packet.echo }));
  }
}

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

async function fixture(t: TestContext, responses: FauxResponseStep[], options: { offline?: boolean; pending?: boolean } = {}) {
  const oldAutostart = process.env.PIQ_SNOWLUMA_AUTOSTART;
  process.env.PIQ_SNOWLUMA_AUTOSTART = '0';
  t.after(() => { if (oldAutostart === undefined) delete process.env.PIQ_SNOWLUMA_AUTOSTART; else process.env.PIQ_SNOWLUMA_AUTOSTART = oldAutostart; });
  LocalSocket.instances = []; LocalSocket.autoOpen = !options.offline; LocalSocket.history = [];
  const parent = join(process.cwd(), '.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'pi-run-control-'));
  const cfg = { id: '123455', name: 'Runtime test group', conversations: [{ type: 'group' as const, id: '123455' }] };
  const cwd = await initializeGroup(root, cfg.id, cfg);
  await writeFile(join(cwd, 'PIQ.md'), '# Test\n```json\n' + JSON.stringify({ ...cfg,
    wsUrl: 'ws://127.0.0.1:9/', accessTokenEnv: 'PIQ_TEST_UNUSED_TOKEN', quietMs: 40, maxWaitMs: 100, minIntervalMs: 0 }) + '\n```\n');
  if (options.pending) {
    LocalSocket.history = [message(1, 'Previously collected message')];
    const store = await GroupStore.open(cwd, cfg);
    await store.append(normalizeMessageEvent(LocalSocket.history[0]!)!); await store.close();
  }
  const previousSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: LocalSocket, configurable: true, writable: true });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No model network in integration tests.'); });
  const agentDir = join(root, 'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager }); await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = fauxProvider({ provider: 'piq-pause-local', tokensPerSecond: 1_000_000 }); faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, '.pi', 'sessions')) });
  const errors: ExtensionError[] = [];
  const notices: string[] = [];
  t.mock.method(session.extensionRunner.createContext().ui, 'notify', (text: string) => notices.push(text));
  t.after(async () => {
    try { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    finally {
      if (previousSocket) Object.defineProperty(globalThis, 'WebSocket', previousSocket);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      await rm(root, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  await eventually(() => LocalSocket.instances.length > 0, 'a test socket');
  const socket = LocalSocket.instances.at(-1)!;
  if (!options.offline) await eventually(async () => (await readRuntimeStatus(cwd))?.connection === 'connected', 'connected runtime');
  return { cwd, session, faux, socket, errors, notices };
}

test('real Pi pauses automatic wakeups and sending, keeps records, then resumes one aggregated signal', async t => {
  const f = await fixture(t, [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: 'group:123455', text: 'must not be sent during pause' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Paused sending was blocked.'),
    fauxAssistantMessage('Now considering the accumulated messages.'),
  ]);
  const pause = await requestRunAction(f.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId, 'pause receipt');
  assert.equal((await readRuntimeStatus(f.cwd))?.paused, true);
  for (let index = 1; index <= 4; index++) f.socket.receive(message(index));
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.pendingCount === 4, 'messages saved while paused');
  await delay(150);
  assert.equal(f.faux.state.callCount, 0);
  // Explicit terminal input may run, but the channel must still refuse external sends.
  await f.session.prompt('Check paused sending using qq_send.');
  assert.equal(f.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
  assert.match(JSON.stringify(f.session.messages), /PiQ 已暂停/);
  const resume = await requestRunAction(f.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId, 'resume receipt');
  await eventually(() => f.faux.state.callCount === 3 && f.session.isIdle, 'one resumed model run');
  assert.equal(f.session.messages.filter(item => item.role === 'custom' && item.customType === 'piq:messages').length, 1);
  assert.match(JSON.stringify(f.session.messages), /4 条新消息/);
  const directory = join(f.cwd, 'messages', 'group', '123455');
  const files = await readdir(directory);
  assert.equal((await readFile(join(directory, files[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)).length, 4);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
});

test('real Pi does not wake for persisted messages while SnowLuma is disconnected', async t => {
  const f = await fixture(t, [fauxAssistantMessage('The connection is ready now.')], { offline: true, pending: true });
  await delay(250);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.session.messages.filter(item => item.role === 'custom').length, 0);
  f.socket.open();
  await eventually(() => f.faux.state.callCount === 1 && f.session.isIdle, 'notification after connection');
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
});

test('pausing an active Pi run aborts it and resume continues even without new group messages', async t => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, [
    async () => { await gate; return fauxAssistantMessage('This response was interrupted.'); },
    fauxAssistantMessage('The interrupted work can now continue.'),
  ]);
  try {
    f.socket.receive(message(10, 'Start one run'));
    await eventually(() => f.faux.state.callCount === 1 && !f.session.isIdle, 'the first run to become busy');
    const pause = await requestRunAction(f.cwd, 'pause');
    await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId, 'pause during active run');
    release();
    await eventually(() => f.session.isIdle, 'the aborted run to settle');
    assert.ok(f.session.messages.some(item => item.role === 'assistant' && item.stopReason === 'aborted'));
    assert.equal((await readRuntimeStatus(f.cwd))?.pendingCount, 0);
    const resume = await requestRunAction(f.cwd, 'resume');
    await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId, 'resume acknowledgement');
    await eventually(() => f.faux.state.callCount === 2 && f.session.isIdle, 'continuation without another QQ message');
    assert.equal(f.session.messages.filter(item => item.role === 'custom' && item.customType === 'piq:resume').length, 1);
    assert.equal(f.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.notices, []);
  } finally { release(); }
});
