import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the project and lockfile exclude SnowLuma SDK dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      assert.notEqual(name, '@snowluma/sdk');
      assert.doesNotMatch(String(value), /npm:@snowluma\/sdk(?:@|$)/);
    }
  }
  for (const [location, entry] of Object.entries(lock.packages ?? {}) as Array<[string, { name?: string }]>) {
    assert.doesNotMatch(location, /(?:^|\/)node_modules\/@snowluma\/sdk$/);
    assert.notEqual(entry.name, '@snowluma/sdk');
  }
});
