import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionError,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { initializeGroup, loadConfig } from '../src/config.ts';
import { GroupStore } from '../src/store.ts';
import { normalizeMessageEvent } from '../src/transport.ts';
import { conversationKey, type Conversation } from '../src/conversations.ts';

/** Fake only the network boundary: Pi and SnowLuma both run their real implementations. */
class LocalSocket extends EventTarget {
  static instances: LocalSocket[] = [];
  static history = new Map<string, Array<Record<string, unknown>>>();
  readyState = 0;
  readonly url: string;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];

  constructor(url: string) {
    super();
    this.url = url;
    LocalSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    const packet = JSON.parse(data);
    this.sent.push(packet);
    const key = packet.action === 'get_friend_msg_history' ? `private:${packet.params.user_id}` : `group:${packet.params.group_id}`;
    const records = LocalSocket.history.get(key) ?? [];
    const anchor = records.findIndex(record => record.message_id === packet.params.message_id);
    const messages = packet.params.message_id
      ? anchor < 0 ? [] : records.slice(anchor, anchor + packet.params.count)
      : records.slice(-packet.params.count);
    const result = packet.action === 'get_login_info' ? { user_id: 99999, nickname: 'Test bot' }
      : ['get_group_msg_history', 'get_friend_msg_history'].includes(packet.action) ? { messages } : { message_id: -900 };
    queueMicrotask(() => this.receive({
      status: 'ok', retcode: 0, data: result, echo: packet.echo,
    }));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function groupMessage(groupId: string, messageId: number, text: string) {
  return {
    post_type: 'message', message_type: 'group', self_id: 99999,
    group_id: Number(groupId), user_id: 88888, message_id: messageId,
    message_seq: messageId, time: 1_700_000_000,
    sender: { nickname: 'Test member' },
    message: [{ type: 'text', data: { text } }], raw_message: text,
  };
}

function privateMessage(userId: string, messageId: number, text: string) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 99999,
    user_id: Number(userId), message_id: messageId, message_seq: messageId, time: 1_700_000_000,
    sender: { nickname: 'Private member' }, message: [{ type: 'text', data: { text } }], raw_message: text };
}

function temporaryMessage(groupId: string, userId: string, messageId: number, text: string) {
  return { ...privateMessage(userId, messageId, text), sub_type: 'group',
    sender: { nickname: 'Temporary member', group_id: Number(groupId) } };
}

const messagesDirectory = (cwd: string, conversation: Conversation) => join(cwd, 'messages', conversation.type, conversation.id);

