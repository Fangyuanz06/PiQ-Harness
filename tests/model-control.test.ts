import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { initializeGroup } from '../src/config.ts';
import { readModelStatus, registerModelControl, requestModelChange } from '../src/model-control.ts';

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type FakeModel = NonNullable<ExtensionContext['model']>;

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await check()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for local model control.');
    await delay(10);
  }
}

async function fixture(t: TestContext, start = true) {
  const parent = join(process.cwd(), '.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'model-control-'));
  const cwd = await initializeGroup(root, '123456', { name: 'Test group', conversations: [{ type: 'group', id: '123456' }] });
  await mkdir(join(cwd, '.piq'));
  const owner = { version: 1, pid: process.pid, token: randomUUID() };
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify(owner));
  const models = ['alpha', 'beta', 'plain'].map(id => ({ provider: 'local', id, name: id }) as FakeModel);
  const state = { model: models[0]!, level: 'low' as ThinkingLevel, rejectAuth: false, gate: undefined as Promise<void> | undefined };
  const calls: string[] = [];
  const notices: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const ctx = {
    cwd,
    get model() { return state.model; },
    modelRegistry: { find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id) },
    isIdle() { assert.fail('Model changes must be allowed while the session is busy.'); },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  async function emit(name: string, event: unknown = { type: name }) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
      return () => {};
    },
    async setModel(model: FakeModel) {
      calls.push(`model:${model.id}`);
      if (state.gate) await state.gate;
      if (state.rejectAuth) return false;
      const previousModel = state.model;
      state.model = model;
      await emit('model_select', { type: 'model_select', model, previousModel, source: 'set' });
      return true;
    },
    getThinkingLevel: () => state.level,
    setThinkingLevel(level: ThinkingLevel) {
      calls.push(`thinking:${level}`);
      state.level = state.model.id === 'plain' ? 'off' : level;
      void emit('thinking_level_select', { type: 'thinking_level_select', level: state.level });
    },
  } as unknown as ExtensionAPI;
  registerModelControl(pi, { pollMs: 5 });
  t.after(async () => { await emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  if (start) await emit('session_start');
  return { root, cwd, owner, state, calls, notices, emit };
}

test('applies model and thinking while busy and returns actual public state', async t => {
  const f = await fixture(t);
  assert.equal((await readModelStatus(f.cwd))?.status, 'ready');
  const request = await requestModelChange(f.cwd, { provider: 'local', model: 'beta', thinkingLevel: 'high' });
  await eventually(async () => (await readModelStatus(f.cwd))?.requestId === request.requestId);
  assert.deepEqual(f.calls, ['model:beta', 'thinking:high']);
  const status = (await readModelStatus(f.cwd))!;
  assert.equal(status.status, 'applied'); assert.equal(status.model, 'beta'); assert.equal(status.thinkingLevel, 'high');
  assert.doesNotMatch(JSON.stringify(status), /ownerToken|token/);
  assert.deepEqual(f.notices, []);
  await delay(30);
  assert.equal(f.calls.length, 2, 'The same request must be applied once.');
});

test('thinking-only updates use Pi capability clamping and manual selections are reflected', async t => {
  const f = await fixture(t);
  f.state.model = { ...f.state.model, id: 'plain' };
  const request = await requestModelChange(f.cwd, { thinkingLevel: 'high' });
  await eventually(async () => (await readModelStatus(f.cwd))?.requestId === request.requestId);
  assert.equal((await readModelStatus(f.cwd))?.thinkingLevel, 'off');
  assert.deepEqual(f.calls, ['thinking:high']);
  f.state.model = { ...f.state.model, id: 'beta' };
  f.state.level = 'max';
  await f.emit('model_select');
  const manual = (await readModelStatus(f.cwd))!;
  assert.equal(manual.model, 'beta'); assert.equal(manual.thinkingLevel, 'max'); assert.equal(manual.status, 'ready');
});

test('unknown model and unavailable authentication produce visible errors without changing thinking', async t => {
  const f = await fixture(t);
  const unknown = await requestModelChange(f.cwd, { provider: 'local', model: 'missing', thinkingLevel: 'high' });
  await eventually(async () => (await readModelStatus(f.cwd))?.requestId === unknown.requestId);
  assert.equal((await readModelStatus(f.cwd))?.status, 'error');
  assert.match((await readModelStatus(f.cwd))!.error!, /找不到|无法找到/);
  assert.deepEqual(f.calls, []);
  f.state.rejectAuth = true;
  const rejected = await requestModelChange(f.cwd, { provider: 'local', model: 'beta', thinkingLevel: 'high' });
  await eventually(async () => (await readModelStatus(f.cwd))?.requestId === rejected.requestId);
  assert.equal((await readModelStatus(f.cwd))?.status, 'error');
  assert.match((await readModelStatus(f.cwd))!.error!, /认证/);
  assert.deepEqual(f.calls, ['model:beta']);
  assert.equal(f.state.level, 'low');
});

test('requests address one owner token and stale requests cannot affect a new session', async t => {
  const f = await fixture(t, false);
  await requestModelChange(f.cwd, { provider: 'local', model: 'beta', thinkingLevel: 'high' });
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ ...f.owner, token: randomUUID() }));
  await f.emit('session_start');
  await delay(35);
  assert.deepEqual(f.calls, []);
  assert.equal((await readModelStatus(f.cwd))?.model, 'alpha');
  const status = JSON.parse(await readFile(join(f.cwd, '.piq', 'model-status.json'), 'utf8'));
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify(f.owner));
  assert.equal(await readModelStatus(f.cwd), null, 'A previous process status must not appear current.');
  assert.notEqual(status.ownerToken, f.owner.token);
});

test('shutdown waits for an active native change and prevents later thinking calls', async t => {
  const f = await fixture(t);
  let release = () => {};
  f.state.gate = new Promise<void>(resolve => { release = resolve; });
  await requestModelChange(f.cwd, { provider: 'local', model: 'beta', thinkingLevel: 'high' });
  await eventually(() => f.calls.length === 1);
  let stopped = false;
  const shutdown = f.emit('session_shutdown').then(() => { stopped = true; });
  await delay(15); assert.equal(stopped, false);
  release(); await shutdown;
  await delay(20);
  assert.deepEqual(f.calls, ['model:beta']);
});

test('invalid selections and absent owner are rejected before creating a request', async t => {
  const f = await fixture(t);
  await assert.rejects(requestModelChange(f.cwd, { model: 'beta' }), /同时选择/);
  await assert.rejects(requestModelChange(f.cwd, { thinkingLevel: 'infinite' }), /强度无效/);
  await f.emit('session_shutdown');
  await rm(join(f.cwd, '.piq', 'owner.lock'));
  await assert.rejects(requestModelChange(f.cwd, { thinkingLevel: 'high' }), /未运行/);
});

test('a linked control directory cannot write outside the group', async t => {
  const parent = join(process.cwd(), '.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'control-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'group'); const outside = join(root, 'outside');
  await mkdir(cwd); await mkdir(outside);
  await writeFile(join(outside, 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'outside' }));
  try { await symlink(outside, join(cwd, '.piq'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('The current OS sandbox forbids symlink creation.'); return; }
    throw error;
  }
  await assert.rejects(requestModelChange(cwd, { thinkingLevel: 'high' }), /本群目录/);
});
