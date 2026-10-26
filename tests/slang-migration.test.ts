import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SlangStore, type SlangEntry } from '../src/slang.ts';
import { SlangMigration, type SharedSlangEntry } from '../src/slang-migration.ts';
import { conversationDirectory, type Conversation } from '../src/conversations.ts';
import type { StoredMessage } from '../src/store.ts';

const publicLesson = { term: '绝绝子', meaning: '表示赞叹，也可能反讽', usage: '看到很出色的操作时回应，先判断语气', example: '这波操作绝绝子', cautions: '严肃场景慎用' };

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'slang-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function group(id: string, qqId: string, autoMigrate = true, enabled = true) {
    const cwd = join(root, id);
    await mkdir(cwd);
    const conversation: Conversation = { type: 'group', id: qqId };
    const key = `group:${qqId}`;
    async function config(automatic = autoMigrate, learning = enabled) {
      await writeFile(join(cwd, 'PIQ.md'), '# 组配置\n\n```json\n' + JSON.stringify({
        id, name: id, conversations: [conversation], slang: { enabled: learning, autoMigrate: automatic },
      }) + '\n```\n');
    }
    await config();
    const directory = join(cwd, conversationDirectory(conversation));
    await mkdir(directory, { recursive: true });
    const records: StoredMessage[] = [1, 2].map(seq => ({
      v: 2, seq, receivedAt: 1793000000000 + seq, conversation,
      messageId: String(-seq), time: 1793000000 + seq, sender: '内部昵称',
      userId: '77777777', selfId: '88888888', rawText: `内部原话marker ${publicLesson.term}`,
      segments: [{ type: 'text', data: { text: `内部原话marker ${publicLesson.term}` } }], outgoing: false,
    }));
    await writeFile(join(directory, '2026-10-26.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const store = new SlangStore(cwd, [conversation]);
    const migration = new SlangMigration(cwd, store);
    async function learn(status: 'candidate' | 'learned' | 'rejected' = 'learned') {
      return store.learn({ ...publicLesson, conversation: key, evidenceSeqs: status === 'candidate' ? [1] : [1, 2], status });
    }
    return { id, cwd, key, store, migration, config, learn, outbox: join(root, '.piq-slang', `${id}.json`) };
  }
  const source = await group('source', '111111');
  const target = await group('target', '222222');
  return { root, group, source, target };
}

const reason = '通用赞叹表达，含义和例句已去除人物与内部事件，可在新语境中重新验证。';

test('agents publish and adopt learned words through a portable exchange without touching peer libraries', async t => {
  const { source, target } = await fixture(t);
  await source.learn();
  const before = await readFile(join(source.cwd, '.piq', 'slang.json'), 'utf8');
  const published = await source.migration.publish(source.key, ['绝绝子'], reason);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.fromGroup, 'source');
  assert.deepEqual(published[0]!.entry, { ...publicLesson, sources: [] });
  const exchange = await readFile(source.outbox, 'utf8');
  assert.doesNotMatch(exchange, /111111|77777777|88888888|内部原话marker|内部昵称|evidenceSeqs|conversation|messageId|receivedAt/);
  const found = await target.migration.discover();
  assert.deepEqual(found, published);
  assert.deepEqual(await source.migration.discover(), []);
  await assert.rejects(readFile(join(target.cwd, '.piq', 'slang.json')), /ENOENT/);
  const adopted = await target.migration.adopt(target.key, [found[0]!.id]);
  assert.equal(adopted[0]!.status, 'candidate');
  assert.deepEqual(adopted[0]!.evidenceSeqs, []);
  assert.equal(adopted[0]!.conversation, target.key);
  assert.equal(await readFile(join(source.cwd, '.piq', 'slang.json'), 'utf8'), before);
  assert.deepEqual(await target.migration.adopt(target.key, [found[0]!.id]), [], 'existing target vocabulary is retained');
  assert.deepEqual((await readdir(join(source.cwd, '.piq'))).sort(), ['slang.json']);
});