async function eventually(check: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const oldAutostart = process.env.PIQ_SNOWLUMA_AUTOSTART;
  process.env.PIQ_SNOWLUMA_AUTOSTART = '0';
  t.after(() => { if (oldAutostart === undefined) delete process.env.PIQ_SNOWLUMA_AUTOSTART; else process.env.PIQ_SNOWLUMA_AUTOSTART = oldAutostart; });
  LocalSocket.history.clear();
  // Windows Codex's virtualized OS temp denies rename; the channel uses atomic rename for receipts.
  const tempRoot = join(process.cwd(), '.test-tmp');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'pi-host-'));
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: LocalSocket, configurable: true, writable: true });
  // Any accidental model/catalog HTTP call fails locally instead of using credentials or the network.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network access is disabled in Pi integration tests'); });
  const sessions: AgentSession[] = [];
  t.after(async () => {
    try {
      for (const session of sessions.reverse()) {
        await session.abort();
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
    } finally {
      if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      await rm(root, { recursive: true, force: true });
    }
  });

  async function host(groupId: string, marker: string, responses: FauxResponseStep[], prepare?: (cwd: string) => Promise<void>, conversations: Conversation[] = [{ type: 'group', id: groupId }], quietMs = 60) {
    const cfg = { id: groupId, name: groupId, conversations };
    const cwd = await initializeGroup(root, groupId, cfg);
    await prepare?.(cwd);
    await writeFile(join(cwd, 'AGENTS.md'), `# This group's instructions\n\n${marker}\n`);
    await writeFile(join(cwd, 'PIQ.md'), '# Connection\n\n```json\n' + JSON.stringify({
      ...cfg, wsUrl: 'ws://127.0.0.1:9/', accessTokenEnv: 'PIQ_TEST_UNUSED_TOKEN',
      quietMs, maxWaitMs: Math.max(200, quietMs * 2), minIntervalMs: 0,
    }) + '\n```\n');
    const agentDir = join(root, `agent-${groupId}`);
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false },
    }));
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    // Load the actual package configured by initializeGroup, including its extension manifest.
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const faux = fauxProvider({ provider: `piq-test-${groupId}`, tokensPerSecond: 1_000_000 });
    faux.setResponses(responses);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, '.pi', 'sessions')),
    });
    sessions.push(session);
    const errors: ExtensionError[] = [];
    const notifications: string[] = [];
    const ui = session.extensionRunner.createContext().ui;
    t.mock.method(ui, 'notify', (message: string) => { notifications.push(message); });
    const socketsBefore = LocalSocket.instances.length;
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    await eventually(() => LocalSocket.instances.length > socketsBefore, 'the group WebSocket');
    const socket = LocalSocket.instances.at(-1)!;
    await eventually(() => socket.readyState === 1, 'the local socket to open');
    return { cwd, session, faux, socket, errors, notifications };
  }

  return { root, host };
}

test('real Pi loads per-group Markdown, receives a signal, reads records and sends only explicit replies', async t => {
  const f = await fixture(t);
  const firstGroup = '123401';
  const secondGroup = '123402';
  const firstMarker = 'PERSONA_ONLY_FOR_FIRST_GROUP';
  const secondMarker = 'PERSONA_ONLY_FOR_SECOND_GROUP';
  const firstBody = 'FIRST_GROUP_MESSAGE_BODY';
  const secondBody = 'SECOND_GROUP_MESSAGE_BODY';
  const requests: string[] = [];
  const first = await f.host(firstGroup, firstMarker, [
    async context => {
      requests.push(JSON.stringify(context));
      const files = await readdir(messagesDirectory(join(f.root, firstGroup), { type: 'group', id: firstGroup }));
      assert.equal(files.filter(file => file.endsWith('.jsonl')).length, 1);
      return fauxAssistantMessage(fauxToolCall('read', { path: join('messages', 'group', firstGroup, files[0]!) }), { stopReason: 'toolUse' });
    },
    context => {
      requests.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `group:${firstGroup}`, text: 'An explicitly chosen reply' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('This ordinary assistant response belongs only in Pi.'),
  ]);
  const second = await f.host(secondGroup, secondMarker, [fauxAssistantMessage('No reply needed.')]);
  assert.match(first.session.systemPrompt, new RegExp(firstMarker));
  assert.doesNotMatch(first.session.systemPrompt, new RegExp(secondMarker));
  assert.match(second.session.systemPrompt, new RegExp(secondMarker));
  assert.doesNotMatch(second.session.systemPrompt, new RegExp(firstMarker));
  assert.ok(first.session.getActiveToolNames().includes('qq_send'));

  for (let index = 1; index <= 3; index++) {
    first.socket.receive(groupMessage(firstGroup, index, `${firstBody} ${index}`));
  }
  first.socket.receive(groupMessage(secondGroup, 20, secondBody));
  second.socket.receive(groupMessage(firstGroup, 30, firstBody));
  second.socket.receive(groupMessage(secondGroup, 40, secondBody));
  await eventually(() => first.faux.state.callCount === 3 && second.faux.state.callCount === 1
    && first.session.isIdle && second.session.isIdle, 'both local model runs to settle');

  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(first.notifications, []);
  assert.deepEqual(second.notifications, []);
  const signals = first.session.messages.filter(message => message.role === 'custom');
  assert.equal(signals.length, 1, 'the burst should produce one context signal');
  assert.doesNotMatch(JSON.stringify(signals), new RegExp(firstBody));
  assert.doesNotMatch(requests[0]!, new RegExp(firstBody));
  assert.match(requests[1]!, new RegExp(firstBody), 'the model obtains message content via the built-in read tool');
  assert.doesNotMatch(JSON.stringify(first.session.messages), new RegExp(secondBody));
  assert.doesNotMatch(JSON.stringify(second.session.messages), new RegExp(firstBody));
  const replies = first.socket.sent.filter(packet => packet.action === 'send_group_msg');
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0]!.params, {
    group_id: Number(firstGroup), message: [{ type: 'text', data: { text: 'An explicitly chosen reply' } }],
  });
  assert.equal(second.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
  assert.match(JSON.stringify(first.session.messages), /-900/, 'the send receipt returns to Pi');
  assert.notEqual(first.session.sessionFile, second.session.sessionFile);
  assert.ok(first.session.sessionFile!.startsWith(join(first.cwd, '.pi', 'sessions')));
  assert.ok(second.session.sessionFile!.startsWith(join(second.cwd, '.pi', 'sessions')));
  const firstDirectory = messagesDirectory(first.cwd, { type: 'group', id: firstGroup });
  const firstFiles = await readdir(firstDirectory);
  const firstLog = await readFile(join(firstDirectory, firstFiles[0]!), 'utf8');
  assert.match(firstLog, new RegExp(firstBody));
  assert.doesNotMatch(firstLog, new RegExp(secondBody));
});

