import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { RunController, clearInterruptedWork, readRuntimeStatus, requestRunAction, type ConnectionState } from '../src/run-control.ts';

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await check()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for run control.');
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const parent = join(process.cwd(), '.test-tmp');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, 'run-control-'));
  await mkdir(join(cwd, '.piq'));
  const owner = { version: 1, pid: process.pid, token: randomUUID() };
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify(owner));
  const calls: Array<string | boolean> = [];
  const errors: unknown[] = [];
  const state = { connection: 'connected' as ConnectionState, pendingCount: 0, busy: true };
  const instances: RunController[] = [];
  const open = async () => {
    const controller = await RunController.open(cwd, {
      snapshot: () => ({ connection: state.connection, pendingCount: state.pendingCount }),
      isBusy: () => state.busy,
      pause: () => { calls.push('pause'); },
      resume: interrupted => { calls.push('resume', interrupted); },
      shutdown: () => { calls.push('shutdown'); },
      error: error => errors.push(error),
    }, 5);
    instances.push(controller);
    return controller;
  };
  t.after(async () => {
    for (const controller of instances) await controller.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, owner, calls, errors, state, open };
}

test('pause and resume persist intent and acknowledge actual state without exposing owner tokens', async t => {
  const f = await fixture(t);
  const controller = await f.open();
  const pause = await requestRunAction(f.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId);
  assert.equal(controller.paused, true);
  assert.deepEqual(f.calls, ['pause']);
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')),
    { version: 1, paused: true, interrupted: true });
  f.state.pendingCount = 12;
  f.state.connection = 'disconnected';
  controller.refresh();
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.pendingCount === 12);
  const paused = (await readRuntimeStatus(f.cwd))!;
  assert.equal(paused.connection, 'disconnected');
  assert.doesNotMatch(JSON.stringify(paused), /token|ownerToken/);
  const resume = await requestRunAction(f.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId);
  assert.equal(controller.paused, false);
  assert.deepEqual(f.calls, ['pause', 'resume', true]);
  await delay(30);
  assert.equal(f.calls.length, 3, 'A request must execute once.');
  assert.deepEqual(f.errors, []);
});

test('a new owner restores pause intent but ignores a request addressed to an old Pi instance', async t => {
  const f = await fixture(t);
  const first = await f.open();
  const pause = await requestRunAction(f.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId);
  await first.close();
  const nextOwner = { ...f.owner, token: randomUUID() };
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify(nextOwner));
  assert.equal(await readRuntimeStatus(f.cwd), null);
  const replacement = await f.open();
  await delay(30);
  assert.equal(replacement.paused, true);
  assert.deepEqual(f.calls, ['pause']);
  const resume = await requestRunAction(f.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId);
  assert.deepEqual(f.calls, ['pause', 'resume', true]);
  assert.deepEqual(f.errors, []);
});

test('shutdown is acknowledged before callback and closing stops later control processing', async t => {
  const f = await fixture(t);
  const controller = await f.open();
  const shutdown = await requestRunAction(f.cwd, 'shutdown');
  await eventually(() => f.calls.includes('shutdown'));
  assert.equal((await readRuntimeStatus(f.cwd))?.requestId, shutdown.requestId);
  await controller.close();
  await requestRunAction(f.cwd, 'pause');
  await delay(40);
  assert.deepEqual(f.calls, ['shutdown']);
  assert.equal(controller.paused, false);
  assert.deepEqual(f.errors, []);
});

test('invalid actions and missing owners cannot create control requests', async t => {
  const f = await fixture(t);
  await assert.rejects(requestRunAction(f.cwd, 'delete' as 'pause'), /未知/);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'run-request.json')), { code: 'ENOENT' });
  await rm(join(f.cwd, '.piq', 'owner.lock'));
  await assert.rejects(requestRunAction(f.cwd, 'pause'), /未运行/);
  assert.equal(await readRuntimeStatus(f.cwd), null);
});

test('busy work survives owner replacement while settled work needs no continuation', async t => {
  const f = await fixture(t);
  const first = await f.open();
  await first.markBusy(true);
  assert.equal(first.needsResume, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')),
    { version: 1, paused: false, interrupted: true });
  await first.close();
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ ...f.owner, token: randomUUID() }));
  const replacement = await f.open();
  assert.equal(replacement.needsResume, true);
  await replacement.markBusy(false);
  assert.equal(replacement.needsResume, false);
  await replacement.close();
  const idle = await f.open();
  assert.equal(idle.needsResume, false);
  assert.deepEqual(f.calls, []);
});

test('pause retains interrupted work through settling and resume until completion', async t => {
  const f = await fixture(t);
  const controller = await f.open();
  await controller.markBusy(true);
  const pause = await requestRunAction(f.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId);
  await controller.markBusy(false);
  assert.equal(controller.needsResume, false);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')).interrupted, true);
  const resume = await requestRunAction(f.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId);
  assert.equal(controller.needsResume, true);
  await controller.markBusy(false);
  assert.equal(controller.needsResume, false);
  assert.deepEqual(f.calls, ['pause', 'resume', true]);
});

test('manual work during an idle pause does not create unfinished automatic work', async t => {
  const f = await fixture(t); f.state.busy = false;
  const controller = await f.open();
  const pause = await requestRunAction(f.cwd, 'pause');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === pause.requestId);
  await controller.markBusy(true); await controller.markBusy(false);
  const resume = await requestRunAction(f.cwd, 'resume');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === resume.requestId);
  assert.equal(controller.needsResume, false);
  assert.deepEqual(f.calls, ['pause', 'resume', false]);
});

test('handoff retains unfinished work even when shutdown settles, explicit stop clears it', async t => {
  const f = await fixture(t);
  const first = await f.open();
  await first.markBusy(true);
  const handoff = await requestRunAction(f.cwd, 'handoff');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === handoff.requestId);
  await first.markBusy(false);
  assert.equal(first.needsResume, true);
  await first.close();
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ ...f.owner, token: randomUUID() }));
  const next = await f.open();
  const stopped = await requestRunAction(f.cwd, 'shutdown');
  await eventually(async () => (await readRuntimeStatus(f.cwd))?.requestId === stopped.requestId);
  await next.markBusy(true);
  assert.equal(next.needsResume, false);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')).interrupted, false);
});

test('an old controller cannot overwrite the new owner continuation state', async t => {
  const f = await fixture(t);
  const old = await f.open();
  await old.markBusy(true);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ ...f.owner, token: randomUUID() }));
  await writeFile(join(f.cwd, '.piq', 'run-preferences.json'), JSON.stringify({ version: 1, paused: false, interrupted: false }));
  await old.markBusy(true); await old.markBusy(false);
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')),
    { version: 1, paused: false, interrupted: false });
});

test('stop clears unfinished work after the owner exits and preserves pause preference', async t => {
  const f = await fixture(t);
  await rm(join(f.cwd, '.piq', 'owner.lock'));
  await clearInterruptedWork(f.cwd);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'run-preferences.json')), { code: 'ENOENT' });
  await writeFile(join(f.cwd, '.piq', 'run-preferences.json'), JSON.stringify({ version: 1, paused: true, interrupted: true }));
  await clearInterruptedWork(f.cwd);
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, '.piq', 'run-preferences.json'), 'utf8')),
    { version: 1, paused: true, interrupted: false });
});
