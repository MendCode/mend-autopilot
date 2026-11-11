#!/usr/bin/env node
// Runs a test command and prints one MEND_EVIDENCE line with its counts, for a declared "tests" capture.
// Reads the TAP summary node --test prints when its output is not a terminal (# pass, # fail, # skipped,
// top-level "not ok" lines). The command's own output is passed through unchanged; the exit code is kept.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function testEvidence(output) {
  const count = (name) => {
    const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  const passed = count('pass');
  const failed = count('fail');
  if (passed === null || failed === null) return null;
  const failing = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim()).sort();
  return { passed, failed, skipped: count('skipped') ?? 0, failing };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stderr.write('usage: emit-tests.mjs <test command...>\n');
    return 64;
  }
  const chunks = [];
  const exit = await new Promise((resolve, reject) => {
    // An inherited test-runner context would switch node --test to its internal output format.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(argv.join(' '), { shell: true, env, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  const evidence = testEvidence(Buffer.concat(chunks).toString('utf8'));
  if (!evidence) {
    process.stderr.write('[EMIT-TESTS]: no TAP summary (# pass / # fail) in the test output\n');
    return exit === 0 ? 1 : exit;
  }
  process.stdout.write(`\nMEND_EVIDENCE ${JSON.stringify(evidence)}\n`);
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