test('real Pi reload closes the old connection and keeps one receiver for the current group', async t => {
  const f = await fixture(t);
  const host = await f.host('123403', 'RELOAD_GROUP_PERSONA', [fauxAssistantMessage('Seen after reload.')]);
  const previousSocket = host.socket;
  const socketsBefore = LocalSocket.instances.length;
  await host.session.reload();
  assert.equal(previousSocket.readyState, 3);
  assert.equal(LocalSocket.instances.length, socketsBefore + 1);
  const currentSocket = LocalSocket.instances.at(-1)!;
  await eventually(() => currentSocket.readyState === 1, 'replacement socket');
  previousSocket.receive(groupMessage('123403', 51, 'STALE_SOCKET_CONTENT'));
  currentSocket.receive(groupMessage('123403', 52, 'CURRENT_SOCKET_CONTENT'));
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'the replacement receiver to notify Pi');
  assert.deepEqual(host.errors, []);
  assert.deepEqual(host.notifications, []);
  const directory = messagesDirectory(host.cwd, { type: 'group', id: '123403' });
  const files = await readdir(directory);
  const log = await readFile(join(directory, files[0]!), 'utf8');
  assert.match(log, /CURRENT_SOCKET_CONTENT/);
  assert.doesNotMatch(log, /STALE_SOCKET_CONTENT/);
  assert.equal(host.session.messages.filter(message => message.role === 'custom').length, 1);
});

