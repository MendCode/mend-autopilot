#!/usr/bin/env node
// Integrity and scope check for one item diff (base..head).
// Flags the ways a cheap owner can make its own checks pass without fixing anything:
// edited or skipped tests, weaker assertions, regenerated baselines, relaxed gates,
// type escapes, swallowed errors, out-of-scope files, unapproved dependencies,
// secrets and test literals special-cased in source. Node standard library only.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadReviewPolicy } from './review-policy.mjs';

const execFileAsync = promisify(execFile);

export const EXIT = { ok: 0, flagged: 1, usage: 64 };
export const RULES = [
  'test-edit', 'skip-marker', 'assertion-drop', 'baseline-edit', 'gate-config-edit', 'type-escape',
  'swallowed-error', 'out-of-scope', 'dependency-ungranted', 'dependency-unknown', 'secret-like', 'test-literal-in-source',
];
const CONFIG_PATH = '.mend/integrity.json';
const CONFIG_PATTERN_RULES = new Set(['skip-marker', 'assertion', 'type-escape', 'swallowed-error', 'secret-like']);
const CONFIG_GLOB_KEYS = { testGlobs: 'test', baselineGlobs: 'baseline', gateConfigGlobs: 'gateConfig' };
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_TEST_FILES_FOR_LITERALS = 3000;
const GREP_CHUNK = 200;
const LOOKUP_TIMEOUT_MS = 20_000;

export class IntegrityUsageError extends Error {
  constructor(message) {
    super(`[INTEGRITY]: ${message}`);
    this.name = 'IntegrityUsageError';
  }
}