test('both groups must opt in and source opt out immediately hides discovery and adoption', async t => {
  const { source, target } = await fixture(t);
  await source.learn();
  await source.config(false);
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /尚未开启/);
  await source.config();
  const [published] = await source.migration.publish(source.key, ['绝绝子'], reason);
  await target.config(false);
  await assert.rejects(target.migration.discover(), /尚未开启/);
  await assert.rejects(target.migration.adopt(target.key, [published!.id]), /尚未开启/);
  await target.config(true, false);
  await assert.rejects(target.migration.discover(), /尚未开启/);
  await target.config();
  await source.config(false);
  assert.deepEqual(await target.migration.discover(), []);
  await assert.rejects(target.migration.adopt(target.key, [published!.id]), /不可用/);
  await source.config(true, false);
  assert.deepEqual(await target.migration.discover(), []);
  await source.config();
  assert.equal((await target.migration.discover()).length, 1);
});

test('only learned source entries are published and republishing preserves the stable identifier', async t => {
  const { source } = await fixture(t);
  await source.learn('candidate');
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /只有本来源已 learned/);
  await source.learn();
  const [first] = await source.migration.publish(source.key, ['绝绝子'], reason);
  await source.store.learn({ ...publicLesson, conversation: source.key, meaning: '修正后的通用含义', evidenceSeqs: [1, 2] });
  const [second] = await source.migration.publish(source.key, [' 绝绝子 '], '已结合新证据修正含义，仍然适合迁移。');
  assert.equal(second!.id, first!.id);
  assert.equal(second!.entry.meaning, '修正后的通用含义');
  assert.equal(JSON.parse(await readFile(source.outbox, 'utf8')).entries.length, 1);
  await source.learn('rejected');
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /找不到/);
  await assert.rejects(source.migration.publish('group:999999', ['绝绝子'], reason), /不属于/);
});

test('malformed exchange data and identity fields are rejected while originals remain intact', async t => {
  const { source, target } = await fixture(t);
  await source.learn();
  const [published] = await source.migration.publish(source.key, ['绝绝子'], reason);
  for (const payload of [
    '{broken',
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ ...published, fromGroup: 'wrong' }] }),
    JSON.stringify({ version: 1, entries: [{ ...published, entry: { ...published!.entry, conversation: source.key } }] }),
    JSON.stringify({ version: 1, entries: [{ ...published, reason: '' }] }),
    JSON.stringify({ version: 1, entries: [{ ...published, entry: { ...published!.entry, sources: [{ title: 'bad', url: 'file:///secret' }] } }] }),
  ]) {
    await writeFile(source.outbox, payload);
    await assert.rejects(target.migration.discover(), /读取失败/);
    await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /读取失败/);
    assert.equal(await readFile(source.outbox, 'utf8'), payload);
  }
});

test('batch, reason and exchange capacity limits reject atomically; discovery stays bounded', async t => {
  const { source, target } = await fixture(t);
  const learned = await source.learn();
  const [base] = await source.migration.publish(source.key, ['绝绝子'], reason);
  const original = await readFile(source.outbox, 'utf8');
  for (const terms of [[], Array.from({ length: 51 }, () => '绝绝子'), ['绝绝子', '绝绝子']]) {
    await assert.rejects(source.migration.publish(source.key, terms, reason));
    assert.equal(await readFile(source.outbox, 'utf8'), original);
  }
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], ''), /reason/);
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], 'x'.repeat(501)), /reason/);
  for (const ids of [[], [base!.id, base!.id], ['bad'], Array.from({ length: 51 }, () => base!.id)]) {
    await assert.rejects(target.migration.adopt(target.key, ids), /1 到 50/);
  }
  const entries: SharedSlangEntry[] = Array.from({ length: 300 }, (_, index) => ({
    ...base!, id: createHash('sha256').update(String(index)).digest('hex').slice(0, 32),
    entry: { ...base!.entry, term: `term${index}` }, updatedAt: index,
  }));
  await writeFile(source.outbox, JSON.stringify({ version: 1, entries }));
  assert.equal((await target.migration.discover()).length, 100);
  const full = await readFile(source.outbox, 'utf8');
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /300/);
  assert.equal(await readFile(source.outbox, 'utf8'), full);
  const local: SlangEntry[] = [learned, ...Array.from({ length: 2 }, (_, index) => ({ ...learned, term: `new${index}` }))];
  await writeFile(join(source.cwd, '.piq', 'slang.json'), JSON.stringify({ version: 1, entries: local }));
  await writeFile(source.outbox, JSON.stringify({ version: 1, entries: entries.slice(0, 299) }));
  const beforeBatch = await readFile(source.outbox, 'utf8');
  await assert.rejects(source.migration.publish(source.key, ['new0', 'new1'], reason), /300/);
  assert.equal(await readFile(source.outbox, 'utf8'), beforeBatch);
});

