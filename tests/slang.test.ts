import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SlangStore, type SlangEntry } from '../src/slang.ts';
import { GroupStore, type StoredMessage } from '../src/store.ts';
import { conversationDirectory, type Conversation } from '../src/conversations.ts';

const first: Conversation = { type: 'group', id: '123456' };
const second: Conversation = { type: 'group', id: '654321' };
const firstKey = 'group:123456';
const secondKey = 'group:654321';

function message(seq: number, body = '这波操作绝绝子', changes: Partial<StoredMessage> = {}): StoredMessage {
  return {
    v: 2, seq, receivedAt: 1793000000000 + seq, messageId: String(-seq),
    conversation: first, userId: '234567', selfId: '345678', sender: '测试成员',
    time: 1793000000 + seq, rawText: body,
    segments: [{ type: 'text', data: { text: body } }], outgoing: false, ...changes,
  };
}

async function fixture(t: TestContext, records: StoredMessage[] = [message(1), message(2)]) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'slang-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new SlangStore(cwd, [first, second, { type: 'private', id: '123456' }]);
  async function journal(items: StoredMessage[], conversation = first) {
    const path = join(cwd, conversationDirectory(conversation));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '2026-10-26.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n');
  }
  await journal(records);
  return { cwd, store, journal, file: join(cwd, '.piq', 'slang.json') };
}

const lesson = { conversation: firstKey, term: '绝绝子', meaning: '夸赞很出色，也可能反讽', usage: '朋友展示操作后，结合上下文赞叹', evidenceSeqs: [1, 2] };

test('learning stores scenarios and evidence, upgrades candidates and survives restart', async t => {
  const { cwd, store, file } = await fixture(t);
  const candidate = await store.learn({ ...lesson, evidenceSeqs: [1, 1], example: '这波绝绝子', cautions: '严肃话题慎用' });
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(candidate.evidenceSeqs, [1]);
  const learned = await store.learn({ conversation: firstKey, term: ' 绝绝子 ', evidenceSeqs: [2] });
  assert.equal(learned.status, 'learned');
  assert.equal(learned.usage, lesson.usage);
  assert.equal(learned.example, '这波绝绝子');
  assert.deepEqual(learned.evidenceSeqs, [1, 2]);
  const restarted = new SlangStore(cwd, [first, second]);
  assert.deepEqual(await restarted.list(firstKey, '操作'), [learned]);
  assert.deepEqual(await restarted.list(secondKey), [learned], 'the conversation group shares its library');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  await store.learn({ ...lesson, status: 'rejected' });
  assert.equal((await store.learn(lesson)).status, 'rejected', 'normal relearning must retain a rejection');
  assert.equal(await store.remove(firstKey, '绝绝子'), true);
  assert.equal(await store.remove(firstKey, '绝绝子'), false);
});

test('the group shares source-specific meanings and keeps evidence with its source', async t => {
  const { store, journal } = await fixture(t);
  await journal([message(3, '绝绝子，怎么又崩了', { conversation: second }), message(4, '这服务真是绝绝子', { conversation: second })], second);
  await store.learn(lesson);
  await store.learn({ ...lesson, conversation: secondKey, meaning: '反讽服务经常故障', usage: '服务崩溃时吐槽', evidenceSeqs: [3, 4] });
  assert.equal((await store.list(firstKey))[0]!.meaning, lesson.meaning);
  assert.equal((await store.list(firstKey)).length, 2);
  assert.equal((await store.list(secondKey)).length, 2);
  assert.equal((await store.list(secondKey))[0]!.meaning, '反讽服务经常故障');
  await assert.rejects(store.learn({ ...lesson, evidenceSeqs: [3] }), /证据/);
  for (const conversation of ['group:999999', 'private:999999', 'temporary:123456:234567']) {
    await assert.rejects(store.list(conversation), /目标对话/);
    await assert.rejects(store.context(conversation), /目标对话/);
    await assert.rejects(store.remove(conversation, '绝绝子'), /目标对话/);
    await assert.rejects(store.learn({ ...lesson, conversation }), /目标对话/);
  }
});

