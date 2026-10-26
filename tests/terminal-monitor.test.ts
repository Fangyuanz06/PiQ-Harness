import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { initializeGroup } from '../src/config.ts';
import { cancelTerminalReturn, getTerminalReturnError, prepareTerminalReturn, registerTerminal, runTerminalMonitor,
  type TerminalMonitorLaunch, type TerminalMonitorOptions } from '../src/terminal-monitor.ts';

const moduleUrl = new URL('../src/terminal-monitor.ts', import.meta.url).href;

async function eventually(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) assert.fail('Timed out waiting for terminal monitor.'); await delay(10); }
}

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'terminal-monitor-'));
  const cwd = await initializeGroup(root, 'friends', { name: 'Friends', conversations: [{ type: 'group', id: '123456' }] });
  await mkdir(join(cwd, '.piq'), { recursive: true });
  const stateFile = join(cwd, '.piq', 'terminal-return.json');
  const tasks: Promise<void>[] = [];
  const children: ChildProcess[] = [];
  let starts = 0;
  const launches: TerminalMonitorLaunch[] = [];
  const prepare = async (options: TerminalMonitorOptions = {}) => prepareTerminalReturn(cwd, {
    env: { SNOWLUMA_ACCESS_TOKEN: 'fake-private-token' }, readyTimeoutMs: 2_000,
    launch: async specification => {
      launches.push(specification);
      const task = runTerminalMonitor(cwd, { token: specification.env.PIQ_TERMINAL_RETURN_TOKEN,
        pollMs: 5, registrationTimeoutMs: 2_000, start: async () => { starts++; }, ...options });
      tasks.push(task);
      return { pid: process.pid };
    },
  });
  const state = async () => { try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  const child = async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolveChild, reject) => { child.once('spawn', resolveChild); child.once('error', reject); });
    return child;
  };
  t.after(async () => {
    await cancelTerminalReturn(cwd).catch(() => {});
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await Promise.all(tasks);
    await rm(root, { recursive: true, force: true });
  });
  return { cwd, root, stateFile, state, prepare, child, launches, tasks, starts: () => starts };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveStop => { child.once('exit', () => resolveStop()); child.kill(); });
}

test('prepares one monitor per group and keeps credentials and lease identifiers out of arguments', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.prepare(), f.prepare()]);
  assert.equal(f.launches.length, 1);
  assert.equal(results[0].token, results[1].token);
  assert.equal(results.filter(result => result.alreadyRunning).length, 1);
  const specification = f.launches[0]!;
  assert.equal(specification.env.SNOWLUMA_ACCESS_TOKEN, 'fake-private-token');
  assert.equal(specification.env.PIQ_TERMINAL_RETURN_TOKEN, results[0].token);
  assert.doesNotMatch(JSON.stringify(specification.args), /fake-private-token/);
  assert.equal(specification.args.includes(results[0].token), false);
  assert.doesNotMatch(await readFile(f.stateFile, 'utf8'), /fake-private-token/);
  assert.equal((await f.state()).state, 'watching');
});

test('a terminal exits before acquiring a Pi owner and returns to the background once', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  await delay(25);
  assert.equal(f.starts(), 0);
  await stopChild(wrapper);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 1);
  assert.equal(await f.state(), null);
});

test('recovery waits for both the terminal wrapper and its Pi process to exit', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child(); const pi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  await stopChild(wrapper);
  await delay(40);
  assert.equal(f.starts(), 0);
  await stopChild(pi);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 1);
});

test('closing before real Pi PID registration waits for owner cleanup then recovers once', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child(); const pi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: pi.pid, token: 'registering-owner' }));
  await stopChild(wrapper);
  await delay(60);
  assert.equal(f.starts(), 0);
  assert.equal((await f.state()).state, 'watching');
  await stopChild(pi);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 1);
  assert.equal(await f.state(), null);
});

test('a still-unregistered live owner outlasting the short grace makes the monitor yield', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare({ registrationTimeoutMs: 1_000 });
  const wrapper = await f.child(); const unrelatedPi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: unrelatedPi.pid, token: 'unregistered-owner' }));
  await stopChild(wrapper);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 0);
  assert.equal(await f.state(), null);
  assert.equal(unrelatedPi.exitCode, null);
  assert.equal(unrelatedPi.signalCode, null);
});

