#!/usr/bin/env node
// Content identities for approval inputs. The lead stores receipts outside the owner's worktree.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function digest(repo, input) {
  if (typeof input.path !== 'string' || path.isAbsolute(input.path)) throw new Error('approval input must be a repository-relative file');
  const root = await fs.realpath(repo);
  const file = await fs.realpath(path.resolve(root, input.path));
  if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile()) throw new Error('approval input escapes the repository or is not a file');
  let bytes = await fs.readFile(file);
  if (input.field) {
    const value = JSON.parse(bytes)[input.field];
    if (value === undefined) throw new Error(`approval input ${input.path} is missing ${input.field}`);
    bytes = JSON.stringify(value);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export async function snapshot(repo, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('approval inputs are missing');
  return Promise.all(inputs.map(async (input) => ({ ...input, sha256: await digest(repo, input) })));
}

export async function verify(repo, inputs) {
  try {
    const current = await snapshot(repo, inputs);
    const changed = current.filter((input, index) => !/^[a-f0-9]{64}$/.test(inputs[index].sha256 ?? '') || input.sha256 !== inputs[index].sha256);
    return changed.length ? { pass: false, error: `approved inputs changed; reapproval required: ${changed.map((input) => input.path).join(', ')}` } : { pass: true };
  } catch (error) {
    return { pass: false, error: `approved input missing or invalid; reapproval required: ${error.message}` };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { stdinArgs } = await import('./stdin-args.mjs');
    const [mode, repo, encoded] = stdinArgs(process.argv.slice(2));
    const inputs = JSON.parse(encoded);
    if (!['snapshot', 'verify'].includes(mode)) throw new Error('usage: approval.mjs snapshot|verify <repo> <inputs-json>');
    const result = mode === 'snapshot' ? { pass: true, inputs: await snapshot(repo, inputs) } : await verify(repo, inputs);
    console.log(JSON.stringify(result));
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ pass: false, error: error.message }));
    process.exitCode = 1;
  }
}
