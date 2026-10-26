import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveImage } from '../src/extension.ts';

test('local media resolves in its group and rejects sibling and linked files', async t => {
  const parent = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const group = join(root, 'one');
  const sibling = join(root, 'two');
  await mkdir(join(group, 'assets'), { recursive: true });
  await mkdir(sibling);
  await writeFile(join(group, 'assets', 'image.png'), 'fixture');
  await writeFile(join(sibling, 'private.png'), 'fixture');
  assert.equal(await resolveImage(group, 'assets/image.png'), await realpath(join(group, 'assets', 'image.png')));
  await assert.rejects(resolveImage(group, '../two/private.png'), /当前对话组目录/);
  await assert.rejects(resolveImage(group, sibling), /当前对话组目录/);
  await t.test('a symlink cannot bypass the group boundary', async linkTest => {
    try {
      await symlink(sibling, join(group, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        linkTest.skip('The current OS sandbox does not permit symlink creation.');
        return;
      }
      throw error;
    }
    await assert.rejects(resolveImage(group, 'assets/linked/private.png'), /当前对话组目录/);
  });
});
