import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { initializeGroup } from '../src/config.ts';
import {
  ensureSnowLuma, openSnowLumaManual, probeSnowLuma,
  type SnowLumaLaunch, type SnowLumaServiceOptions, type SnowLumaServiceResult,
} from '../src/snowluma-service.ts';

async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'snowluma-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'SnowLuma install & safe');
  await mkdir(join(installDir, 'config'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: '@snowluma/runtime', main: 'index.mjs' }));
  await writeFile(join(installDir, 'index.mjs'), '/* fixture */');
  const managementPort = await unusedPort();
  await writeFile(join(installDir, 'config', 'runtime.json'), JSON.stringify({ webuiPort: managementPort, hookAutoLoad: false }));
  const port = await unusedPort();
  const cwd = await initializeGroup(join(root, 'groups'), '123456', { name: 'Test group', conversations: [{ type: 'group', id: '123456' }], wsUrl: `ws://127.0.0.1:${port}/` });
  return { root, cwd, installDir, port, managementPort };
}

const down = (): SnowLumaServiceResult => ({ ok: false, started: false, diagnostic: 'service-down', canStart: true, canOpenManual: true, message: 'down' });
const ready = (): SnowLumaServiceResult => ({ ok: true, started: false, diagnostic: 'ready', canStart: false, canOpenManual: true, message: 'ready' });

function clockOptions() {
  let clock = 100_000;
  return { now: () => clock, sleep: async (milliseconds: number) => { clock += milliseconds; } };
}

test('a local stopped endpoint can start only with a validated installation', async t => {
  const f = await fixture(t);
  const state = await probeSnowLuma(f.cwd, { installDir: f.installDir });
  assert.equal(state.diagnostic, 'service-down');
  assert.equal(state.canStart, true);
  assert.equal(state.canOpenManual, true);
  await writeFile(join(f.installDir, 'package.json'), JSON.stringify({ name: 'untrusted-package', main: 'index.mjs' }));
  const rejected = await probeSnowLuma(f.cwd, { installDir: f.installDir });
  assert.equal(rejected.canStart, false);
  assert.equal(rejected.canOpenManual, false);
});

