import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { copyGroup, deleteGroup, initializeGroup, listGroupConfigs, loadConfig, validateConfig } from '../src/config.ts';
import { getProcessStatus, startGroup } from '../src/process-manager.ts';
import { GroupStore } from '../src/store.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'delete-group-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await initializeGroup(root, 'friends', { name: '朋友', conversations: [{ type: 'group', id: '123456' }] });
  return { root, cwd };
}

async function runtime(cwd: string, file: string, value: unknown) {
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', file), JSON.stringify(value));
}

test('deleting a stopped group retains its complete directory and permits reusing its id and members', async t => {
  const { root, cwd } = await fixture(t);
  const persona = '# 原始人格\n不可丢失';
  const message = '{"original":"message"}\n';
  await writeFile(join(cwd, 'PERSONA.md'), persona);
  await mkdir(join(cwd, 'messages', 'group', '123456'), { recursive: true });
  await writeFile(join(cwd, 'messages', 'group', '123456', '2026-10-26.jsonl'), message);
  await runtime(cwd, 'slang.json', { version: 1, entries: [] });
  await mkdir(join(root, '.piq-slang'));
  await writeFile(join(root, '.piq-slang', 'friends.json'), '{"version":1,"entries":[]}');
  const before = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  const deleted = await deleteGroup(cwd);
  assert.equal(deleted.deleted, true); assert.equal(deleted.id, 'friends');
  assert.ok(deleted.recoveryPath.startsWith(join(root, '.trash', 'friends-')));
  await assert.rejects(readFile(join(cwd, 'PIQ.md')), /ENOENT/);
  assert.equal(await readFile(join(deleted.recoveryPath, 'PERSONA.md'), 'utf8'), persona);
  assert.equal(await readFile(join(deleted.recoveryPath, 'PIQ.md'), 'utf8'), before);
  assert.equal(await readFile(join(deleted.recoveryPath, 'messages', 'group', '123456', '2026-10-26.jsonl'), 'utf8'), message);
  assert.deepEqual(JSON.parse(await readFile(join(deleted.recoveryPath, '.piq', 'slang.json'), 'utf8')), { version: 1, entries: [] });
  for (const file of ['owner.lock', 'start.lock']) await assert.rejects(readFile(join(deleted.recoveryPath, '.piq', file)), /ENOENT/);
  assert.deepEqual(await listGroupConfigs(root), []);
  await assert.rejects(readFile(join(root, '.piq-slang', 'friends.json')), /ENOENT/);
  const retained = (await readdir(join(deleted.recoveryPath, '.piq'))).find(name => /^shared-slang-/.test(name));
  assert.ok(retained);
  assert.deepEqual(JSON.parse(await readFile(join(deleted.recoveryPath, '.piq', retained), 'utf8')), { version: 1, entries: [] });
  await initializeGroup(root, 'friends', { name: '新朋友', conversations: [{ type: 'group', id: '123456' }] });
  assert.equal((await listGroupConfigs(root))[0]!.config.name, '新朋友');
  assert.equal(await readFile(join(deleted.recoveryPath, 'PERSONA.md'), 'utf8'), persona);
});

test('running owners, startup leases and live starting workers cannot be moved or copied', async t => {
  for (const [file, value] of [
    ['owner.lock', { version: 1, pid: process.pid, token: randomUUID() }],
    ['start.lock', { pid: process.pid, token: randomUUID() }],
    ['worker-launch.json', { version: 1, pid: process.pid, launchId: 'pending-upstream', startedAt: Date.now() }],
    ['launch.json', { version: 1, pid: process.pid, launchId: 'legacy-pending', startedAt: Date.now() }],
    ['worker.json', { version: 1, mode: 'background', pid: process.pid, launchId: 'test', startedAt: Date.now(), state: 'starting' }],
  ] as const) {
    const { cwd } = await fixture(t);
    const before = await readFile(join(cwd, 'PIQ.md'), 'utf8');
    await runtime(cwd, file, value);
    for (const operation of [() => deleteGroup(cwd), () => copyGroup(cwd, '副本')]) {
      await assert.rejects(operation(), error => (error as { status?: number }).status === 409);
      assert.equal(await readFile(join(cwd, 'PIQ.md'), 'utf8'), before);
    }
    assert.deepEqual(JSON.parse(await readFile(join(cwd, '.piq', file), 'utf8')), value);
  }
});

test('a concurrent background start keeps its group while deletion waits on the shared startup lease', async t => {
  const { cwd } = await fixture(t);
  let launchStarted!: () => void, finishLaunch!: () => void;
  const started = new Promise<void>(resolve => { launchStarted = resolve; });
  const finish = new Promise<void>(resolve => { finishLaunch = resolve; });
  const start = startGroup(cwd, { env: { SNOWLUMA_ACCESS_TOKEN: 'fake-test-token' }, timeoutMs: 1, launch: async specification => {
    launchStarted(); await finish;
    await runtime(cwd, 'worker.json', { version: 1, mode: 'background', pid: process.pid, launchId: specification.env.PIQ_LAUNCH_ID, startedAt: Date.now(), state: 'starting' });
    return { pid: process.pid };
  } });
  await started;
  try { await assert.rejects(deleteGroup(cwd), error => (error as { status?: number }).status === 409); }
  finally { finishLaunch(); }
  assert.equal((await start).starting, true);
  assert.ok(await readFile(join(cwd, 'PIQ.md'), 'utf8'));
});