test('evidence excludes own messages, commands, quoted raw text and missing sequences', async t => {
  const { store } = await fixture(t, [
    message(1),
    message(2, '绝绝子', { outgoing: true }),
    message(3, '绝绝子', { userId: '345678' }),
    message(4, '/绝绝子'),
    message(5, '引用原文绝绝子', { segments: [{ type: 'reply', data: { id: '-99', text: '绝绝子' } }, { type: 'text', data: { text: '真的吗' } }] }),
    message(6, 'raw_message包含绝绝子', { segments: [{ type: 'image', data: { summary: '绝绝子' } }] }),
    message(7, '好一个绝绝子', { segments: [{ type: 'reply', data: { id: '-99' } }, { type: 'text', data: { text: '好一个绝绝子' } }] }),
  ]);
  for (const seq of [2, 3, 4, 5, 6, 99]) await assert.rejects(store.learn({ ...lesson, evidenceSeqs: [seq] }), /证据/);
  await assert.rejects(store.learn({ ...lesson, term: '不存在的梗' }), /证据/);
  await assert.rejects(store.learn({ ...lesson, evidenceSeqs: [1], status: 'learned' }), /至少两条/);
  const context = await store.context(firstKey);
  assert.deepEqual(context.map(item => item.seq), [1, 5, 7]);
  assert.equal(context[1]!.rawText, '真的吗');
  assert.deepEqual(context[1]!.segments, [{ type: 'text', data: { text: '真的吗' } }]);
  assert.equal((await store.learn({ ...lesson, evidenceSeqs: [1, 7] })).status, 'learned');
});

test('normalization merges equivalent terms and concurrent writes preserve bounded evidence', async t => {
  const { store } = await fixture(t, Array.from({ length: 24 }, (_, index) => message(index + 1, '你是 YYDS')));
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.learn({ conversation: firstKey, term: index % 2 ? 'ｙｙｄｓ' : ' YYDS ', evidenceSeqs: [index + 1] })));
  const entries = await store.list(firstKey);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.evidenceSeqs, Array.from({ length: 12 }, (_, index) => index + 1));
  const updated = await store.learn({ conversation: firstKey, term: 'YYDS', evidenceSeqs: Array.from({ length: 12 }, (_, index) => index + 13), meaning: '永远的神', usage: '赞叹表现极好' });
  assert.deepEqual(updated.evidenceSeqs, Array.from({ length: 12 }, (_, index) => index + 13));
  assert.equal(updated.status, 'learned');
});

test('malformed storage and invalid lessons leave the existing file intact', async t => {
  const { store, file } = await fixture(t);
  await store.learn(lesson);
  const before = await readFile(file, 'utf8');
  for (const changes of [
    { term: 'x'.repeat(51) }, { term: '㍿'.repeat(20) }, { meaning: 'x'.repeat(1001) },
    { evidenceSeqs: [] }, { evidenceSeqs: [0] },
    { evidenceSeqs: Array.from({ length: 13 }, (_, index) => index + 1) },
    { sources: [{ title: 'bad', url: 'file:///private' }] },
    { sources: [{ title: 'bad', url: 'https://name:secret@example.com/' }] },
  ]) {
    await assert.rejects(store.learn({ ...lesson, ...changes }));
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await writeFile(file, '{broken');
  await assert.rejects(store.list(firstKey), /读取失败/);
  await assert.rejects(store.learn(lesson), /读取失败/);
  await assert.rejects(store.remove(firstKey, '绝绝子'), /读取失败/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ ...JSON.parse(before).entries[0], status: 'invalid' }] }));
  await assert.rejects(store.list(firstKey), /读取失败/);
});

test('capacity rejects new terms without evicting learned entries', async t => {
  const { store, file } = await fixture(t);
  const learned = await store.learn(lesson);
  const entries: SlangEntry[] = Array.from({ length: 300 }, (_, index) => ({ ...learned, term: `term${index}` }));
  await writeFile(file, JSON.stringify({ version: 1, entries }));
  await assert.rejects(store.learn(lesson), /300/);
  assert.equal((await store.list(firstKey)).length, 300);
  assert.equal(await store.remove(firstKey, 'term0'), true);
  await store.learn(lesson);
  assert.equal((await store.list(firstKey)).length, 300);
});

