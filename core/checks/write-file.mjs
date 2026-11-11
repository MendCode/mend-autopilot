#!/usr/bin/env node
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function writeFile(file, text, mode) {
  if (!file || typeof text !== 'string' || ![undefined, '--exclusive', '--append'].includes(mode)) throw new Error('usage: write-file.mjs <path> [--exclusive|--append]');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: mode === '--exclusive' ? 'wx' : mode === '--append' ? 'a' : 'w' });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let args = process.argv.slice(2), text = readFileSync(0, 'utf8');
    if (args.length === 1 && args[0] === '--stdin') ({ args, text } = JSON.parse(text));
    if (!Array.isArray(args) || args.length < 1 || args.length > 2) throw new Error('invalid writer arguments');
    await writeFile(args[0], text, args[1]);
  } catch (error) { console.error(`[WRITE-FILE]: ${error.message}`); process.exitCode = 1; }
}