test('a directly opening Pi store holds an owner lease and cannot be archived', async t => {
  const { cwd } = await fixture(t);
  const config = (await loadConfig(cwd))!;
  const store = await GroupStore.open(cwd, config);
  try { await assert.rejects(deleteGroup(cwd), error => (error as { status?: number }).status === 409); }
  finally { await store.close(); }
  await deleteGroup(cwd);
});

test('missing groups, malformed config and damaged worker data are preserved', async t => {
  const { root, cwd } = await fixture(t);
  await assert.rejects(deleteGroup(join(root, 'absent')), /ENOENT/);
  await assert.rejects(deleteGroup(join(root, 'bad.name')));
  await writeFile(join(cwd, 'PIQ.md'), '{broken');
  await assert.rejects(deleteGroup(cwd));
  assert.equal(await readFile(join(cwd, 'PIQ.md'), 'utf8'), '{broken');
  await initializeGroup(root, 'other', { name: '其他', conversations: [] }).catch(() => {});
  // Repair only the test document, then simulate a corrupt worker record.
  await writeFile(join(cwd, 'PIQ.md'), '# 组\n```json\n' + JSON.stringify({ id: 'friends', name: '朋友', conversations: [] }) + '\n```\n');
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await writeFile(join(cwd, '.piq', 'worker.json'), '{broken');
  await assert.rejects(deleteGroup(cwd), /运行记录无效/);
  assert.equal(await readFile(join(cwd, '.piq', 'worker.json'), 'utf8'), '{broken');
});

