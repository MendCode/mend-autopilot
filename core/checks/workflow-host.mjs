#!/usr/bin/env node
// Host operations that cannot be represented by MendCode's short, non-shell check grammar.
import { execFile, spawn } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertGuardAllowed } from './guard-command.mjs';
import { stdinArgs } from './stdin-args.mjs';

const exec = promisify(execFile);
const git = async (cwd, args, input) => {
  const child = exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  child.child.stdin.on('error', () => {});
  child.child.stdin.end(input);
  return (await child).stdout;
};

export async function host(operation, data) {
  const { cwd, file } = data;
  if (operation === 'git') return git(cwd, data.args);
  if (operation === 'read-json') return JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')));
  if (operation === 'read') return fs.readFile(path.resolve(cwd ?? '.', file), 'utf8');
  if (operation === 'tail') return (await fs.readFile(path.resolve(cwd, file), 'utf8')).trimEnd().split('\n').pop();
  if (operation === 'exists') {
    const stat = await fs.stat(path.resolve(cwd ?? '.', file));
    if (!(data.directory ? stat.isDirectory() : stat.isFile())) throw new Error('wrong file type');
    return '';
  }
  if (operation === 'worktree-preflight') {
    for (const name of ['.mend', '.mend/worktrees']) {
      try {
        const stat = await fs.lstat(path.join(cwd, name));
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a real directory: ' + name);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return '';
  }
  if (operation === 'count') {
    const names = await git(cwd, ['diff', '--name-only', '-z', '--no-renames', data.base, data.head, '--', ...data.pathspec]);
    return JSON.stringify({ count: names.split('\0').filter(Boolean).length });
  }
  if (operation === 'patch-id') return git(cwd, ['patch-id', '--stable'], await git(cwd, ['diff', data.base, data.head]));
  if (operation === 'guard' || operation === 'execute') {
    await assertGuardAllowed({ command: data.command, cwd });
    if (operation === 'guard') return '';
    const log = path.resolve(cwd, file);
    await fs.mkdir(path.dirname(log), { recursive: true });
    const handle = await fs.open(log, 'w');
    try {
      await handle.writeFile('$ ' + data.command + '\n');
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(data.command, { cwd, shell: true, stdio: ['ignore', handle.fd, handle.fd] });
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });
      await handle.writeFile('\nexit: ' + exit + '\n');
      return JSON.stringify({ exit });
    } finally { await handle.close(); }
  }
  throw new Error('unknown host operation: ' + operation);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, data] = stdinArgs(process.argv.slice(2));
    process.stdout.write(await host(operation, JSON.parse(data)));
  } catch (error) { console.error(`[WORKFLOW-HOST]: ${error.message}`); process.exitCode = 1; }
}