test('an occupied management port offers manual recovery instead of spawning a duplicate', async t => {
  const f = await fixture(t);
  const server = createTcpServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(f.managementPort, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let launches = 0;
  const state = await ensureSnowLuma(f.cwd, { installDir: f.installDir, launch: async () => { launches++; } });
  assert.equal(state.diagnostic, 'account-offline');
  assert.equal(state.canStart, false);
  assert.equal(state.canOpenManual, true);
  assert.equal(launches, 0);
  const specifications: SnowLumaLaunch[] = [];
  const manual = await openSnowLumaManual(f.cwd, { installDir: f.installDir, launch: async spec => { specifications.push(spec); } });
  assert.equal(specifications[0]!.command, 'rundll32.exe');
  assert.equal(specifications[0]!.args[1], `http://127.0.0.1:${f.managementPort}`);
  assert.match(manual.message, /管理界面/);
});

test('probes verify read-only login and online status rather than trusting an open socket', async t => {
  const f = await fixture(t);
  const server = createTcpServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let online = true; let closed = 0; const actions: string[] = [];
  const createClient: NonNullable<SnowLumaServiceOptions['createClient']> = () => ({
    connect: async () => { actions.push('connect'); }, close: () => { closed++; },
    raw: async <T>(action: string) => {
      actions.push(action);
      if (action === 'get_login_info') return { user_id: 10001, nickname: 'test' } as T;
      if (action === 'get_status') return { online, good: true, time: 1_700_000_000 } as T;
      throw new Error(`Unexpected action: ${action}`);
    },
  });
  const connected = await probeSnowLuma(f.cwd, { installDir: f.installDir, createClient });
  assert.equal(connected.diagnostic, 'ready');
  online = false;
  const offline = await probeSnowLuma(f.cwd, { installDir: f.installDir, createClient });
  assert.equal(offline.diagnostic, 'account-offline');
  assert.equal(offline.canStart, false);
  assert.equal(closed, 2);
  assert.deepEqual(actions, ['connect', 'get_login_info', 'get_status', 'connect', 'get_login_info', 'get_status']);
});

test('authentication failure does not launch another service or reveal a token', async t => {
  const f = await fixture(t);
  const server = createHttpServer((_request, response) => { response.writeHead(401); response.end('Unauthorized'); });
  await new Promise<void>(resolve => server.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let launches = 0;
  const state = await ensureSnowLuma(f.cwd, { installDir: f.installDir, env: { SNOWLUMA_ACCESS_TOKEN: 'never-display-this-token' },
    launch: async () => { launches++; } });
  assert.equal(state.diagnostic, 'auth-failed');
  assert.equal(state.canStart, false);
  assert.equal(launches, 0);
  assert.doesNotMatch(JSON.stringify(state), /never-display/);
});

test('startup is shared across endpoints and waits through initial account attachment', async t => {
  const f = await fixture(t);
  const other = await initializeGroup(join(f.root, 'groups'), '654321', { name: 'Other group', conversations: [{ type: 'group', id: '654321' }], wsUrl: `ws://127.0.0.1:${await unusedPort()}/` });
  const calls = new Map<string, number>(); let launches = 0;
  const options: SnowLumaServiceOptions = {
    installDir: f.installDir, timeoutMs: 2000, ...clockOptions(),
    launch: async spec => { launches++; assert.equal(spec.visible, false); assert.equal(spec.cwd, f.installDir); await delay(5); },
    probe: async cwd => {
      const number = (calls.get(cwd) ?? 0) + 1; calls.set(cwd, number);
      if (number === 1) return down();
      if (number === 2) return { ...down(), diagnostic: 'account-offline', canStart: false, message: 'attaching' };
      return ready();
    },
  };
  const [first, second] = await Promise.all([ensureSnowLuma(f.cwd, options), ensureSnowLuma(other, options)]);
  assert.equal(launches, 1);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(first.started, true); assert.equal(second.started, true);
  const runtime = JSON.parse(await readFile(join(f.installDir, 'config', 'runtime.json'), 'utf8'));
  assert.equal(runtime.hookAutoLoad, false, 'service helper must never broaden QQ attach settings');
});

test('a failed startup stays bounded and does not repeat during the cooldown', async t => {
  const f = await fixture(t);
  let launches = 0;
  const options = { installDir: f.installDir, timeoutMs: 1200, ...clockOptions(),
    probe: async () => down(), launch: async () => { launches++; } };
  const first = await ensureSnowLuma(f.cwd, options);
  const second = await ensureSnowLuma(f.cwd, options);
  assert.equal(first.ok, false); assert.equal(first.started, true);
  assert.match(first.message, /手动恢复/);
  assert.match(second.message, /上次自动启动/);
  assert.equal(launches, 1);
});

test('manual startup uses validated runtime and environment arguments without changing configuration', async t => {
  const f = await fixture(t);
  const specifications: SnowLumaLaunch[] = [];
  await openSnowLumaManual(f.cwd, { installDir: f.installDir, launch: async spec => { specifications.push(spec); } });
  assert.equal(specifications.length, 1);
  const spec = specifications[0]!;
  assert.equal(spec.command, 'wt.exe'); assert.equal(spec.visible, true);
  assert.equal(spec.env.PIQ_SNOWLUMA_ENTRY, join(f.installDir, 'index.mjs'));
  assert.equal(spec.args.some(arg => arg.includes(f.installDir)), false, 'path remains environment data, not PowerShell syntax');
  assert.equal(JSON.parse(await readFile(join(f.installDir, 'config', 'runtime.json'), 'utf8')).hookAutoLoad, false);
});

test('remote endpoints never offer a local automatic or manual startup', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'PIQ.md'), '# Remote\n\n```json\n{"id":"123456","name":"Remote test","conversations":[{"type":"group","id":"123456"}],"wsUrl":"ws://192.0.2.1:9/"}\n```\n');
  const state = await probeSnowLuma(f.cwd, { installDir: f.installDir, timeoutMs: 50 });
  assert.equal(state.canStart, false); assert.equal(state.canOpenManual, false); assert.equal(state.manualUrl, undefined);
  await assert.rejects(openSnowLumaManual(f.cwd, { installDir: f.installDir }), /远程/);
});
