import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { HistorySync } from '../src/history.ts';
import { GroupStore } from '../src/store.ts';
import { messageCursor, type ConversationEvent, type HistoryCursor } from '../src/transport.ts';
import { conversationKey, type Conversation } from '../src/conversations.ts';

const GROUP: Conversation = { type: 'group', id: '123456' };
const PRIVATE: Conversation = { type: 'private', id: '123456' };

function record(seq: number, own = false, conversation: Conversation = GROUP): ConversationEvent {
  return {
    conversation, selfId: '99999', userId: own ? '99999' : conversation.type === 'group' ? '88888' : conversation.id,
    messageId: String(-seq), messageSeq: String(seq), time: 1_700_000_000 + seq,
    sender: own ? 'Bot' : 'Member', outgoing: own, rawText: `History ${seq}`,
    segments: [{ type: 'text', data: { text: `History ${seq}` } }],
  };
}

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'history-'));
  const store = await GroupStore.open(cwd, { id: 'test-group', conversations: [GROUP, PRIVATE] });
  const syncs: HistorySync[] = [];
  t.after(async () => { for (const sync of syncs) sync.close(); await store.close(); await rm(cwd, { recursive: true, force: true }); });
  const errors: string[] = [];
  let changes = 0;
  const sync = (fetch: (cursor: HistoryCursor | null, count: number, signal: AbortSignal) => Promise<ConversationEvent[]>, conversation: Conversation = GROUP) => {
    const instance = new HistorySync({ conversation, store, fetch,
      changed: () => changes++, error: error => errors.push(String(error)),
      pageSize: 4, batchPages: 2, batchDelayMs: 0,
    });
    syncs.push(instance);
    return instance;
  };
  const cursor = async (conversation: Conversation = GROUP) => {
    const history = JSON.parse(await readFile(join(cwd, '.piq', 'history.json'), 'utf8'));
    assert.equal(history.version, 2);
    assert.equal(history.groupId, 'test-group');
    return (history.cursors[conversationKey(conversation)] ?? null) as HistoryCursor | null;
  };
  return { cwd, store, errors, sync, cursor, changes: () => changes };
}

function historyPage(records: ConversationEvent[], cursor: HistoryCursor | null, count: number): ConversationEvent[] {
  if (!cursor) return records.slice(-count);
  const start = records.findIndex(event => event.messageId === cursor.messageId);
  return start < 0 ? [] : records.slice(start, start + count);
}

test('a new group seeds latest 20 available messages and excludes own messages from notifications', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 50 }, (_, i) => record(i + 1, i === 44));
  const sync = f.sync(async (cursor, count) => historyPage(records, cursor, count));
  sync.connect(); await sync.wait();
  assert.equal(f.store.pending()!.count, 19);
  assert.equal((await f.cursor())!.messageSeq, '50');
  assert.deepEqual(f.errors, []);
  sync.connect(); await sync.wait();
  assert.equal(f.store.pending()!.count, 19, 'reconnection must deduplicate the seed page');
});

test('paged recovery follows inclusive anchors through short pages and persists its high watermark', async t => {
  const f = await fixture(t);
  await f.store.append(record(1)); await f.store.acknowledge(1);
  const records = Array.from({ length: 30 }, (_, i) => record(i + 1));
  let pages = 0;
  const sync = f.sync(async (cursor, count) => {
    if (cursor) pages++;
    // The upstream can return a short page before the end; keep walking to the snapshot.
    return historyPage(records, cursor, cursor ? 2 : count);
  });
  sync.connect(); await sync.wait();
  assert.equal(pages, 29);
  assert.equal(f.store.pending()!.count, 29);
  assert.equal((await f.cursor())!.messageSeq, '30');
  assert.deepEqual(f.errors, []);
  sync.connect(); await sync.wait();
  assert.equal(pages, 29, 'already caught-up groups need only the latest snapshot');
});

test('live messages overlapping a catchup cannot jump its cursor across an offline gap', async t => {
  const f = await fixture(t);
  await f.store.append(record(1)); await f.store.acknowledge(1);
  const records = Array.from({ length: 12 }, (_, i) => record(i + 1));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let announced!: () => void;
  const started = new Promise<void>(resolve => { announced = resolve; });
  const sync = f.sync(async (cursor, count) => {
    if (!cursor) { announced(); await blocked; }
    return historyPage(records, cursor, count);
  });
  sync.connect(); await started;
  await sync.receive(record(12));
  assert.equal((await f.cursor())!.messageSeq, '1');
  assert.equal(sync.running, true);
  release(); await sync.wait();
  assert.equal(f.store.pending()!.count, 11);
  assert.equal((await f.cursor())!.messageSeq, '12');
  assert.deepEqual(f.errors, []);
});

