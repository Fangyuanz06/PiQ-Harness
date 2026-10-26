import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { conversationDirectory, conversationKey, parseConversationKey, validateConversation, validateQQId, type Conversation } from '../src/conversations.ts';
import { adoptTemporaryConversation, assertAssignments, claimConversations, initializeGroup, listGroupConfigs, loadConfig, saveGroupConfig, type GroupConfig } from '../src/config.ts';

const group = (id: string): Conversation => ({ type: 'group', id });
const person = (id: string): Conversation => ({ type: 'private', id });
const temporary = (sourceGroupId: string, id: string): Conversation => ({ type: 'temporary', sourceGroupId, id });
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'conversations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function create(root: string, id: string, conversations: Conversation[]) {
  return initializeGroup(root, id, { name: id, conversations });
}
async function current(cwd: string) {
  const text = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  return { config: (await loadConfig(cwd))!, revision: revision(text), text };
}
async function manuallyWrite(cwd: string, config: GroupConfig) {
  await writeFile(join(cwd, 'PIQ.md'), '# 手动编辑\n\n```json\n' + JSON.stringify(config) + '\n```\n');
}
async function own(cwd: string, token: string = randomUUID()) {
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token }));
  return token;
}

test('conversation identities separate group, friend and source-specific temporary chats', () => {
  assert.equal(conversationKey(group('123')), 'group:123');
  assert.equal(conversationKey(person('123')), 'private:123');
  assert.deepEqual(parseConversationKey('private:123'), person('123'));
  assert.equal(conversationKey(temporary('456', '123')), 'temporary:456:123');
  assert.notEqual(conversationKey(temporary('456', '123')), conversationKey(temporary('789', '123')));
  assert.notEqual(conversationKey(temporary('456', '123')), conversationKey(person('123')));
  assert.deepEqual(parseConversationKey('temporary:456:123'), temporary('456', '123'));
  assert.deepEqual(validateConversation({ type: 'group', id: '123', name: '工作群' }), { type: 'group', id: '123', name: '工作群' });
  assert.equal(validateQQId('123'), '123');
  for (const value of ['0', '-1', '01', '1e3', '../1', '9007199254740992']) assert.throws(() => validateQQId(value));
  for (const value of ['group:0', 'GROUP:123', 'other:123', 'group:1:2', '123', 'private:../1', 'temporary:123', 'temporary:0:123', 'temporary:123:0', 'temporary:1:2:3']) assert.throws(() => parseConversationKey(value));
  for (const value of [
    { type: 'group', groupId: '123' }, { type: 'channel', id: '123' }, { type: 'private', id: '123', unexpected: true },
    { type: 'temporary', id: '123' }, { type: 'temporary', id: '123', sourceGroupId: '0' },
    { type: 'group', id: '123', sourceGroupId: '456' }, { type: 'private', id: '123', sourceGroupId: '456' },
  ]) assert.throws(() => validateConversation(value));
});

test('temporary conversation assignment is exclusive for one source group and peer pair', async t => {
  const root = await fixture(t);
  await create(root, 'alpha', [temporary('123', '456')]);
  await create(root, 'beta', [temporary('789', '456'), person('456')]);
  await assert.rejects(create(root, 'duplicate', [temporary('123', '456')]));
});

test('conversation directories preserve type and source and reject path-shaped QQ identifiers', () => {
  assert.equal(conversationDirectory(group('123')), 'messages/group/123');
  assert.equal(conversationDirectory(person('123')), 'messages/private/123');
  assert.equal(conversationDirectory(temporary('456', '123')), 'messages/temporary/456/123');
  for (const invalid of ['../123', '..\\123', '/123', 'C:\\123', '0', '-1']) {
    assert.throws(() => conversationDirectory(group(invalid)));
    assert.throws(() => conversationDirectory(person(invalid)));
    assert.throws(() => conversationDirectory(temporary(invalid, '123')));
    assert.throws(() => conversationDirectory(temporary('456', invalid)));
  }
});

