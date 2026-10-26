import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { GroupConfig } from '../src/config.ts';
import { checkPersonaTool, registerPersonaGuard } from '../src/persona-guard.ts';

async function fixture(t: TestContext) {
  const parent = resolve('.test-tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'persona-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'friends'); await mkdir(cwd);
  async function permissions(value?: GroupConfig['permissions']) {
    await writeFile(join(cwd, 'PIQ.md'), '```json\n' + JSON.stringify({ id: 'friends', name: 'Friends', conversations: [], ...(value === undefined ? {} : { permissions: value }) }) + '\n```\n');
  }
  await permissions(); await writeFile(join(cwd, 'PERSONA.md'), 'Keep this personality.');
  return { root, cwd, permissions };
}

test('default permissions allow commands, ordinary files inside and outside the group, QQ and extensions', async t => {
  const { root, cwd } = await fixture(t);
  for (const path of ['MEMORY.md', 'AGENTS.md', 'PIQ.md', '.pi/settings.json', '.piq/slang.json', 'messages/new.jsonl', '../other.md', join(root, 'outside.md'), '~/ordinary-note.md', '@MEMORY.md', 'notes\u2000with\u00a0spaces.md']) {
    for (const tool of ['write', 'edit']) assert.equal(await checkPersonaTool(cwd, tool, { path }), undefined, `${tool} ${path}`);
  }
  for (const tool of ['bash', 'powershell', 'exec', 'codemode', 'run_python', 'unknown_tool', 'read', 'grep', 'find', 'ls', 'qq_send', 'qq_slang', 'qq_slang_search']) {
    assert.equal(await checkPersonaTool(cwd, tool, {}), undefined, tool);
  }
  assert.equal(await checkPersonaTool(root, 'bash', {}), undefined);
});

test('standard writes and edits protect only this group persona across Pi path spellings', async t => {
  const { cwd } = await fixture(t);
  const paths = ['PERSONA.md', './PERSONA.md', 'assets/../PERSONA.md', join(cwd, 'PERSONA.md'), '@PERSONA.md', '@./PERSONA.md', pathToFileURL(join(cwd, 'PERSONA.md')).href];
  if (process.platform === 'win32') paths.push('persona.MD', 'PERSONA.md.', 'PERSONA.md ', 'PERSONA.md:stream', 'PERSONA.md\u00a0');
  const homeRelative = join(cwd, 'PERSONA.md').slice(homedir().length);
  if (cwd.startsWith(homedir())) paths.push('~' + homeRelative);
  if (process.platform === 'win32') {
    const slash = join(cwd, 'PERSONA.md').replaceAll('\\', '/');
    const drive = slash[0]!.toLowerCase(), tail = slash.slice(3);
    paths.push(`/${drive}/${tail}`, `/mnt/${drive}/${tail}`, `/cygdrive/${drive}/${tail}`);
  }
  for (const path of paths) for (const tool of ['write', 'edit']) assert.match((await checkPersonaTool(cwd, tool, { path }))!, /人格保护/, `${tool} ${path}`);
  await unlink(join(cwd, 'PERSONA.md'));
  assert.match((await checkPersonaTool(cwd, 'write', { path: '@PERSONA.md' }))!, /人格保护/, 'a missing personality cannot be recreated');
});

test('every capability switch is independent and takes effect on the next tool call', async t => {
  const { cwd, permissions } = await fixture(t);
  const cases: Array<[keyof NonNullable<GroupConfig['permissions']>, string, Record<string, unknown>]> = [
    ['commands', 'bash', { command: 'echo hello' }], ['commands', 'powershell', {}], ['commands', 'codemode', {}],
    ['fileRead', 'read', { path: 'PERSONA.md' }], ['fileRead', 'grep', {}], ['fileRead', 'qq_read_media', {}],
    ['fileWrite', 'write', { path: 'MEMORY.md' }], ['fileWrite', 'edit', { path: 'AGENTS.md' }], ['fileWrite', 'qq_group_files', { action: 'download' }],
    ['qq', 'qq_send', {}], ['qq', 'qq_poke', {}], ['qq', 'qq_react', {}], ['qq', 'qq_recall', {}],
    ['qq', 'qq_sticker', { action: 'rename' }], ['qq', 'qq_voice', { action: 'send' }], ['qq', 'qq_voice', { action: 'send_file' }], ['qq', 'qq_album', { action: 'like' }], ['qq', 'qq_group_files', { action: 'upload' }],
    ['network', 'qq_slang_search', {}], ['network', 'web_search', {}], ['network', 'web_fetch', {}], ['network', 'qq_read_media', {}], ['network', 'qq_group_files', { action: 'download' }],
    ['otherTools', 'unknown_extension', {}],
  ];
  for (const [key, tool, input] of cases) {
    await permissions({ [key]: false });
    assert.match((await checkPersonaTool(cwd, tool, input))!, new RegExp(key), `${key} ${tool}`);
    assert.equal(await checkPersonaTool(cwd, 'qq_slang', { action: 'learn' }), undefined, 'internal learning remains available');
    await permissions({ [key]: true });
    assert.equal(await checkPersonaTool(cwd, tool, input), undefined, `${key} immediately reopened`);
  }
  await permissions({ qq: false });
  for (const [tool, action] of [['qq_sticker', 'list'], ['qq_voice', 'list'], ['qq_voice', 'transcribe'], ['qq_album', 'list'], ['qq_album', 'media'], ['qq_group_files', 'list'], ['qq_group_files', 'download']]) {
    assert.equal(await checkPersonaTool(cwd, tool!, { action }), undefined, `${tool} ${action} is not a remote mutation`);
  }
  await permissions({ otherTools: false });
  assert.equal(await checkPersonaTool(cwd, 'bash', {}), undefined, 'known command capability has its own switch');
  assert.equal(await checkPersonaTool(cwd, 'qq_slang_transfer', {}), undefined);
});

