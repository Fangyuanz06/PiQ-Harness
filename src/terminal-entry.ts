#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGroup } from './cli.ts';

export async function terminalMain(args = process.argv.slice(2)): Promise<number> {
  if (args.length !== 1) throw new Error('请指定一个群工作目录。');
  const cwd = resolve(args[0]!);
  return await openGroup(cwd);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  terminalMain().then(code => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`PiQ: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