test('one conversation belongs to one group while different conversation kinds may share a QQ number', async t => {
  const root = await fixture(t);
  await create(root, 'alpha', [group('123'), person('456')]);
  await create(root, 'beta', [person('123'), group('456')]);
  await assert.rejects(create(root, 'duplicate', [group('123')]));
  await assert.rejects(create(root, 'duplicate-private', [person('456')]));
  const listed = await listGroupConfigs(root);
  assert.deepEqual(listed.map(item => item.id).sort(), ['alpha', 'beta']);
});

test('concurrent initialization cannot assign the same conversation twice', async t => {
  const root = await fixture(t);
  const results = await Promise.allSettled([create(root, 'alpha', [group('123')]), create(root, 'beta', [group('123')])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const listed = await listGroupConfigs(root);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]!.config.conversations, [group('123')]);
});

test('stopped groups can move a conversation after releasing its previous assignment', async t => {
  const root = await fixture(t);
  const alpha = await create(root, 'alpha', [group('123')]);
  const beta = await create(root, 'beta', []);
  let b = await current(beta);
  await assert.rejects(saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision));
  const a = await current(alpha);
  await saveGroupConfig(alpha, { ...a.config, conversations: [] }, a.revision);
  b = await current(beta);
  await saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision);
  assert.deepEqual((await loadConfig(alpha))!.conversations, []);
  assert.deepEqual((await loadConfig(beta))!.conversations, [group('123')]);
});

test('configuration saves preserve prose and reject stale or competing revisions', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  const initial = await current(cwd);
  await writeFile(join(cwd, 'PIQ.md'), '# 自定义说明\n\n保留前言。\n\n```json\n' + JSON.stringify(initial.config, null, 2) + '\n```\n\n保留结尾。\n');
  const before = await current(cwd);
  const outcomes = await Promise.allSettled([
    saveGroupConfig(cwd, { ...before.config, name: '第一版' }, before.revision),
    saveGroupConfig(cwd, { ...before.config, name: '第二版' }, before.revision),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  const final = await current(cwd);
  assert.match(final.text, /保留前言/); assert.match(final.text, /保留结尾/);
  await assert.rejects(saveGroupConfig(cwd, { ...final.config, id: 'different' }, final.revision));
});

test('membership edits require the group to stop but ordinary shared settings can be saved', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd);
  const before = await current(cwd);
  await assert.rejects(saveGroupConfig(cwd, { ...before.config, conversations: [] }, before.revision));
  await saveGroupConfig(cwd, { ...before.config, name: '运行中的新名称' }, before.revision);
  assert.equal((await loadConfig(cwd))!.name, '运行中的新名称');
});

test('active ownership prevents a manually edited configuration from freeing a live conversation', async t => {
  const root = await fixture(t);
  const alpha = await create(root, 'alpha', [group('123')]);
  const beta = await create(root, 'beta', []);
  await own(alpha);
  const a = (await current(alpha)).config;
  const releaseA = await claimConversations(alpha, a);
  try {
    await manuallyWrite(alpha, { ...a, conversations: [] });
    const b = await current(beta);
    await assert.rejects(saveGroupConfig(beta, { ...b.config, conversations: [group('123')] }, b.revision));
    await assert.rejects(assertAssignments(beta, { ...b.config, conversations: [group('123')] }));
    await manuallyWrite(beta, { ...b.config, conversations: [group('123')] });
    await own(beta);
    await assert.rejects(claimConversations(beta, (await loadConfig(beta))!));
  } finally { await releaseA(); }
  const releaseB = await claimConversations(beta, (await loadConfig(beta))!);
  await releaseB();
});

