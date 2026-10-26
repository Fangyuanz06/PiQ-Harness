import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { initializeGroup, validateConfig } from '../src/config.ts';
import { credentialStatus, getRunningOwner, openGroupTerminal, resolveGroupEnvironment, type TerminalLaunch } from '../src/web-terminal.ts';

async function fixture() {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'terminal-'));
  const configDirectory = join(root, 'snow-config');
  await mkdir(configDirectory);
  const config = validateConfig({ id: '223344', name: 'Test group', conversations: [{ type: 'group', id: '223344' }], wsUrl: 'ws://127.0.0.1:3000/' });
  const cwd = await initializeGroup(root, config.id, { name: config.name, conversations: config.conversations, wsUrl: config.wsUrl });
  await writeFile(join(configDirectory, 'onebot_10001.json'), JSON.stringify({ networks: { httpServers: [{
    host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: true, accessToken: 'private-test-token',
  }] } }));
  return { root, cwd, configDirectory, config };
}

test('credential metadata contains no secret and environment variables take priority', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const options = { configDirectory: f.configDirectory, env: {} };
  assert.deepEqual(await credentialStatus(f.config, options), { available: true, source: 'SnowLuma 本地配置' });
  const resolved = await resolveGroupEnvironment(f.cwd, f.config, options);
  assert.equal(resolved.env.SNOWLUMA_ACCESS_TOKEN, 'private-test-token');
  assert.doesNotMatch(JSON.stringify(resolved.credential), /private-test-token/);
  assert.equal(await resolveGroupEnvironment(f.cwd, f.config, {
    ...options, env: { SNOWLUMA_ACCESS_TOKEN: 'from-environment' },
  }).then(result => result.env.SNOWLUMA_ACCESS_TOKEN), 'from-environment');
});

test('local credentials require a matching enabled endpoint and are not inferred for remote hosts', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const options = { configDirectory: f.configDirectory, env: {} };
  for (const wsUrl of ['ws://127.0.0.1:3001/', 'ws://127.0.0.1:3000/other', 'ws://example.com:3000/']) {
    const config = { ...f.config, wsUrl };
    assert.equal((await credentialStatus(config, options)).available, false);
    assert.equal((await resolveGroupEnvironment(f.cwd, config, options)).env.SNOWLUMA_ACCESS_TOKEN, undefined);
  }
  await writeFile(join(f.configDirectory, 'onebot_10001.json'), JSON.stringify({ networks: { httpServers: [{
    host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: false, accessToken: 'private-test-token',
  }] } }));
  assert.equal((await credentialStatus(f.config, options)).available, false);
  await writeFile(join(f.configDirectory, 'onebot_10002.json'), JSON.stringify({ networks: { wsServers: [{
    host: '0.0.0.0', port: 3000, path: '/', accessToken: 'ws-token',
  }] } }));
  assert.equal((await resolveGroupEnvironment(f.cwd, f.config, options)).env.SNOWLUMA_ACCESS_TOKEN, 'ws-token');
});

test('ambiguous matching account credentials require an explicit environment variable', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.configDirectory, 'onebot_20001.json'), JSON.stringify({ networks: { wsServers: [{
    host: '127.0.0.1', port: 3000, path: '/', accessToken: 'another-private-token',
  }] } }));
  const status = await credentialStatus(f.config, { configDirectory: f.configDirectory, env: {} });
  assert.equal(status.available, false);
  assert.doesNotMatch(JSON.stringify(status), /another-private-token|private-test-token/);
});

test('terminal request uses trusted scripts and separate arguments with a scoped credential environment', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const fakeEntry = join(f.root, 'pi with spaces.cjs');
  await writeFile(fakeEntry, '');
  let request: TerminalLaunch | undefined;
  const result = await openGroupTerminal(f.cwd, {
    configDirectory: f.configDirectory,
    env: { SystemRoot: 'C:\\Windows', PIQ_PI_ENTRY: fakeEntry },
    launch: async specification => { request = specification; },
  });
  assert.match(result.message, /继续本群最近/);
  assert.equal(request!.cwd, f.cwd);
  assert.equal(request!.command, 'wt.exe');
  assert.equal(request!.env.SNOWLUMA_ACCESS_TOKEN, 'private-test-token');
  assert.equal(request!.env.PIQ_GROUP_DIRECTORY, f.cwd);
  assert.equal(request!.env.PIQ_NODE_EXECUTABLE, process.execPath);
  assert.ok(request!.args.includes('-NoExit'));
  assert.ok(request!.args.includes('--inheritEnvironment'));
  assert.ok(!request!.args.includes(f.cwd));
  assert.ok(request!.args.some(arg => arg.endsWith(join('scripts', 'open-pi.ps1'))));
  assert.equal(request!.args.some(arg => arg.includes('Start-Pi.ps1') || arg.includes('private-test-token')), false);
});

test('an existing live group owner prevents a duplicate terminal', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.cwd, '.piq'));
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: 'test-owner' }));
  assert.deepEqual(await getRunningOwner(f.cwd), { running: true, pid: process.pid });
  const result = await openGroupTerminal(f.cwd, { launch: async () => assert.fail('Duplicate launch') });
  assert.equal(result.alreadyRunning, true);
  await writeFile(join(f.cwd, '.piq', 'owner.lock'), 'invalid');
  await assert.rejects(getRunningOwner(f.cwd), /运行锁/);
});

test('the trusted terminal entry continues the correct group session without a model or QQ call', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(join(f.cwd, '.pi', 'settings.json'), JSON.stringify({
    defaultProvider: 'test-provider', defaultModel: 'test-model', defaultThinkingLevel: 'high',
  }));
  const fakeEntry = join(f.root, 'fake-pi.cjs');
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.SNOWLUMA_ACCESS_TOKEN }));');
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/terminal-entry.ts', import.meta.url)), f.cwd], {
      cwd: f.root, env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-only' }, shell: false, windowsHide: true,
    });
    let text = ''; let errors = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveOutput(text) : reject(new Error(errors)));
  });
  assert.deepEqual(JSON.parse(output), {
    cwd: f.cwd, args: ['--continue', '--session-dir', join(f.cwd, '.pi', 'sessions'),
      '--provider', 'test-provider', '--model', 'test-model', '--thinking', 'high'], credential: true,
  });
});

test('the PowerShell helper treats special characters in group paths as literal data', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const cwd = await initializeGroup(join(f.root, 'space; $value & [literal]'), '223355', { name: 'Special path group', conversations: [{ type: 'group', id: '223355' }], wsUrl: f.config.wsUrl });
  const fakeEntry = join(f.root, 'fake-pi-helper.cjs');
  await writeFile(fakeEntry, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), credential: !!process.env.SNOWLUMA_ACCESS_TOKEN }));');
  let output = '';
  await openGroupTerminal(cwd, {
    configDirectory: f.configDirectory, env: { ...process.env, PIQ_PI_ENTRY: fakeEntry, SNOWLUMA_ACCESS_TOKEN: 'test-helper' },
    launch: specification => new Promise<void>((resolveLaunch, reject) => {
      const helper = specification.args[specification.args.indexOf('-File') + 1]!;
      const shell = specification.args[specification.args.indexOf('-NoLogo') - 1]!;
      const child = spawn(shell, ['-NoLogo', '-NoProfile', '-File', helper], {
        cwd: f.root, env: specification.env, shell: false, windowsHide: true,
      });
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveLaunch() : reject(new Error(errors)));
    }),
  });
  assert.deepEqual(JSON.parse(output), {
    cwd, args: ['--continue', '--session-dir', join(cwd, '.pi', 'sessions')], credential: true,
  });
});