test('publish serializes concurrent batches and validates current source configuration', async t => {
  const { source, target } = await fixture(t);
  await source.learn();
  const updates = await Promise.all(Array.from({ length: 5 }, (_, index) => source.migration.publish(source.key, ['绝绝子'], `第${index}次判断：这是通用词。`)));
  assert.equal(new Set(updates.map(items => items[0]!.id)).size, 1);
  assert.equal(JSON.parse(await readFile(source.outbox, 'utf8')).entries.length, 1);
  await writeFile(join(source.cwd, 'PIQ.md'), '# 配置\n\n```json\n' + JSON.stringify({ id: 'wrong', name: 'wrong', conversations: [], slang: { autoMigrate: true } }) + '\n```\n');
  await assert.rejects(target.migration.discover(), /标识不一致/);
});

test('directory junctions cannot redirect exchange or source configuration', async t => {
  const { root, source, target } = await fixture(t);
  await source.learn();
  const outside = join(root, 'outside');
  await mkdir(outside);
  const exchange = join(root, '.piq-slang');
  try { await symlink(outside, exchange, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('OS does not allow directory links'); return; }
    throw error;
  }
  await assert.rejects(source.migration.publish(source.key, ['绝绝子'], reason), /普通目录/);
  await assert.rejects(target.migration.discover(), /普通目录/);
  assert.deepEqual(await readdir(outside), []);
  if (process.platform === 'win32') await rmdir(exchange); else await unlink(exchange);
  await source.migration.publish(source.key, ['绝绝子'], reason);
  const backup = join(root, 'source-backup');
  await mkdir(backup);
  await writeFile(join(backup, 'PIQ.md'), await readFile(join(source.cwd, 'PIQ.md')));
  await rm(source.cwd, { recursive: true });
  await symlink(backup, source.cwd, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(target.migration.discover(), /普通目录/);
  if (process.platform === 'win32') await rmdir(source.cwd); else await unlink(source.cwd);
});

test('agents can revoke their own shared words without deleting their local vocabulary', async t => {
  const { source, target } = await fixture(t);
  await source.learn();
  await target.learn();
  const [sourceEntry] = await source.migration.publish(source.key, ['绝绝子'], reason);
  const [targetEntry] = await target.migration.publish(target.key, ['绝绝子'], reason);
  const localBefore = await readFile(join(source.cwd, '.piq', 'slang.json'), 'utf8');
  const outboxBefore = await readFile(source.outbox, 'utf8');
  for (const ids of [[], [sourceEntry!.id, sourceEntry!.id], ['bad'], Array.from({ length: 51 }, () => sourceEntry!.id)]) {
    await assert.rejects(source.migration.revoke(ids), /1 到 50/);
  }
  await assert.rejects(source.migration.revoke([sourceEntry!.id, targetEntry!.id]), /不属于本组/);
  assert.equal(await readFile(source.outbox, 'utf8'), outboxBefore, 'invalid mixed-source selection cannot partially revoke');
  await source.config(false);
  await assert.rejects(source.migration.revoke([sourceEntry!.id]), /尚未开启/);
  await source.config();
  assert.equal(await source.migration.revoke([sourceEntry!.id]), 1);
  assert.deepEqual(await target.migration.discover(), []);
  await assert.rejects(target.migration.adopt(target.key, [sourceEntry!.id]), /不可用/);
  assert.equal(await readFile(join(source.cwd, '.piq', 'slang.json'), 'utf8'), localBefore);
  assert.equal((await source.store.list(source.key))[0]!.status, 'learned');
  assert.equal(JSON.parse(await readFile(target.outbox, 'utf8')).entries.length, 1);
});