test('real Pi keeps collecting while busy and wakes once with the accumulated messages after settling', async t => {
  const f = await fixture(t);
  let release = () => {};
  const busy = new Promise<void>(resolve => { release = resolve; });
  const host = await f.host('123404', 'BUSY_GROUP_PERSONA', [
    async () => { await busy; return fauxAssistantMessage('The first response is finished.'); },
    fauxAssistantMessage('The accumulated messages can now be considered.'),
  ]);
  const independent = await f.host('123405', 'INDEPENDENT_GROUP_PERSONA', [fauxAssistantMessage('Another group remains responsive.')]);
  try {
    host.socket.receive(groupMessage('123404', 60, 'START_ONE_RUN'));
    await eventually(() => host.faux.state.callCount === 1, 'the first model response to start');
    assert.equal(host.session.isIdle, false);
    for (let index = 1; index <= 10; index++) {
      host.socket.receive(groupMessage('123404', 60 + index, `WHILE_BUSY_${index}`));
    }
    independent.socket.receive(groupMessage('123405', 80, 'INDEPENDENT_GROUP_MESSAGE'));
    await eventually(() => independent.faux.state.callCount === 1 && independent.session.isIdle,
      'the other group to respond independently while the first group is busy');
    assert.equal(host.session.isIdle, false);
    assert.deepEqual(independent.errors, []);
    await eventually(async () => {
      const directory = messagesDirectory(host.cwd, { type: 'group', id: '123404' });
      const files = await readdir(directory);
      return files.length > 0 && (await readFile(join(directory, files[0]!), 'utf8')).includes('WHILE_BUSY_10');
    }, 'all incoming messages to reach the journal while Pi is busy');
    await delay(250);
    assert.equal(host.faux.state.callCount, 1);
    assert.equal(host.session.messages.filter(message => message.role === 'custom').length, 1);
    release();
    await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle, 'one follow-up notification after settling');
    assert.deepEqual(host.errors, []);
    assert.deepEqual(host.notifications, []);
    assert.deepEqual(independent.notifications, []);
    const signals = host.session.messages.filter(message => message.role === 'custom');
    assert.equal(signals.length, 2);
    assert.match(JSON.stringify(signals[1]), /10 条新消息/);
    assert.doesNotMatch(JSON.stringify(signals), /WHILE_BUSY_/);
    assert.doesNotMatch(JSON.stringify(host.session.messages), /INDEPENDENT_GROUP_MESSAGE/);
    assert.equal(host.socket.sent.filter(packet => packet.action === 'send_group_msg').length, 0);
  } finally {
    release();
  }
});

test('real Pi recovers offline history on startup and reconnects without injecting or duplicating message text', async t => {
  const f = await fixture(t);
  const groupId = '123406';
  const records = Array.from({ length: 9 }, (_, index) => groupMessage(groupId, index + 1, 'IDENTICAL_OFFLINE_BODY'));
  LocalSocket.history.set(`group:${groupId}`, records.slice(0, 6));
  const host = await f.host(groupId, 'HISTORY_GROUP', [
    fauxAssistantMessage('The initial offline batch is available.'),
    fauxAssistantMessage('The next offline batch is available.'),
  ], async cwd => {
    const store = await GroupStore.open(cwd, { id: groupId, conversations: [{ type: 'group', id: groupId }] });
    try { await store.append(normalizeMessageEvent(records[0]!)!); await store.acknowledge(1); }
    finally { await store.close(); }
  });
  await eventually(() => host.faux.state.callCount === 1 && host.session.isIdle, 'the startup history notification');
  const firstSignals = host.session.messages.filter(message => message.role === 'custom');
  assert.equal(firstSignals.length, 1);
  assert.match(JSON.stringify(firstSignals), /5 条新消息/);
  assert.doesNotMatch(JSON.stringify(host.session.messages), /IDENTICAL_OFFLINE_BODY/);
  LocalSocket.history.set(`group:${groupId}`, records);
  host.socket.close();
  await eventually(() => host.faux.state.callCount === 2 && host.session.isIdle, 'the reconnect history notification');
  const signals = host.session.messages.filter(message => message.role === 'custom');
  assert.equal(signals.length, 2);
  assert.match(JSON.stringify(signals[1]), /3 条新消息/);
  const directory = messagesDirectory(host.cwd, { type: 'group', id: groupId });
  const files = await readdir(directory);
  const log = await readFile(join(directory, files[0]!), 'utf8');
  assert.equal(log.trimEnd().split('\n').map(line => JSON.parse(line)).length, 9);
  assert.deepEqual(host.errors, []);
  assert.deepEqual(host.notifications, []);
});