test('persona aliases through hard links and redirected ancestors are blocked while unrelated links remain usable', async t => {
  const { root, cwd } = await fixture(t);
  try { await link(join(cwd, 'PERSONA.md'), join(cwd, 'alias.md')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Links unavailable'); return; } throw error; }
  assert.match((await checkPersonaTool(cwd, 'edit', { path: 'alias.md' }))!, /硬链接/);
  await writeFile(join(root, 'unrelated.md'), 'ordinary');
  await link(join(root, 'unrelated.md'), join(cwd, 'ordinary-link.md'));
  assert.equal(await checkPersonaTool(cwd, 'write', { path: 'ordinary-link.md' }), undefined);
  const redirected = join(root, 'redirected');
  try { await symlink(cwd, redirected, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links unavailable'); return; } throw error; }
  try {
    assert.match((await checkPersonaTool(cwd, 'write', { path: join(redirected, 'PERSONA.md') }))!, /人格保护/);
    assert.equal(await checkPersonaTool(cwd, 'write', { path: join(redirected, 'ordinary-new.md') }), undefined);
    await unlink(join(cwd, 'PERSONA.md'));
    assert.match((await checkPersonaTool(cwd, 'write', { path: join(redirected, 'PERSONA.md') }))!, /人格保护/);
  } finally { if (process.platform === 'win32') await rmdir(redirected); else await unlink(redirected); }
});

test('guard hooks report actual permission states without declaring other files read only', async t => {
  const { root, cwd, permissions } = await fixture(t);
  await permissions({ network: false });
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<Record<string, unknown> | undefined>>();
  registerPersonaGuard({ on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<Record<string, unknown> | undefined>) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const ctx = { cwd } as ExtensionContext;
  assert.equal((await handlers.get('tool_call')!({ toolName: 'write', input: { path: '@PERSONA.md' } }, ctx))?.block, true);
  assert.equal(await handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'echo allowed' } }, ctx), undefined);
  const prompt = String((await handlers.get('before_agent_start')!({ systemPrompt: 'base' }, ctx))?.systemPrompt);
  assert.match(prompt, /^base[\s\S]*PERSONA.md/); assert.match(prompt, /commands=开启/); assert.match(prompt, /network=关闭/);
  assert.doesNotMatch(prompt, /AGENTS.md.*只读|命令.*已阻止|messages.*只读/);
  assert.equal(await handlers.get('before_agent_start')!({ systemPrompt: 'base' }, { cwd: root } as ExtensionContext), undefined);
  assert.equal(await readFile(join(cwd, 'PERSONA.md'), 'utf8'), 'Keep this personality.');
});

test('a dangling file symlink cannot recreate the absent persona through another name', async t => {
  const { cwd } = await fixture(t);
  const alias = join(cwd, 'dangling-alias.md');
  await unlink(join(cwd, 'PERSONA.md'));
  try { await symlink(join(cwd, 'PERSONA.md'), alias, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('File symlink unavailable'); return; } throw error; }
  try { assert.match((await checkPersonaTool(cwd, 'write', { path: 'dangling-alias.md' }))!, /人格保护/); }
  finally { await unlink(alias); }
});

test('forward reading follows fileRead and remains a known tool when other extensions are disabled', async t => {
  const { cwd, permissions } = await fixture(t);
  assert.equal(await checkPersonaTool(cwd, 'qq_read_forward', { conversation: 'group:123456', messageId: -123 }), undefined);
  await permissions({ otherTools: false });
  assert.equal(await checkPersonaTool(cwd, 'qq_read_forward', {}), undefined);
  await permissions({ fileRead: false, otherTools: false });
  assert.match((await checkPersonaTool(cwd, 'qq_read_forward', {}))!, /fileRead/);
  await permissions({ fileRead: true, otherTools: false });
  assert.equal(await checkPersonaTool(cwd, 'qq_read_forward', {}), undefined);
});