test('explicit cancellation suppresses recovery and stale tokens cannot affect a replacement', async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  await registerTerminal(f.cwd, first.token);
  await cancelTerminalReturn(f.cwd);
  await f.tasks[0];
  assert.equal(f.starts(), 0);
  const second = await f.prepare();
  assert.notEqual(second.token, first.token);
  await cancelTerminalReturn(f.cwd, first.token);
  assert.equal((await f.state()).token, second.token);
  await assert.rejects(registerTerminal(f.cwd, first.token), /失效/);
  await registerTerminal(f.cwd, second.token);
  await cancelTerminalReturn(f.cwd, second.token);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 0);
});

test('rapid concurrent open, registration and cancellation tolerate file lock transitions', async t => {
  const f = await fixture(t);
  for (let round = 0; round < 20; round++) {
    const prepared = await f.prepare();
    const results = await Promise.all([
      registerTerminal(f.cwd, prepared.token), f.prepare(), f.prepare(),
      getTerminalReturnError(f.cwd), getTerminalReturnError(f.cwd),
    ]);
    assert.equal(results[1]!.token, prepared.token);
    assert.equal(results[2]!.alreadyRunning, true);
    assert.equal(results[3], undefined);
    assert.equal(results[4], undefined);
    await Promise.all([cancelTerminalReturn(f.cwd, prepared.token), cancelTerminalReturn(f.cwd, prepared.token), getTerminalReturnError(f.cwd)]);
    await f.tasks[round];
  }
  assert.equal(f.launches.length, 20);
  assert.equal(f.starts(), 0);
  assert.equal(await f.state(), null);
});

test('cancellation waits for an in-progress recovery so its caller can stop the new owner', async t => {
  const f = await fixture(t);
  let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const prepared = await f.prepare({ start: async () => { assert.equal(await getTerminalReturnError(f.cwd), undefined); entered = true; await gate; } });
  const wrapper = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  await stopChild(wrapper);
  await eventually(() => entered);
  let cancelled = false;
  const cancelling = cancelTerminalReturn(f.cwd).then(() => { cancelled = true; });
  await delay(35);
  assert.equal(cancelled, false);
  release();
  await cancelling;
  await Promise.all(f.tasks);
  assert.equal(cancelled, true);
  assert.equal(await f.state(), null);
});

test('a different live Pi owner makes an old monitor yield without restarting or stopping it', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child(); const oldPi = await f.child();
  await stopChild(oldPi);
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, oldPi.pid);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'different-owner' }));
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 0);
  assert.equal(await f.state(), null);
  assert.equal(JSON.parse(await readFile(join(f.cwd, '.piq', 'owner.lock'), 'utf8')).token, 'different-owner');
});

test('an owner lock being written does not permanently fail the monitor', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, wrapper.pid);
  const ownerFile = join(f.cwd, '.piq', 'owner.lock');
  await writeFile(ownerFile, '');
  await delay(20);
  await writeFile(ownerFile, JSON.stringify({ version: 1, pid: wrapper.pid, token: 'new-owner' }));
  await delay(80);
  assert.equal(await getTerminalReturnError(f.cwd), undefined);
  assert.equal((await f.state()).state, 'watching');
  await stopChild(wrapper);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 1);
});

test('native reloads can replace the owner token in the same Pi process without losing background return', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child(); const pi = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, pi.pid);
  const ownerFile = join(f.cwd, '.piq', 'owner.lock');
  await writeFile(ownerFile, JSON.stringify({ version: 1, pid: pi.pid, token: 'before-reload' }));
  await eventually(async () => (await f.state())?.ownerToken === 'before-reload');
  await writeFile(ownerFile, JSON.stringify({ version: 1, pid: pi.pid, token: 'after-reload' }));
  await eventually(async () => (await f.state())?.ownerToken === 'after-reload');
  assert.equal(await getTerminalReturnError(f.cwd), undefined);
  await stopChild(wrapper); await stopChild(pi);
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 1);
  assert.equal(await f.state(), null);
});

test('failed background startup is bounded and exposes only a safe generic diagnostic', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const prepared = await f.prepare({ start: async () => { attempts++; throw new Error('private-token https://private.example/?secret=private'); } });
  const wrapper = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid);
  await stopChild(wrapper);
  await Promise.all(f.tasks);
  assert.equal(attempts, 1);
  await delay(35);
  assert.equal(attempts, 1);
  assert.equal((await f.state()).state, 'error');
  const diagnostic = await getTerminalReturnError(f.cwd);
  assert.match(diagnostic!, /后台恢复失败/);
  assert.doesNotMatch(diagnostic!, /private|token|secret/);
  assert.doesNotMatch(await readFile(f.stateFile, 'utf8'), /private\.example|private-token/);
});

