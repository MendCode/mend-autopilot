// Docs check over the lines a change adds to documentation pages: links and repo paths resolve at head,
// commands and flags exist in the repo, runnable blocks have a recorded passing run, prose stays within a
// word budget, avoids filler and is written in the repo locale, and headings follow the approved outline.
// Runnable blocks are not executed here: the verification skill runs them and records doc-runs.json.
import path from 'node:path';

import { changesFromFiles, collectChanges, matchesGlobs } from '../../../checks/changes.mjs';
import { fixtureTree, headTree, readItemEvidence } from '../../../checks/repo-read.mjs';
import { foreignStopwordShare, primaryLanguage, wordsOf } from '../../../checks/text-locale.mjs';

export const OUTLINE_FILE = 'outline.json';
export const RUNS_FILE = 'doc-runs.json';
export const CLI_HELP_FILE = 'cli-help.json';

const DEFAULTS = Object.freeze({
  docGlobs: ['**/*.md', '**/*.mdx'],
  wordBudget: 800,
  foreignStopwordRatio: 0.2,
});

// Filler that adds length without telling the reader anything. Phrases, not single words, to keep false hits rare.
export const GENERIC_PHRASES = Object.freeze([
  'it is important to note that',
  "it's important to note that",
  'it is worth noting that',
  'it should be noted that',
  "in today's fast-paced",
  'in this day and age',
  'this guide will walk you through',
  'without further ado',
  'unlock the full potential',
  'to the next level',
  'a seamless experience',
  'seamlessly integrates',
  'robust and scalable',
  'cutting-edge',
  'game-changer',
  'best-in-class',
  'look no further',
  'we hope this helps',
  'happy coding',
  'needless to say',
  'at the end of the day',
  'in conclusion,',
]);

const SHELL_LANGUAGES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console', 'terminal']);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Subcommands of the package managers that are not package.json scripts.
const RUNNER_BUILTINS = new Set([
  'add', 'audit', 'bin', 'cache', 'ci', 'config', 'create', 'dedupe', 'dlx', 'exec', 'fetch', 'help', 'i', 'import',
  'info', 'init', 'install', 'link', 'list', 'ls', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild', 'remove', 'rm',
  'root', 'run', 'run-script', 'setup', 'store', 'uninstall', 'unlink', 'up', 'update', 'upgrade', 'version', 'why', 'workspace',
  'x',
]);
// npm, pnpm and yarn run these package.json scripts without "run".
const LIFECYCLE_SCRIPTS = new Set(['test', 'start', 'stop', 'restart']);
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/;
const INLINE_CODE = /`([^`]+)`/g;
const REPO_PATH = /^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function resolveRules(config) {
  return {
    ...DEFAULTS,
    ...config,
    genericPhrases: [...GENERIC_PHRASES, ...(config?.genericPhrases ?? [])].map((phrase) => phrase.toLowerCase()),
  };
}

/**
 * Splits a markdown page into lines tagged prose, fence or code, and lists its fenced blocks:
 * [{ line, language, runnable, body: [{ line, text }] }] with line the opening fence (1-based).
 */
export function parseMarkdown(text) {
  const lines = [];
  const blocks = [];
  let open = null;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const fence = raw.match(FENCE);
    if (open) {
      if (fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && fence[2] === '' && fence[3].trim() === '') {
        lines.push({ line, text: raw, kind: 'fence' });
        open = null;
      } else {
        lines.push({ line, text: raw, kind: 'code', block: open.block });
        open.block.body.push({ line, text: raw });
      }
      return;
    }
    if (fence) {
      const info = `${fence[2]} ${fence[3]}`.trim().toLowerCase().split(/[\s,{}]+/).filter(Boolean);
      const block = { line, language: fence[2].toLowerCase(), runnable: info.includes('runnable'), body: [] };
      blocks.push(block);
      open = { marker: fence[1], block };
      lines.push({ line, text: raw, kind: 'fence', block });
      return;
    }
    lines.push({ line, text: raw, kind: 'prose' });
  });
  return { lines, blocks };
}

function stripInline(text) {
  return text
    .replace(/`[^`]*`/g, (span) => span.slice(1, -1))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '');
}