test('a failed page retains progress while later live traffic stays available for a successful retry', async t => {
  const f = await fixture(t);
  await f.store.append(record(1)); await f.store.acknowledge(1);
  const records = Array.from({ length: 12 }, (_, i) => record(i + 1));
  let fail = true;
  const sync = f.sync(async (cursor, count) => {
    if (cursor?.messageSeq === '4' && fail) throw new Error('Temporary failure');
    return historyPage(records, cursor, count);
  });
  sync.connect(); await sync.wait();
  assert.equal((await f.cursor())!.messageSeq, '4');
  await sync.receive(record(12));
  assert.equal((await f.cursor())!.messageSeq, '4');
  assert.equal(f.errors.length, 1);
  fail = false; sync.retry(); await sync.wait();
  assert.equal((await f.cursor())!.messageSeq, '12');
  assert.equal(f.store.pending()!.count, 11);
  await sync.receive(record(13));
  assert.equal((await f.cursor())!.messageSeq, '13');
});

test('missing and repeated anchors are visible gaps rather than silent successful synchronization', async t => {
  const f = await fixture(t);
  await f.store.append(record(1));
  const sync = f.sync(async cursor => cursor ? [] : [record(9)]);
  sync.connect(); await sync.wait();
  assert.match(f.errors[0]!, /锚点/);
  assert.equal((await f.cursor())!.messageSeq, '1');
  sync.close();
  const stalled = f.sync(async cursor => cursor ? [record(1)] : [record(9)]);
  stalled.connect(); await stalled.wait();
  assert.match(f.errors[1]!, /暂未前进/);
  assert.equal((await f.cursor())!.messageSeq, '1');
});

test('an empty snapshot retains the saved cursor even when newer live messages have arrived', async t => {
  const f = await fixture(t);
  await f.store.append(record(1));
  const sync = f.sync(async () => []);
  sync.connect(); await sync.wait();
  await sync.receive(record(99));
  assert.equal((await f.cursor())!.messageSeq, '1');
  assert.match(f.errors[0]!, /暂未返回/);
  assert.equal(f.store.pending()!.count, 2);
});

test('disconnect cancels an old catchup and prevents late pages from writing into its replacement', async t => {
  const f = await fixture(t);
  await f.store.append(record(1));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  const sync = f.sync(async (cursor, count, signal) => {
    if (first) { first = false; entered(); await blocked; return [record(99)]; }
    signal.throwIfAborted();
    return historyPage([record(1), record(2)], cursor, count);
  });
  sync.connect(); await started; sync.disconnect(); sync.connect(); await sync.wait();
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.cursor())!.messageSeq, '2');
  assert.equal(f.store.pending()!.count, 2);
  assert.deepEqual(f.errors, []);
});

test('same-second messages still paginate correctly when the server omits sequence numbers', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 8 }, (_, index) => ({ ...record(index + 1), messageSeq: undefined, time: 1700000000 }));
  await f.store.append(records[0]!);
  await f.store.saveHistoryCursor(GROUP, messageCursor(records[0]!));
  const sync = f.sync(async (cursor, count) => historyPage(records, cursor, count));
  sync.connect(); await sync.wait();
  assert.equal(f.store.pending()!.count, 8);
  assert.equal((await f.cursor())!.messageId, '-8');
  assert.deepEqual(f.errors, []);
});

test('identical message content with distinct QQ identities survives history and live deduplication', async t => {
  const f = await fixture(t);
  const sameText = Array.from({ length: 3 }, (_, index) => ({
    ...record(index + 1), rawText: '收到', segments: [{ type: 'text', data: { text: '收到' } }],
  }));
  const sync = f.sync(async (cursor, count) => historyPage(sameText, cursor, count));
  sync.connect(); await sync.wait();
  await sync.receive(sameText[0]!);
  await sync.receive(sameText[1]!);
  assert.equal(f.store.pending()!.count, 3, 'replayed events deduplicate, distinct messages with identical text stay');
  assert.deepEqual(f.errors, []);
});