test('an unopened terminal registration expires without creating a background instance', async t => {
  const f = await fixture(t);
  await f.prepare({ registrationTimeoutMs: 1_000 });
  await Promise.all(f.tasks);
  assert.equal(f.starts(), 0);
  assert.equal(await f.state(), null);
});

test('a dead monitor fails readiness visibly and an abandoned lock can be recovered', async t => {
  const f = await fixture(t);
  const dead = await f.child(); await stopChild(dead);
  await writeFile(join(f.cwd, '.piq', 'terminal-return.lock'), JSON.stringify({ pid: dead.pid, token: 'dead-lock' }));
  await assert.rejects(prepareTerminalReturn(f.cwd, { readyTimeoutMs: 30, launch: async () => ({ pid: dead.pid! }) }), /未能启动/);
  assert.match((await getTerminalReturnError(f.cwd))!, /后台恢复失败/);
  const retry = await f.prepare();
  assert.equal((await f.state()).token, retry.token);
});

test('registration validates process identity and rejects changes to a registered Pi', async t => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const wrapper = await f.child(); const other = await f.child();
  await registerTerminal(f.cwd, prepared.token, wrapper.pid, wrapper.pid);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, other.pid), /另一进程/);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, wrapper.pid, other.pid), /已登记/);
  await assert.rejects(registerTerminal(f.cwd, prepared.token, 0), /无效/);
});

test('monitor metadata refuses links outside the group', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await rename(join(f.cwd, '.piq'), join(f.cwd, '.piq-original'));
  try { await symlink(outside, join(f.cwd, '.piq'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await rename(join(f.cwd, '.piq-original'), join(f.cwd, '.piq'));
    t.skip('The OS sandbox does not permit directory links.'); return;
  }
  try {
    await assert.rejects(prepareTerminalReturn(f.cwd), /普通/);
    assert.equal(await getTerminalReturnError(f.cwd) !== undefined, true);
  } finally {
    const linked = join(f.cwd, '.piq');
    try { await unlink(linked); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EISDIR') await rmdir(linked);
      else if (code !== 'ENOENT') throw error;
    }
    await rename(join(f.cwd, '.piq-original'), join(f.cwd, '.piq'));
  }
});

test('the detached monitor survives its launcher and recovers after a real terminal child is killed', async t => {
  const f = await fixture(t);
  const recovered = join(f.root, 'recovered.json');
  const monitorEntry = join(f.root, 'fake-monitor.mjs');
  const launcherEntry = join(f.root, 'fake-launcher.mjs');
  const launcherReady = join(f.root, 'launcher-ready');
  await writeFile(monitorEntry, `import {writeFile} from 'node:fs/promises';\nimport {runTerminalMonitor} from ${JSON.stringify(moduleUrl)};\nawait runTerminalMonitor(process.argv[2],{pollMs:10,start:async()=>{await writeFile(${JSON.stringify(recovered)},JSON.stringify({pid:process.pid}));}});\n`);
  await writeFile(launcherEntry, `import {spawn} from 'node:child_process';\nimport {writeFile} from 'node:fs/promises';\nimport {prepareTerminalReturn} from ${JSON.stringify(moduleUrl)};\nawait prepareTerminalReturn(process.argv[2],{launch:async s=>await new Promise((resolveLaunch,reject)=>{const child=spawn(process.execPath,[${JSON.stringify(monitorEntry)},...s.args.slice(1)],{cwd:s.cwd,env:s.env,detached:true,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolveLaunch({pid:child.pid});});})});\nawait writeFile(${JSON.stringify(launcherReady)},'ready');\nsetInterval(()=>{},1000);\n`);
  const launcher = spawn(process.execPath, [launcherEntry, f.cwd], { stdio: 'ignore' });
  t.after(() => { if (launcher.exitCode === null) launcher.kill(); });
  await eventually(async () => { try { await readFile(launcherReady); return true; } catch { return false; } });
  const lease = await f.state();
  t.after(() => { try { process.kill(lease.monitorPid); } catch { /* already exited */ } });
  const wrapper = await f.child();
  await registerTerminal(f.cwd, lease.token, wrapper.pid, wrapper.pid);
  await stopChild(launcher);
  assert.equal(launcher.signalCode !== null || launcher.exitCode !== null, true);
  await stopChild(wrapper);
  await eventually(async () => { try { await readFile(recovered); return true; } catch { return false; } });
  const result = JSON.parse(await readFile(recovered, 'utf8'));
  assert.equal(result.pid, lease.monitorPid);
  assert.notEqual(result.pid, process.pid);
  await eventually(async () => (await f.state()) === null);
});