/** Heading anchors the way the common markdown hosts build them, with -1, -2 for repeats. */
export function headingSlugs(text) {
  const seen = new Map();
  const slugs = new Set();
  for (const entry of parseMarkdown(text).lines) {
    if (entry.kind !== 'prose') continue;
    const match = entry.text.match(HEADING);
    if (!match) continue;
    const base = stripInline(match[2]).toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/** Headings of a page in order: [{ level, text }]. */
export function headingsOf(text) {
  return parseMarkdown(text)
    .lines.filter((entry) => entry.kind === 'prose')
    .map((entry) => entry.text.match(HEADING))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, text: stripInline(match[2]).trim() }));
}

/** Link targets on a prose line: inline links and reference definitions, outside inline code. */
export function linkTargets(line) {
  const outsideCode = line.replace(INLINE_CODE, (span) => ' '.repeat(span.length));
  const definition = outsideCode.match(REFERENCE_DEFINITION);
  if (definition) return [definition[1]];
  return [...outsideCode.matchAll(LINK)].map((match) => match[1]);
}

/** Command segments on a shell line: tokens of each part split on &&, ||, ; and |, without a leading $ prompt or VAR=value. */
export function commandSegments(line) {
  return line
    .replace(/^\s*\$\s+/, '')
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((tokens) => {
      let start = 0;
      while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
      return tokens.slice(start);
    })
    .filter((tokens) => tokens.length > 0 && !tokens[0].startsWith('#'));
}