test('group and private conversations share an inbox while keeping independent recovery positions', async t => {
  const f = await fixture(t);
  const groups = Array.from({ length: 3 }, (_, i) => ({ ...record(i + 1), rawText: '收到' }));
  const privates = Array.from({ length: 4 }, (_, i) => ({ ...record(i + 1, false, PRIVATE), rawText: '收到' }));
  const groupSync = f.sync(async (cursor, count) => historyPage(groups, cursor, count));
  const privateSync = f.sync(async (cursor, count) => historyPage(privates, cursor, count), PRIVATE);
  groupSync.connect(); privateSync.connect();
  await Promise.all([groupSync.wait(), privateSync.wait()]);
  assert.equal(f.store.pending()!.count, 7, 'equal QQ numbers, IDs, sequences and text in different conversations are distinct');
  assert.equal((await f.cursor(GROUP))!.messageId, '-3');
  assert.equal((await f.cursor(PRIVATE))!.messageId, '-4');
  const counts = new Map(f.store.pending()!.conversations.map(item => [conversationKey(item.conversation), item.count]));
  assert.equal(counts.get('group:123456'), 3);
  assert.equal(counts.get('private:123456'), 4);
  const paths = f.store.pending()!.files;
  assert.deepEqual([...new Set(paths.map(file => file.split('/').slice(0, 3).join('/')))].sort(), [
    'messages/group/123456', 'messages/private/123456',
  ]);
  for (const file of paths) {
    assert.match(file, /^messages\/(group|private)\/123456\/\d{4}-\d{2}-\d{2}\.jsonl$/);
    const records = (await readFile(join(f.cwd, file), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.ok(records.every(record => record.conversation.type === file.split('/')[1]));
  }
  await privateSync.receive(record(5, false, PRIVATE));
  assert.equal((await f.cursor(GROUP))!.messageId, '-3');
  assert.equal((await f.cursor(PRIVATE))!.messageId, '-5');
  groupSync.connect(); await groupSync.wait();
  assert.equal(f.store.pending()!.count, 8);
  assert.deepEqual(f.errors, []);
});

test('private recovery respects upstream order when sender-local sequences decrease within one second', async t => {
  const f = await fixture(t);
  const remoteSequences = ['900', '1', '901', '2', '902', '3'];
  const records = remoteSequences.map((messageSeq, index) => ({
    ...record(index + 1, index % 2 === 1, PRIVATE), messageSeq, time: 1700000000,
  }));
  await f.store.append(records[0]!);
  await f.store.saveHistoryCursor(PRIVATE, messageCursor(records[0]!));
  let pages = 0;
  const sync = f.sync(async (cursor, count) => {
    if (cursor) pages++;
    return historyPage(records, cursor, count);
  }, PRIVATE);
  sync.connect(); await sync.wait();
  assert.equal(pages, 2);
  assert.equal(f.store.pending()!.count, 3, 'own private messages stay logged without adding notifications');
  assert.equal(f.store.pending()!.through, 5);
  assert.equal((await f.cursor(PRIVATE))!.messageId, '-6');
  assert.equal((await f.cursor(PRIVATE))!.messageSeq, '3');
  assert.deepEqual(f.errors, []);
});

test('a recovery instance rejects a foreign-conversation page and ignores foreign live events', async t => {
  const f = await fixture(t);
  const bad = f.sync(async () => [record(1, false, PRIVATE)]);
  bad.connect(); await bad.wait();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0]!, /不属于 group:123456/);
  assert.equal(f.store.pending(), null);
  assert.equal(await f.cursor(GROUP), null);
  assert.equal(await f.cursor(PRIVATE), null);
  bad.close();
  const good = f.sync(async () => [record(1)]);
  good.connect(); await good.wait();
  await good.receive(record(2, false, PRIVATE));
  assert.equal(f.store.pending()!.count, 1);
  assert.equal((await f.cursor(GROUP))!.messageId, '-1');
  assert.equal(await f.cursor(PRIVATE), null);
});

test('a new temporary conversation becomes ready without requesting private history', async t => {
  const f = await fixture(t);
  const temporary: Conversation = { type: 'temporary', id: '123456', sourceGroupId: '555' };
  await f.store.addConversation(temporary);
  let fetches = 0;
  const sync = f.sync(async () => { fetches++; throw new Error('Temporary history must not use friend history.'); }, temporary);
  sync.connect(); await sync.wait();
  assert.equal(fetches, 0);
  assert.equal(sync.running, false);
  assert.equal(await f.cursor(temporary), null);
  assert.equal(f.store.pending(), null);
  await sync.receive(record(1, false, temporary));
  assert.equal((await f.cursor(temporary))!.messageId, '-1');
  assert.equal(f.store.pending()!.count, 1);
  assert.deepEqual(f.errors, []);
});

test('temporary reconnect keeps saved messages and follows time without touching same-user private history', async t => {
  const f = await fixture(t);
  const temporary: Conversation = { type: 'temporary', id: '123456', sourceGroupId: '555' };
  const otherTemporary: Conversation = { type: 'temporary', id: '123456', sourceGroupId: '556' };
  await f.store.addConversation(temporary);
  const first = { ...record(1, false, temporary), messageSeq: '900', time: 1700000000 };
  await f.store.append(first);
  let fetches = 0;
  const sync = f.sync(async () => { fetches++; return []; }, temporary);
  sync.connect(); await sync.wait();
  assert.equal(fetches, 0);
  assert.equal(f.store.pending()!.count, 1, 'saved temporary messages remain eligible for notification');
  assert.equal((await f.cursor(temporary))!.messageId, '-1');
  await sync.receive({ ...record(2, false, temporary), messageSeq: '1', time: 1700000001 });
  assert.equal((await f.cursor(temporary))!.messageId, '-2', 'newer time wins over a larger sender-local sequence');
  sync.disconnect(); sync.connect(); await sync.wait();
  assert.equal(fetches, 0);
  assert.equal((await f.cursor(temporary))!.messageId, '-2');
  await sync.receive(record(3, false, otherTemporary));
  assert.equal(f.store.pending()!.count, 2, 'another source group is a distinct temporary conversation');
  const privateSync = f.sync(async () => [{ ...first, conversation: PRIVATE }], PRIVATE);
  privateSync.connect(); await privateSync.wait();
  assert.equal((await f.cursor(PRIVATE))!.messageId, '-1');
  assert.equal((await f.cursor(temporary))!.messageId, '-2');
  assert.equal(f.store.pending()!.count, 3, 'temporary and private identities remain separate for the same QQ user');
  assert.deepEqual(f.errors, []);
});
