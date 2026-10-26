import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeGroup } from '../src/config.ts';
import { getProcessStatus, handoffToTerminal, startGroup, type BackgroundLaunch } from '../src/process-manager.ts';
import { configureBackgroundHttp, runBackground, type BackgroundSession } from '../src/background.ts';

test('background HTTP setup applies global proxy settings before configuring the dispatcher', async () => {
  const calls: unknown[] = [];
  const previousFetch = globalThis.fetch;
  await configureBackgroundHttp({
    getGlobalSettings: () => ({ httpProxy: 'http://127.0.0.1:12345' }),
    getHttpIdleTimeoutMs: () => 120_000,
  }, async () => ({
    applyHttpProxySettings: value => { calls.push(['proxy', value]); },
    configureHttpDispatcher: value => { calls.push(['dispatcher', value]); },
  }));
  assert.deepEqual(calls, [['proxy', 'http://127.0.0.1:12345'], ['dispatcher', 120_000]]);
  assert.equal(globalThis.fetch, previousFetch);
});

test('official Pi HTTP bootstrap sends model fetches through a configured local proxy', async () => {
  const moduleUrl = new URL('../src/background.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { configureBackgroundHttp } from ${JSON.stringify(moduleUrl)};
    const sockets = new Set();
    const connects = [];
    const proxy = createServer();
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('connect', (request, socket) => {
      connects.push(request.url);
      socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
      socket.once('data', () => socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 11\\r\\nConnection: close\\r\\n\\r\\n{"ok":true}'));
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    for (const name of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy']) delete process.env[name];
    try {
      const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
      await configureBackgroundHttp({getGlobalSettings: () => ({httpProxy:proxyUrl}), getHttpIdleTimeoutMs: () => 3000});
      const response = await fetch('http://piq-model-test.invalid/health', {signal:AbortSignal.timeout(3000)});
      assert.deepEqual(await response.json(), {ok:true});
      assert.deepEqual(connects, ['piq-model-test.invalid:80']);
      console.log('proxy-bootstrap-ok');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
  assert.match(stdout, /proxy-bootstrap-ok/);
});

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'process-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = await initializeGroup(root, '10001', { name: 'Test group', conversations: [{ type: 'group', id: '10001' }] });
  await mkdir(join(cwd, '.piq'));
  const ownerFile = join(cwd, '.piq', 'owner.lock');
  const workerFile = join(cwd, '.piq', 'worker.json');
  const token = 'owned-worker-token';
  const owner = () => writeFile(ownerFile, JSON.stringify({ version: 1, pid: process.pid, token }));
  const record = (launchId = 'fixture', state = 'running', ownerToken = token) => writeFile(workerFile, JSON.stringify({
    version: 1, mode: 'background', pid: process.pid, launchId, startedAt: Date.now(), state, ownerToken,
  }));
  return { root, cwd, ownerFile, workerFile, token, owner, record };
}

test('starts one isolated hidden worker with credentials only in its environment', async t => {
  const f = await fixture(t);
  const launches: BackgroundLaunch[] = [];
  const result = await startGroup(f.cwd, { env: { SNOWLUMA_ACCESS_TOKEN: 'private-token' }, launch: async specification => {
    launches.push(specification);
    await f.owner();
    await f.record(specification.env.PIQ_LAUNCH_ID);
    return { pid: process.pid };
  } });
  assert.equal(result.starting, undefined);
  assert.equal(result.pid, process.pid);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.cwd, f.cwd);
  assert.equal(launches[0]!.command, process.execPath);
  assert.ok(launches[0]!.args[0]!.endsWith('background.ts'));
  assert.deepEqual(launches[0]!.args.slice(1), [f.cwd]);
  assert.equal(launches[0]!.env.SNOWLUMA_ACCESS_TOKEN, 'private-token');
  assert.equal(launches[0]!.env.PIQ_RUN_MODE, 'background');
  assert.equal(launches[0]!.env.PIQ_START_RUNNING, '1');
  assert.doesNotMatch(JSON.stringify(launches[0]!.args), /private-token/);
  assert.deepEqual(await getProcessStatus(f.cwd), { running: true, pid: process.pid, mode: 'background', starting: false });
  await assert.rejects(readFile(join(f.cwd, '.piq', 'start.lock')), { code: 'ENOENT' });
});

test('concurrent starts and existing terminal owners cannot create duplicate sessions', async t => {
  const f = await fixture(t);
  let launches = 0;
  const options = { env: { SNOWLUMA_ACCESS_TOKEN: 'test' }, launch: async (spec: BackgroundLaunch) => {
    launches++;
    await f.owner(); await f.record(spec.env.PIQ_LAUNCH_ID);
    return { pid: process.pid };
  } };
  const results = await Promise.all([startGroup(f.cwd, options), startGroup(f.cwd, options)]);
  assert.equal(launches, 1);
  assert.equal(results.filter(result => result.alreadyRunning).length, 1);
  await unlink(f.workerFile);
  assert.equal((await getProcessStatus(f.cwd)).mode, 'terminal');
  assert.equal((await startGroup(f.cwd, options)).alreadyRunning, true);
  assert.equal(launches, 1);
});

test('a still-starting worker is reported without dispatching a second launch', async t => {
  const f = await fixture(t);
  let launches = 0;
  const options = { timeoutMs: 1, env: { SNOWLUMA_ACCESS_TOKEN: 'test' }, launch: async (spec: BackgroundLaunch) => {
    launches++;
    await f.record(spec.env.PIQ_LAUNCH_ID, 'starting');
    return { pid: process.pid };
  } };
  assert.equal((await startGroup(f.cwd, options)).starting, true);
  assert.equal((await getProcessStatus(f.cwd)).starting, true);
  assert.equal((await startGroup(f.cwd, options)).alreadyRunning, true);
  assert.equal(launches, 1);
});

test('startup failure is visible and releases the startup lease', async t => {
  const f = await fixture(t);
  await assert.rejects(startGroup(f.cwd, { env: { SNOWLUMA_ACCESS_TOKEN: 'test' }, launch: async spec => {
    await f.record(spec.env.PIQ_LAUNCH_ID, 'error');
    return { pid: process.pid };
  } }), /启动失败/);
  assert.match((await getProcessStatus(f.cwd)).error!, /启动失败/);
  await assert.rejects(readFile(join(f.cwd, '.piq', 'start.lock')), { code: 'ENOENT' });
});

test('handoff waits for the background owner to release before opening its existing session directory', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  const calls: string[] = [];
  const result = await handoffToTerminal(f.cwd, {
    shutdown: async cwd => { assert.equal(cwd, f.cwd); calls.push('shutdown'); await unlink(f.ownerFile); },
    openTerminal: async cwd => {
      assert.equal(cwd, f.cwd);
      await assert.rejects(readFile(f.ownerFile), { code: 'ENOENT' });
      calls.push('terminal'); return { message: 'opened' };
    },
  });
  assert.equal(result.message, 'opened');
  assert.deepEqual(calls, ['shutdown', 'terminal']);
});

test('handoff does not close terminal owners or processes with a mismatched owner token', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record('fixture', 'running', 'old-owner');
  let shutdowns = 0;
  const result = await handoffToTerminal(f.cwd, {
    shutdown: async () => { shutdowns++; },
    openTerminal: async () => ({ message: 'already open', alreadyRunning: true }),
  });
  assert.equal(result.alreadyRunning, true);
  assert.equal(shutdowns, 0);
});

test('handoff timeout preserves the running worker and does not launch a competing terminal', async t => {
  const f = await fixture(t);
  await f.owner(); await f.record();
  let opens = 0;
  await assert.rejects(handoffToTerminal(f.cwd, {
    timeoutMs: 1, shutdown: async () => {},
    openTerminal: async () => { opens++; return { message: 'unexpected' }; },
  }), /尚未退出/);
  assert.equal(opens, 0);
  assert.equal((await getProcessStatus(f.cwd)).running, true);
});

test('background lifecycle waits without a prompt and gracefully releases the owner on shutdown', async t => {
  const f = await fixture(t);
  const actions: string[] = [];
  let shutdown: (() => void) | undefined;
  const session: BackgroundSession = {
    abort: async () => { actions.push('abort'); },
    bindExtensions: async bindings => {
      actions.push('bind');
      shutdown = bindings.shutdownHandler;
      await f.owner();
    },
    extensionRunner: { emit: async () => { actions.push('shutdown'); await unlink(f.ownerFile); } },
    dispose: () => { actions.push('dispose'); },
  };
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeSigterm = process.listenerCount('SIGTERM');
  const previousMode = process.env.PIQ_RUN_MODE;
  const running = runBackground(f.cwd, { launchId: 'lifecycle-test', sessionFactory: async () => session });
  const deadline = Date.now() + 3_000;
  while (!shutdown || (await getProcessStatus(f.cwd)).mode !== 'background') {
    if (Date.now() > deadline) assert.fail('Background worker did not become ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(actions, ['bind']);
  assert.equal(process.env.PIQ_RUN_MODE, 'background');
  shutdown();
  await running;
  assert.deepEqual(actions, ['bind', 'abort', 'shutdown', 'dispose']);
  assert.equal((await getProcessStatus(f.cwd)).running, false);
  const state = JSON.parse(await readFile(f.workerFile, 'utf8'));
  assert.equal(state.state, 'stopped');
  assert.equal(state.launchId, 'lifecycle-test');
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.env.PIQ_RUN_MODE, previousMode);
});

test('background startup errors remain readable without exposing provider error details', async t => {
  const f = await fixture(t);
  await assert.rejects(runBackground(f.cwd, {
    sessionFactory: async () => { throw new Error('secret-token private upstream response'); },
  }), /后台 Pi 启动失败/);
  const state = await readFile(f.workerFile, 'utf8');
  assert.match(state, /"state": "error"/);
  assert.doesNotMatch(state, /secret-token|private upstream/);
});

test('runtime extension errors are persisted as safe warnings without stopping the worker', async t => {
  const f = await fixture(t);
  let shutdown: (() => void) | undefined;
  let report: Parameters<BackgroundSession['bindExtensions']>[0]['onError'];
  const session: BackgroundSession = {
    abort: async () => {},
    bindExtensions: async bindings => { shutdown = bindings.shutdownHandler; report = bindings.onError; await f.owner(); },
    extensionRunner: { emit: async () => { await unlink(f.ownerFile); } },
    dispose: () => {},
  };
  const running = runBackground(f.cwd, { sessionFactory: async () => session });
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 3_000;
    while (!await predicate()) { if (Date.now() > deadline) assert.fail('Timed out waiting for worker state'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  await wait(async () => (await getProcessStatus(f.cwd)).mode === 'background');
  report!({ extensionPath: 'fixture.ts', event: 'send_message', error: 'secret-token private provider response' });
  await wait(async () => Boolean(JSON.parse(await readFile(f.workerFile, 'utf8')).lastError));
  const stored = await readFile(f.workerFile, 'utf8');
  assert.match(stored, /"state": "running"/);
  assert.doesNotMatch(stored, /secret-token|private provider/);
  const state = await getProcessStatus(f.cwd);
  assert.equal(state.running, true);
  assert.match(state.error!, /扩展运行出现错误/);
  shutdown!();
  await running;
  assert.equal(JSON.parse(await readFile(f.workerFile, 'utf8')).state, 'stopped');
});