test('one Pi conversation group shares context across group and private dialogs while replies stay explicitly scoped', async t => {
  const f = await fixture(t);
  const sharedId = 'shared';
  const peerId = '123407';
  const conversations: Conversation[] = [{ type: 'group', id: peerId }, { type: 'private', id: peerId }];
  const requests: string[] = [];
  const readConversation = async (type: Conversation['type']) => {
    const directory = join(f.root, sharedId, 'messages', type, peerId);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    return fauxAssistantMessage(fauxToolCall('read', { path: join('messages', type, peerId, files[0]!) }), { stopReason: 'toolUse' });
  };
  const shared = await f.host(sharedId, 'SHARED_GROUP_RULES', [
    async context => { requests.push(JSON.stringify(context)); return readConversation('group'); },
    async context => { requests.push(JSON.stringify(context)); return readConversation('private'); },
    context => {
      requests.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `private:${peerId}`, text: 'A reply to the private dialog only.' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: 'group:999888', text: 'This outside-group destination must be blocked.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Conversation group processing is complete.'),
  ], undefined, conversations);
  const other = await f.host('isolated', 'OTHER_GROUP_RULES', [fauxAssistantMessage('Only the other group sees its own message.')], undefined, [{ type: 'group', id: '999888' }]);
  const groupRecord = groupMessage(peerId, 1, 'SAME_SHARED_BODY');
  const privateRecord = privateMessage(peerId, 1, 'SAME_SHARED_BODY');
  shared.socket.receive(groupRecord);
  shared.socket.receive(privateRecord);
  shared.socket.receive(groupRecord);
  shared.socket.receive(privateRecord);
  shared.socket.receive(groupMessage('999888', 2, 'OTHER_GROUP_BODY'));
  other.socket.receive(groupRecord);
  other.socket.receive(privateRecord);
  other.socket.receive(groupMessage('999888', 2, 'OTHER_GROUP_BODY'));
  await eventually(() => shared.faux.state.callCount === 5 && shared.session.isIdle
    && other.faux.state.callCount === 1 && other.session.isIdle, 'the shared and isolated groups to finish');

  assert.deepEqual(shared.errors, []);
  assert.deepEqual(shared.notifications, []);
  assert.deepEqual(other.errors, []);
  const signals = shared.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1, 'both dialogs aggregate into one Pi turn');
  assert.match(JSON.stringify(signals), /2 条新消息/);
  assert.match(JSON.stringify(signals), /messages\/group\/123407\//);
  assert.match(JSON.stringify(signals), /messages\/private\/123407\//);
  const firstSignal = signals[0]!;
  assert.ok(firstSignal.role === 'custom');
  const details = firstSignal.details as { conversations: Array<{ conversation: Conversation; count: number }> };
  assert.deepEqual(details.conversations.map(item => [conversationKey(item.conversation), item.count]).sort(),
    [[`group:${peerId}`, 1], [`private:${peerId}`, 1]].sort());
  assert.doesNotMatch(JSON.stringify(signals), /SAME_SHARED_BODY/);
  assert.doesNotMatch(requests[0]!, /SAME_SHARED_BODY/);
  assert.match(requests[2]!, /SAME_SHARED_BODY/);
  assert.doesNotMatch(JSON.stringify(shared.session.messages), /OTHER_GROUP_BODY|OTHER_GROUP_RULES/);
  assert.doesNotMatch(JSON.stringify(other.session.messages), /SAME_SHARED_BODY|SHARED_GROUP_RULES/);
  const sends = shared.socket.sent.filter(packet => ['send_private_msg', 'send_group_msg'].includes(packet.action));
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.action, 'send_private_msg');
  assert.equal(sends[0]!.params.user_id, Number(peerId));
  assert.equal(sends[0]!.params.group_id, undefined);
  assert.ok(shared.session.messages.some(message => message.role === 'toolResult' && message.toolName === 'qq_send' && message.isError));
  assert.notEqual(shared.session.sessionFile, other.session.sessionFile);
  for (const conversation of conversations) {
    const directory = messagesDirectory(shared.cwd, conversation);
    const files = await readdir(directory);
    const records = (await readFile(join(directory, files[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const incoming = records.filter(record => !record.outgoing);
    assert.equal(incoming.length, 1, 'duplicate delivery deduplicates within each dialog, not between dialogs');
    assert.deepEqual(incoming[0].conversation, conversation);
    assert.equal(incoming[0].v, 2);
    assert.ok(records.every(record => record.conversation.type === conversation.type && record.conversation.id === peerId));
  }
});

test('temporary messages join their source group, stay in a separate log, and respect explicit assignments', async t => {
  const f = await fixture(t);
  const sourceId = '123408';
  const peerId = '876501';
  const source = await f.host('source', 'SOURCE_GROUP_RULES', [
    fauxAssistantMessage(fauxToolCall('qq_send', { conversation: `temporary:${sourceId}:${peerId}`, text: 'A temporary-session reply.' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The three dialog types were considered together.'),
  ], undefined, [{ type: 'group', id: sourceId }, { type: 'private', id: peerId }], 250);
  const otherPeer = '876502';
  const other = await f.host('assigned', 'EXPLICIT_TEMP_GROUP', [fauxAssistantMessage('This temporary dialog was explicitly assigned here.')], undefined,
    [{ type: 'temporary', sourceGroupId: sourceId, id: otherPeer }], 250);

  source.socket.receive(groupMessage(sourceId, 1, 'SAME_BURST_CONTENT'));
  source.socket.receive(privateMessage(peerId, 1, 'SAME_BURST_CONTENT'));
  source.socket.receive(temporaryMessage(sourceId, peerId, 1, 'SAME_BURST_CONTENT'));
  await eventually(() => source.faux.state.callCount === 2 && source.session.isIdle, 'classified group/private/temporary notification');
  assert.deepEqual(source.errors, []);
  assert.deepEqual(source.notifications, []);
  const signals = source.session.messages.filter(message => message.role === 'custom' && message.customType === 'piq:messages');
  assert.equal(signals.length, 1);
  const firstSignal = signals[0]!;
  assert.ok(firstSignal.role === 'custom');
  const details = firstSignal.details as { conversations: Array<{ conversation: Conversation; count: number }> };
  assert.deepEqual(details.conversations.map(item => [conversationKey(item.conversation), item.count]).sort(),
    [[`group:${sourceId}`, 1], [`private:${peerId}`, 1], [`temporary:${sourceId}:${peerId}`, 1]].sort());
  assert.doesNotMatch(JSON.stringify(signals), /SAME_BURST_CONTENT/);
  assert.ok((await loadConfig(source.cwd))!.conversations.some(conversation => conversationKey(conversation) === `temporary:${sourceId}:${peerId}`));
  const temporaryDirectory = join(source.cwd, 'messages', 'temporary', sourceId, peerId);
  const files = await readdir(temporaryDirectory);
  const temporaryRecords = (await readFile(join(temporaryDirectory, files[0]!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(temporaryRecords.filter(record => !record.outgoing).length, 1);
  assert.ok(temporaryRecords.every(record => conversationKey(record.conversation) === `temporary:${sourceId}:${peerId}`));
  const sends = source.socket.sent.filter(packet => packet.action === 'send_private_msg');
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.params.user_id, Number(peerId));
  assert.equal(sends[0]!.params.group_id, Number(sourceId));

  const elsewhere = temporaryMessage(sourceId, otherPeer, 2, 'EXPLICIT_ASSIGNMENT_BODY');
  source.socket.receive(elsewhere);
  other.socket.receive(elsewhere);
  await eventually(() => other.faux.state.callCount === 1 && other.session.isIdle, 'the explicit temporary owner to receive its message');
  await delay(300);
  assert.equal(source.faux.state.callCount, 2, 'automatic source routing must respect the configured owner');
  assert.equal((await loadConfig(source.cwd))!.conversations.some(conversation => conversationKey(conversation) === `temporary:${sourceId}:${otherPeer}`), false);
  assert.deepEqual(source.errors, []); assert.deepEqual(source.notifications, []);
  assert.deepEqual(other.errors, []); assert.deepEqual(other.notifications, []);
});
