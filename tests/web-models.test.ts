import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import { getModelPreference, listModels, modelArguments, saveModelPreference, type ModelCatalog } from '../src/web-models.ts';

async function group(t: TestContext): Promise<string> {
  const parent = join(process.cwd(), '.test-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const catalog = async (): Promise<ModelCatalog> => ({ models: [
  { provider: 'local', id: 'reasoner', name: 'Reasoner', thinkingLevels: ['off', 'low', 'high', 'max'] },
  { provider: 'local', id: 'plain', name: 'Plain', thinkingLevels: ['off'] },
] });

test('catalog uses official supported thinking levels and returns only public model fields', async () => {
  const fake = (id: string, reasoning: boolean): Model<Api> => ({
    id, name: id, provider: 'local', api: 'openai-completions', reasoning,
    thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' },
    baseUrl: 'https://secret.example/?token=private', headers: { Authorization: 'private' },
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000,
  });
  const result = await listModels(async () => ({ getAvailableSnapshot: () => [fake('reasoner', true), fake('plain', false)], getError: () => undefined }));
  assert.deepEqual(result.models[0], { provider: 'local', id: 'plain', name: 'plain', thinkingLevels: ['off'] });
  assert.deepEqual(result.models[1]!.thinkingLevels, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|headers|baseUrl/);
  const failed = await listModels(async () => { throw new Error('https://secret.example/?token=private'); });
  assert.equal(failed.models.length, 0);
  assert.doesNotMatch(failed.error!, /secret|private/);
});

test('group settings preserve Pi packages and produce explicit launch arguments', async t => {
  const cwd = await group(t);
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: ['piq'], theme: 'dark', unrelated: 7 }));
  const initial = await getModelPreference(cwd);
  assert.equal(initial.provider, undefined);
  const saved = await saveModelPreference(cwd, { ...initial, provider: 'local', model: 'reasoner', thinkingLevel: 'max' }, catalog);
  assert.equal(saved.thinkingLevel, 'max');
  assert.deepEqual(await modelArguments(cwd), ['--provider', 'local', '--model', 'reasoner', '--thinking', 'max']);
  const raw = JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8'));
  assert.deepEqual(raw.packages, ['piq']); assert.equal(raw.theme, 'dark'); assert.equal(raw.unrelated, 7);
  await saveModelPreference(cwd, { revision: saved.revision }, catalog);
  assert.deepEqual(await modelArguments(cwd), []);
  assert.equal(JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8')).defaultModel, undefined);
});

test('stale revisions and concurrent saves cannot overwrite newer Pi settings', async t => {
  const cwd = await group(t);
  const initial = await getModelPreference(cwd);
  const results = await Promise.allSettled([
    saveModelPreference(cwd, { ...initial, provider: 'local', model: 'reasoner', thinkingLevel: 'high' }, catalog),
    saveModelPreference(cwd, { ...initial, provider: 'local', model: 'plain', thinkingLevel: 'off' }, catalog),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  const current = await getModelPreference(cwd);
  await writeFile(join(cwd, '.pi', 'settings.json'), '{"packages":["changed-elsewhere"]}');
  await assert.rejects(saveModelPreference(cwd, { ...current, provider: 'local', model: 'plain' }, catalog), { status: 409 });
  assert.deepEqual(JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8')).packages, ['changed-elsewhere']);
});

test('unavailable models and unsupported thinking levels fail without writing', async t => {
  const cwd = await group(t);
  const initial = await getModelPreference(cwd);
  for (const values of [
    { provider: 'local', model: 'missing' },
    { provider: 'local', model: 'plain', thinkingLevel: 'high' },
    { provider: 'local' },
    { thinkingLevel: 'unknown' },
    { provider: '--bad', model: 'reasoner' },
  ]) {
    await assert.rejects(saveModelPreference(cwd, { ...initial, ...values }, catalog), { status: 400 });
  }
  assert.deepEqual(await modelArguments(cwd), []);
});

test('thinking can be set independently while keeping the resumed session model', async t => {
  const cwd = await group(t);
  const initial = await getModelPreference(cwd);
  const saved = await saveModelPreference(cwd, { revision: initial.revision, thinkingLevel: 'high' }, async () => {
    assert.fail('A standalone thinking choice does not need to load a model catalog.');
  });
  assert.equal(saved.provider, undefined);
  assert.equal(saved.model, undefined);
  assert.deepEqual(await modelArguments(cwd), ['--thinking', 'high']);
});

test('model selection is independent between group folders', async t => {
  const first = await group(t); const second = await group(t);
  await saveModelPreference(first, { ...await getModelPreference(first), provider: 'local', model: 'plain', thinkingLevel: 'off' }, catalog);
  assert.equal((await getModelPreference(first)).model, 'plain');
  assert.deepEqual(await modelArguments(second), []);
});