// Patterns per ecosystem. One table; .mend/integrity.json can add to it, never remove.
export const ECOSYSTEMS = {
  js: {
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
    skipMarkers: [/\b(?:it|test|describe|context|suite)\.(?:skip|only|todo|fixme)\b/, /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/],
    assertions: [/\bexpect\s*\(/, /\bassert(?:\.\w+)?\s*\(/, /\bt\.(?:is|not|deepEqual|true|false|throws|snapshot)\s*\(/],
    weakAssertions: [/\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)/, /\.not\.(?:toBeNull|toBeUndefined)\s*\(\s*\)/, /\bexpect\s*\(\s*true\s*\)/, /\bassert\s*\(\s*true\s*\)/],
    typeEscapes: [/\bas\s+any\b/, /:\s*any\b/, /<any>/, /@ts-(?:ignore|expect-error|nocheck)\b/, /eslint-disable/, /biome-ignore/, /\bas\s+unknown\s+as\b/],
    swallowedStyle: 'brace',
  },
  python: {
    extensions: ['.py'],
    skipMarkers: [/@pytest\.mark\.(?:skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/, /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, /\bself\.skipTest\s*\(/],
    assertions: [/^\s*assert\b/, /\bself\.assert\w+\s*\(/, /\bpytest\.raises\s*\(/],
    weakAssertions: [/^\s*assert\s+True\b/, /^\s*assert\s+[\w.]+\s+is\s+not\s+None\s*$/, /\bassertTrue\s*\(\s*True\s*\)/, /\bassertIsNotNone\s*\(/],
    typeEscapes: [/#\s*type:\s*ignore/, /#\s*noqa\b/, /#\s*pylint:\s*disable/, /#\s*pyright:\s*ignore/, /\bcast\s*\(\s*Any\b/],
    swallowedStyle: 'python',
  },
  go: {
    extensions: ['.go'],
    skipMarkers: [/\bt\.Skip(?:f|Now)?\s*\(/],
    assertions: [/\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/, /\b(?:assert|require)\.\w+\s*\(/],
    weakAssertions: [/\b(?:assert|require)\.NotNil\s*\(/],
    typeEscapes: [/\/\/\s*nolint\b/],
    swallowedStyle: 'go',
  },
  rust: {
    extensions: ['.rs'],
    skipMarkers: [/#\[ignore\b/],
    assertions: [/\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq)!\s*\(/],
    weakAssertions: [/\bassert!\s*\(\s*true\s*\)/],
    typeEscapes: [/#!?\[allow\s*\(/],
    swallowedStyle: 'rust',
  },
  jvm: {
    extensions: ['.java', '.kt', '.kts', '.scala'],
    skipMarkers: [/@Disabled\b/, /@Ignore\b/, /\bassumeTrue\s*\(/],
    assertions: [/\bassert\w*\s*\(/, /\bverify\s*\(/],
    weakAssertions: [/\bassertNotNull\s*\(/, /\bassertTrue\s*\(\s*true\s*\)/],
    typeEscapes: [/@SuppressWarnings\b/, /@Suppress\s*\(/],
    swallowedStyle: 'brace',
  },
  ruby: {
    extensions: ['.rb', '.rake'],
    skipMarkers: [/^\s*(?:skip|pending)\b/, /\b(?:xit|xdescribe|xcontext|xspecify)\b/],
    assertions: [/\bexpect\s*[({]/, /\bassert\w*\b/, /\.should\b/],
    weakAssertions: [/\bto\s+be_truthy\b/, /\bnot_to\s+be_nil\b/],
    typeEscapes: [/#\s*rubocop:disable\b/, /#\s*steep:ignore\b/],
    swallowedStyle: 'ruby',
  },
  sql: {
    extensions: ['.sql'],
    skipMarkers: [/\bskip\s*\(/i, /\btodo_start\s*\(/i],
    assertions: [/\b(?:ok|is|isnt|results_eq|set_eq|throws_ok|lives_ok)\s*\(/i],
    weakAssertions: [/\bok\s*\(\s*true\b/i],
    typeEscapes: [],
    swallowedStyle: null,
  },
};

export const DEFAULT_GLOBS = {
  baseline: [
    '**/__snapshots__/**', '**/*.snap', '**/*.golden', '**/testdata/**', '**/__fixtures__/**', '**/fixtures/**',
    '**/*.approved.*', '**/baseline/**', '**/baselines/**', '**/*.baseline.*',
  ],
  gateConfig: [
    '.mend/**', '.github/workflows/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml', '**/Jenkinsfile', '.husky/**',
    '.pre-commit-config.yaml', '**/lefthook.yml', '**/lefthook.yaml', '**/.eslintrc', '**/.eslintrc.*', '**/eslint.config.*',
    '**/biome.json', '**/biome.jsonc', '**/.stylelintrc*', '**/tsconfig*.json', '**/jest.config.*', '**/vitest.config.*',
    '**/vitest.workspace.*', '**/playwright.config.*', '**/.nycrc*', '**/.c8rc*', '**/ruff.toml', '**/.ruff.toml', '**/.flake8',
    '**/mypy.ini', '**/.mypy.ini', '**/pytest.ini', '**/tox.ini', '**/setup.cfg', '**/.coveragerc', '**/codecov.yml',
    '**/.codecov.yml', '**/.golangci.yml', '**/.golangci.yaml', '**/clippy.toml', '**/.clippy.toml', '**/.rubocop.yml',
    '**/detekt.yml', '**/checkstyle.xml', '**/.swiftlint.yml',
  ],
  test: [
    '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/spec/**', '**/e2e/**', '**/test_*.py',
    '**/*_test.py', '**/conftest.py', '**/*_test.go', '**/src/test/**', '**/*Test.java', '**/*Tests.java', '**/*Test.kt',
    '**/*Tests.kt', '**/*_spec.rb', '**/*_test.rb',
  ],
};

const GATE_SCRIPT_KEY = /(?:^|[:_-])(?:test|tests|lint|typecheck|type-check|check|ci|verify|coverage|e2e)(?:$|[:_-])/i;
const GATE_PACKAGE_KEYS = ['jest', 'eslintConfig', 'c8', 'nyc', 'vitest', 'ava', 'mocha'];
const PYPROJECT_GATE_SECTION = /^tool\.(?:ruff|mypy|pytest|coverage|pylint|black|isort|pyright|flake8|bandit)\b/;
const PROMISE_SWALLOW = /\.catch\(\s*(?:(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined|void 0|false|\[\])|noop|_\.noop)\s*\)/;
const RUST_SWALLOW = [/\.ok\(\)\s*;\s*$/, /\bErr\s*\(\s*_\s*\)\s*=>\s*(?:\{\s*\}|\(\s*\))/];
const GO_DISCARD = /^\s*_\s*=\s*err\b/;
const SECRET_PATTERNS = [
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'stripe-live-key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'llm-api-key', regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: 'private-key', regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'credential-in-url', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s:@/]{6,})@/i, valueGroup: 1 },
  {
    kind: 'assigned-secret',
    regex: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)\w*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    valueGroup: 1,
  },
];
// Fixture values named as fixtures (test-owner-token, fake_api_key) are not secrets; pilots flagged them twice.
const SECRET_PLACEHOLDER = /^(?:x+|\*+|\.+|password|postgres|root|admin|secret|test|local|dev)$|^(?:test|fake|mock|fixture|stub)[-_]|example|sample|dummy|placeholder|changeme|change-me|your[_-]|<|>|\$\{|\{\{|process\.env|os\.environ|getenv/i;
const NUMBER_LITERAL = /(?<![\w.$])-?\d+(?:\.\d+)?(?![\w.])/g;
const STRING_LITERAL = /(["'`])((?:(?!\1)[^\\\n]){5,})\1/g;
const TRIVIAL_NUMBERS = new Set(['-1', '10', '100', '1000', '0.5', '1.0', '0.0']);
const ASSERTION_GREP = 'expect|assert|should|want|t\\.(error|fatal)|require\\.|tobe|toequal';
const IMPORT_LINE = /^\s*(?:import|from|export)\b|\brequire\s*\(/;

// ---------------------------------------------------------------------------
// Paths and globs

export function globToRegExp(glob) {
  let normalized = glob.replace(/\\/g, '/');
  if (normalized.endsWith('/')) normalized += '**';
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      const followedBySlash = normalized[index + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function compileGlobs(globs) {
  return globs.map((glob) => globToRegExp(glob));
}

function matchesAny(filePath, compiled) {
  return compiled.some((regex) => regex.test(filePath));
}

export function ecosystemOf(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  return Object.keys(ECOSYSTEMS).find((name) => ECOSYSTEMS[name].extensions.includes(extension)) ?? null;
}

function classify(filePath, globs) {
  if (matchesAny(filePath, globs.baseline)) return 'baseline';
  if (matchesAny(filePath, globs.gateConfig)) return 'gate';
  if (matchesAny(filePath, globs.test)) return 'test';
  return 'source';
}

// ---------------------------------------------------------------------------
// Git

async function git(repo, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

async function resolveCommit(repo, sha) {
  if (typeof sha !== 'string' || sha.trim() === '') throw new IntegrityUsageError('base and head SHAs are required');
  const resolved = await git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { allowFailure: true });
  if (!resolved) throw new IntegrityUsageError(`commit not found: ${sha}`);
  return resolved.trim();
}

async function showFile(repo, sha, filePath) {
  if (!filePath) return null;
  return git(repo, ['show', `${sha}:${filePath}`], { allowFailure: true });
}

export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const paths = parseGitDiffPaths(raw);
      current = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, status: 'modified', binary: false, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    const header = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('new file mode')) current.status = 'added';
      else if (raw.startsWith('deleted file mode')) current.status = 'deleted';
      else if (raw.startsWith('rename from ')) {
        current.status = 'renamed';
        current.oldPath = decodeGitPath(raw.slice('rename from '.length));
      } else if (raw.startsWith('rename to ')) current.newPath = decodeGitPath(raw.slice('rename to '.length));
      else if (raw.startsWith('Binary files ')) current.binary = true;
      else if (raw.startsWith('--- ')) current.oldPath = raw === '--- /dev/null' ? null : decodeGitPath(raw.slice(4).replace(/\t$/, '')).replace(/^a\//, '');
      else if (raw.startsWith('+++ ')) current.newPath = raw === '+++ /dev/null' ? null : decodeGitPath(raw.slice(4).replace(/\t$/, '')).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('+')) {
      hunk.added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      hunk.removed.push({ line: oldLine, text: raw.slice(1) });
      oldLine += 1;
    } else if (raw.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  for (const file of files) file.path = file.newPath ?? file.oldPath;
  return files.filter((file) => file.path);
}

function parseGitDiffPaths(header) {
  const body = header.slice('diff --git '.length);
  // Git does not quote spaces. Equal paths have an unambiguous midpoint even
  // when the filename itself contains " b/"; rename headers supply other paths.
  const middle = (body.length - 1) / 2;
  if (body.startsWith('a/') && body[middle] === ' ' && body.slice(middle + 1).startsWith('b/') && body.slice(2, middle) === body.slice(middle + 3)) {
    return [body.slice(2, middle), body.slice(middle + 3)];
  }
  const match = /^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(body);
  if (!match) return [];
  const oldPath = decodeGitPath(match[1]);
  const newPath = decodeGitPath(match[2]);
  return oldPath.startsWith('a/') && newPath.startsWith('b/') ? [oldPath.slice(2), newPath.slice(2)] : [];
}

function decodeGitPath(token) {
  if (!token.startsWith('"')) return token;
  const bytes = [];
  const escapes = { a: 7, t: 9, n: 10, r: 13, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
  for (let index = 1; index < token.length - 1; index += 1) {
    if (token[index] !== '\\') {
      const char = String.fromCodePoint(token.codePointAt(index));
      bytes.push(...Buffer.from(char));
      index += char.length - 1;
      continue;
    }
    const next = token[++index];
    if (next in escapes) bytes.push(escapes[next]);
    else if (/[0-7]/.test(next)) {
      const octal = (next + token.slice(index + 1, index + 3)).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(octal, 8));
      index += octal.length - 1;
    } else bytes.push(...Buffer.from(next));
  }
  return Buffer.from(bytes).toString('utf8');
}

function addedLines(file) {
  return file.hunks.flatMap((hunk) => hunk.added);
}

function removedLines(file) {
  return file.hunks.flatMap((hunk) => hunk.removed);
}

// Recognize assertion expressions without executing them. Calls to the code
// under test need not have appeared at base; assignments, statement injection
// and explicit test/process termination are not additive assertions.
function additiveJsAssertion(text) {
  const source = text.trim().replace(/;$/, '').trimEnd();
  const token = /\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|[()[\]{},.:!+*/%<>&|~-])/gy;
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) return false;
    tokens.push(match[0].trim());
    offset = token.lastIndex;
  }
  const identifier = /^[A-Za-z_$][\w$]*$/;
  const forbidden = new Set(['eval', 'Function', 'require', 'import', 'load', 'exit', 'quit', 'stop', 'abort', 'skip', 'only', 'todo', 'constructor', '__proto__', 'prototype']);
  const reserved = new Set(['return', 'throw', 'yield', 'await', 'new', 'delete', 'function', 'class']);
  let cursor = 0;
  const take = (value) => tokens[cursor] === value && (++cursor > 0);
  const argumentsUntil = (end) => {
    if (take(end)) return true;
    do { if (!expression()) return false; } while (take(','));
    return take(end);
  };
  const primary = () => {
    if (['!', '+', '-', '~', 'typeof'].includes(tokens[cursor])) {
      cursor += 1;
      return primary();
    }
    if (take('(')) return expression() && take(')');
    if (take('[')) return argumentsUntil(']');
    if (take('{')) {
      if (take('}')) return true;
      do {
        if (!/^(?:[A-Za-z_$][\w$]*|'.*'|".*"|\d+)$/.test(tokens[cursor] ?? '')) return false;
        cursor += 1;
        if (!take(':') || !expression()) return false;
      } while (take(','));
      return take('}');
    }
    const value = tokens[cursor++];
    if (/^(?:'.*'|".*"|\d+(?:\.\d+)?)$/.test(value ?? '')) return true;
    if (!value || !identifier.test(value) || reserved.has(value) || forbidden.has(value)) return false;
    let indexed = false;
    while (tokens[cursor] === '.' || tokens[cursor] === '(' || tokens[cursor] === '[') {
      if (take('.')) {
        const member = tokens[cursor++];
        if (!member || !identifier.test(member) || forbidden.has(member)) return false;
      } else if (take('[')) {
        if (!expression() || !take(']')) return false;
        // Reads are additive; a computed callee could hide process['exit'] or
        // reach a forbidden method through an intermediate computed property.
        indexed = true;
      } else if (take('(') && (indexed || !argumentsUntil(')'))) return false;
    }
    return true;
  };
  const expression = () => {
    if (!primary()) return false;
    while (['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '===', '!==', '&&', '||', '??', '&', '|'].includes(tokens[cursor])) {
      cursor += 1;
      if (!primary()) return false;
    }
    return true;
  };
  // Awaiting the whole assertion preserves its normal resolves/rejects chain.
  // Do not admit arbitrary await statements or assignment inside its subject.
  take('await');
  if (!take('expect') || !take('(') || !expression() || !take(')') || !take('.')) return false;
  while (['not', 'resolves', 'rejects'].includes(tokens[cursor])) {
    cursor += 1;
    if (!take('.')) return false;
  }
  if (!/^to[A-Z]\w*$/.test(tokens[cursor++] ?? '')) return false;
  return take('(') && argumentsUntil(')') && cursor === tokens.length;
}

// Map head line numbers back to insertion seams in the unchanged base. A bare
// control header is not a statement boundary: inserting after `if (disabled)`
// would steal its body and make the old `return` unconditional.
function additiveAssertionContext(added, baseText, isAssertion) {
  const lines = baseText.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const spans = [...baseText.matchAll(/"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)];
  let code = baseText;
  for (const span of spans) {
    code = code.slice(0, span.index) + span[0].replace(/[^\n]/g, ' ') + code.slice(span.index + span[0].length);
  }
  return added.every(({ line }, index) => {
    const seam = offsets[line - 1 - index];
    if (seam === undefined || spans.some((span) => span.index < seam && seam < span.index + span[0].length)) return false;
    const before = code.slice(0, seam).trimEnd();
    const parentheses = [];
    let previousToken = '';
    for (const match of before.matchAll(/[A-Za-z_$][\w$]*|[(){};]/g)) {
      const current = match[0];
      if (current === '(') parentheses.push(/^(?:if|for|while|switch|with|catch)$/.test(previousToken));
      else if (current === ')') parentheses.pop();
      previousToken = current;
    }
    if (parentheses.includes(true)) return false;
    if (/^\s*else\b/.test(code.slice(seam))) return false;
    if (/[;{}]$/.test(before)) return true;
    // Semicolon-free standalone assertions also end a statement, unlike a
    // control header ending in `)`. Ignore blank/comment-only lines.
    const previous = code.slice(0, seam).split('\n').findLastIndex((text) => text.trim());
    return previous >= 0 && isAssertion(lines[previous]);
  });
}

// Fail closed on non-assertion additions and on unsafe insertion contexts.
function additiveTestAssertions(added, ecosystem, baseText) {
  if (!ecosystem || added.length === 0) return false;
  if (ecosystem === 'js') return added.every(({ text }) => additiveJsAssertion(text)) && additiveAssertionContext(added, baseText, additiveJsAssertion);
  const literal = String.raw`(?:-?\d+(?:\.\d+)?|'[^'\\\r\n]*'|"[^"\\\r\n]*")`;
  const atom = String.raw`(?:${literal}|[A-Za-z_$][\w$]*)`;
  const list = String.raw`${atom}(?:\s*,\s*${atom})*`;
  const value = String.raw`(?:${atom}|\[\s*(?:${list})?\s*\]|\{\s*\}|\(\s*(?:${list})?\s*\))`;
  const pair = String.raw`${value}\s*,\s*${value}`;
  const patterns = {
    python: String.raw`(?:assert\s+${value}\s*(?:==|!=|<=|>=|<|>|\bis\b|\bis\s+not\b)\s*${value}|self\.assert(?:Equal|NotEqual)\(\s*${pair}\s*\))`,
    go: String.raw`(?:assert|require)\.(?:Equal|NotEqual)\(\s*t\s*,\s*${pair}\s*\)`,
    rust: String.raw`assert_(?:eq|ne)!\(\s*${pair}\s*\);?`,
    jvm: String.raw`assert(?:Equals|NotEquals)\(\s*${pair}\s*\);?`,
    ruby: String.raw`(?:assert_equal\s+${pair}|expect\(\s*${value}\s*\)\.to\s+eq\(\s*${value}\s*\))`,
    sql: String.raw`SELECT\s+(?:is|isnt)\(\s*${pair}\s*\);?`,
  };
  if (!patterns[ecosystem]) return false;
  const assertion = new RegExp(String.raw`^\s*${patterns[ecosystem]}\s*$`, ecosystem === 'sql' ? 'i' : '');
  return added.every(({ text }) => assertion.test(text)) &&
    (ecosystem !== 'jvm' || additiveAssertionContext(added, baseText, (text) => assertion.test(text)));
}

/** Head-side line numbers touched by the diff, including the seam where lines were removed. */
function changedHeadLines(file) {
  const lines = new Set();
  for (const hunk of file.hunks) {
    for (const added of hunk.added) lines.add(added.line);
    if (hunk.removed.length > 0 && hunk.added.length === 0) {
      lines.add(hunk.newStart);
      lines.add(hunk.newStart + 1);
    }
  }
  return lines;
}

/** First changed line and which side it refers to. */
function firstChange(file) {
  const first = file.hunks[0];
  if (!first) return { line: 1, side: 'head' };
  if (first.removed.length > 0 && (first.added.length === 0 || file.status === 'deleted')) return { line: first.removed[0].line, side: 'base' };
  if (first.added.length > 0) return { line: first.added[0].line, side: 'head' };
  return { line: first.newStart, side: 'head' };
}

function lineOf(text, needle) {
  if (!text) return 1;
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

// ---------------------------------------------------------------------------
// Configuration and item

export function mergeConfig(raw) {
  const globs = {
    test: [...DEFAULT_GLOBS.test],
    baseline: [...DEFAULT_GLOBS.baseline],
    gateConfig: [...DEFAULT_GLOBS.gateConfig],
  };
  const patterns = Object.fromEntries([...CONFIG_PATTERN_RULES].map((rule) => [rule, []]));
  const warnings = [];
  if (raw === null || raw === undefined) return { globs: compileAll(globs), patterns, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${CONFIG_PATH} is not a JSON object; built-in rules only`);
    return { globs: compileAll(globs), patterns, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key in CONFIG_GLOB_KEYS) {
      if (Array.isArray(value)) globs[CONFIG_GLOB_KEYS[key]].push(...value.map(String));
      else warnings.push(`${key} must be an array of globs; ignored`);
    } else if (key === 'patterns' && value && typeof value === 'object') {
      for (const [rule, list] of Object.entries(value)) {
        if (!CONFIG_PATTERN_RULES.has(rule) || !Array.isArray(list)) {
          warnings.push(`patterns.${rule} is not an extendable rule; ignored`);
          continue;
        }
        for (const source of list) {
          try {
            patterns[rule].push(new RegExp(String(source)));
          } catch (error) {
            warnings.push(`patterns.${rule}: invalid regular expression ${JSON.stringify(source)}`);
          }
        }
      }
    } else {
      warnings.push(`"${key}" cannot change or remove built-in rules; ignored`);
    }
  }
  return { globs: compileAll(globs), patterns, warnings };
}

function compileAll(globs) {
  return { test: compileGlobs(globs.test), baseline: compileGlobs(globs.baseline), gateConfig: compileGlobs(globs.gateConfig) };
}

export function normalizeItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const editSet = source.editSet ?? source.edit_set ?? source.edit_files ?? [];
  const profiles = source.profiles ?? [];
  const grants = source.grants ?? {};
  const dependencies = grants.dependencies ?? [];
  // An existing test the item must change on purpose (its behaviour is what the item changes), with the reason.
  const testChanges = Array.isArray(source.testChanges) ? source.testChanges.filter((entry) => typeof entry?.file === 'string' && typeof entry?.why === 'string' && entry.why.trim()) : [];
  return {
    testChanges: new Map(testChanges.map((entry) => [entry.file, entry.why.trim()])),
    id: source.id ?? null,
    editSet: Array.isArray(editSet) ? editSet.map(String) : [],
    profiles: Array.isArray(profiles) ? profiles.map(String) : [],
    grantedDependencies: new Set((Array.isArray(dependencies) ? dependencies : []).map((name) => normalizeDependencyName(String(name)))),
  };
}

// ---------------------------------------------------------------------------
// Per-rule detectors

function isStrongAssertion(text, ecosystem, extraAssertions) {
  const rules = ECOSYSTEMS[ecosystem];
  const asserts = rules.assertions.some((regex) => regex.test(text)) || extraAssertions.some((regex) => regex.test(text));
  return asserts && !rules.weakAssertions.some((regex) => regex.test(text));
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Returns the head line where the block opened at (lineIndex, column) closes, and whether it is empty. */
function braceBlock(lines, lineIndex, column) {
  let depth = 0;
  let body = '';
  for (let index = lineIndex; index < Math.min(lines.length, lineIndex + 40); index += 1) {
    const text = index === lineIndex ? lines[index].slice(column) : lines[index];
    for (const char of text) {
      if (char === '{') {
        depth += 1;
        if (depth === 1) continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return { endIndex: index, empty: stripComments(body).trim() === '' };
      }
      body += char;
    }
    body += '\n';
  }
  return null;
}

function swallowedBlocks(headText, style) {
  const lines = headText.split('\n');
  const found = [];
  lines.forEach((text, index) => {
    if (style === 'brace' || style === 'go') {
      const opener = style === 'go' ? /\berr\s*!=\s*nil\s*\{/ : /\bcatch\b\s*(?:\([^)]*\))?\s*\{/;
      const match = opener.exec(text);
      if (match) {
        const block = braceBlock(lines, index, match.index + match[0].length - 1);
        if (block?.empty) found.push({ startLine: index + 1, endLine: block.endIndex + 1 });
      }
    }
    if (style === 'python') {
      const match = /^(\s*)except\b[^:]*:(.*)$/.exec(text);
      if (!match) return;
      const inline = match[2].replace(/#.*$/, '').trim();
      if (inline !== '') {
        if (inline === 'pass' || inline === '...') found.push({ startLine: index + 1, endLine: index + 1 });
        return;
      }
      const indent = match[1].length;
      const statements = [];
      let endIndex = index;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (candidate.trim() === '' || candidate.trim().startsWith('#')) continue;
        if (candidate.length - candidate.trimStart().length <= indent) break;
        statements.push(candidate.trim());
        endIndex = next;
      }
      if (statements.length > 0 && statements.every((statement) => statement === 'pass' || statement === '...')) {
        found.push({ startLine: index + 1, endLine: endIndex + 1 });
      }
    }
    if (style === 'ruby' && /^\s*rescue\b/.test(text)) {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '' && !candidate.trim().startsWith('#'));
      if (next !== undefined && /^\s*end\b/.test(next)) found.push({ startLine: index + 1, endLine: index + 2 });
    }
  });
  return found;
}

function swallowedOnAddedLine(text, style) {
  if (style === 'brace' && PROMISE_SWALLOW.test(text)) return true;
  if (style === 'go' && GO_DISCARD.test(text)) return true;
  if (style === 'rust' && RUST_SWALLOW.some((regex) => regex.test(text))) return true;
  if (style === 'ruby' && /\brescue\s+nil\b/.test(text)) return true;
  return false;
}

export function findSecrets(text, extraPatterns = []) {
  const findings = [];
  const patterns = [...SECRET_PATTERNS, ...extraPatterns.map((regex) => ({ kind: 'custom', regex }))];
  String(text)
    .split('\n')
    .forEach((line, index) => {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match) continue;
        if (pattern.valueGroup && SECRET_PLACEHOLDER.test(match[pattern.valueGroup] ?? '')) continue;
        findings.push({ line: index + 1, kind: pattern.kind });
        break;
      }
    });
  return findings;
}

/** Scan JSON fields both as assignments and as raw text, before JSON escapes quotes. */
export function findStructuredSecrets(value, extraPatterns = []) {
  const findings = findSecrets(JSON.stringify(value ?? null), extraPatterns);
  const visit = (entry) => {
    if (typeof entry === 'string') findings.push(...findSecrets(entry, extraPatterns));
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(value);
  return findings;
}

export function extractLiterals(text) {
  const found = new Set();
  for (const match of text.matchAll(NUMBER_LITERAL)) {
    const value = match[0];
    if (/^-?\d$/.test(value) || TRIVIAL_NUMBERS.has(value)) continue;
    found.add(value);
  }
  for (const match of text.matchAll(STRING_LITERAL)) found.add(match[2]);
  return found;
}

// ---------------------------------------------------------------------------
// Dependencies

function normalizeDependencyName(name) {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

function jsonDependencyNames(sections, { requireSlash = false } = {}) {
  return (text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const names = new Set();
    for (const section of sections) {
      for (const name of Object.keys(parsed?.[section] ?? {})) {
        if (!requireSlash || name.includes('/')) names.add(name);
      }
    }
    return names;
  };
}

function requirementsNames(text) {
  const names = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '' || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function pyprojectNames(text) {
  const names = new Set();
  let section = '';
  let inArray = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      inArray = false;
      continue;
    }
    const arraySection = section === 'project' || section === 'project.optional-dependencies' || section === 'dependency-groups';
    if (arraySection && /^\s*[\w-]*dependencies\s*=\s*\[|^\s*[\w-]+\s*=\s*\[/.test(line) && (section !== 'project' || /dependencies\s*=/.test(line))) {
      inArray = true;
    }
    if (inArray) {
      for (const match of line.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(match[1]);
      if (line.includes(']')) inArray = false;
      continue;
    }
    if (/^tool\.poetry(?:\.group\.[\w-]+)?\.(?:dev-)?dependencies$/.test(section)) {
      const key = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (key && key[1].toLowerCase() !== 'python') names.add(key[1]);
    }
  }
  return names;
}

function goModNames(text) {
  const names = new Set();
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (/^\s*require\s*\(\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s*\)\s*$/.test(line)) {
      inBlock = false;
      continue;
    }
    const pattern = inBlock ? /^\s*([A-Za-z0-9.\-_~]+(?:\/[A-Za-z0-9.\-_~]+)+)\s+v\d/ : /^\s*require\s+([A-Za-z0-9.\-_~]+(?:\/[A-Za-z0-9.\-_~]+)+)\s+v\d/;
    const match = pattern.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function cargoNames(text) {
  const names = new Set();
  let inDependencies = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const section = header[1].trim();
      const named = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (named) {
        names.add(named[1]);
        inDependencies = false;
      } else {
        inDependencies = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section);
      }
      continue;
    }
    if (!inDependencies) continue;
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (key) names.add(key[1]);
  }
  return names;
}

function gemfileNames(text) {
  return new Set([...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((match) => match[1]));
}

function gradleNames(text) {
  const pattern = /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor)\s*\(?\s*["']([^:"'\s]+:[^:"'\s]+)/g;
  return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

function pomNames(text) {
  const names = new Set();
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = /<groupId>([^<]+)<\/groupId>/.exec(block[1]);
    const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block[1]);
    if (group && artifact) names.add(`${group[1].trim()}:${artifact[1].trim()}`);
  }
  return names;
}

const MANIFESTS = [
  { matches: (name) => name === 'package.json', ecosystem: 'npm', extract: jsonDependencyNames(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) },
  { matches: (name) => name === 'composer.json', ecosystem: 'composer', extract: jsonDependencyNames(['require', 'require-dev'], { requireSlash: true }) },
  { matches: (name) => /^requirements.*\.(?:txt|in)$/.test(name) || name === 'constraints.txt', ecosystem: 'pypi', extract: requirementsNames },
  { matches: (name) => name === 'pyproject.toml', ecosystem: 'pypi', extract: pyprojectNames },
  { matches: (name) => name === 'go.mod', ecosystem: 'go', extract: goModNames },
  { matches: (name) => name === 'Cargo.toml', ecosystem: 'crates', extract: cargoNames },
  { matches: (name) => name === 'Gemfile', ecosystem: 'rubygems', extract: gemfileNames },
  { matches: (name) => /^build\.gradle(?:\.kts)?$/.test(name), ecosystem: 'maven', extract: gradleNames },
  { matches: (name) => name === 'pom.xml', ecosystem: 'maven', extract: pomNames },
];

/** Asks the repo's own package manager whether a name exists: 'found' | 'missing' | 'unavailable'. */
export async function defaultLookup({ ecosystem, name, repo }) {
  const commands = {
    npm: ['npm', ['view', name, 'name', '--json']],
    pypi: ['pip', ['index', 'versions', name]],
  };
  const command = commands[ecosystem];
  if (!command) return 'unavailable';
  try {
    await execFileAsync(command[0], command[1], { cwd: repo, timeout: LOOKUP_TIMEOUT_MS });
    return 'found';
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/E404|404 Not Found|No matching distribution/i.test(output)) return 'missing';
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Scan

export async function scanDiff({ repo, baseSha, headSha, item, config, lookup = defaultLookup }) {
  if (typeof repo !== 'string' || repo === '') throw new IntegrityUsageError('repo is required');
  const base = await resolveCommit(repo, baseSha);
  const head = await resolveCommit(repo, headSha);
  const settings = mergeConfig(config);
  const scope = normalizeItem(item);
  const editSet = compileGlobs(scope.editSet);
  const flags = [];
  const seen = new Set();
  const flag = ({ rule, file, line, detail, severity = 'block' }) => {
    const key = rule === 'config-warning' ? `${rule}|${detail}` : `${rule}|${file}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ rule, file, line, detail, severity });
  };

  for (const warning of settings.warnings) flag({ rule: 'config-warning', file: CONFIG_PATH, line: 0, detail: warning, severity: 'warn' });
  if (scope.editSet.length === 0) flag({ rule: 'out-of-scope', file: '(item)', line: 0, detail: 'the item declares no edit set, so every file is out of scope' });
  const cardSecret = findStructuredSecrets(item, settings.patterns['secret-like'])[0];
  if (cardSecret) flag({ rule: 'secret-like', file: '(item)', line: 0, detail: `${cardSecret.kind} in item card; value withheld` });

  const { pathspec } = await loadReviewPolicy({ repo, baseSha: base });
  const diffText = await git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/', base, head, '--', ...pathspec]);
  const files = parseUnifiedDiff(diffText);
  const newDependencies = [];
  const literalCandidates = [];

  for (const file of files) {
    const kind = classify(file.path, settings.globs);
    const ecosystem = ecosystemOf(file.path);
    const added = addedLines(file);
    const removed = removedLines(file);
    const first = firstChange(file);
    const where = first.side === 'base' ? ` (base line ${first.line})` : '';

    const scopePaths = file.status === 'renamed' ? [file.oldPath, file.newPath] : [file.path];
    if (scope.editSet.length > 0 && scopePaths.some((candidate) => !matchesAny(candidate, editSet))) {
      flag({ rule: 'out-of-scope', file: file.path, line: first.line, detail: `${file.status} file is outside the item's edit set${where}` });
    }

    if (kind === 'baseline' && file.status !== 'added') {
      flag({ rule: 'baseline-edit', file: file.path, line: first.line, detail: `existing snapshot, fixture or baseline ${file.status}${where}` });
    }

    if (kind === 'gate') {
      flag({ rule: 'gate-config-edit', file: file.path, line: first.line, detail: `CI, lint, type-check, coverage or mend config ${file.status}${where}` });
    }

    if (kind === 'test') {
      if (file.status !== 'added' && (!scope.profiles.includes('test-authoring') || removed.length > 0 || file.binary || file.status !== 'modified' || !additiveTestAssertions(added, ecosystem, (await showFile(repo, base, file.oldPath)) ?? ''))) {
        // Declared by the item and only modified: a warning the card carries to the human. Deleting or renaming
        // a test, and dropping assertions (assertion-drop below), still block.
        const declared = file.status === 'modified' ? scope.testChanges.get(file.path) : undefined;
        if (declared) flag({ rule: 'test-edit', file: file.path, line: first.line, detail: `existing test modified as the item declares: ${declared}${where}`, severity: 'warn' });
        else flag({ rule: 'test-edit', file: file.path, line: first.line, detail: `existing test ${file.status}${where}` });
      }
      if (ecosystem) {
        const markers = [...ECOSYSTEMS[ecosystem].skipMarkers, ...settings.patterns['skip-marker']];
        for (const line of added) {
          if (markers.some((regex) => regex.test(line.text))) {
            flag({ rule: 'skip-marker', file: file.path, line: line.line, detail: 'new skip, only or disabled-test marker' });
          }
        }
        if (file.status !== 'added') {
          const extra = settings.patterns.assertion;
          const removedStrong = removed.filter((line) => isStrongAssertion(line.text, ecosystem, extra));
          const addedStrong = added.filter((line) => isStrongAssertion(line.text, ecosystem, extra));
          if (removedStrong.length > addedStrong.length) {
            flag({
              rule: 'assertion-drop',
              file: file.path,
              line: removedStrong[0].line,
              detail: `${removedStrong.length} assertion(s) removed or weakened, ${addedStrong.length} added (base line ${removedStrong[0].line})`,
            });
          }
        }
      }
    }

    if (file.binary) continue;
    const headText = file.status === 'deleted' ? '' : (await showFile(repo, head, file.newPath)) ?? '';
    const baseText = file.status === 'added' ? '' : (await showFile(repo, base, file.oldPath)) ?? '';

    const basename = path.posix.basename(file.path);
    if (basename === 'package.json') checkPackageGateKeys({ file, headText, baseText, flag });
    if (basename === 'pyproject.toml') checkPyprojectGateSections({ file, headText, baseText, flag });

    if (kind === 'source' && ecosystem) {
      const rules = ECOSYSTEMS[ecosystem];
      const escapes = [...rules.typeEscapes, ...settings.patterns['type-escape']];
      const extraSwallow = settings.patterns['swallowed-error'];
      for (const line of added) {
        if (escapes.some((regex) => regex.test(line.text))) {
          flag({ rule: 'type-escape', file: file.path, line: line.line, detail: 'new type, lint or compiler escape' });
        }
        if (swallowedOnAddedLine(line.text, rules.swallowedStyle) || extraSwallow.some((regex) => regex.test(line.text))) {
          flag({ rule: 'swallowed-error', file: file.path, line: line.line, detail: 'error discarded without handling' });
        }
      }
      if (rules.swallowedStyle && headText) {
        const changed = changedHeadLines(file);
        for (const block of swallowedBlocks(headText, rules.swallowedStyle)) {
          let touched = false;
          for (let line = block.startLine; line <= block.endLine; line += 1) touched ||= changed.has(line);
          if (touched) flag({ rule: 'swallowed-error', file: file.path, line: block.startLine, detail: 'empty catch or except block' });
        }
      }
      if (added.length > 0) literalCandidates.push({ file, added, baseText });
    }

    const secretExtra = settings.patterns['secret-like'];
    for (const line of added) {
      const [finding] = findSecrets(line.text, secretExtra);
      if (finding) flag({ rule: 'secret-like', file: file.path, line: line.line, detail: `${finding.kind} on an added line; value withheld` });
    }

    const manifest = MANIFESTS.find((candidate) => candidate.matches(basename));
    if (manifest && file.status !== 'deleted') {
      const headNames = manifest.extract(headText);
      const baseNames = baseText ? manifest.extract(baseText) : new Set();
      if (headNames) {
        const before = new Set([...(baseNames ?? [])].map(normalizeDependencyName));
        for (const name of headNames) {
          if (before.has(normalizeDependencyName(name))) continue;
          newDependencies.push({ name, ecosystem: manifest.ecosystem, file: file.path, line: lineOf(headText, name) });
        }
      }
    }
  }

  for (const dependency of newDependencies) {
    if (!scope.grantedDependencies.has(normalizeDependencyName(dependency.name))) {
      flag({ rule: 'dependency-ungranted', file: dependency.file, line: dependency.line, detail: `new ${dependency.ecosystem} dependency ${dependency.name} has no recorded grant` });
    }
    const status = await lookup({ ecosystem: dependency.ecosystem, name: dependency.name, repo });
    if (status === 'missing') {
      flag({ rule: 'dependency-unknown', file: dependency.file, line: dependency.line, detail: `${dependency.name} was not found by the ${dependency.ecosystem} registry lookup` });
    } else if (status !== 'found') {
      flag({ rule: 'dependency-unknown', file: dependency.file, line: dependency.line, detail: `could not confirm ${dependency.name} exists (${dependency.ecosystem} lookup unavailable or offline)`, severity: 'warn' });
    }
  }

  if (literalCandidates.length > 0) {
    const expectations = await expectationLiterals(repo, head, settings.globs);
    for (const candidate of literalCandidates) {
      const existing = extractLiterals(candidate.baseText);
      for (const line of candidate.added) {
        const copied = [...extractLiterals(line.text)].find((literal) => expectations.has(literal) && !existing.has(literal));
        if (copied !== undefined) {
          flag({
            rule: 'test-literal-in-source',
            file: candidate.file.path,
            line: line.line,
            detail: `literal ${JSON.stringify(copied)} also appears in a test expectation; check for special-casing`,
            severity: 'warn',
          });
        }
      }
    }
  }

  flags.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule));
  return { pass: !flags.some((entry) => entry.severity === 'block'), flags };
}

function checkPackageGateKeys({ file, headText, baseText, flag }) {
  let headJson;
  let baseJson;
  try {
    headJson = headText ? JSON.parse(headText) : {};
    baseJson = baseText ? JSON.parse(baseText) : {};
  } catch {
    return;
  }
  const scriptKeys = new Set([...Object.keys(headJson.scripts ?? {}), ...Object.keys(baseJson.scripts ?? {})]);
  for (const key of scriptKeys) {
    if (!GATE_SCRIPT_KEY.test(key)) continue;
    if ((headJson.scripts ?? {})[key] !== (baseJson.scripts ?? {})[key]) {
      flag({ rule: 'gate-config-edit', file: file.path, line: lineOf(headText || baseText, `"${key}"`), detail: `the "${key}" script changed` });
    }
  }
  for (const key of GATE_PACKAGE_KEYS) {
    if (JSON.stringify(headJson[key]) !== JSON.stringify(baseJson[key])) {
      flag({ rule: 'gate-config-edit', file: file.path, line: lineOf(headText || baseText, `"${key}"`), detail: `the "${key}" tool config changed` });
    }
  }
}

function sectionAt(lines, lineNumber) {
  for (let index = Math.min(lineNumber, lines.length) - 1; index >= 0; index -= 1) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[index]);
    if (header) return header[1].trim();
  }
  return '';
}

function checkPyprojectGateSections({ file, headText, baseText, flag }) {
  const headLines = headText.split('\n');
  const baseLines = baseText.split('\n');
  const touched = [
    ...addedLines(file).map((line) => ({ line: line.line, section: sectionAt(headLines, line.line) })),
    ...removedLines(file).map((line) => ({ line: line.line, section: sectionAt(baseLines, line.line) })),
  ];
  const hit = touched.find((entry) => PYPROJECT_GATE_SECTION.test(entry.section));
  if (hit) flag({ rule: 'gate-config-edit', file: file.path, line: hit.line, detail: `[${hit.section}] changed` });
}

async function expectationLiterals(repo, head, globs) {
  const tree = (await git(repo, ['ls-tree', '-r', '--name-only', head])) ?? '';
  const testFiles = tree
    .split('\n')
    .filter((filePath) => filePath && classify(filePath, globs) === 'test' && ecosystemOf(filePath))
    .slice(0, MAX_TEST_FILES_FOR_LITERALS);
  const literals = new Set();
  for (let start = 0; start < testFiles.length; start += GREP_CHUNK) {
    const chunk = testFiles.slice(start, start + GREP_CHUNK).map((filePath) => `:(literal)${filePath}`);
    const output = (await git(repo, ['grep', '-h', '-I', '-i', '-E', ASSERTION_GREP, head, '--', ...chunk], { allowFailure: true })) ?? '';
    for (const line of output.split('\n')) {
      if (line === '' || IMPORT_LINE.test(line)) continue;
      for (const literal of extractLiterals(line)) literals.add(literal);
    }
  }
  return literals;
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = 'usage: node integrity.mjs --base <sha> --head <sha> --item <item.json> [--repo <dir>] [--json] [--no-lookup]';

function parseArguments(argv) {
  const options = { repo: process.cwd(), json: false, lookup: true };
  const valueFlags = { '--base': 'base', '--head': 'head', '--item': 'item', '--repo': 'repo' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument in valueFlags) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new IntegrityUsageError(`${argument} needs a value`);
      options[valueFlags[argument]] = value;
      index += 1;
    } else if (argument === '--json') options.json = true;
    else if (argument === '--no-lookup') options.lookup = false;
    else throw new IntegrityUsageError(`unknown argument ${argument}`);
  }
  for (const required of ['base', 'head', 'item']) {
    if (!options[required]) throw new IntegrityUsageError(`--${required} is required`);
  }
  return options;
}

export async function loadBaseConfig(repo, base) {
  const text = await showFile(repo, base, CONFIG_PATH);
  let local = null;
  // A tracked base file is not ignored by Git; never trust its mutable checkout as local policy.
  const ignored = await git(repo, ['check-ignore', '-q', CONFIG_PATH], { allowFailure: true });
  if (ignored !== null) {
    try { local = await readFile(path.join(repo, CONFIG_PATH), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new IntegrityUsageError(`cannot read local ${CONFIG_PATH}`); }
  }
  const combined = {};
  for (const [source, content] of [['base', text], ['local', local]]) {
    if (content === null) continue;
    let raw;
    try { raw = JSON.parse(content); }
    catch { throw new IntegrityUsageError(`${CONFIG_PATH} at ${source} is not valid JSON`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IntegrityUsageError(`${CONFIG_PATH} at ${source} must be an object`);
    // Local policy may add rules, never remove the base policy or built-in floors.
    for (const key of Object.keys(CONFIG_GLOB_KEYS)) {
      if (raw[key] !== undefined) {
        if (!Array.isArray(raw[key])) throw new IntegrityUsageError(`${CONFIG_PATH} ${key} must be an array`);
        combined[key] = [...(combined[key] ?? []), ...raw[key]];
      }
    }
    if (raw.patterns !== undefined) {
      if (!raw.patterns || typeof raw.patterns !== 'object' || Array.isArray(raw.patterns)) throw new IntegrityUsageError(`${CONFIG_PATH} patterns must be an object`);
      combined.patterns ??= {};
      for (const [rule, patterns] of Object.entries(raw.patterns)) {
        if (!Array.isArray(patterns)) throw new IntegrityUsageError(`${CONFIG_PATH} patterns.${rule} must be an array`);
        combined.patterns[rule] = [...(combined.patterns[rule] ?? []), ...patterns];
      }
    }
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in CONFIG_GLOB_KEYS) && key !== 'patterns') combined[key] = value;
    }
  }
  return combined;
}

export function formatFlags(result) {
  if (result.flags.length === 0) return '[INTEGRITY]: no flags';
  const lines = result.flags.map((entry) => `${entry.severity.toUpperCase()} ${entry.rule} ${entry.file}:${entry.line} ${entry.detail}`);
  const blocking = result.flags.filter((entry) => entry.severity === 'block').length;
  lines.push(`[INTEGRITY]: ${blocking} blocking flag(s), ${result.flags.length - blocking} warning(s)`);
  return lines.join('\n');
}

export async function main(argv, { lookup } = {}) {
  let options;
  try {
    options = parseArguments(argv);
    const repo = path.resolve(options.repo);
    let item;
    try {
      item = JSON.parse(await readFile(path.resolve(options.item), 'utf8'));
    } catch (error) {
      throw new IntegrityUsageError(`cannot read item file ${options.item}: ${error.message}`);
    }
    const base = await resolveCommit(repo, options.base);
    const config = await loadBaseConfig(repo, base);
    const result = await scanDiff({
      repo,
      baseSha: base,
      headSha: options.head,
      item,
      config,
      lookup: lookup ?? (options.lookup ? defaultLookup : async () => 'unavailable'),
    });
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : formatFlags(result)}\n`);
    return result.pass ? EXIT.ok : EXIT.flagged;
  } catch (error) {
    if (error instanceof IntegrityUsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      return EXIT.usage;
    }
    throw error;
  }
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const { stdinArgs } = await import('./stdin-args.mjs');
  process.exitCode = await main(stdinArgs(process.argv.slice(2)));
}