test('context is bounded and ignores an uncommitted final log line', async t => {
  const { cwd, store, journal } = await fixture(t, Array.from({ length: 100 }, (_, index) => message(index + 1)));
  assert.deepEqual((await store.context(firstKey, 2)).map(item => item.seq), [99, 100]);
  assert.equal((await store.context(firstKey, 80)).length, 80);
  await assert.rejects(store.context(firstKey, 81), /limit/);
  await journal([message(1)]);
  const path = join(cwd, 'messages', 'group', first.id, '2026-10-26.jsonl');
  await writeFile(path, JSON.stringify(message(1)) + '\n' + JSON.stringify(message(2)));
  assert.deepEqual((await store.context(firstKey)).map(item => item.seq), [1]);
  await assert.rejects(store.learn(lesson), /证据/);
  await writeFile(path, JSON.stringify(message(1)) + '\n{bad}\n');
  await assert.rejects(store.context(firstKey), /Invalid JSONL/);
});

test('junctions cannot redirect learning or storage outside the group', async t => {
  const { cwd, store, file } = await fixture(t);
  const outside = join(cwd, 'outside');
  await mkdir(outside);
  try { await symlink(outside, join(cwd, '.piq'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('OS does not allow test directory links'); return; }
    throw error;
  }
  await assert.rejects(store.list(firstKey), /读取失败/);
  await assert.rejects(store.learn(lesson), /读取失败/);
  await assert.rejects(readFile(join(outside, 'slang.json')), /ENOENT/);
  assert.equal(file, join(cwd, '.piq', 'slang.json'));
  if (process.platform === 'win32') await rmdir(join(cwd, '.piq')); else await unlink(join(cwd, '.piq'));
  const groupPath = join(cwd, 'messages', 'group', first.id);
  await rm(groupPath, { recursive: true });
  await symlink(outside, groupPath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.context(firstKey), /普通目录/);
  await assert.rejects(store.learn(lesson), /普通目录/);
  if (process.platform === 'win32') await rmdir(groupPath); else await unlink(groupPath);
});

test('private and dynamically adopted temporary chats can learn and share within the group', async t => {
  const { store, journal, cwd } = await fixture(t);
  const privateChat: Conversation = { type: 'private', id: '123456' };
  const temporary: Conversation = { type: 'temporary', id: '234567', sourceGroupId: '123456' };
  await journal([message(3, '私聊绝绝子', { conversation: privateChat }), message(4, '私聊也是绝绝子', { conversation: privateChat })], privateChat);
  const privateEntry = await store.learn({ ...lesson, conversation: 'private:123456', evidenceSeqs: [3, 4] });
  assert.equal(privateEntry.status, 'learned');
  assert.deepEqual((await store.context('private:123456')).map(item => item.seq), [3, 4]);
  assert.equal((await store.list(firstKey))[0]!.conversation, 'private:123456');
  store.addConversation(temporary);
  await journal([message(5, '临时绝绝子', { conversation: temporary })], temporary);
  const temporaryEntry = await store.learn({ ...lesson, conversation: 'temporary:123456:234567', evidenceSeqs: [5] });
  assert.equal(temporaryEntry.status, 'candidate');
  assert.deepEqual((await store.context('temporary:123456:234567')).map(item => item.seq), [5]);
  const afterRemoval = new SlangStore(cwd, [first]);
  assert.equal((await afterRemoval.list(firstKey)).length, 2, 'old member records remain part of this group memory');
  await assert.rejects(afterRemoval.context('private:123456'), /目标对话/);
});

test('selected migrations omit provenance, import as candidates and preserve existing entries', async t => {
  const source = await fixture(t);
  const destination = await fixture(t);
  await source.store.learn({ ...lesson, sources: [{ title: '参考', url: 'https://example.com/meaning' }] });
  const portable = await source.store.exportEntries(firstKey, ['绝绝子']);
  assert.deepEqual(Object.keys(portable[0]!).sort(), ['term', 'meaning', 'usage', 'example', 'cautions', 'sources'].sort());
  assert.doesNotMatch(JSON.stringify(portable), /conversation|evidenceSeqs|updatedAt|receivedAt|messageId/);
  const imported = await destination.store.importEntries(secondKey, portable);
  assert.equal(imported.length, 1);
  assert.equal(imported[0]!.conversation, secondKey);
  assert.equal(imported[0]!.status, 'candidate');
  assert.deepEqual(imported[0]!.evidenceSeqs, []);
  const restarted = new SlangStore(destination.cwd, [first, second]);
  assert.deepEqual(await restarted.list(firstKey), imported);
  assert.deepEqual(await destination.store.importEntries(secondKey, [{ ...portable[0]!, meaning: '覆盖尝试' }]), []);
  assert.equal((await destination.store.list(secondKey))[0]!.meaning, lesson.meaning);
  await assert.rejects(source.store.exportEntries(secondKey, ['绝绝子']), /来源中找不到/);
  await assert.rejects(source.store.exportEntries(firstKey, []), /显式选择/);
  await assert.rejects(source.store.exportEntries(firstKey, ['绝绝子', '绝绝子']), /不能重复/);
  await source.store.learn({ ...lesson, status: 'rejected' });
  await assert.rejects(source.store.exportEntries(firstKey, ['绝绝子']), /来源中找不到/);
});

test('migration validates every selected entry before any write and enforces capacity', async t => {
  const { store, file } = await fixture(t);
  await store.learn(lesson);
  const before = await readFile(file, 'utf8');
  const portable = { term: '新词', meaning: '待确认', usage: '待确认', example: '', cautions: '', sources: [] };
  await assert.rejects(store.importEntries(secondKey, []), /1 到 50/);
  await assert.rejects(store.importEntries(secondKey, Array.from({ length: 51 }, (_, index) => ({ ...portable, term: `term${index}` }))), /1 到 50/);
  await assert.rejects(store.importEntries(secondKey, [portable, { ...portable, term: '重复', sources: [{ title: 'bad', url: 'javascript:alert(1)' }] }]), /HTTP/);
  await assert.rejects(store.importEntries(secondKey, [{ ...portable, conversation: firstKey } as unknown as typeof portable]), /只接受/);
  await assert.rejects(store.importEntries(secondKey, [portable, portable]), /不能重复/);
  assert.equal(await readFile(file, 'utf8'), before);
  const base = JSON.parse(before).entries[0] as SlangEntry;
  await writeFile(file, JSON.stringify({ version: 1, entries: Array.from({ length: 300 }, (_, index) => ({ ...base, conversation: secondKey, term: `term${index}` })) }));
  await assert.rejects(store.importEntries(secondKey, [portable]), /300/);
  assert.equal((await store.list(firstKey)).length, 300);
});

test('mixed message and poke journals retain message context without learning poke events', async t => {
  const { cwd, store } = await fixture(t);
  const journal = await GroupStore.open(cwd, { id: 'poke-slang', conversations: [first] });
  try {
    await journal.appendPoke({
      kind: 'poke', eventId: randomUUID(), source: 'notice', conversation: first,
      userId: '234567', selfId: '345678', targetId: '345678', sender: '测试成员',
      time: 1793000003, rawText: '绝绝子', segments: [{ type: 'text', data: { text: '绝绝子' } }], outgoing: false,
    });
    await journal.append(message(4, '绝绝子，又成功了'));
    await journal.appendPoke({
      kind: 'poke', eventId: randomUUID(), source: 'action', conversation: first,
      userId: '345678', selfId: '345678', targetId: '234567', sender: 'Pi',
      time: 1793000005, rawText: '绝绝子', segments: [{ type: 'text', data: { text: '绝绝子' } }], outgoing: true,
    });
  } finally { await journal.close(); }
  assert.deepEqual((await store.context(firstKey)).map(item => item.seq), [1, 2, 4]);
  const learned = await store.learn({ ...lesson, evidenceSeqs: [1, 4] });
  assert.equal(learned.status, 'learned');
  assert.deepEqual(learned.evidenceSeqs, [1, 4]);
  for (const seq of [3, 5]) await assert.rejects(store.learn({ ...lesson, evidenceSeqs: [seq] }), /证据/);
});
