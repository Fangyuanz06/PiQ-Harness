import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionError,
} from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { readModelStatus, registerModelControl, requestModelChange } from '../src/model-control.ts';

async function eventually(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

test('real Pi applies a requested model and thinking change while running, then uses them on the next request', async t => {
  // Atomic control-file replacement requires the workspace's ordinary filesystem on Windows.
  const temporaryRoot = join(process.cwd(), '.test-tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'live-pi-model-'));
  const cwd = join(root, 'group');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.piq'), { recursive: true });
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(agentDir);
  const originalSettings = '{"defaultProvider":"preserve-this-setting","defaultThinkingLevel":"medium"}\n';
  const projectSettings = '{"customSetting":"preserve-project-settings"}\n';
  await writeFile(join(agentDir, 'settings.json'), originalSettings);
  await writeFile(join(cwd, '.pi', 'settings.json'), projectSettings);
  await writeFile(join(cwd, 'PIQ.md'), '# Test group\n\n```json\n{"id":"group","name":"Live model test","conversations":[{"type":"group","id":"123490"}]}\n```\n');
  await writeFile(join(cwd, '.piq', 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() }));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network access is disabled in model-control integration tests'); });

  let releaseFirst = () => {};
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = fauxProvider({
    provider: 'piq-live-test-first', tokensPerSecond: 1_000_000,
    models: [{ id: 'model-first', reasoning: true }],
  });
  const second = fauxProvider({
    provider: 'piq-live-test-second', tokensPerSecond: 1_000_000,
    models: [{ id: 'model-second', reasoning: true }],
  });
  const requestModels: string[] = [];
  first.setResponses([async (_context, _options, _state, model) => {
    requestModels.push(`${model.provider}/${model.id}`);
    await firstResponse;
    return fauxAssistantMessage('The original model finished its in-flight response.');
  }]);
  second.setResponses([(_context, options, _state, model) => {
    requestModels.push(`${model.provider}/${model.id}`);
    assert.equal(options?.reasoning, 'high');
    return fauxAssistantMessage('The selected model handles the next request.');
  }]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(first.provider);
  modelRuntime.registerNativeProvider(second.provider);
  await modelRuntime.setRuntimeApiKey(first.provider.id, 'local-test-key');
  await modelRuntime.setRuntimeApiKey(second.provider.id, 'local-test-key');
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  const beforeSettings = settingsManager.getSettings();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => registerModelControl(pi, { pollMs: 10 })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, modelRuntime, model: first.getModel(), thinkingLevel: 'low',
    resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, '.pi', 'sessions')),
  });
  const errors: ExtensionError[] = [];
  const notifications: string[] = [];
  t.mock.method(session.extensionRunner.createContext().ui, 'notify', (message: string) => { notifications.push(message); });
  t.after(async () => {
    releaseFirst();
    await session.abort();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  assert.equal((await readModelStatus(cwd))?.status, 'ready');

  const running = session.prompt('Start a local test response.');
  try {
    await eventually(async () => first.state.callCount === 1, 'the first model request to begin');
    assert.equal(session.isIdle, false);
    const requested = await requestModelChange(cwd, {
      provider: second.provider.id, model: second.getModel().id, thinkingLevel: 'high',
    });
    await eventually(async () => {
      const status = await readModelStatus(cwd);
      return status?.requestId === requested.requestId && status.status === 'applied';
    }, 'Pi to apply the requested model while the first response is active');
    const status = await readModelStatus(cwd);
    assert.equal(status?.provider, second.provider.id);
    assert.equal(status?.model, second.getModel().id);
    assert.equal(status?.thinkingLevel, 'high');
    assert.equal(status?.pid, process.pid);
    assert.equal(session.model?.provider, second.provider.id);
    assert.equal(session.model?.id, second.getModel().id);
    assert.equal(session.thinkingLevel, 'high');
    assert.equal(session.isIdle, false, 'applying a model choice must not wait for the current response');
    assert.equal(second.state.callCount, 0, 'the current response continues with the model that started it');
    assert.equal('ownerToken' in status!, false);
  } finally {
    releaseFirst();
    await running;
  }

  await session.prompt('Use the newly selected model for this local test response.');
  assert.deepEqual(requestModels, [
    `${first.provider.id}/${first.getModel().id}`,
    `${second.provider.id}/${second.getModel().id}`,
  ]);
  assert.equal(first.state.callCount, 1);
  assert.equal(second.state.callCount, 1);
  assert.equal(session.getLastAssistantText(), 'The selected model handles the next request.');
  const entries = session.sessionManager.getEntries();
  assert.ok(entries.some(entry => entry.type === 'model_change'
    && entry.provider === second.provider.id && entry.modelId === second.getModel().id));
  assert.ok(entries.some(entry => entry.type === 'thinking_level_change' && entry.thinkingLevel === 'high'));
  assert.deepEqual(settingsManager.getSettings(), beforeSettings);
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), originalSettings);
  assert.equal(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8'), projectSettings);
  assert.deepEqual(errors, []);
  assert.deepEqual(notifications, []);
});