test('copying creates an unassigned group with reusable knowledge and only whitelisted Pi settings', async t => {
  const { root, cwd } = await fixture(t);
  await writeFile(join(cwd, 'MEMORY.md'), '# 已有记忆\n有用的事实');
  await writeFile(join(cwd, 'CUSTOM.md'), '# 其他约定');
  await mkdir(join(cwd, 'assets', 'nested'), { recursive: true });
  await writeFile(join(cwd, 'assets', 'nested', 'picture.bin'), new Uint8Array([1, 2, 3]));
  await mkdir(join(cwd, 'memory'));
  await writeFile(join(cwd, 'memory', 'facts.txt'), 'Reusable knowledge');
  await writeFile(join(cwd, 'auth.json'), 'PRIVATE_AUTH');
  await mkdir(join(cwd, '.pi', 'sessions'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'sessions', 'private.jsonl'), 'PRIVATE_SESSION');
  const settings = JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8'));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ ...settings, defaultProvider: 'deepseek', defaultModel: 'deepseek-flash', defaultThinkingLevel: 'low', apiKey: 'PRIVATE_SETTINGS_KEY', theme: 'excluded-theme' }));
  await runtime(cwd, 'slang.json', { version: 1, entries: [] });
  await mkdir(join(root, '.piq-slang'));
  await writeFile(join(root, '.piq-slang', 'friends.json'), '{"version":1,"entries":[]}');
  const before = await readFile(join(cwd, 'PIQ.md'), 'utf8');
  const copy = await copyGroup(cwd, '  朋友副本  ');
  assert.match(copy.id, /^friends-copy-[a-f0-9]{8}$/); assert.equal(copy.name, '朋友副本');
  assert.equal(copy.path, join(root, copy.id));
  assert.equal((await loadConfig(copy.path))!.id, copy.id);
  assert.deepEqual((await loadConfig(copy.path))!.conversations, []);
  assert.equal(await readFile(join(copy.path, 'MEMORY.md'), 'utf8'), '# 已有记忆\n有用的事实');
  assert.equal(await readFile(join(copy.path, 'CUSTOM.md'), 'utf8'), '# 其他约定');
  assert.deepEqual(await readFile(join(copy.path, 'assets', 'nested', 'picture.bin')), Buffer.from([1, 2, 3]));
  assert.equal(await readFile(join(copy.path, 'memory', 'facts.txt'), 'utf8'), 'Reusable knowledge');
  const copiedSettings = JSON.parse(await readFile(join(copy.path, '.pi', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(copiedSettings).sort(), ['packages', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel'].sort());
  assert.doesNotMatch(JSON.stringify(copiedSettings), /PRIVATE_SETTINGS_KEY|excluded-theme/);
  for (const path of ['auth.json', '.piq', 'messages', '.pi/sessions']) await assert.rejects(readdir(join(copy.path, path)), /ENOENT|ENOTDIR/);
  assert.equal(await readFile(join(cwd, 'PIQ.md'), 'utf8'), before);
  for (const file of ['owner.lock', 'start.lock']) await assert.rejects(readFile(join(cwd, '.piq', file)), /ENOENT/);
  assert.equal((await listGroupConfigs(root)).length, 2);
});

test('directory junctions cannot redirect group deletion, trash storage or copied assets', async t => {
  const { root, cwd } = await fixture(t);
  const outside = join(root, 'outside'); await mkdir(outside);
  try { await symlink(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links unavailable'); return; } throw error; }
  try { await assert.rejects(deleteGroup(join(root, 'alias')), /普通目录/); }
  finally { if (process.platform === 'win32') await rmdir(join(root, 'alias')); else await unlink(join(root, 'alias')); }
  await symlink(outside, join(root, '.trash'), process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(deleteGroup(cwd), /普通目录/); }
  finally { if (process.platform === 'win32') await rmdir(join(root, '.trash')); else await unlink(join(root, '.trash')); }
  await symlink(outside, join(cwd, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(copyGroup(cwd, '不可复制的链接'), /普通目录/); }
  finally { if (process.platform === 'win32') await rmdir(join(cwd, 'assets', 'linked')); else await unlink(join(cwd, 'assets', 'linked')); }
  assert.deepEqual(await readdir(outside), []);
  assert.ok(await readFile(join(cwd, 'PIQ.md'), 'utf8'));
});

test('a launched process without its first worker record remains visible after startup timeout', async t => {
  const { cwd } = await fixture(t);
  let launches = 0;
  const options = { env: { SNOWLUMA_ACCESS_TOKEN: 'fake-test-token' }, timeoutMs: 1, launch: async () => { launches++; return { pid: process.pid }; } };
  assert.equal((await startGroup(cwd, options)).starting, true);
  await assert.rejects(readFile(join(cwd, '.piq', 'worker.json')), /ENOENT/);
  await assert.rejects(readFile(join(cwd, '.piq', 'start.lock')), /ENOENT/);
  assert.deepEqual(await getProcessStatus(cwd), { running: false, pid: process.pid, mode: 'background', starting: true });
  await assert.rejects(deleteGroup(cwd), error => (error as { status?: number }).status === 409);
  await assert.rejects(copyGroup(cwd, '仍在启动'), error => (error as { status?: number }).status === 409);
  assert.equal((await startGroup(cwd, options)).alreadyRunning, true);
  assert.equal(launches, 1);
});

test('permission configuration accepts independent boolean switches and defaults to unrestricted tools', () => {
  const minimal = { id: 'permissions', name: '权限', conversations: [] };
  assert.equal(validateConfig(minimal).permissions, undefined);
  assert.deepEqual(validateConfig({ ...minimal, permissions: {} }).permissions, {});
  const permissions = { commands: false, fileRead: true, fileWrite: false, qq: true, network: false, otherTools: true };
  assert.deepEqual(validateConfig({ ...minimal, permissions }).permissions, permissions);
  for (const value of [null, [], true, { commands: 'false' }, { network: 0 }, { fileRead: undefined }, { unexpected: true }]) {
    assert.throws(() => validateConfig({ ...minimal, permissions: value }), /permissions/);
  }
});

test('terminal return leases protect pending monitors and actual Pi PIDs before owner registration', async t => {
  for (const detail of [
    { state: 'starting' },
    { state: 'watching', monitorPid: process.pid },
    { state: 'recovering', monitorPid: process.pid },
    { state: 'watching', wrapperPid: process.pid, piPid: process.pid },
    { state: 'error', piPid: process.pid },
  ]) {
    const { cwd } = await fixture(t);
    const terminal = { version: 1, token: randomUUID(), createdAt: Date.now(), launcherPid: process.pid, ...detail };
    await runtime(cwd, 'terminal-return.json', terminal);
    for (const operation of [() => deleteGroup(cwd), () => copyGroup(cwd, '仍有终端恢复')]) {
      await assert.rejects(operation(), error => (error as { status?: number }).status === 409);
      await assert.rejects(readFile(join(cwd, '.piq', 'owner.lock')), /ENOENT/);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, '.piq', 'terminal-return.json'), 'utf8')), terminal);
    }
  }
});

test('matching finished worker state supersedes pending markers and stopped error monitors permit archival', async t => {
  const { cwd } = await fixture(t);
  for (const file of ['worker-launch.json', 'launch.json']) {
    await runtime(cwd, file, { version: 1, pid: process.pid, launchId: 'completed-launch', startedAt: 1 });
  }
  await runtime(cwd, 'worker.json', { version: 1, mode: 'background', pid: process.pid, launchId: 'completed-launch', startedAt: 2, state: 'stopped' });
  await runtime(cwd, 'terminal-return.json', { version: 1, token: randomUUID(), createdAt: Date.now(), launcherPid: process.pid, monitorPid: process.pid, state: 'error' });
  assert.equal((await getProcessStatus(cwd)).starting, false);
  assert.equal((await deleteGroup(cwd)).deleted, true);
});

test('legacy launch markers remain visible without a worker-launch record', async t => {
  const { cwd } = await fixture(t);
  await runtime(cwd, 'launch.json', { version: 1, pid: process.pid, launchId: 'legacy', startedAt: 1 });
  assert.deepEqual(await getProcessStatus(cwd), { running: false, pid: process.pid, mode: 'background', starting: true });
  await assert.rejects(copyGroup(cwd, '旧启动仍活跃'), error => (error as { status?: number }).status === 409);
});
