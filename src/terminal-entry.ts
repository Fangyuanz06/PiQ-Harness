#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGroup } from './cli.ts';
import { registerTerminal } from './terminal-monitor.ts';

interface TerminalEntryOptions {
  env?: NodeJS.ProcessEnv;
  register?: typeof registerTerminal;
  open?: typeof openGroup;
}

export async function terminalMain(args = process.argv.slice(2), options: TerminalEntryOptions = {}): Promise<number> {
  if (args.length !== 1) throw new Error('请指定一个群工作目录。');
  const cwd = resolve(args[0]!);
  const token = (options.env ?? process.env).PIQ_TERMINAL_RETURN_TOKEN;
  if (!token) return await (options.open ?? openGroup)(cwd);
  const register = options.register ?? registerTerminal;
  await register(cwd, token, process.pid);
  return await (options.open ?? openGroup)(cwd, [], {
    onSpawn: pid => register(cwd, token, process.pid, pid),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  terminalMain().then(code => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`PiQ: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