test('stale owner tokens do not retain claims and an old release cannot erase a new claim', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd, 'old-owner');
  const config = (await loadConfig(cwd))!;
  const releaseOld = await claimConversations(cwd, config);
  await own(cwd, 'new-owner');
  const releaseNew = await claimConversations(cwd, config);
  await releaseOld();
  const active = JSON.parse(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'));
  assert.equal(active.ownerToken, 'new-owner');
  await releaseNew();
  await assert.rejects(readFile(join(cwd, '.piq', 'conversations.json')), { code: 'ENOENT' });
  await own(cwd, 'stale-token');
  const releaseStale = await claimConversations(cwd, config);
  await own(cwd, 'replacement-token');
  await manuallyWrite(cwd, { ...config, conversations: [] });
  await create(root, 'beta', [group('123')]);
  await releaseStale();
});

test('removing an active group configuration cannot release its live conversation assignment', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd);
  const before = await current(cwd);
  const release = await claimConversations(cwd, before.config);
  try {
    await unlink(join(cwd, 'PIQ.md'));
    await assert.rejects(create(root, 'beta', [group('123')]));
  } finally {
    await writeFile(join(cwd, 'PIQ.md'), before.text);
    await release();
  }
});

test('claims require the current process owner and malformed sibling configs stop registry writes', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await assert.rejects(claimConversations(cwd, (await loadConfig(cwd))!));
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: 2147483647, token: 'not-this-process' }));
  await assert.rejects(claimConversations(cwd, (await loadConfig(cwd))!));
  await unlink(join(cwd, '.piq', 'owner.lock'));
  await mkdir(join(root, 'broken')); await writeFile(join(root, 'broken', 'PIQ.md'), '# invalid');
  await assert.rejects(create(root, 'beta', [group('456')]));
});

test('registry rejects group-directory symlinks that escape the configured root', async t => {
  const base = await fixture(t); const root = join(base, 'root'); const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'PIQ.md'), '# External\n```json\n' + JSON.stringify({ id: 'escape', name: '外部', conversations: [] }) + '\n```\n');
  try { await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('The OS sandbox does not permit symlinks.'); return; } throw error; }
  await assert.rejects(listGroupConfigs(root));
  await assert.rejects(create(root, 'beta', [group('456')]));
});

test('an active source group adopts one temporary conversation and preserves Markdown and ownership', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  const initial = await current(cwd);
  await writeFile(join(cwd, 'PIQ.md'), '# 共享配置\n\n保留说明。\n\n```json\n' + JSON.stringify(initial.config, null, 2) + '\n```\n\n保留结尾。\n');
  const token = await own(cwd);
  const release = await claimConversations(cwd, (await loadConfig(cwd))!);
  try {
    const target = { ...temporary('123', '456'), name: '临时来访者' };
    const before = await current(cwd);
    await assert.rejects(saveGroupConfig(cwd, { ...before.config, conversations: [...before.config.conversations, target] }, before.revision));
    const adopted = await adoptTemporaryConversation(cwd, target);
    assert.ok(adopted);
    assert.deepEqual(adopted.conversations, [group('123'), target]);
    const saved = await current(cwd);
    assert.deepEqual(saved.config, adopted);
    assert.match(saved.text, /保留说明。/); assert.match(saved.text, /保留结尾。/);
    const claim = JSON.parse(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'));
    assert.equal(claim.ownerToken, token);
    assert.deepEqual(claim.keys.sort(), ['group:123', 'temporary:123:456']);
  } finally { await release(); }
});

test('duplicate and concurrent temporary events do not rewrite or duplicate membership', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd); const release = await claimConversations(cwd, (await loadConfig(cwd))!);
  try {
    const target = temporary('123', '456');
    const results = await Promise.all(Array.from({ length: 4 }, () => adoptTemporaryConversation(cwd, target)));
    for (const result of results) assert.deepEqual(result?.conversations, [group('123'), target]);
    const before = await current(cwd);
    const claimBefore = await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8');
    assert.deepEqual(await adoptTemporaryConversation(cwd, { ...target, name: '之后的事件名称' }), before.config);
    assert.equal((await current(cwd)).text, before.text);
    assert.equal(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'), claimBefore);
  } finally { await release(); }
});