function nearestFile(tree, docPath, name) {
  let dir = path.posix.dirname(docPath);
  for (;;) {
    const candidate = dir === '.' ? name : `${dir}/${name}`;
    if (tree.has(candidate)) return candidate;
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

async function packageScripts(tree, docPath) {
  const file = nearestFile(tree, docPath, 'package.json');
  if (!file) return { file: null, scripts: null };
  try {
    return { file, scripts: JSON.parse(await tree.read(file))?.scripts ?? {} };
  } catch {
    return { file, scripts: null };
  }
}

function scriptNameOf(tokens) {
  const [runner, sub, next] = tokens;
  if (!SCRIPT_RUNNERS.has(runner) || sub === undefined || sub.startsWith('-')) return null;
  if (sub === 'run' || sub === 'run-script') return next && !next.startsWith('-') ? next : null;
  if (LIFECYCLE_SCRIPTS.has(sub)) return sub;
  if (runner === 'npm' || RUNNER_BUILTINS.has(sub)) return null;
  return sub;
}

async function targetsOf(tree, docPath, fileNames, pattern) {
  for (const name of fileNames) {
    const file = nearestFile(tree, docPath, name);
    if (!file) continue;
    const text = (await tree.read(file)) ?? '';
    return { file, targets: new Set([...text.matchAll(pattern)].map((match) => match[1])) };
  }
  return { file: null, targets: new Set() };
}

async function inventedCommand(tree, docPath, tokens) {
  const [tool, target] = tokens;
  const script = scriptNameOf(tokens);
  if (script !== null) {
    const { file, scripts } = await packageScripts(tree, docPath);
    if (!file) return `"${tokens.join(' ')}" runs script "${script}" but there is no package.json`;
    if (scripts === null) return `${file} is not valid JSON, so script "${script}" cannot be confirmed`;
    return Object.hasOwn(scripts, script) ? null : `script "${script}" is not in ${file}`;
  }
  if ((tool === 'make' || tool === 'just') && target && !target.startsWith('-') && !target.includes('=')) {
    const lookup =
      tool === 'make'
        ? await targetsOf(tree, docPath, ['Makefile', 'makefile', 'GNUmakefile'], /^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)
        : await targetsOf(tree, docPath, ['justfile', 'Justfile', '.justfile'], /^@?([A-Za-z0-9_-]+)(?:\s+[^:=\n]*)?:(?!=)/gm);
    if (!lookup.file) return `"${tool} ${target}" but there is no ${tool === 'make' ? 'Makefile' : 'justfile'}`;
    return lookup.targets.has(target) ? null : `target "${target}" is not in ${lookup.file}`;
  }
  return null;
}

function helpFor(cliHelp, tokens) {
  const tools = cliHelp?.tools ?? {};
  const sub = tokens[1] && !tokens[1].startsWith('-') ? `${tokens[0]} ${tokens[1]}` : null;
  if (sub && typeof tools[sub] === 'string') return { name: sub, text: tools[sub] };
  return typeof tools[tokens[0]] === 'string' ? { name: tokens[0], text: tools[tokens[0]] } : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inventedFlags(cliHelp, tokens) {
  const help = helpFor(cliHelp, tokens);
  if (!help) return [];
  return tokens
    .slice(1)
    .filter((token) => /^--?[A-Za-z]/.test(token))
    .map((token) => token.split('=')[0])
    .filter((flag) => !new RegExp(`(^|[^\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(help.text))
    .map((flag) => ({ flag, tool: help.name }));
}

function decodedPath(rawPath) {
  try {
    return decodeURI(rawPath.split('?')[0]);
  } catch {
    return rawPath.split('?')[0];
  }
}

async function linkProblem({ tree, docPath, target, ownSlugs, slugCache, docGlobs }) {
  if (SCHEME.test(target) || target.startsWith('//')) return null;
  const [rawPath, anchor] = target.split('#');
  const cleanPath = decodedPath(rawPath);
  let resolved = docPath;
  if (cleanPath !== '') {
    resolved = cleanPath.startsWith('/') ? cleanPath.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(docPath), cleanPath));
    const isDir = () => tree.paths().some((entry) => entry.startsWith(`${resolved.replace(/\/$/, '')}/`));
    if (!tree.has(resolved) && !isDir()) return `${target} does not resolve at head`;
  }
  if (anchor === undefined || anchor === '') return null;
  if (cleanPath !== '' && !matchesGlobs(resolved, docGlobs)) return null;
  if (cleanPath !== '' && !slugCache.has(resolved)) slugCache.set(resolved, headingSlugs((await tree.read(resolved)) ?? ''));
  const slugs = cleanPath === '' ? ownSlugs : slugCache.get(resolved);
  return slugs.has(anchor.toLowerCase()) ? null : `${target}: no heading with anchor #${anchor}`;
}

function outlineFor(outline, docPath) {
  const documents = Array.isArray(outline?.documents) ? outline.documents : [];
  return documents.find((entry) => entry?.path === docPath) ?? null;
}

function outlineDrift(planned, actual) {
  const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const want = planned.map(normalize);
  const have = actual.map((heading) => normalize(heading.text));
  const missing = want.filter((heading) => !have.includes(heading));
  const extra = have.filter((heading) => !want.includes(heading));
  const sharedWant = want.filter((heading) => have.includes(heading));
  const sharedHave = have.filter((heading) => want.includes(heading));
  const reordered = sharedWant.join('\n') !== sharedHave.join('\n');
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.map((heading) => `"${heading}"`).join(', ')}`);
  if (extra.length > 0) parts.push(`not in the outline ${extra.map((heading) => `"${heading}"`).join(', ')}`);
  if (reordered) parts.push('headings are in a different order than the outline');
  return parts.join('; ');
}

function runFor(runResults, docPath, line) {
  const runs = Array.isArray(runResults?.runs) ? runResults.runs : [];
  return runs.find((run) => run?.path === docPath && run?.line === line) ?? null;
}

/** Pure part: changes (shared change model), a head tree view, rules and the item's recorded outline, runs and help texts. */
export async function evaluate({ changes, tree, config, outline, runResults, cliHelp }) {
  const rules = resolveRules(config);
  const failures = [];
  const fail = (target, rule, detail) => failures.push({ target, rule, detail });
  const docs = changes.filter((change) => !change.binary && change.headText !== null && matchesGlobs(change.path, rules.docGlobs));

  const slugCache = new Map();

  for (const doc of docs) {
    const page = parseMarkdown(doc.headText);
    const addedNumbers = new Set(doc.added.map((entry) => entry.line));
    const added = page.lines.filter((entry) => addedNumbers.has(entry.line));
    const ownSlugs = headingSlugs(doc.headText);
    const prose = added.filter((entry) => entry.kind === 'prose');
    const at = (line) => `${doc.path}:${line}`;

    for (const entry of prose) {
      for (const target of linkTargets(entry.text)) {
        const problem = await linkProblem({ tree, docPath: doc.path, target, ownSlugs, slugCache, docGlobs: rules.docGlobs });
        if (problem) fail(at(entry.line), 'dead-link', problem);
      }
      for (const [, span] of entry.text.matchAll(INLINE_CODE)) {
        const candidate = span.trim();
        if (REPO_PATH.test(candidate)) {
          const fromDoc = path.posix.normalize(path.posix.join(path.posix.dirname(doc.path), candidate));
          const fromRoot = path.posix.normalize(candidate);
          if (!tree.has(fromRoot) && !tree.has(fromDoc)) fail(at(entry.line), 'dead-link', `file path ${candidate} does not exist at head`);
        }
      }
    }

    const shellLines = [
      ...added.filter((entry) => entry.kind === 'code' && SHELL_LANGUAGES.has(entry.block.language)).map((entry) => ({ line: entry.line, text: entry.text })),
      ...prose.flatMap((entry) => [...entry.text.matchAll(INLINE_CODE)].map(([, span]) => ({ line: entry.line, text: span }))),
    ];
    for (const { line, text } of shellLines) {
      for (const tokens of commandSegments(text)) {
        const problem = await inventedCommand(tree, doc.path, tokens);
        if (problem) fail(at(line), 'invented-command', problem);
        for (const { flag, tool } of inventedFlags(cliHelp, tokens)) {
          fail(at(line), 'invented-flag', `${flag} is not in the recorded help of ${tool}`);
        }
      }
    }

    for (const block of page.blocks) {
      const touched = addedNumbers.has(block.line) || block.body.some((entry) => addedNumbers.has(entry.line));
      if (!block.runnable || !touched) continue;
      const run = runFor(runResults, doc.path, block.line);
      if (!run) fail(at(block.line), 'runnable-missing', `no run recorded in ${RUNS_FILE} for the runnable block at line ${block.line}`);
      else if (run.exitCode !== 0) fail(at(block.line), 'runnable-failed', `the runnable block exited ${run.exitCode}`);
    }

    const proseText = prose
      .filter((entry) => !REFERENCE_DEFINITION.test(entry.text))
      .map((entry) => stripInline(entry.text.replace(INLINE_CODE, ' ')))
      .join('\n');
    const words = wordsOf(proseText);
    if (words.length > rules.wordBudget) {
      fail(doc.path, 'word-budget', `${words.length} words of new prose, budget ${rules.wordBudget}; cut or split the page`);
    }

    for (const entry of prose) {
      const lower = stripInline(entry.text).toLowerCase();
      const phrase = rules.genericPhrases.find((candidate) => lower.includes(candidate));
      if (phrase) fail(at(entry.line), 'generic-sentence', `"${phrase}" adds length without information`);
    }

    if (words.length > 0) {
      if (!primaryLanguage(rules.locale)) {
        fail(doc.path, 'doc-locale', 'no repo locale recorded; the verification skill records it, there is no default language');
      } else {
        const measure = foreignStopwordShare(words, rules.locale);
        if (measure.share > rules.foreignStopwordRatio) {
          fail(doc.path, 'doc-locale', `${Math.round(measure.share * 100)}% of words (${measure.foreign}/${measure.words}) are stopwords of a language other than ${rules.locale}`);
        }
      }
    }

    const planned = outlineFor(outline, doc.path);
    if (planned && Array.isArray(planned.headings)) {
      const drift = outlineDrift(planned.headings, headingsOf(doc.headText));
      if (drift) fail(doc.path, 'outline-drift', drift);
    }
  }
  return { pass: failures.length === 0, failures };
}

export default {
  id: 'doc-check',
  description:
    'Added documentation lines: links and repo paths resolve, commands and flags exist, runnable blocks have a recorded passing run, prose fits a word budget without filler in the repo locale, and headings follow the approved outline.',
  async run({ repo, item, baseSha, headSha, config }) {
    const evidence = (name) => readItemEvidence({ repo, itemId: item?.id, name });
    return evaluate({
      changes: await collectChanges({ repo, baseSha, headSha }),
      tree: await headTree({ repo, headSha }),
      config,
      outline: await evidence(OUTLINE_FILE),
      runResults: await evidence(RUNS_FILE),
      cliHelp: await evidence(CLI_HELP_FILE),
    });
  },
  async runFixture(fixture) {
    return evaluate({
      changes: changesFromFiles(fixture.files),
      tree: fixtureTree(fixture.files, fixture.paths),
      config: fixture.config,
      outline: fixture.outline ?? null,
      runResults: fixture.runResults ?? null,
      cliHelp: fixture.cliHelp ?? null,
    });
  },
};
