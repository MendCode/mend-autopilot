#!/usr/bin/env node
// Checks a composed evidence card for the workflows, which cannot load modules themselves:
// secret-like values anywhere in the card (built-in patterns plus the base commit's integrity config)
// and the installed evidence-card schema. Prints one JSON line { secret, failures }; secret is the
// kind of the first finding or null, never the matched value.
//   card-check.mjs <card.json> <worktree> <baseSha>
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStructuredSecrets, loadBaseConfig, mergeConfig } from './integrity.mjs';
import { validateSchema } from './json-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, '..', 'skills', 'mend-ship', 'evidence-card.schema.json');

export async function checkCard({ card, worktree, baseSha, schemaFile = SCHEMA }) {
  const settings = mergeConfig(await loadBaseConfig(worktree, baseSha));
  const secret = findStructuredSecrets(card, settings.patterns['secret-like'])[0];
  const schema = JSON.parse(await readFile(schemaFile, 'utf8'));
  const failures = validateSchema(schema, card).map((error) => ({ target: error.path || '/', rule: 'card-schema', detail: error.message }));
  return { secret: secret ? secret.kind : null, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { stdinArgs } = await import('./stdin-args.mjs');
    const [cardFile, worktree, baseSha] = stdinArgs(process.argv.slice(2));
    if (!cardFile || !worktree || !baseSha) throw new TypeError('usage: card-check.mjs <card.json> <worktree> <baseSha>');
    const card = JSON.parse(await readFile(cardFile, 'utf8'));
    console.log(JSON.stringify(await checkCard({ card, worktree, baseSha })));
  } catch (error) {
    console.error(`[CARD-CHECK]: ${error.message}`);
    process.exitCode = 1;
  }
}