test('simultaneous temporary visitors are both retained without losing a configuration update', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd); const release = await claimConversations(cwd, (await loadConfig(cwd))!);
  try {
    await Promise.all([adoptTemporaryConversation(cwd, temporary('123', '456')), adoptTemporaryConversation(cwd, temporary('123', '789'))]);
    assert.deepEqual((await loadConfig(cwd))!.conversations.map(conversationKey).sort(), ['group:123', 'temporary:123:456', 'temporary:123:789']);
    const claim = JSON.parse(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'));
    assert.deepEqual(claim.keys.sort(), ['group:123', 'temporary:123:456', 'temporary:123:789']);
  } finally { await release(); }
});

test('explicit assignment to another group takes precedence over temporary auto adoption', async t => {
  const root = await fixture(t); const target = temporary('123', '456');
  const source = await create(root, 'source', [group('123')]);
  const explicit = await create(root, 'explicit', [target]);
  await own(source); const release = await claimConversations(source, (await loadConfig(source))!);
  try {
    const before = await current(source);
    const claimBefore = await readFile(join(source, '.piq', 'conversations.json'), 'utf8');
    assert.equal(await adoptTemporaryConversation(source, target), null);
    assert.equal((await current(source)).text, before.text);
    assert.equal(await readFile(join(source, '.piq', 'conversations.json'), 'utf8'), claimBefore);
    assert.deepEqual((await loadConfig(explicit))!.conversations, [target]);
  } finally { await release(); }
});

test('temporary auto adoption requires current owner and a live source-group claim', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  const target = temporary('123', '456');
  const before = await current(cwd);
  assert.equal(await adoptTemporaryConversation(cwd, target), null);
  await own(cwd);
  assert.equal(await adoptTemporaryConversation(cwd, target), null);
  const release = await claimConversations(cwd, before.config);
  try {
    assert.equal(await adoptTemporaryConversation(cwd, temporary('789', '456')), null);
    await own(cwd, 'replacement-owner');
    assert.equal(await adoptTemporaryConversation(cwd, target), null);
    assert.equal((await current(cwd)).text, before.text);
  } finally { await release(); }
  await assert.rejects(adoptTemporaryConversation(cwd, person('456')));
  await assert.rejects(adoptTemporaryConversation(cwd, { type: 'temporary', id: '456' }));
});

test('removing the source group from disk prevents new temporary adoption despite an old runtime claim', async t => {
  const root = await fixture(t); const cwd = await create(root, 'alpha', [group('123')]);
  await own(cwd); const before = await current(cwd);
  const release = await claimConversations(cwd, before.config);
  try {
    await manuallyWrite(cwd, { ...before.config, conversations: [] });
    const edited = await current(cwd);
    assert.equal(await adoptTemporaryConversation(cwd, temporary('123', '456')), null);
    assert.equal((await current(cwd)).text, edited.text);
  } finally { await release(); }
});

test('an already claimed explicit temporary chat works without a source-group membership', async t => {
  const root = await fixture(t); const target = temporary('123', '456');
  const cwd = await create(root, 'alpha', [target]);
  await own(cwd); const before = await current(cwd);
  const release = await claimConversations(cwd, before.config);
  try {
    const claimBefore = await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8');
    assert.deepEqual(await adoptTemporaryConversation(cwd, target), before.config);
    assert.equal((await current(cwd)).text, before.text);
    assert.equal(await readFile(join(cwd, '.piq', 'conversations.json'), 'utf8'), claimBefore);

    const notClaimed = temporary('789', '456');
    await manuallyWrite(cwd, { ...before.config, conversations: [target, notClaimed] });
    assert.equal(await adoptTemporaryConversation(cwd, notClaimed), null);
  } finally { await release(); }
});
