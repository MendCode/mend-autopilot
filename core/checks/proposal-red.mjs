#!/usr/bin/env node
// Validate the entire proposal diff and measure the declared regression before integration.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { globToRegExp } from './integrity.mjs';
import { authorizedTests } from './red-green.mjs';
import { runRedGreen } from './red-green.mjs';
import { stdinArgs } from './stdin-args.mjs';

const exec = promisify(execFile);
const git = async (repo, args) => (await exec('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout;

export async function proposalRed({ repo, base, head, item, proposalTestGlobs }) {
  const command = [item.regressionCommand, item.regression].find((value) => typeof value === 'string' && value.trim())?.trim();
  if (!command) throw new Error('the item needs a regression command');
  // Tracked edits must be committed; untracked files count only inside the edit set, so local tooling copied into the worktree does not block.
  const scope = (item.editSet ?? []).map(String).map(globToRegExp);
  const pending = (await git(repo, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean)
    .filter((line) => !line.startsWith('?? ') || scope.some((glob) => glob.test(line.slice(3))));
  if (pending.length) throw new Error('proposal must commit all authored changes before measurement: ' + pending.slice(0, 5).join(', '));
  const selected = await authorizedTests({ repo, baseSha: base, headSha: head, item, testGlobs: proposalTestGlobs });
  const changes = (await git(repo, ['diff', '--name-status', '-z', '--no-renames', base, head, '--'])).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < changes.length; i += 2) {
    const [status, file] = changes.slice(i, i + 2);
    // The proposal artifacts the owner was asked to revise live here; only code outside them must stay in the test scope.
    if (file.startsWith('.mend/evidence/')) continue;
    if (!['A', 'M'].includes(status) || !selected.includes(file)) throw new Error('proposal changes a file outside the regression test scope: ' + file);
    files.push(file);
  }
  const outcome = await runRedGreen({ repo, baseSha: base, headSha: head, command, setup: item.regressionSetup, expectBase: item.regressionExpect, timeoutMs: item.regressionTimeoutMs, testFiles: files });
  if (item.regressionExpect == null && ([126, 127].includes(outcome.baseExit) || [126, 127].includes(outcome.headExit) || /syntax\s*error|module[_ ]not[_ ]found|cannot find module|command not found|(?:^|\n).*: not found\b/i.test(outcome.logs.base + '\n' + outcome.logs.head))) throw new Error('regression looks like a load or run error; set regressionExpect to the bug-specific failure');
  if (outcome.timedOut || outcome.baseExit === 0 || outcome.headExit === 0 || outcome.baseMatched === false) throw new Error('regression did not reproduce red at base and proposal head: ' + outcome.reason);
  return { command, base, head, files, baseExit: outcome.baseExit, output: outcome.logs.base, expected: item.acceptance?.[0] ?? item.goal ?? '', expectBase: item.regressionExpect ?? null };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await proposalRed(JSON.parse(stdinArgs(process.argv.slice(2))[0])))); }
  catch (error) { console.error('[PROPOSAL-RED]: ' + error.message); process.exitCode = 1; }
}
