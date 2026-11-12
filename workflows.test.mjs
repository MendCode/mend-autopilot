// Runs the adapters' workflow scripts end to end on synthetic git repositories. The MendCode workflow
// API is replaced by a harness: agent() and ask() follow a scripted scenario, while check() runs the
// real commands from a separate clean clone without .mend/, so every core CLI and every card
// check is exercised for real. What this cannot show: MendCode's own agent sessions, model replies,
// approvals and the exact text check() returns in the product.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSchema } from './core/checks/json-schema.mjs';
import { captureEvidence } from './core/checks/test-support.mjs';
import { critiqueContract } from './core/checks/critic-reply.mjs';
import { snapshot as approvalSnapshot } from './core/checks/approval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'mend-workflows-suite-')));
after(() => fs.rm(ROOT, { recursive: true, force: true }));
const PKG = path.join(ROOT, 'installed packages', 'mend-autopilot-codex'.padEnd(Math.max(20, 80 - ROOT.length - 20), '-'));
await fs.cp(path.join(HERE, 'core'), PKG, { recursive: true });
const WORKFLOWS = path.join(HERE, 'core', 'workflows');
const GENERIC_CATEGORIES = await critiqueContract([{ kind: 'generic', critiqueLens: path.join(PKG, 'profiles/generic/critique-lens.md') }]);
const MIGRATION_CATEGORIES = await critiqueContract([{ kind: 'schema-migration', critiqueLens: path.join(PKG, 'profiles/schema-migration/critique-lens.md') }]);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const AsyncFunction = (async () => {}).constructor;
const API = ['args', 'agent', 'check', 'ask', 'phase', 'log', 'memo', 'sleep', 'parallel', 'pipeline', 'merge'];

function sh(cwd, command) {
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// The host's check detail starts with an exit line; tests that rewrite a result read only the command output.
const hostOutput = (detail) => String(detail).replace(/^exit -?\d+\n/, '');

// Deliberately independent of workflow quoting: this is the host's grammar, not a shell.
function checkArgv(command) {
  assert.equal(typeof command, 'string');
  assert.ok(command.length <= 300, 'check command exceeds 300 characters');
  assert.doesNotMatch(command, /[;&|<>`$\\\n\r]/, 'check forbids shell metacharacters even inside quotes');
  const argv = [];
  let word = '', quote = null, started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === ' ') {
      if (started) argv.push(word);
      word = ''; started = false;
    } else { word += char; started = true; }
  }
  assert.equal(quote, null, 'unterminated quote');
  if (started) argv.push(word);
  assert.ok(argv.length, 'empty command');
  assert.doesNotMatch(argv[0], /^[A-Za-z_][A-Za-z0-9_]*=/, 'environment prefixes are not programs');
  return argv;
}

const inputArgs = (options) => JSON.parse(options.stdin).args;
const hostData = (options) => JSON.parse(inputArgs(options)[1]);
const isHost = (command, options, operation) => command.includes('/workflow-host.mjs') && inputArgs(options)[0] === operation;
const isGrowthDiff = (command, options) => isHost(command, options, 'git') && hostData(options).args.includes('--unified=0');

test('check grammar groups and glues quotes, has no escapes and treats glob characters literally', () => {
  assert.deepEqual(checkArgv(`node a"b c"d '"' "'" '' {} [] * ? ~ #`), ['node', 'ab cd', '"', "'", '', '{}', '[]', '*', '?', '~', '#']);
  assert.deepEqual(checkArgv('node ' + 'x'.repeat(295)), ['node', 'x'.repeat(295)]);
  assert.throws(() => checkArgv('node ' + 'x'.repeat(296)));
  for (const char of [';', '&', '|', '<', '>', '`', '$', '\\', '\n', '\r']) {
    for (const quote of ['', "'", '"']) assert.throws(() => checkArgv(`node ${quote}${char}${quote}`));
  }
  for (const command of ['FOO=1 node', "'FOO=1' node", 'node "open', "node 'open", '   ']) assert.throws(() => checkArgv(command));
});

test('every workflow command builder obeys check grammar with large hostile payloads', async () => {
  for (const name of ['mend-quality', 'mend-pr', 'mend-lite', 'mend-lite-pr']) {
    const source = await fs.readFile(path.join(WORKFLOWS, name + '.js'), 'utf8');
    // All host commands pass through these builders and the single checked dispatch.
    assert.equal([...source.matchAll(/await check\(/g)].length, 1);
    assert.match(source, /await check\(command, \{ stdin \}\)/);
    assert.doesNotMatch(source, /run\("|runInWorktree\("|inWorktree\("|node -e|MEND_REVIEW_POLICY=/);
    const builders = source.slice(source.indexOf('const quote ='), source.indexOf(name.startsWith('mend-lite') ? '\nfunction jsonOutput' : '\nfunction lastJsonLine'));
    const scripts = new Set([...source.matchAll(/tool\("([^"\n]+)"/g)].map((match) => match[1]));
    assert.ok(scripts.size >= 5);
    for (const pkg of [PKG, PKG + `/both'" quotes`]) {
      // mend-quality aliases JSON.stringify as js above the builders.
      const make = new Function('pkg', 'const js = JSON.stringify;\n' + builders + '\nreturn tool;')(pkg);
      for (const script of scripts) {
        const args = ['x'.repeat(200_000), '\n; & | < > ` $ \\ " \' {} [] * ? ~ #'];
        const built = make(script, args, args.join('\n'));
        assert.deepEqual(checkArgv(built.command), ['node', pkg + '/checks/' + script, '--stdin']);
        assert.deepEqual(JSON.parse(built.stdin).args, args);
        assert.equal(JSON.parse(built.stdin).text, args.join('\n'));
      }
    }
  }
});

function loadWorkflow(name) {
  const source = readFileSync(path.join(WORKFLOWS, `${name}.js`), 'utf8');
  const limit = name === 'mend-quality' ? 44_000 : 48 * 1024;
  assert.ok(Buffer.byteLength(source) < limit, `${name} must stay below ${limit} bytes`);
  assert.match(source, /^export const meta = \{/, 'the first statement must be the literal meta');
  // The workflow host refuses import and require; only this suite's AsyncFunction would allow them.
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, `${name} must not load modules; run them through a check script`);
  return new AsyncFunction(...API, source.replace(/^export const meta =/m, 'const meta ='));
}

async function makeRepo({ itemId = 'tidy-total', item = {} } = {}) {
  const repo = await fs.mkdtemp(path.join(ROOT, 'repo space-'));
  sh(repo, 'git init -q -b main');
  await fs.mkdir(path.join(repo, 'src'));
  await fs.writeFile(path.join(repo, '.gitignore'), '.mend/\n');
  await fs.writeFile(path.join(repo, 'src', 'total.js'), 'export const total = (a, b) => a + b + 0;\n');
  await fs.writeFile(path.join(repo, 'src', 'reference.js'), 'export const sum = (a, b) => a + b;\n');
  sh(repo, 'git add -A && git commit -q -m base');
  const itemPath = `.mend/items/${itemId}.json`;
  await fs.mkdir(path.join(repo, '.mend', 'items'), { recursive: true });
  const fullItem = {
    id: itemId,
    type: 'change',
    goal: 'total returns the sum without the redundant zero',
    acceptance: ['total(2, 3) is 5', 'no other file changes'],
    profiles: [],
    editSet: ['src/total.js'],
    checks: ['test -f src/total.js'],
    risk: 'low',
    ...item,
  };
  await fs.writeFile(path.join(repo, itemPath), JSON.stringify(fullItem));
  const skill = '.mendcode/skills/verify-fixture/SKILL.md';
  await fs.mkdir(path.dirname(path.join(repo, skill)), { recursive: true });
  await fs.writeFile(path.join(repo, skill), '# Fixture verification\nRun the file check.\n');
  sh(repo, 'git add .mendcode && git commit -q -m "verification skill"');
  await fs.mkdir(path.join(repo, '.mend/evidence'), { recursive: true });
  await fs.writeFile(path.join(repo, '.mend/evidence/verify.json'), JSON.stringify({
    skill, result: 'PASS', profiles: { generic: 'PASS' }, evidenceSurvivedCleanup: true,
    steps: [{ name: 'file-check', command: 'test -f src/total.js', exit: 0 }],
  }));
  await fs.mkdir(path.join(repo, '.mend/exemplars/generic'), { recursive: true });
  await fs.writeFile(path.join(repo, '.mend/exemplars/generic/helper.md'), '# Helper reference\n');
  await fs.writeFile(path.join(repo, '.mend/exemplars/index.json'), JSON.stringify([
    { profile: 'generic', id: 'helper', file: '.mend/exemplars/generic/helper.md', approved: false },
  ]));
  // Model the host's detached workspace: tracked files only, outside the user's repository.
  const checkCwd = await fs.mkdtemp(path.join(ROOT, 'check scratch-'));
  const cloned = spawnSync('git', ['clone', '--quiet', '--no-local', repo, checkCwd], { cwd: ROOT, env: GIT_ENV, encoding: 'utf8' });
  assert.ifError(cloned.error);
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.equal(existsSync(path.join(checkCwd, '.mend')), false);
  // Diverge the scratch checkout so a tool that reads files or runs git from its working directory gets different answers.
  await fs.appendFile(path.join(checkCwd, 'src/total.js'), '\n// scratch checkout, not the user repository\n');
  const diverged = sh(checkCwd, 'git commit -q -am "scratch divergence"');
  assert.equal(diverged.status, 0, diverged.out);
  return { repo, checkCwd, itemPath, itemId, worktree: path.join(repo, '.mend', 'worktrees', itemId) };
}

async function prepareProfile(setup, kind) {
  const verifyPath = path.join(setup.repo, '.mend/evidence/verify.json');
  const verify = JSON.parse(await fs.readFile(verifyPath, 'utf8'));
  verify.profiles[kind] = 'PASS';
  await fs.writeFile(verifyPath, JSON.stringify(verify));
  const indexPath = path.join(setup.repo, '.mend/exemplars/index.json');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const exemplar = `.mend/exemplars/${kind}/reference.md`;
  await fs.mkdir(path.dirname(path.join(setup.repo, exemplar)), { recursive: true });
  await fs.writeFile(path.join(setup.repo, exemplar), '# Profile reference\n');
  index.push({ profile: kind, id: 'reference', file: exemplar, approved: false });
  await fs.writeFile(indexPath, JSON.stringify(index));
}

function criticReply({ head, anchor = 8, base = 7, findings = [], resolved = [], gaming = 'no', vsBase = 'better', vsAnchor = 'same' }) {
  return [
    'scores:',
    '| category | base | head | sum-helper |',
    '|---|---|---|---|',
    ...GENERIC_CATEGORIES.map((category) => `| ${category} | ${base} | ${head} | ${anchor} |`),
    '',
    ...GENERIC_CATEGORIES.map((category) => `vs: ${category} base=${vsBase} sum-helper=${vsAnchor} - The helper implements the requested sum and its check exercises the reported behavior.`),
    `gaming: ${gaming} - looked at the tests and the checks`,
    'findings:',
    ...findings.map((finding) => `- ${finding} src/total.js:1: synthetic issue -> synthetic fix`),
    `resolved: ${resolved.length ? resolved.join(', ') : 'none'}`,
    'still-open:',
    'cut:',
    'brief: none',
  ].join('\n');
}

/** A scripted owner: each call applies the next edit in the worktree, commits it and reports. */
function ownerSteps(steps) {
  let call = 0;
  return async ({ worktree, itemId }) => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    for (const [file, content] of Object.entries(step.files ?? {})) {
      await fs.mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
      if (content === null) await fs.rm(path.join(worktree, file), { force: true });
      else await fs.writeFile(path.join(worktree, file), content);
    }
    const log = `.mend/evidence/${itemId}/owner-check.log`;
    sh(worktree, `mkdir -p .mend/evidence/${itemId} && { echo "$ test -f src/total.js"; test -f src/total.js; echo "exit: $?"; } > ${log} 2>&1`);
    sh(worktree, `git add -A && git commit -q --allow-empty -m "step ${call}"`);
    const report = {
      exemplars: step.exemplars ?? [{ label: 'sum-helper', path: 'src/reference.js', took: 'one expression per helper' }],
      commands: [{ name: 'owner-check', command: 'test -f src/total.js', log }],
      proposals: step.proposals ?? [],
      profileEvidence: step.profileEvidence ?? {},
      disputes: step.disputes ?? [],
      card: {
        problem: step.card?.problem ?? 'total adds a redundant zero that hides the real expression',
        drivenPath: { steps: ['ran the file check'], artifacts: [log] },
        proof: { changeType: 'refactor', artifacts: [log] },
        notVerified: ['callers outside this repository'],
        notChanged: ['the exported name stays total'],
        uncertain: ['none'],
        rollback: 'revert the merge commit',
        riskRule: 'one pure helper inside one module',
        ...(step.card ?? {}),
      },
    };
    return { text: `## Owner report\n${JSON.stringify(report)}\n## Notes\nDone.\n{\"unrelated\":true}`, taskId: `owner-task-${call}` };
  };
}

const DEFAULT_SPEC = 'Remove the redundant zero from total; keep the exported name and its callers; test total(2, 3) is 5.';

function harness({ repo, checkCwd, itemId, worktree, owner, critic, answers = [], restate, auditor, supervisor, spec = { spec: DEFAULT_SPEC } }) {
  assert.ok(path.isAbsolute(checkCwd) && !checkCwd.startsWith(repo + path.sep) && checkCwd !== repo);
  const calls = { agents: [], asks: [], phases: [], checks: [], inputs: [] };
  const queue = [...answers];
  let critiques = 0;
  const api = {
    repo,
    agent: async (prompt, options = {}) => {
      // The host rejects any agent option outside this list.
      const allowed = ['label', 'phase', 'schema', 'mode', 'worktree', 'model', 'effort', 'engine', 'agent', 'retry', 'timeoutMinutes', 'budget', 'detail', 'allowedTools'];
      for (const key of Object.keys(options)) assert.ok(allowed.includes(key), `unknown agent option "${key}"`);
      calls.agents.push({ label: options.label, mode: options.mode, model: options.model, engine: options.engine, allowedTools: options.allowedTools, prompt });
      const label = String(options.label ?? '');
      if (label.startsWith('spec')) return spec;
      if (label.startsWith('restate')) return restate ?? { goal: 'drop the zero', finish: 'total(2, 3) is 5', files: ['src/total.js'] };
      if (label.startsWith('supervise')) return supervisor ?? { approved: true, restatementMatches: true, reason: 'The plan removes only the redundant zero and preserves the exported helper.' };
      if (label.startsWith('owner') || label.startsWith('proposal')) return owner({ worktree, itemId, prompt });
      if (label.startsWith('critique')) {
        critiques += 1;
        return critic(critiques, prompt);
      }
      if (label.startsWith('audit')) {
        const reply = auditor ?? { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran the item check at head' }, { lane: 'driven-path', result: 'PASS', method: 'drove the recorded path at head' }], notVerified: ['production data'] };
        // As the host does (script-engine.ts): with detail, the validated object is value and text is the agent's prose.
        return options.detail ? { value: reply, text: 'Sin defectos; los checks pasan.', ...(reply.noSession ? {} : { taskId: 'audit-task-1' }) } : reply;
      }
      throw new Error(`unexpected agent ${label}`);
    },
    check: async (command, options = {}) => {
      const [program, ...argv] = checkArgv(command);
      assert.equal(program, 'node');
      assert.ok(argv[0].startsWith(ROOT + path.sep) && /\/checks\/[a-z-]+\.mjs$/.test(argv[0]));
      assert.deepEqual(argv.slice(1), ['--stdin']);
      assert.equal(typeof options.stdin, 'string');
      assert.ok(Buffer.byteLength(options.stdin) <= 1024 * 1024, 'stdin exceeds 1 MB');
      if (command.includes('/workflow-host.mjs')) {
        const data = hostData(options);
        if (data.cwd !== undefined) assert.ok(path.isAbsolute(data.cwd), 'host cwd must be absolute');
        if (data.file !== undefined) assert.ok(path.isAbsolute(data.file) || path.isAbsolute(data.cwd ?? ''), 'host file needs an absolute path or cwd');
        else assert.ok(path.isAbsolute(data.cwd ?? ''), 'host operation needs an absolute cwd');
      }
      const toolArgs = inputArgs(options);
      for (const flag of ['--repo', '--item', '--review-card']) {
        const index = toolArgs.indexOf(flag);
        if (index >= 0) assert.ok(path.isAbsolute(toolArgs[index + 1]), `${flag} must be absolute`);
      }
      if (command.includes('/write-file.mjs')) assert.ok(path.isAbsolute(toolArgs[0]), 'writer path must be absolute');
      calls.checks.push(command);
      calls.inputs.push({ command, ...options });
      assert.equal(existsSync(path.join(checkCwd, '.mend')), false, 'check workspace must not contain runtime state');
      const result = spawnSync(program, argv, { cwd: checkCwd, env: { ...GIT_ENV, CI: '1', TERM: 'dumb' }, input: options.stdin, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      assert.ifError(result.error);
      assert.equal(existsSync(path.join(checkCwd, '.mend')), false, 'workflow wrote runtime state into the check workspace');
      // Same shape as the host: an exit line, then the command's combined output.
      // Like the host: an empty output yields a bare "exit N" without a trailing newline.
      const output = `${result.stdout}${result.stderr}`;
      return { ok: result.status === 0, detail: output ? `exit ${result.status}\n${output}` : `exit ${result.status}` };
    },
    ask: async (question, options) => {
      calls.asks.push({ question, options });
      if (queue.length === 0) throw new Error(`unexpected question: ${question}`);
      return queue.shift();
    },
    phase: (title) => calls.phases.push(title),
    log: () => {},
    memo: async (_key, fn) => fn(),
    sleep: async () => {},
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async () => {
      throw new Error('pipeline is not used by these workflows');
    },
    merge: async () => {
      throw new Error('merge is not used by these workflows');
    },
  };
  return { api, calls };
}

async function runWorkflow(name, runArgs, api) {
  const body = loadWorkflow(name);
  return body({ repo: api.repo, ...runArgs }, api.agent, api.check, api.ask, api.phase, api.log, api.memo, api.sleep, api.parallel, api.pipeline, api.merge);
}

const CARD_SCHEMA = JSON.parse(readFileSync(path.join(PKG, 'skills', 'mend-ship', 'evidence-card.schema.json'), 'utf8'));

/** Every card a workflow writes must be a valid card, whatever its state. */
function readValidCard(file) {
  const card = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(validateSchema(CARD_SCHEMA, card), [], `card ${file} does not match the schema`);
  return card;
}

const CRITIC = 'strong-test-model';
const FIXED = { files: { 'src/total.js': 'export const total = (a, b) => a + b;\n' } };

describe('workflow repository paths', () => {
  for (const name of ['mend-quality', 'mend-pr']) {
    for (const repo of [undefined, '', '   ', '.', 'relative/repo']) {
      test(`${name} refuses ${JSON.stringify(repo)} repo before host operations`, async () => {
        const setup = await makeRepo();
        const { api, calls } = harness(setup);
        const result = await runWorkflow(name, { repo, item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
        assert.equal(result.state, 'blocked');
        assert.match(result.reason, repo?.trim() ? /repo must be an absolute path/ : /argument repo is required/);
        assert.equal(calls.checks.length, 0);
        assert.equal(calls.agents.length, 0);
      });
    }
    test(`${name} refuses an absolute path outside a git repository`, async () => {
      const setup = await makeRepo();
      const { api, calls } = harness(setup);
      const result = await runWorkflow(name, { repo: ROOT, item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /could not resolve the repository root from argument repo/);
      assert.equal(calls.checks.length, 1);
      assert.equal(calls.agents.length, 0);
    });
  }

  for (const absoluteItem of [false, true]) {
    test(`quality and delivery resolve ${absoluteItem ? 'absolute' : 'relative'} item and relative pkg from repo`, async () => {
      const setup = await makeRepo();
      // Passing a subdirectory proves Git discovers the real root from repo, not check's cwd.
      const repo = path.join(setup.repo, 'src');
      const item = absoluteItem ? path.join(setup.repo, setup.itemPath) : '../' + setup.itemPath;
      const pkg = path.relative(repo, PKG);
      const qualityHarness = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
      const quality = await runWorkflow('mend-quality', { repo, item, pkg, critic: CRITIC }, qualityHarness.api);
      assert.equal(quality.state, 'critiqued', quality.reason);
      assert.equal(quality.worktree, setup.worktree);
      assert.ok(path.isAbsolute(quality.itemPath));
      assert.equal(await fs.realpath(quality.itemPath), path.join(setup.repo, setup.itemPath));
      const delivery = harness(setup);
      const result = await runWorkflow('mend-pr', { repo, item, pkg }, delivery.api);
      assert.equal(result.state, 'merge-ready', JSON.stringify(result));
      assert.equal(readValidCard(result.card).headSha, quality.headSha);
      assert.equal(existsSync(path.join(setup.repo, '.mend/approvals', setup.itemId + '.json')), true);
      assert.equal(existsSync(path.join(setup.checkCwd, '.mend')), false);
      const status = sh(setup.checkCwd, 'git status --porcelain --untracked-files=all');
      assert.equal(status.status, 0, status.out);
      assert.equal(status.out, '');
    });
  }
});

describe('mend-quality', () => {
  for (const failure of [
    { command: `node -e 'require("node:assert/strict").equal(2, 3, "neighbor assertion")'`, detail: /neighbor assertion/ },
    { command: `node -e 'require("./missing-fixture-module.cjs")'`, detail: /Cannot find module/ },
  ]) {
    test(`full verification returns the actual failure: ${failure.command}`, async () => {
      const setup = await makeRepo();
      const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      record.steps.push({ name: 'neighbor', command: failure.command, exit: 0 });
      record.steps.push({ name: 'after-failure', command: 'test -d src', exit: 0 });
      await fs.writeFile(recordPath, JSON.stringify(record));
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft', result.reason);
      assert.deepEqual(result.rejectedBy, ['rubric', 'rubric']);
      assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
      const retry = calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`);
      assert.match(retry.prompt, failure.detail);
      assert.match(retry.prompt, /Full verification failed/);
      const log = await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/verify-r1-2.log`), 'utf8');
      assert.match(log, failure.detail);
      assert.match(log, /exit: 1/);
      const laterLog = await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/verify-r1-3.log`), 'utf8');
      assert.match(laterLog, /exit: 0/);
    });
  }

  test('verification-record commands go through the guard before running', async () => {
    const setup = await makeRepo();
    const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.steps.push({ name: 'forbidden', command: 'git push --force origin main', exit: 0 });
    await fs.writeFile(recordPath, JSON.stringify(record));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /git-force/);
    assert.equal(calls.inputs.some(({ command, ...options }) => isHost(command, options, 'execute') && hostData(options).command.includes('git push')), false);
  });

  for (const generated of [false, true]) {
    test(`verification ${generated ? 'caches are excluded' : 'source edits block critique'}`, async () => {
      const setup = await makeRepo();
      const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      record.steps.push({ name: 'output', command: generated
        ? 'mkdir -p cache/__pycache__ && printf cache > cache/build.tsbuildinfo && printf bytecode > cache/__pycache__/helper.pyc'
        : 'printf changed > src/total.js', exit: 0 });
      await fs.writeFile(recordPath, JSON.stringify(record));
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, generated ? 'critiqued' : 'blocked', result.reason);
      assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), generated);
      if (!generated) assert.match(result.reason, /verification changed the reviewed head or authored files/);
    });
  }

  for (const steps of [undefined, [], [{ command: 'test -d src', exit: 1 }], [{ command: '', exit: 0 }]]) {
    test(`incomplete verification command record blocks: ${JSON.stringify(steps)}`, async () => {
      const setup = await makeRepo();
      const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      record.steps = steps;
      await fs.writeFile(recordPath, JSON.stringify(record));
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.equal(calls.agents.length, 0);
    });
  }

  test('committed verification artifacts do not consume the file cap or reach critique', async () => {
    const setup = await makeRepo();
    const artifacts = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`cache/${index}.tsbuildinfo`, 'synthetic cache\n']));
    artifacts['cache/__pycache__/helper.pyc'] = 'synthetic bytecode\n';
    const { api, calls } = harness({ ...setup, owner: ownerSteps([{ files: { ...FIXED.files, ...artifacts } }]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    const prompt = calls.agents.find((call) => call.label.startsWith('critique')).prompt;
    const line = prompt.split('\n').find((entry) => entry.startsWith('Read the full diff'));
    const command = line.split(': git diff ')[1];
    assert.ok(command);
    const reviewed = sh(setup.worktree, `git diff ${command}`);
    assert.equal(reviewed.status, 0, reviewed.out);
    assert.match(reviewed.out, /src\/total.js/);
    assert.doesNotMatch(reviewed.out, /tsbuildinfo|__pycache__/);
    // The read-only critic gets the same diff as a file it can open without a shell.
    const file = line.match(/ in (\S+\.patch) inside the worktree/)[1];
    assert.equal(readFileSync(path.join(setup.worktree, file), 'utf8'), sh(setup.worktree, `git diff --no-color --no-ext-diff ${command}`).out);
    assert.equal(result.checkResults.integrity.pass, true);
  });

  test('a configured growth factor permits a round below its limit', async () => {
    const setup = await makeRepo();
    await fs.writeFile(path.join(setup.repo, '.mend/quality.json'), JSON.stringify({ critique: { growthFactor: 4 } }));
    const larger = { files: { 'src/total.js': 'export const total = (a, b) => {\n  const sum = a + b;\n  const copy = sum;\n  const result = copy;\n  return result;\n};\n' } };
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED, larger]), critic: (round) => criticReply({ head: round === 1 ? 6 : 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
  });

  for (const explained of [false, true]) {
    test(`diff growth ${explained ? 'with' : 'without'} an open finding`, async () => {
      const setup = await makeRepo();
      const larger = { files: { 'src/total.js': 'export const total = (a, b) => {\n  const sum = a + b;\n  const copy = sum;\n  const result = copy;\n  return result;\n};\n' } };
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED, larger]), critic: (round, prompt) => round === 1
        ? criticReply({ head: 6, findings: explained ? ['F1 [should]'] : [] }).replace('synthetic issue -> synthetic fix', 'The helper must expose explicit intermediate steps -> expand the expression into named sum, copy and result steps')
        : criticReply({ head: 8, resolved: explained ? ['F1'] : [] }) + '\ngrowth: ' + JSON.stringify({ hunks: JSON.parse(prompt.split('Growth evidence: ')[1]).hunks.map((hunk) => ({ hunk, finding: 'F1', reason: 'The changed return hunk expands the helper into the explicit intermediate steps required by F1.' })) }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      if (explained) {
        assert.equal(result.state, 'critiqued', result.reason);
        const prompt = calls.agents.filter((call) => call.label.startsWith('critique')).at(-1).prompt;
        assert.match(prompt, /critique-r1\.md/);
        assert.match(prompt, /An open finding alone is NOT an explanation/);
      }
      else { assert.equal(result.state, 'draft'); assert.match(result.reason, /unexplained diff growth/); }
    });
  }

  for (const explained of [false, true]) {
    test(`large growth diff stays local and ${explained ? 'accepts justified' : 'rejects unjustified'} hunks`, async () => {
      const setup = await makeRepo();
      const prose = 'ordinary explanatory prose '.repeat(100);
      const content = 'export const total = (a, b) => {\n'
        + Array.from({ length: 64 }, () => `  // Large diff transport fixture: ${prose}\n`).join('')
        + '  return a + b;\n};\n';
      assert.ok(Buffer.byteLength(content) > 128 * 1024);
      let reviewedGrowth = false;
      let diffBytes = 0;
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED, { files: { 'src/total.js': content } }]), critic: (round, prompt) => {
        if (round === 1) return criticReply({ head: 6, findings: ['F1 [should]'] });
        const growth = JSON.parse(prompt.split('Growth evidence: ')[1]);
        reviewedGrowth = true;
        assert.deepEqual(growth.hunks, ['diff --git a/src/total.js b/src/total.js\n@@ -1 +1,67 @@']);
        assert.ok(growth.logs.some((log) => log.endsWith('critique-r1.md')));
        assert.ok(growth.findings.some((finding) => finding.id === 'F1'));
        assert.equal(Object.hasOwn(growth, 'detail'), false);
        const hunks = explained ? growth.hunks.map((hunk) => ({ hunk, finding: 'F1', reason: 'The expanded explanation addresses F1.' })) : [];
        return criticReply({ head: 8, resolved: ['F1'] }) + '\ngrowth: ' + JSON.stringify({ hunks });
      } });
      const check = api.check;
      api.check = async (command, options) => {
        // Enforce the Linux argument ceiling on every platform, before spawning.
        assert.ok(Buffer.byteLength(command) < 128 * 1024, 'workflow sent an oversized shell argument');
        assert.ok(!command.includes(prose), 'diff body must not enter a CLI argument');
        const result = await check(command, options);
        if (isGrowthDiff(command, options)) {
          assert.equal(result.ok, true, result.detail);
          diffBytes = Buffer.byteLength(result.detail);
        }
        return result;
      };
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.ok(diffBytes > 128 * 1024, 'the workflow must inspect a real diff above the argument limit');
      assert.equal(reviewedGrowth, true);
      assert.equal(result.state, explained ? 'critiqued' : 'draft', result.reason);
      if (!explained) assert.match(result.reason, /unexplained diff growth/);
    });
  }

  test('growth with hunk headers above the argument limit reaches critique and rejects incomplete coverage', async () => {
    const setup = await makeRepo();
    const count = 3000;
    const sections = Array.from({ length: count }, (_, index) => `// Section ${index}\n// Unchanged separator ${index}\n`);
    const baseline = FIXED.files['src/total.js'] + sections.join('');
    await fs.writeFile(path.join(setup.repo, 'src/total.js'), baseline);
    assert.equal(sh(setup.repo, 'git add src/total.js && git commit -qm baseline').status, 0);
    const first = { files: { 'src/total.js': baseline.replace('a + b;', '(a + b);') } };
    const second = { files: { 'src/total.js': first.files['src/total.js'].replace(/\/\/ Section (\d+)/g, '// Explained section $1') } };
    let reviewed = false;
    let observedHunks;
    const { api } = harness({ ...setup, owner: ownerSteps([first, second]), critic: (round, prompt) => {
      if (round === 1) return criticReply({ head: 6, findings: ['F1 [should]'] });
      const growth = JSON.parse(prompt.split('Growth evidence: ')[1]);
      assert.deepEqual(growth.hunks, observedHunks);
      assert.equal(growth.hunks.length, count);
      assert.ok(Buffer.byteLength(JSON.stringify(growth.hunks)) > 128 * 1024);
      assert.ok(growth.logs.some((log) => log.endsWith('critique-r1.md')));
      assert.match(prompt, /An open finding alone is NOT an explanation/);
      reviewed = true;
      // A short, incomplete reply exercises local coverage validation.
      return criticReply({ head: 8, resolved: ['F1'] }) + '\ngrowth: ' + JSON.stringify({ hunks: [{ hunk: growth.hunks[0], finding: 'F1', reason: 'Only this section is justified.' }] });
    } });
    const check = api.check;
    api.check = async (command, options) => {
      assert.ok(Buffer.byteLength(command) < 128 * 1024, 'growth evidence must not enter a shell argument');
      const result = await check(command, options);
      if (isGrowthDiff(command, options)) {
        assert.equal(result.ok, true, result.detail);
        observedHunks = result.detail.split('\n').filter((line) => line.startsWith('@@ ')).map((line) => 'diff --git a/src/total.js b/src/total.js\n' + line);
      }
      return result;
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(reviewed, true);
    assert.equal(result.state, 'draft', result.reason);
    assert.match(result.reason, /unexplained diff growth/);
    assert.deepEqual(result.growth.hunks, observedHunks);
  });

  test('dispatch accepts and propagates a documented none exemplar entry', async () => {
    const setup = await makeRepo();
    const none = { profile: 'generic', none: 'No earlier example exists.', search: { paths: ['src', 'tests'], gitLogRange: 'HEAD' } };
    await fs.writeFile(path.join(setup.repo, '.mend/exemplars/index.json'), JSON.stringify([none]));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.ok(calls.agents.some((call) => call.label.startsWith('owner')), 'dispatch should reach the owner');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(setup.worktree, '.mend/exemplars/index.json'), 'utf8')), [none]);
  });

  for (const entries of [[], [{ profile: 'generic' }], [{ profile: 'generic', none: 'No example.', search: { paths: [], gitLogRange: 'HEAD' } }], [{ profile: 'generic', none: 'No example.', search: { paths: ['src'], gitLogRange: 'HEAD' } }, { profile: 'generic', file: '.mend/exemplars/generic/helper.md' }]]) {
    test(`dispatch rejects missing or invalid exemplar declarations: ${JSON.stringify(entries)}`, async () => {
      const setup = await makeRepo();
      await fs.writeFile(path.join(setup.repo, '.mend/exemplars/index.json'), JSON.stringify(entries));
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.equal(calls.agents.length, 0);
    });
  }

  test('selects the headed owner report and supplies product constraints to the critic', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(result.exemplars[0].label, 'sum-helper');
    const prompt = calls.agents.find((call) => call.label.startsWith('critique')).prompt;
    assert.match(prompt, /normal install without an extra service/);
    assert.match(prompt, /cut diff growth/);
  });

  for (const explanation of ['unrelated', 'missing', 'unknown-finding', 'empty-reason', 'wrong-hunk']) {
    test(`open should does not excuse diff growth with ${explanation} evidence`, async () => {
      const setup = await makeRepo();
      const larger = { files: { 'src/total.js': 'export const total = (a, b) => {\n  const sum = a + b;\n  const copy = sum;\n  const result = copy;\n  return result;\n};\n' } };
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED, larger]), critic: (round, prompt) => {
        if (round === 1) return criticReply({ head: 6, findings: ['F1 [should]'] }).replace('synthetic issue -> synthetic fix', 'The helper needs one explanatory comment -> add a comment only');
        const reply = criticReply({ head: 8, resolved: ['F1'] });
        if (explanation === 'missing') return reply;
        const growth = JSON.parse(prompt.split('Growth evidence: ')[1]);
        const hunks = explanation === 'unrelated' ? [] : growth.hunks.map((hunk) => ({
          hunk: explanation === 'wrong-hunk' ? 'not a changed hunk' : hunk,
          finding: explanation === 'unknown-finding' ? 'F999' : 'F1',
          reason: explanation === 'empty-reason' ? '' : 'synthetic explanation',
        }));
        return reply + '\ngrowth: ' + JSON.stringify({ hunks });
      } });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft', result.reason);
      assert.match(result.reason, /unexplained diff growth/);
      assert.ok(result.growth.findings.some((finding) => finding.id === 'F1'));
      assert.ok(result.growth.hunks.length > 0);
      assert.match(await fs.readFile(path.join(setup.worktree, result.log), 'utf8'), /resolved: F1/);
    });
  }

  test('JSON notes without a new heading cannot replace the owner report', async () => {
    const setup = await makeRepo();
    const worker = ownerSteps([FIXED]);
    const { api, calls } = harness({ ...setup, owner: async (context) => {
      const reply = await worker(context);
      reply.text = reply.text.replace('## Notes\n', 'Notes without a heading:\n') + '\n{"commands":[],"exemplars":[]}';
      return reply;
    }, critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(result.exemplars[0].label, 'sum-helper');
    assert.ok(result.commands.some((command) => command.name === 'owner-check'));
    const prompt = calls.agents.find((call) => call.label.startsWith('critique')).prompt;
    assert.match(prompt, /sum-helper/);
    assert.match(prompt, /owner-check/);
  });

  test('growth explanations must cover every changed hunk, not just a related one', async () => {
    const setup = await makeRepo();
    const baseline = 'export const total = (a, b) => a + b + 0;\n' + '\n'.repeat(6) + '// Existing footer\n';
    await fs.writeFile(path.join(setup.repo, 'src/total.js'), baseline);
    assert.equal(sh(setup.repo, 'git add src/total.js && git commit -qm baseline').status, 0);
    const first = { files: { 'src/total.js': baseline.replace(' + 0', '') } };
    const second = { files: { 'src/total.js': first.files['src/total.js'].replace('a + b;', '{\n  const sum = a + b;\n  return sum;\n};').replace('// Existing footer', '// Existing footer\n// Unrelated addition\n// More unrelated work') } };
    const { api } = harness({ ...setup, owner: ownerSteps([first, second]), critic: (round, prompt) => {
      if (round === 1) return criticReply({ head: 6, findings: ['F1 [should]'] });
      const growth = JSON.parse(prompt.split('Growth evidence: ')[1]);
      assert.ok(growth.hunks.length >= 2);
      return criticReply({ head: 8, resolved: ['F1'] }) + '\ngrowth: ' + JSON.stringify({ hunks: [{ hunk: growth.hunks[0], finding: 'F1', reason: 'Only the return hunk addresses F1; the footer is unrelated.' }] });
    } });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /unexplained diff growth/);
  });

  for (const configured of [false, true]) {
    test(`owner cannot hide out-of-scope changes by ${configured ? 'editing' : 'creating'} ignored review policy`, async () => {
      const setup = await makeRepo();
      if (configured) await fs.writeFile(path.join(setup.repo, '.mend/quality.json'), '{"generatedFiles":[]}');
      const worker = ownerSteps([{ files: { ...FIXED.files, 'src/outside.js': 'export const extra = 1;\n' } }]);
      const { api, calls } = harness({ ...setup, owner: async (context) => {
        const reply = await worker(context);
        await fs.writeFile(path.join(setup.worktree, '.mend/quality.json'), '{"generatedFiles":["src/outside.js"]}');
        return reply;
      }, critic: () => criticReply({ head: 8 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /review policy changed after capture/);
      assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
      assert.equal(calls.checks.some((command) => command.includes('/integrity.mjs')), false);
      const saved = JSON.parse(await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
      assert.ok(!saved.reviewPolicy.generatedFiles.includes('src/outside.js'));
      const retry = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
      const restarted = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, retry.api);
      assert.equal(restarted.state, 'blocked');
      assert.equal(retry.calls.agents.length, 0, 'a restart must not recapture the mutated policy');
    });
  }

  // Replace only the rubric run response; planning, integrity and critique still use the real harness.
  function rubricResponse(api, report) {
    const check = api.check;
    api.check = async (command, options) => command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'run'
      ? { ok: report.pass, detail: JSON.stringify(report) }
      : check(command, options);
  }

  for (const response of [
    { ok: true, detail: '{}' },
    { ok: false, detail: '{"pass":true,"flags":[]}' },
    { ok: true, detail: '{"pass":false,"flags":[]}' },
    { ok: false, detail: '{"pass":false,"flags":[{}]}' },
  ]) {
    test(`quality blocks invalid integrity before critique or approval: ${response.detail}`, async () => {
      const setup = await makeRepo({ item: { visual: true } });
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: ['approve', 'reviewer'] });
      const check = api.check;
      api.check = async (command, options) => command.includes('integrity.mjs') ? response : check(command, options);
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /integrity/i);
      assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
      assert.equal(calls.asks.some(({ question }) => /Approve (the proposal|the result)/i.test(question)), false);
    });
  }

  const loosening = { profile: 'ui', key: 'layoutTolerance', from: 0.08, to: 0.15, loosens: true };
  const rubricReport = (checksPass) => ({
    pass: false, checksPass, blocked: false, loosenings: [loosening],
    profiles: [{ kind: 'ui', rubric: { pass: checksPass, failures: checksPass ? [] : [{ rule: 'contrast', detail: 'synthetic failure' }] }, checks: [{ overrides: [loosening] }] }],
  });

  for (const answer of ['', '   ', null, undefined, false, 'no', ' No ']) {
    test(`gate loosening response ${JSON.stringify(answer)} sends exact rejected settings back`, async () => {
      const setup = await makeRepo();
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: [answer, answer] });
      rubricResponse(api, rubricReport(true));
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft');
      assert.ok(calls.asks.some(({ question }) => question.startsWith('Gate loosenings on ')));
      assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
      const retry = calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`);
      assert.match(retry.prompt, /denied/i);
      assert.ok(retry.prompt.includes(JSON.stringify(loosening)));
    });
  }

  test('gate loosening authorization records the exact settings and reaches the critic', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: ['synthetic justification'] });
    rubricResponse(api, rubricReport(true));
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    const sign = result.countersigns.find((entry) => entry.kind === 'gate-loosening');
    assert.deepEqual(JSON.parse(sign.subject), [loosening]);
    assert.equal(sign.reason, 'synthetic justification');
    assert.ok(calls.agents.find((call) => call.label.startsWith('critique')).prompt.includes(JSON.stringify(loosening)));
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`), 'utf8'));
    assert.deepEqual(stored.countersigns, result.countersigns);
  });

  test('a failed check cannot be countersigned into passing', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: ['would authorize'] });
    rubricResponse(api, rubricReport(false));
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.equal(calls.asks.length, 0);
    assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
    assert.match(calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`).prompt, /synthetic failure/);
  });

  test('rejects a tracked setup marker rather than skipping local configuration', async () => {
    const setup = await makeRepo();
    const mend = path.join(setup.repo, '.mend');
    await fs.writeFile(path.join(mend, 'setup-complete'), 'complete\n');
    assert.equal(sh(setup.repo, 'git add -f .mend/setup-complete && git commit -qm setup').status, 0);
    await fs.writeFile(path.join(mend, 'quality.json'), '{"ui":{"locale":"fr-FR"}}');
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /tracked setup marker/);
    assert.equal(calls.agents.length, 0);
  });

  test('preserves tracked setup files while copying missing local exemplars', async () => {
    const setup = await makeRepo();
    const mend = path.join(setup.repo, '.mend');
    await fs.mkdir(path.join(mend, 'exemplars'), { recursive: true });
    await fs.writeFile(path.join(mend, 'quality.json'), '{"marker":"base"}');
    await fs.writeFile(path.join(mend, 'exemplars', 'tracked.json'), 'base');
    assert.equal(sh(setup.repo, 'git add -f .mend/quality.json .mend/exemplars/tracked.json && git commit -qm setup').status, 0);
    await fs.writeFile(path.join(mend, 'exemplars', 'generic', 'local.json'), 'local');
    const index = JSON.parse(await fs.readFile(path.join(mend, 'exemplars', 'index.json'), 'utf8'));
    index.push({ profile: 'generic', id: 'local', file: '.mend/exemplars/generic/local.json', approved: false });
    await fs.writeFile(path.join(mend, 'exemplars', 'index.json'), JSON.stringify(index));
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(await fs.readFile(path.join(setup.worktree, '.mend/quality.json'), 'utf8'), '{"marker":"base"}');
    assert.equal(await fs.readFile(path.join(setup.worktree, '.mend/exemplars/tracked.json'), 'utf8'), 'base');
    assert.equal(await fs.readFile(path.join(setup.worktree, '.mend/exemplars/generic/local.json'), 'utf8'), 'local');
  });

  test('retries incomplete setup before dispatch after a copy failure', async () => {
    const setup = await makeRepo();
    const mend = path.join(setup.repo, '.mend');
    await fs.writeFile(path.join(mend, 'quality.json'), '{}');
    await fs.symlink('missing', path.join(mend, 'guard.json'));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const args = { item: setup.itemPath, pkg: PKG, critic: CRITIC };
    const first = await runWorkflow('mend-quality', args, api);
    assert.equal(first.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    await fs.unlink(path.join(mend, 'guard.json'));
    await fs.writeFile(path.join(mend, 'guard.json'), '{}');
    await runWorkflow('mend-quality', args, api);
    assert.equal(await fs.readFile(path.join(setup.worktree, '.mend/guard.json'), 'utf8'), '{}');
    assert.ok(calls.agents.some((call) => call.label.startsWith('restate')));
  });

  test('refuses a symlinked source .mend before creating a worktree', async () => {
    const setup = await makeRepo();
    const mend = path.join(setup.repo, '.mend');
    await fs.rename(mend, path.join(setup.repo, 'local-settings'));
    await fs.symlink('local-settings', mend);
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(existsSync(setup.worktree), false);
  });

  for (const scenario of [
    { name: 'missing verification', file: '.mend/evidence/verify.json', remove: true },
    { name: 'failed verification', file: '.mend/evidence/verify.json', value: { result: 'FAIL' } },
    { name: 'malformed verification', file: '.mend/evidence/verify.json', raw: '{' },
    { name: 'missing verification skill', file: '.mendcode/skills/verify-fixture/SKILL.md', remove: true },
    { name: 'blocked generic profile', file: '.mend/evidence/verify.json', value: { skill: '.mendcode/skills/verify-fixture/SKILL.md', result: 'PASS', profiles: { generic: 'BLOCKED: missing runner' } } },
    { name: 'missing exemplar set', file: '.mend/exemplars/index.json', value: [] },
    { name: 'missing exemplar artifact', file: '.mend/exemplars/generic/helper.md', remove: true },
    { name: 'investigate grant', file: '.mend/grants.json', value: { rung: 'investigate', queue: false } },
    { name: 'invalid grant', file: '.mend/grants.json', value: { rung: 'unknown' } },
    { name: 'malformed grant', file: '.mend/grants.json', raw: '{' },
    { name: 'investigate item', item: { type: 'investigate' } },
    { name: 'investigate item rung', item: { rung: 'investigate' } },
    { name: 'unsafe item id', item: { id: '../escape' } },
  ]) {
    test(`${scenario.name} blocks before a worktree or agent exists`, async () => {
      const setup = await makeRepo({ item: scenario.item });
      if (scenario.file) {
        const file = path.join(setup.repo, scenario.file);
        if (scenario.remove) await fs.rm(file);
        else await fs.writeFile(file, scenario.raw ?? JSON.stringify(scenario.value));
      }
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked', result.reason);
      assert.equal(calls.agents.length, 0);
      assert.equal(calls.inputs.some(({ command, ...options }) => isHost(command, options, 'git') && hostData(options).args[0] === 'worktree'), false);
      assert.equal(existsSync(setup.worktree), false);
      assert.equal(sh(setup.repo, 'git branch --list "mend/*"').out.trim(), '');
    });
  }

  test('a declared blocked profile cannot hide behind a passing generic profile', async () => {
    const setup = await makeRepo({ item: { profiles: ['ui'] } });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(existsSync(setup.worktree), false);
  });

  test('ignored team settings and indexed exemplars reach the worktree before dispatch, but unrelated files do not', async () => {
    const setup = await makeRepo();
    await fs.mkdir(path.join(setup.repo, '.mendcode/skills/verify-fixture/features'));
    await fs.writeFile(path.join(setup.repo, '.mendcode/skills/verify-fixture/features/README.md'), '# Feature map\n');
    sh(setup.repo, 'git add .mendcode && git commit -q -m "verification feature map"');
    const settings = {
      'quality.json': { ui: { locale: 'es', rules: { minFontPx: 16 } } },
      'guard.json': { productionPatterns: ['team-prod.invalid'], grantedDependencies: ['fixture-only'] },
      'integrity.json': { baselineGlobs: ['team-baselines/**'] },
      'grants.json': { rung: 'draft', queue: false, maxOwners: 1, disposable: false },
    };
    for (const [file, value] of Object.entries(settings)) await fs.writeFile(path.join(setup.repo, '.mend', file), JSON.stringify(value));
    for (const file of ['.env', 'credentials.json', 'evidence/unrelated.log', 'exemplars/unindexed.txt']) {
      await fs.writeFile(path.join(setup.repo, '.mend', file), 'private fixture marker');
    }
    assert.equal(sh(setup.repo, 'git check-ignore -q .mend/quality.json').status, 0);
    const worker = ownerSteps([FIXED]);
    const { api, calls } = harness({
      ...setup,
      owner: async (context) => {
        for (const [file, value] of Object.entries(settings)) {
          assert.deepEqual(JSON.parse(readFileSync(path.join(setup.worktree, '.mend', file))), value);
        }
        for (const file of ['.mend/evidence/verify.json', '.mend/exemplars/index.json', '.mend/exemplars/generic/helper.md', '.mendcode/skills/verify-fixture/SKILL.md', '.mendcode/skills/verify-fixture/features/README.md']) {
          assert.ok(existsSync(path.join(setup.worktree, file)), file);
        }
        for (const file of ['.env', 'credentials.json', 'items', 'worktrees', 'evidence/unrelated.log', 'exemplars/unindexed.txt']) {
          assert.equal(existsSync(path.join(setup.worktree, '.mend', file)), false, file);
        }
        const event = JSON.stringify({ tool_name: 'shell', cwd: setup.worktree, tool_input: { command: 'curl https://team-prod.invalid' } });
        const guard = spawnSync('python3', ['-I', path.join(PKG, 'guard/mend_guard.py')], { input: event, encoding: 'utf8' });
        assert.notEqual(guard.status, 0, 'the propagated production pattern must block the command');
        return worker(context);
      },
      critic: () => criticReply({ head: 9 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.ok(calls.agents.every((call) => call.prompt.includes(setup.worktree)));
    assert.equal(result.rung, 'draft');
  });

  test('verification skill propagates regular helpers and resources regardless of extension', async () => {
    const setup = await makeRepo();
    const directory = '.mendcode/skills/verify-fixture/resources';
    const resources = {
      'helper.ts': 'export const check = () => true;\n',
      'config.yaml': 'check: enabled\n',
      'fixture.sql': 'SELECT 1;\n',
      'diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    };
    await fs.mkdir(path.join(setup.repo, directory), { recursive: true });
    await fs.appendFile(path.join(setup.repo, '.git/info/exclude'), `\n${directory}/\n`);
    for (const [name, content] of Object.entries(resources)) await fs.writeFile(path.join(setup.repo, directory, name), content);
    const worker = ownerSteps([FIXED]);
    const { api } = harness({
      ...setup,
      owner: async (context) => {
        for (const [name, content] of Object.entries(resources)) {
          assert.equal(await fs.readFile(path.join(setup.worktree, directory, name), 'utf8'), content);
        }
        return worker(context);
      },
      critic: () => criticReply({ head: 9 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
  });

  test('Python verification helpers dispatch without propagating generated bytecode caches', async () => {
    const setup = await makeRepo();
    const scripts = '.mendcode/skills/verify-fixture/scripts';
    const helpers = {
      'check.py': 'from local_check import check\ncheck()\n',
      'local_check.py': 'from pathlib import Path\ndef check():\n    assert Path("src/total.js").is_file()\n',
    };
    await fs.mkdir(path.join(setup.repo, scripts), { recursive: true });
    for (const [name, content] of Object.entries(helpers)) {
      await fs.writeFile(path.join(setup.repo, scripts, name), content);
    }
    assert.equal(sh(setup.repo, 'git add .mendcode && git commit -q -m "Python verification helpers"').status, 0);
    const verification = spawnSync('python3', ['-E', `${scripts}/check.py`], { cwd: setup.repo, encoding: 'utf8' });
    assert.equal(verification.status, 0, verification.stderr);
    const cache = `${scripts}/__pycache__`;
    const cachedFiles = await fs.readdir(path.join(setup.repo, cache));
    assert.ok(cachedFiles.some((name) => name.endsWith('.pyc')), 'the local import must generate bytecode');
    const worker = ownerSteps([FIXED]);
    const { api, calls } = harness({
      ...setup,
      owner: async (context) => {
        for (const [name, content] of Object.entries(helpers)) {
          assert.equal(await fs.readFile(path.join(setup.worktree, scripts, name), 'utf8'), content);
        }
        assert.equal(existsSync(path.join(setup.worktree, cache)), false, 'exclude caches before dispatch');
        return worker(context);
      },
      critic: () => criticReply({ head: 9 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.ok(calls.agents.some((call) => call.mode === 'work'));
    assert.equal(existsSync(path.join(setup.worktree, cache)), false);
    assert.deepEqual(await fs.readdir(path.join(setup.repo, cache)), cachedFiles, 'preserve source caches');
  });

  test('a symlinked configuration is refused rather than copied', async () => {
    const setup = await makeRepo();
    await fs.writeFile(path.join(setup.repo, 'outside.json'), '{}');
    await fs.symlink('../outside.json', path.join(setup.repo, '.mend/quality.json'));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(existsSync(setup.worktree), false);
  });

  test('refuses symlinked destination setup directories', async () => {
    const setup = await makeRepo();
    const mend = path.join(setup.repo, '.mend');
    await fs.rename(path.join(mend, 'exemplars'), path.join(mend, 'saved-exemplars'));
    await fs.symlink('../../src', path.join(mend, 'exemplars'));
    assert.equal(sh(setup.repo, 'git add -f .mend/exemplars && git commit -qm setup').status, 0);
    await fs.unlink(path.join(mend, 'exemplars'));
    await fs.rename(path.join(mend, 'saved-exemplars'), path.join(mend, 'exemplars'));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(existsSync(path.join(setup.worktree, 'src/index.json')), false);
  });
  test('copies ignored local settings and exemplars into a new worktree before dispatch', async () => {
    const setup = await makeRepo();
    for (const [file, text] of Object.entries({ 'quality.json': '{"ui":{"locale":"fr-FR"}}', 'guard.json': '{"productionPatterns":["example.invalid"]}', 'integrity.json': '{}' })) {
      const target = path.join(setup.repo, '.mend', file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text);
    }
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await loadWorkflow('mend-quality')({ repo: setup.repo, item: setup.itemPath, pkg: PKG, critic: 'supervisor' }, ...API.slice(1).map((key) => api[key]));
    assert.equal(result.state, 'critiqued', result.reason);
    for (const file of ['quality.json', 'guard.json', 'integrity.json']) {
      assert.equal(await fs.readFile(path.join(setup.worktree, '.mend', file), 'utf8'), await fs.readFile(path.join(setup.repo, '.mend', file), 'utf8'));
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(setup.worktree, '.mend/exemplars/index.json'), 'utf8')), JSON.parse(await fs.readFile(path.join(setup.repo, '.mend/exemplars/index.json'), 'utf8')));
    assert.equal(await fs.readFile(path.join(setup.worktree, '.mend/exemplars/generic/helper.md'), 'utf8'), await fs.readFile(path.join(setup.repo, '.mend/exemplars/generic/helper.md'), 'utf8'));
  });
  for (const [kind, risk, approver] of [
    ['ui', 'low', 'human'],
    ['schema-migration', 'low', 'human'],
    ['docs', 'high', 'human'],
    ['docs', 'low', 'supervisor'],
  ]) {
    test(`${kind} at declared risk ${risk} sends its artifact to ${approver} before integration`, async () => {
      const setup = await makeRepo({ item: { profiles: [kind], risk } });
      await prepareProfile(setup, kind);
      if (kind === 'ui') await fs.writeFile(path.join(setup.repo, '.mend/quality.json'), JSON.stringify({ ui: { locale: 'en' } }));
      const artifact = `.mend/evidence/${setup.itemId}/proposal/plan.txt`;
      const inputName = { ui: 'layout.json', 'schema-migration': 'migration-plan.json', docs: 'outline.json' }[kind];
      const input = `.mend/evidence/${setup.itemId}/${inputName}`;
      const evidence = `.mend/evidence/${setup.itemId}`;
      const proposalInputs = {
        ui: { preview: { blocks: [] } },
        docs: { documents: [{ path: 'docs/guide.md', reader: 'maintainers', task: 'understand the change', headings: ['Guide'] }] },
        'schema-migration': { tables: [], steps: [], locks: [], rowCountChanges: {} },
      };
      const scaleElement = { fontSize: '16px', fontWeight: '400', borderRadius: '4px', color: 'rgb(20, 30, 40)', backgroundColor: 'rgb(255, 255, 255)' };
      const scaleSnapshot = JSON.stringify({ components: [{ id: 'preview', elements: [scaleElement] }], page: { elements: [scaleElement] } });
      const { api, calls } = harness({
        ...setup,
        owner: ownerSteps([{ files: {
          [artifact]: 'Synthetic proposal for the declared item.\n',
          [input]: JSON.stringify(proposalInputs[kind]),
          ...(kind === 'ui' ? { [`${evidence}/ui-snapshot.json`]: JSON.stringify({ components: [{ id: 'preview', texts: [{ text: 'Total', fontPx: 14 }], numbers: [], timestamps: [], overflow: false }] }), [`${evidence}/ui-scale-base.json`]: scaleSnapshot, [`${evidence}/ui-scale-head.json`]: scaleSnapshot } : {}),
        }, proposals: [artifact], profileEvidence: { [kind]: { approvedProposal: artifact } } }]),
        critic: (_round, prompt) => {
          const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
          return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The proposal meets this category.`), 'gaming: no - checked'].join('\n');
        },
        answers: approver === 'human' ? ['reject'] : [],
        supervisor: { approved: false, reason: 'The artifact omits the acceptance evidence.' },
      });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft', result.reason);
      assert.equal(calls.agents.filter((call) => call.label.startsWith('proposal')).length, 1);
      assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
      assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
      if (approver === 'human') {
        assert.equal(calls.asks.length, 1);
        assert.ok(calls.asks[0].question.includes(artifact));
        assert.equal(calls.agents.some((call) => call.label.startsWith('supervise')), false);
      } else {
        assert.equal(calls.asks.length, 0);
        const review = calls.agents.find((call) => call.label.startsWith('supervise'));
        assert.equal(review.model, CRITIC);
        assert.ok(review.prompt.includes(artifact));
      }
    });
  }

  test('a proposal without a profile association is blocked before approval', async () => {
    const setup = await makeRepo({ item: { profiles: ['docs'] } });
    await prepareProfile(setup, 'docs');
    const artifact = `.mend/evidence/${setup.itemId}/proposal/plan.txt`;
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([{ files: { [artifact]: 'Synthetic proposal.\n' }, proposals: [artifact] }]),
      critic: () => criticReply({ head: 8 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /did not identify an approved proposal for docs/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('supervise')), false);
    assert.equal(calls.asks.length, 0);
  });

  test('a single artifact named by the profile proposal is associated when the owner leaves it empty', async () => {
    const setup = await makeRepo({ item: { profiles: ['docs'] } });
    await prepareProfile(setup, 'docs');
    const artifact = `.mend/evidence/${setup.itemId}/proposal/outline.md`;
    const { api } = harness({
      ...setup,
      owner: ownerSteps([{ files: { [artifact]: 'Synthetic outline.\n' }, proposals: [artifact], profileEvidence: { docs: { approvedProposal: null } } }]),
      critic: () => criticReply({ head: 8 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.doesNotMatch(String(result.reason ?? ''), /did not identify an approved proposal/);
  });

  test('accepted profile evidence replaces preliminary fields but not the approved proposal association', async () => {
    const setup = await makeRepo({ item: { profiles: ['docs'] } });
    await prepareProfile(setup, 'docs');
    const artifact = `.mend/evidence/${setup.itemId}/proposal/outline.json`;
    const input = `.mend/evidence/${setup.itemId}/outline.json`;
    const outline = JSON.stringify({ documents: [{ path: 'docs/guide.md', reader: 'maintainers', task: 'understand the change', headings: ['Guide'] }] });
    const pairs = [{ exemplar: 'src/total.js', proposal: artifact }];
    const { api } = harness({
      ...setup,
      owner: ownerSteps([
        { files: { [artifact]: outline, [input]: outline }, proposals: [artifact], profileEvidence: { docs: { approvedProposal: artifact, exemplarPairs: pairs, proof: 'preliminary' } } },
        { ...FIXED, profileEvidence: { docs: { approvedProposal: 'unapproved.json', exemplarPairs: [], proof: 'final' } } },
      ]),
      critic: (_round, prompt) => {
        const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
        return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The proposal meets this category.`), 'gaming: no - checked'].join('\n');
      },
    });
    rubricResponse(api, { pass: true, checksPass: true, blocked: false, profiles: [] });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.deepEqual(result.profileEvidence.docs, { approvedProposal: artifact, exemplarPairs: pairs, proof: 'final' });
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`), 'utf8'));
    assert.deepEqual(stored.profileEvidence.docs, result.profileEvidence.docs);
  });

  test('an implementing owner that reports no exemplars keeps the ones cited in the proposal', async () => {
    const setup = await makeRepo({ item: { profiles: ['docs'] } });
    await prepareProfile(setup, 'docs');
    const artifact = `.mend/evidence/${setup.itemId}/proposal/outline.json`;
    const input = `.mend/evidence/${setup.itemId}/outline.json`;
    const outline = JSON.stringify({ documents: [{ path: 'docs/guide.md', reader: 'maintainers', task: 'understand the change', headings: ['Guide'] }] });
    const { api } = harness({
      ...setup,
      owner: ownerSteps([
        { files: { [artifact]: outline, [input]: outline }, proposals: [artifact], profileEvidence: { docs: { approvedProposal: artifact } } },
        { ...FIXED, exemplars: [] },
      ]),
      critic: (_round, prompt) => {
        const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
        return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The proposal meets this category.`), 'gaming: no - checked'].join('\n');
      },
    });
    rubricResponse(api, { pass: true, checksPass: true, blocked: false, profiles: [] });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
  });

  test('a low-risk proposal is explicitly approved by the strong supervisor before integration', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 7 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(calls.asks.length, 0);
    const review = calls.agents.find((call) => call.label.startsWith('supervise'));
    assert.equal(review.model, CRITIC);
    assert.equal(review.mode, 'read');
    assert.ok(calls.agents.indexOf(review) < calls.agents.findIndex((call) => call.label.startsWith('owner')));
    assert.equal(result.proposalApproval.approver, 'supervisor');
    assert.equal(result.proposalApproval.by, CRITIC);
    assert.ok(Number.isFinite(Date.parse(result.proposalApproval.at)));
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/proposal-approval.json`), 'utf8'));
    assert.deepEqual(stored, result.proposalApproval);
  });

  test('the strong model writes a read-only spec before any owner, and every owner and the frozen plan carry it', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    const spec = calls.agents.find((call) => call.label.startsWith('spec'));
    assert.equal(spec.model, CRITIC);
    assert.equal(spec.mode, 'read');
    assert.ok(calls.agents.indexOf(spec) < calls.agents.findIndex((call) => call.label.startsWith('restate')));
    for (const call of calls.agents.filter((c) => c.label.startsWith('owner') || c.label.startsWith('restate'))) assert.ok(call.prompt.includes(`.mend/evidence/${setup.itemId}/spec.md`), call.label);
    const frozen = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/proposal-plan.json`), 'utf8'));
    // Readers cut long lines, so the spec is multi-line Markdown named by the frozen plan and hashed with it.
    assert.equal(frozen.spec, `.mend/evidence/${setup.itemId}/spec.md`);
    assert.equal(readFileSync(path.join(setup.worktree, frozen.spec), 'utf8'), DEFAULT_SPEC + '\n');
    assert.ok(result.proposalApproval.inputs.some((input) => input.path === frozen.spec));
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/spec.json`), 'utf8'));
    assert.deepEqual(stored, { planner: CRITIC, spec: DEFAULT_SPEC });
    assert.match(calls.agents.find((call) => call.label.startsWith('critique')).prompt, /contract for how the item works/);
  });

  test('a spec longer than the host prompt limit keeps every agent prompt within it', async () => {
    const setup = await makeRepo();
    const long = 'Handle this case exactly. '.repeat(600);
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), spec: { spec: long } });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    for (const call of calls.agents.filter((c) => !c.label.startsWith('critique'))) assert.ok(call.prompt.length <= 8000, `${call.label}: ${call.prompt.length}`);
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/spec.json`), 'utf8'));
    assert.equal(stored.spec, long.trim());
  });

  test('an owner exemplar list outside the profile contract goes back to the owner instead of blocking as a critic failure', async () => {
    const setup = await makeRepo();
    const tooMany = ['a', 'b', 'c', 'd'].map((label) => ({ label, path: 'src/reference.js', took: 'style' }));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([{ ...FIXED, exemplars: tooMany }, FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
    assert.match(calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`).prompt, /Fix your exemplars: exemplar count is outside the profile contract/);
  });

  test('an exemplar the item edits goes back to the owner before any critique, so the anchor cannot move between rounds', async () => {
    const setup = await makeRepo();
    const edited = [{ label: 'own file', path: 'src/total.js', took: 'style' }];
    const { api, calls } = harness({ ...setup, owner: ownerSteps([{ ...FIXED, exemplars: edited }, FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
    assert.match(calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`).prompt, /Fix your exemplars: exemplars must be files this item does not edit; replace src\/total\.js/);
  });

  test('a named planner writes the spec instead of the critic', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC, planner: 'planner-test-model' }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(calls.agents.find((call) => call.label.startsWith('spec')).model, 'planner-test-model');
    assert.equal(calls.agents.find((call) => call.label.startsWith('critique')).model, CRITIC);
  });

  for (const empty of [{ spec: '' }, { spec: '   ' }, {}, null]) {
    test(`an empty planner spec ${JSON.stringify(empty)} blocks before any owner`, async () => {
      const setup = await makeRepo();
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), spec: empty });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /planner returned no spec/);
      assert.equal(calls.agents.some((call) => call.label.startsWith('owner') || call.label.startsWith('restate')), false);
    });
  }

  test('a supervisor rejection stops before integration', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), supervisor: { approved: false, reason: 'The proposed file is outside the item.' } });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /supervisor did not approve/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  test('a high-risk generic item needs human approval even without a profile artifact', async () => {
    const setup = await makeRepo({ item: { risk: 'high' } });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([{}, FIXED]), critic: () => criticReply({ head: 8 }), answers: ['approve', 'proposal-reviewer', 'approve', 'reviewer'] });
    const ask = api.ask;
    api.ask = async (question, options) => {
      if (question.startsWith('Approve the proposal')) {
        assert.ok(calls.inputs.some(({ command, ...options }) => command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'run'));
        assert.ok(calls.checks.some((command) => command.includes('integrity.mjs')));
        assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
        const critique = calls.agents.find((call) => call.label.startsWith('critique'));
        assert.match(critique.prompt, /proposal-plan\.json/);
        assert.match(critique.prompt, /not yet approved; critique the proposal itself/);
        assert.match(critique.prompt, /review-card\.json/);
        assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
        assert.match(await fs.readFile(path.join(setup.worktree, 'src/total.js'), 'utf8'), /a \+ b \+ 0/);
      }
      return ask(question, options);
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(result.proposalApproval.approver, 'human');
    assert.equal(calls.asks.length, 4);
    assert.equal(result.proposalApproval.by, 'proposal-reviewer');
    assert.match(result.proposalApproval.inputs[0].sha256, /^[a-f0-9]{64}$/);
    const frozen = JSON.parse(await fs.readFile(path.join(setup.worktree, result.proposalApproval.inputs[0].path), 'utf8'));
    assert.equal(frozen.item.risk, 'high');
    assert.equal(frozen.restatement.goal, 'drop the zero');
    assert.equal(result.resultApproval.by, 'reviewer');
    assert.match(calls.asks[0].question, /Approve the proposal/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('supervise')), false);
  });

  for (const failure of ['rubric', 'integrity', 'critique']) {
    test(`a failed ${failure} prevents human approval of an artifact-free proposal`, async () => {
      const setup = await makeRepo({ item: { risk: 'high' } });
      const { api, calls } = harness({ ...setup, owner: ownerSteps([{}]), critic: () => criticReply({ head: failure === 'critique' ? 6 : 8 }) });
      const check = api.check;
      api.check = async (command, options) => {
        const result = await check(command, options);
        if (failure === 'integrity' && command.includes('integrity.mjs')) return { ok: true, detail: '{}' };
        if (failure === 'rubric' && command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'run') {
          const report = JSON.parse(hostOutput(result.detail));
          report.pass = report.checksPass = false;
          report.profiles[0].rubric = { pass: false, failures: [{ rule: 'synthetic', detail: 'proposal fails' }] };
          return { ok: false, detail: JSON.stringify(report) };
        }
        return result;
      };
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, failure === 'integrity' ? 'blocked' : 'draft', result.reason);
      assert.equal(calls.asks.length, 0);
      assert.equal(calls.agents.some((call) => call.prompt.includes('Implement the item')), false);
    });
  }

  for (const stage of ['proposal', 'result']) for (const identity of [null, undefined, false, 42, {}, '', '   ']) {
    test(`invalid ${stage} approver identity ${String(identity)} blocks approval`, async () => {
      const setup = await makeRepo({ item: { risk: 'high' } });
      const answers = stage === 'proposal' ? ['approve', identity] : ['approve', 'proposal-reviewer', 'approve', identity];
      const { api, calls } = harness({ ...setup, owner: ownerSteps([{}, FIXED]), critic: () => criticReply({ head: 8 }), answers });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /approval needs an approver identity/);
      assert.ok(calls.asks.some(({ question }) => question.startsWith(`Who approves this ${stage}?`)));
      const approvalPath = path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`);
      if (stage === 'proposal') assert.equal(existsSync(approvalPath), false);
      else {
        const approval = JSON.parse(await fs.readFile(approvalPath, 'utf8'));
        assert.equal(approval.proposal.by, 'proposal-reviewer');
        assert.equal(approval.result, undefined);
        assert.equal(existsSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`)), false);
      }
    });
  }

  test('a cancelled artifact proposal approver identity blocks integration', async () => {
    const setup = await makeRepo();
    const proposal = `.mend/evidence/${setup.itemId}/proposal/plan.md`;
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([{ files: { [proposal]: 'Synthetic proposal\n' }, proposals: [proposal], profileEvidence: { generic: { approvedProposal: proposal } } }]),
      critic: () => criticReply({ head: 8 }), answers: ['approve', null],
    });
    const check = api.check;
    api.check = async (command, options) => {
      const result = await check(command, options);
      if (command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'plan') {
        const plan = JSON.parse(hostOutput(result.detail));
        Object.assign(plan.profiles[0], { proposalArtifact: { name: 'plan', what: 'A plan file' }, humanApproval: true, proposalApprover: 'human' });
        return { ...result, detail: JSON.stringify(plan) };
      }
      return result;
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked', result.reason);
    assert.match(result.reason, /approval needs an approver identity/);
    assert.equal(calls.agents.filter(({ label }) => label.startsWith('proposal ')).length, 1);
    assert.equal(calls.agents.filter(({ label }) => label.startsWith('critique ')).length, 1);
    assert.equal(existsSync(path.join(setup.worktree, proposal)), true);
    assert.equal(calls.asks.length, 2);
    assert.ok(calls.asks[0].question.includes(`Files: ${proposal}`), 'the approved decision must concern the generated artifact');
    assert.ok(calls.asks[1].question.startsWith('Who approves this proposal?'));
    assert.equal(calls.agents.some(({ label }) => label.startsWith('owner')), false);
    assert.equal(existsSync(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`)), false);
  });

  test('tampering with the approved plan while collecting the approver identity blocks implementation', async () => {
    const setup = await makeRepo({ item: { risk: 'high' } });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([{}, FIXED]), critic: () => criticReply({ head: 8 }), answers: ['approve', 'proposal-reviewer'] });
    const ask = api.ask;
    api.ask = async (question, options) => {
      if (question.startsWith('Who approves this proposal?')) {
        await fs.writeFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/proposal-plan.json`), '{}');
      }
      return ask(question, options);
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /approved inputs changed/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  for (const [name, options] of [
    ['head below 7', { head: 6.9 }],
    ['worse than base despite a higher score', { head: 9, base: 7, vsBase: 'worse' }],
    ['worse than an exemplar despite a higher score', { head: 9, anchor: 8, vsAnchor: 'worse' }],
    ['gaming', { head: 9, gaming: 'yes' }],
    ['open blocker', { head: 9, findings: ['F1 [blocker]'] }],
    ['open should', { head: 9, findings: ['F1 [should]'] }],
  ]) {
    test(`${name} rejects the round`, async () => {
      const setup = await makeRepo();
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply(options) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft');
      assert.deepEqual(result.rejectedBy, ['critique', 'critique']);
    });
  }

  test('same judgments pass despite lower numeric scores than base and exemplar, and nits do not block', async () => {
    const setup = await makeRepo();
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 7, base: 9, anchor: 9, vsBase: 'same', findings: ['F1 [nit]'] }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(result.rounds.used, 0);
  });

  test('missing comparisons block the workflow rather than passing on scores alone', async () => {
    const setup = await makeRepo();
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }).replace(/^vs:.*\n/gm, '') });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /missing vs:/);
  });

  test('an indexed exemplar cannot escape to a private file', async () => {
    const setup = await makeRepo();
    await fs.writeFile(path.join(setup.repo, '.mend/exemplars/index.json'), JSON.stringify([
      { profile: 'generic', id: 'escape', file: '.mend/exemplars/generic/../../credentials.json' },
    ]));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(existsSync(setup.worktree), false);
  });

  test('a tracked multi-profile exemplar index is preserved during dispatch', async () => {
    const setup = await makeRepo();
    const indexPath = '.mend/exemplars/index.json';
    const index = JSON.parse(await fs.readFile(path.join(setup.repo, indexPath), 'utf8'));
    index.push({ profile: 'ui', id: 'other', file: '.mend/exemplars/ui/reference.md', approved: false });
    const original = JSON.stringify(index, null, 4) + '\n';
    await fs.writeFile(path.join(setup.repo, indexPath), original);
    assert.equal(sh(setup.repo, `git add -f ${indexPath} && git commit -qm "tracked exemplar index"`).status, 0);
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(await fs.readFile(path.join(setup.worktree, indexPath), 'utf8'), original);
    assert.equal(existsSync(path.join(setup.worktree, '.mend/exemplars/ui/reference.md')), false);
    assert.equal(sh(setup.worktree, `git status --porcelain -- ${indexPath}`).out.trim(), '');
  });

  test('a divergent tracked exemplar index blocks without overwriting it', async () => {
    const setup = await makeRepo();
    const indexPath = '.mend/exemplars/index.json';
    const original = await fs.readFile(path.join(setup.repo, indexPath), 'utf8');
    assert.equal(sh(setup.repo, `git add -f ${indexPath} && git commit -qm "tracked exemplar index"`).status, 0);
    assert.equal(sh(setup.repo, `git worktree add -b mend/${setup.itemId} '${setup.worktree}' HEAD`).status, 0);
    const destination = path.join(setup.worktree, indexPath);
    const divergent = original + '\n';
    await fs.writeFile(destination, divergent);
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /worktree setup conflicts with source/);
    assert.equal(calls.agents.length, 0);
    assert.equal(await fs.readFile(destination, 'utf8'), divergent);
  });

  test('conflicting settings in a reused worktree block instead of silently overwriting either copy', async () => {
    const setup = await makeRepo();
    await fs.writeFile(path.join(setup.repo, '.mend/quality.json'), '{"ui":{"locale":"es"}}');
    assert.equal(sh(setup.repo, `git worktree add -b mend/${setup.itemId} '${setup.worktree}' HEAD`).status, 0);
    await fs.mkdir(path.join(setup.worktree, '.mend'), { recursive: true });
    await fs.writeFile(path.join(setup.worktree, '.mend/quality.json'), '{"ui":{"locale":"en"}}');
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(JSON.parse(readFileSync(path.join(setup.worktree, '.mend/quality.json'))).ui.locale, 'en');
  });

  for (const { name, sourceMode, destinationMode, blocked } of [
    { name: 'removed executable permission', sourceMode: 0o755, destinationMode: 0o644, blocked: true },
    { name: 'removed owner executable permission only', sourceMode: 0o755, destinationMode: 0o655, blocked: true },
    { name: 'unexpected executable permission', sourceMode: 0o644, destinationMode: 0o755, blocked: true },
    { name: 'matching executable permission with private mode', sourceMode: 0o755, destinationMode: 0o700, blocked: false },
  ]) {
    test(`a reused verification helper with ${name} ${blocked ? 'blocks before dispatch' : 'remains usable'}`, async () => {
      const setup = await makeRepo();
      const relative = '.mendcode/skills/verify-fixture/scripts/check.sh';
      const source = path.join(setup.repo, relative);
      const destination = path.join(setup.worktree, relative);
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, '#!/bin/sh\ntest -f src/total.js\n');
      await fs.chmod(source, sourceMode);
      assert.equal(sh(setup.repo, 'git add .mendcode && git commit -q -m "verification helper"').status, 0);
      assert.equal(sh(setup.repo, `git worktree add -b mend/${setup.itemId} '${setup.worktree}' HEAD`).status, 0);
      await fs.chmod(destination, destinationMode);
      const before = await fs.readFile(destination);
      assert.deepEqual(before, await fs.readFile(source), 'only permissions differ');

      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, blocked ? 'blocked' : 'critiqued', result.reason);
      if (blocked) {
        assert.match(result.reason, /executable permission conflicts with source/);
        assert.equal(calls.agents.length, 0);
        assert.equal(existsSync(path.join(setup.worktree, '.mend')), false, 'validate before copying setup files');
      } else {
        assert.ok(calls.agents.some((call) => call.mode === 'work'));
      }
      assert.equal((await fs.stat(destination)).mode & 0o777, destinationMode, 'never silently change destination permissions');
      assert.equal((await fs.stat(source)).mode & 0o777, sourceMode, 'never change source permissions');
      assert.deepEqual(await fs.readFile(destination), before);
    });
  }
  test('a proposal is checked and critiqued before approval, and an approved file cannot change during integration', async () => {
    const setup = await makeRepo();
    const proposal = `.mend/evidence/${setup.itemId}/proposal/plan.md`;
    let owners = 0;
    const steps = ownerSteps([{}, FIXED]);
    const { api, calls } = harness({
      ...setup,
      owner: async (context) => {
        const result = await steps(context);
        owners += 1;
        await fs.mkdir(path.dirname(path.join(context.worktree, proposal)), { recursive: true });
        await fs.writeFile(path.join(context.worktree, proposal), owners === 1 ? 'Approved shape\n' : 'Different shape\n');
        const report = JSON.parse(result.text.split('\n')[1]);
        report.proposals = [proposal];
        report.profileEvidence = { generic: { approvedProposal: proposal } };
        return { ...result, text: `## Owner report\n${JSON.stringify(report)}` };
      },
      critic: () => criticReply({ head: 8 }),
      answers: ['approve', 'fixture-reviewer', 'approve', 'fixture-reviewer'],
    });
    const check = api.check;
    api.check = async (command, options) => {
      const result = await check(command, options);
      if (command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'plan') {
        const plan = JSON.parse(hostOutput(result.detail));
        Object.assign(plan.profiles[0], { proposalArtifact: { name: 'plan', what: 'A plan file' }, humanApproval: true, proposalApprover: 'human' });
        return { ...result, detail: JSON.stringify(plan) };
      }
      return result;
    };
    const ask = api.ask;
    api.ask = async (question, options) => {
      if (question.startsWith('Approve the proposal')) {
        assert.ok(calls.agents.some((call) => call.label.startsWith('critique')), 'critique precedes approval');
        assert.ok(calls.checks.some((command) => command.includes('integrity.mjs')), 'integrity precedes approval');
      }
      return ask(question, options);
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /approved.*changed|approval.*changed|reapproval/i);
    assert.equal(owners, 2);
  });

  test('a declared layout artifact freezes its preview but permits integrated measurements', async () => {
    for (const mutatePreview of [false, true]) {
      const setup = await makeRepo();
      const layout = `.mend/evidence/${setup.itemId}/layout.json`;
      const preview = { blocks: [{ id: 'total' }] };
      const steps = ownerSteps([{}, FIXED]);
      let owners = 0;
      const { api } = harness({ ...setup, owner: async (context) => {
        const result = await steps(context);
        owners += 1;
        await fs.mkdir(path.dirname(path.join(context.worktree, layout)), { recursive: true });
        await fs.writeFile(path.join(context.worktree, layout), JSON.stringify({
          preview: owners > 1 && mutatePreview ? { blocks: [] } : preview,
          ...(owners > 1 ? { integrated: { blocks: [{ id: 'total' }] } } : {}),
        }));
        const report = JSON.parse(result.text.split('\n')[1]);
        report.proposals = [layout];
        report.profileEvidence = { generic: { approvedProposal: layout } };
        return { ...result, text: `## Owner report\n${JSON.stringify(report)}` };
      }, critic: () => criticReply({ head: 8 }), answers: ['approve', 'proposal-reviewer', 'approve', 'result-reviewer'] });
      const check = api.check;
      api.check = async (command, options) => {
        const result = await check(command, options);
        if (command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'plan') {
          const plan = JSON.parse(hostOutput(result.detail));
          Object.assign(plan.profiles[0], { proposalArtifact: { name: 'preview', what: 'A preview', inputs: [{ path: 'layout.json', field: 'preview' }] }, humanApproval: true, proposalApprover: 'human' });
          return { ...result, detail: JSON.stringify(plan) };
        }
        return result;
      };
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, mutatePreview ? 'draft' : 'critiqued', result.reason);
      if (mutatePreview) assert.match(result.reason, /approved inputs changed/);
      else {
        const inputs = result.proposalApproval.inputs.filter((input) => input.path === layout);
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].field, 'preview');
      }
    }
  });

  test('changing the item after artifact approval blocks integration without changing the proposal', async () => {
    const setup = await makeRepo();
    const proposal = `.mend/evidence/${setup.itemId}/proposal/plan.md`;
    const steps = ownerSteps([{}, FIXED]);
    let owners = 0;
    const { api } = harness({ ...setup, owner: async (context) => {
      const result = await steps(context);
      owners += 1;
      await fs.mkdir(path.dirname(path.join(context.worktree, proposal)), { recursive: true });
      if (owners === 1) await fs.writeFile(path.join(context.worktree, proposal), 'Approved shape\n');
      else {
        const itemFile = path.join(setup.repo, setup.itemPath);
        const item = JSON.parse(await fs.readFile(itemFile, 'utf8'));
        item.goal = 'Changed scope after approval';
        await fs.writeFile(itemFile, JSON.stringify(item));
      }
      const report = JSON.parse(result.text.split('\n')[1]);
      report.proposals = [proposal];
      report.profileEvidence = { generic: { approvedProposal: proposal } };
      return { ...result, text: `## Owner report\n${JSON.stringify(report)}` };
    }, critic: () => criticReply({ head: 8 }), answers: ['approve', 'proposal-reviewer'] });
    const check = api.check;
    api.check = async (command, options) => {
      const result = await check(command, options);
      if (command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'plan') {
        const plan = JSON.parse(hostOutput(result.detail));
        Object.assign(plan.profiles[0], { proposalArtifact: { name: 'plan', what: 'A plan file' }, humanApproval: true, proposalApprover: 'human' });
        return { ...result, detail: JSON.stringify(plan) };
      }
      return result;
    };
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /approved item changed/);
    assert.equal(owners, 2);
    assert.equal(await fs.readFile(path.join(setup.worktree, proposal), 'utf8'), 'Approved shape\n');
  });

  test('missing categories and missing exemplar columns cannot reach critiqued', async () => {
    for (const reply of [
      '| category | base | head | sum-helper |\n|---|---|---|---|\n| generic.goal | 7 | 9 | 8 |\ngaming: no - checked\n',
      criticReply({ head: 9 }).replace(/ \| sum-helper/g, '').replace(/\|---\|---\|---\|---\|/, '|---|---|---|').replace(/ \| 8 \|/g, ' |'),
    ]) {
      const setup = await makeRepo();
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => reply });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'blocked', result.reason);
      assert.match(result.reason, /categor|anchor|exemplar/i);
    }
  });

  test('missing exemplars go back to the owner and never pay for a critic', async () => {
    const setup = await makeRepo();
    const steps = ownerSteps([FIXED]);
    const { api, calls } = harness({ ...setup, owner: async (context) => {
      const result = await steps(context);
      const report = JSON.parse(result.text.split('\n')[1]);
      report.exemplars = [];
      return { ...result, text: `## Owner report\n${JSON.stringify(report)}` };
    }, critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    // The owner is sent back to cite them; rounds run out without a critic ever being paid.
    assert.equal(result.state, 'draft', result.reason);
    assert.match(result.reason, /budget spent/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
    assert.match(calls.agents.find((call) => call.label === `owner ${setup.itemId} r2`).prompt, /Fix your exemplars: exemplar labels and paths are required/);
  });

  test('an unchanged proposal records its approver, date and hashes and still reaches critiqued', async () => {
    const setup = await makeRepo();
    const proposal = `.mend/evidence/${setup.itemId}/proposal/plan.md`;
    const steps = ownerSteps([{}, FIXED]);
    const { api } = harness({ ...setup, owner: async (context) => {
      const result = await steps(context);
      await fs.mkdir(path.dirname(path.join(context.worktree, proposal)), { recursive: true });
      await fs.writeFile(path.join(context.worktree, proposal), 'Keep the exported name and remove the zero.\n');
      const report = JSON.parse(result.text.split('\n')[1]);
      report.proposals = [proposal];
      report.profileEvidence = { generic: { approvedProposal: proposal } };
      return { ...result, text: `## Owner report\n${JSON.stringify(report)}` };
    }, critic: () => criticReply({ head: 8 }), answers: ['approve', 'reviewer-one', 'approve', 'reviewer-two'] });
    const check = api.check;
    api.check = async (command, options) => {
      const result = await check(command, options);
      if (command.includes('run-rubric.mjs') && inputArgs(options)[0] === 'plan') {
        const plan = JSON.parse(hostOutput(result.detail));
        Object.assign(plan.profiles[0], { proposalArtifact: { name: 'plan', what: 'A plan file' }, humanApproval: true, proposalApprover: 'human' });
        return { ...result, detail: JSON.stringify(plan) };
      }
      return result;
    };
    const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(quality.state, 'critiqued', quality.reason);
    assert.equal(quality.proposalApproval.by, 'reviewer-one');
    assert.ok(Number.isFinite(Date.parse(quality.proposalApproval.at)));
    assert.match(quality.proposalApproval.inputs[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(quality.resultApproval.by, 'reviewer-two');
    const receipt = JSON.parse(await fs.readFile(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`), 'utf8'));
    assert.deepEqual(receipt.proposal, quality.proposalApproval);
    assert.ok(receipt.quality.some((input) => input.path.endsWith('critique-r2.md')));
    const snapshot = receipt.proposal.inputs.find((input) => input.path === `.mend/evidence/${setup.itemId}/proposal-plan.json`);
    assert.ok(snapshot, 'artifact approval also freezes the item and restatement');
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    const frozen = JSON.parse(await fs.readFile(path.join(setup.worktree, snapshot.path), 'utf8'));
    const itemFile = path.join(setup.repo, setup.itemPath);
    const approvedItem = await fs.readFile(itemFile, 'utf8');
    assert.deepEqual(frozen.item, JSON.parse(approvedItem));
    assert.deepEqual(frozen.restatement, quality.restatement);

    for (const timing of ['before delivery', 'during audit']) {
      const changeItem = () => fs.writeFile(itemFile, JSON.stringify({ ...frozen.item, goal: 'Changed scope after artifact approval' }));
      const delivery = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      if (timing === 'before delivery') await changeItem();
      else {
        const agent = delivery.api.agent;
        delivery.api.agent = async (prompt, options) => {
          if (options.label.startsWith('audit')) await changeItem();
          return agent(prompt, options);
        };
      }
      const refused = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, delivery.api);
      assert.equal(refused.state, 'draft', timing);
      assert.match(refused.reason, /approved item changed/, timing);
      assert.equal(delivery.calls.agents.some((call) => call.label.startsWith('audit')), timing === 'during audit');
      if (timing === 'during audit') assert.equal(readValidCard(refused.card).state, 'draft');
      assert.equal(await fs.readFile(path.join(setup.worktree, proposal), 'utf8'), 'Keep the exported name and remove the zero.\n');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`), 'utf8')), receipt);
      await fs.writeFile(itemFile, approvedItem);
    }
  });

  test('visual work still needs human approval when declared as generic', async () => {
    const setup = await makeRepo({ item: { visual: true } });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: ['approve', 'visual-reviewer'] });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(result.resultApproval.by, 'visual-reviewer');
    assert.ok(calls.asks.some((entry) => entry.question.includes('Approve the result')));
  });

  test('changing an exemplar between rounds blocks before another critic is called', async () => {
    const setup = await makeRepo();
    const steps = ownerSteps([FIXED, FIXED]);
    let owners = 0;
    const { api, calls } = harness({ ...setup, owner: async (context) => {
      const result = await steps(context);
      if (++owners === 2) await fs.writeFile(path.join(context.worktree, 'src/reference.js'), 'export const sum = () => 0;\n');
      return result;
    }, critic: () => criticReply({ head: 8, findings: ['F1 [should]'] }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /exemplar anchors changed/);
    assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
  });

  test('an exemplar changed during either result approval question cannot get a receipt', async () => {
    for (const questionPart of ['Approve the result?', 'Who approves this result?']) {
      const setup = await makeRepo({ item: { visual: true } });
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }), answers: ['approve', 'visual-reviewer'] });
      const ask = api.ask;
      let changed = false;
      api.ask = async (question, options) => {
        if (question.includes(questionPart)) {
          assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
          await fs.writeFile(path.join(setup.worktree, 'src/reference.js'), 'export const sum = () => 0;\n');
          changed = true;
        }
        return ask(question, options);
      };
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(changed, true);
      assert.equal(result.state, 'draft', result.reason);
      assert.match(result.reason, /approved inputs changed.*src\/reference\.js/);
      assert.equal(existsSync(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`)), false);
    }
  });

  test('a should finding sends the item back once; the next reply resolves it and the item is critiqued', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([FIXED, { files: { 'src/total.js': 'export const total = (a, b) => a + b; // sum\n' } }]),
      critic: (n) => (n === 1 ? criticReply({ head: 8, findings: ['F1 [should]'] }) : criticReply({ head: 8, resolved: ['F1'] })),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.deepEqual(result.rounds, { used: 1, budget: 2, rejectedBy: ['critique'] });
    assert.deepEqual(result.critique.findings, [{ id: 'F1', severity: 'should', status: 'resolved', round: 1 }]);
    assert.equal(result.critiqueScores.generic, 8);
    assert.ok(existsSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/critique-r1.md`)));
    assert.ok(existsSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`)));
    const critiques = calls.agents.filter((call) => call.label.startsWith('critique'));
    assert.ok(critiques.every((call) => call.model === CRITIC && call.mode === 'read'));
    assert.ok(critiques.every((call) => !/\b7\b.*(threshold|bar|pass)/i.test(call.prompt)), 'the critic is never told the bar');
    assert.equal(sh(setup.worktree, 'git rev-parse --abbrev-ref HEAD').out.trim(), 'mend/tidy-total');
  });

  test('a previous critique log modified between rounds cannot be certified', async () => {
    const setup = await makeRepo();
    const steps = ownerSteps([FIXED, FIXED]);
    let owners = 0;
    const { api } = harness({ ...setup, owner: async (context) => {
      const result = await steps(context);
      owners += 1;
      if (owners === 2) {
        const log = path.join(context.worktree, `.mend/evidence/${context.itemId}/critique-r1.md`);
        const text = await fs.readFile(log, 'utf8');
        await fs.writeFile(log, text.replace('looked at the tests and the checks', 'different supporting evidence'));
      }
      return result;
    }, critic: (n) => n === 1 ? criticReply({ head: 8, findings: ['F1 [should]'] }) : criticReply({ head: 8, resolved: ['F1'] }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft', result.reason);
    assert.match(result.reason, /approved inputs changed.*critique-r1\.md/);
    assert.equal(existsSync(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`)), false);
    const state = JSON.parse(await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
    assert.ok(state.critiqueIdentities.some((input) => input.path.endsWith('critique-r1.md') && /^[a-f0-9]{64}$/.test(input.sha256)));
  });

  test('an anchor that drifts voids the round; a fresh critic reruns it and only counted rounds decide', async () => {
    const setup = await makeRepo();
    // The first counted round sets the anchors, so drift needs a later round: send round 1 back with a finding.
    const { api: driftApi } = harness({
      ...setup,
      owner: ownerSteps([FIXED, FIXED]),
      critic: (n) => [criticReply({ head: 8, anchor: 8, findings: ['F1 [should]'] }), criticReply({ head: 8, anchor: 5, resolved: ['F1'] }), criticReply({ head: 8, anchor: 8, resolved: ['F1'] })][n - 1],
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, driftApi);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.deepEqual(result.critique.rounds.map((round) => [round.round, round.void === true]), [[1, false], [2, true], [3, false]]);
    assert.match(result.critique.rounds[1].voidReason, /moved from 8 to 5/);
  });

  test('an integrity flag that survives a fix round goes to the human, who may countersign it', async () => {
    const setup = await makeRepo();
    const keepsExtra = { files: { 'src/total.js': 'export const total = (a, b) => a + b;\n', 'src/extra.js': 'export const extra = 1;\n' } };
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([keepsExtra, keepsExtra]),
      critic: () => criticReply({ head: 9 }),
      answers: ['the extra module is generated by the build and must ship with this change'],
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(calls.asks.length, 1);
    assert.deepEqual(result.countersigns.map((sign) => [sign.kind, sign.subject]), [['integrity-flag', 'out-of-scope src/extra.js:1']]);
  });

  test('test-authoring assertion weakening stays draft without a countersign and advances with one recorded on the card', async () => {
    // The kit does not ship this optional profile yet; supply a minimal real profile
    // so dispatch, integrity, quality and delivery all exercise the declared kind.
    const pkg = await fs.mkdtemp(path.join(ROOT, 'test-authoring installed package-'));
    await fs.cp(PKG, pkg, { recursive: true });
    const generic = JSON.parse(await fs.readFile(path.join(pkg, 'profiles/generic/profile.json'), 'utf8'));
    const profileDir = path.join(pkg, 'profiles/test-authoring');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, 'profile.json'), JSON.stringify({ ...generic, kind: 'test-authoring', matchHints: { paths: [], intents: [] }, rubric: [] }));
    await fs.writeFile(path.join(profileDir, 'critique-lens.md'), '1. **Test quality** — Check the assertions.\n');
    const weakened = { files: { ...FIXED.files, 'src/total.test.js': "test('total', () => {\n  expect(total(2, 3)).toBeTruthy();\n});\n" } };
    const critic = (_n, prompt) => {
      const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
      return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 9 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - Checked the change against the reference.`), 'gaming: no - checked the tests', 'findings:', 'resolved: none', 'still-open:', 'cut:', 'brief: none'].join('\n');
    };
    for (const signed of [false, true]) {
      const setup = await makeRepo({ item: { profiles: ['test-authoring'], editSet: ['src/total.js', 'src/total.test.js'], regression: "grep -q 'a + b;' src/total.js" } });
      await prepareProfile(setup, 'test-authoring');
      await fs.writeFile(path.join(setup.repo, 'src/total.test.js'), "test('total', () => {\n  expect(total(2, 3)).toBe(5);\n});\n");
      sh(setup.repo, 'git add src/total.test.js && git commit -q -m "existing test"');
      const reason = 'The old assertion is intentionally replaced for this reviewed change.';
      const qualityHarness = harness({ ...setup, owner: ownerSteps([weakened, weakened]), critic, answers: [signed ? reason : 'no'] });
      const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg, critic: CRITIC }, qualityHarness.api);
      assert.ok(qualityHarness.calls.asks.some(({ question }) => question.includes('test-edit src/total.test.js:2') && question.includes('assertion-drop src/total.test.js:2')));
      if (!signed) {
        assert.equal(quality.state, 'draft', quality.reason);
        const state = JSON.parse(await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
        assert.deepEqual(state.countersigns, []);
        continue;
      }
      assert.equal(quality.state, 'critiqued', quality.reason);
      const expected = ['assertion-drop src/total.test.js:2', 'test-edit src/total.test.js:2'];
      assert.deepEqual(quality.countersigns.map((sign) => sign.subject).sort(), expected);
      assert.ok(quality.countersigns.every((sign) => sign.kind === 'integrity-flag' && sign.by === 'operator' && sign.reason === reason));
      const delivery = harness({ ...setup, owner: ownerSteps([weakened]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg }, delivery.api);
      assert.equal(result.state, 'merge-ready', result.reasons?.join('; ') ?? result.reason);
      const card = readValidCard(result.card);
      assert.equal(card.integrity.pass, true);
      assert.deepEqual(card.integrity.countersigned.map((flag) => `${flag.rule} ${flag.file}:${flag.line}`).sort(), expected);
      assert.deepEqual(card.countersigns, quality.countersigns);
    }
  });

  for (const answer of ['', '   ', null, undefined, false, 'no', ' No ']) {
    test(`an integrity countersign rejects ${String(answer)}`, async () => {
      const setup = await makeRepo();
      const keepsExtra = { files: { 'src/total.js': 'export const total = (a, b) => a + b;\n', 'src/extra.js': 'export const extra = 1;\n' } };
      const { api, calls } = harness({
        ...setup,
        owner: ownerSteps([keepsExtra, keepsExtra]),
        critic: () => criticReply({ head: 9 }),
        answers: [answer, answer, answer, answer],
      });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      assert.equal(result.state, 'draft');
      assert.match(result.reason, /round budget spent/);
      assert.ok(calls.asks.some(({ question }) => question.startsWith('Integrity flags on ')));
      const state = JSON.parse(await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
      assert.match(state.feedback, /Integrity flags to remove/);
      assert.equal(state.countersigns.some((sign) => sign.kind === 'integrity-flag'), false);
    });
  }

  for (const [kind, subject, step, question] of [
    ['irreversible', 'migration.sql', { ...FIXED, card: { irreversible: ['migration.sql'] } }, 'Countersign irreversible step '],
    ['integrity-flag', 'out-of-scope src/extra.js:1', { files: { 'src/total.js': 'export const total = (a, b) => a + b;\n', 'src/extra.js': 'export const extra = 1;\n' } }, 'Integrity flags on '],
  ]) {
    test(`resuming ignores an invalid saved ${kind} countersign`, async () => {
      const setup = await makeRepo();
      const args = { item: setup.itemPath, pkg: PKG, critic: CRITIC };
      const first = harness({ ...setup, owner: ownerSteps([step]), critic: () => criticReply({ head: 9 }), answers: [] });
      await assert.rejects(runWorkflow('mend-quality', args, first.api), /unexpected question/);
      assert.ok(first.calls.asks.some((entry) => entry.question.startsWith(question)));
      const statePath = path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`);
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state.countersigns = [{ kind, subject, by: 'operator', reason: '   ', at: '2026-01-01T00:00:00.000Z' }];
      await fs.writeFile(statePath, JSON.stringify(state));
      const retry = harness({ ...setup, owner: ownerSteps([step]), critic: () => criticReply({ head: 9 }), answers: ['valid synthetic reason'] });
      const result = await runWorkflow('mend-quality', args, retry.api);
      assert.equal(result.state, 'critiqued', result.reason);
      assert.ok(retry.calls.asks.some((entry) => entry.question.startsWith(question)));
      assert.deepEqual(result.countersigns.filter((sign) => sign.kind === kind).map((sign) => sign.reason), ['valid synthetic reason']);
    });
  }

  test('a file outside the edit set is sent back to the owner before any critique, and the fix round goes on', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([
        { files: { 'src/total.js': 'export const total = (a, b) => a + b;\n', 'src/extra.js': 'export const extra = 1;\n' } },
        { files: { 'src/extra.js': null } },
      ]),
      critic: () => criticReply({ head: 9 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.deepEqual(result.rounds.rejectedBy, ['rubric']);
    assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
  });

  test('an owner that stops as blocked spends its round instead of failing the workflow', async () => {
    const setup = await makeRepo();
    const steps = ownerSteps([FIXED]);
    let owners = 0;
    const { api, calls } = harness({
      ...setup,
      owner: async (context) => {
        owners += 1;
        if (owners === 1) throw new Error(`agent("owner ${setup.itemId} r1") failed: blocked: partial implementation, no commit`);
        return steps(context);
      },
      critic: () => criticReply({ head: 9 }),
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.equal(owners, 2);
    assert.equal(result.rounds.rejectedBy.length, 1);
    assert.equal(calls.agents.filter((call) => call.label.startsWith('critique')).length, 1);
  });

  test('when the round budget is spent the item stops at draft with an escalation proposal', async () => {
    const setup = await makeRepo();
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 5 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.equal(result.reason, 'round budget spent');
    assert.deepEqual(result.rejectedBy, ['critique', 'critique']);
    assert.equal(result.escalation.proposed, true);
  });

  test('restarting an exhausted item preserves its rejection budget and critique logs', async () => {
    const setup = await makeRepo();
    const first = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 5 }) });
    const args = { item: setup.itemPath, pkg: PKG, critic: CRITIC };
    const stopped = await runWorkflow('mend-quality', args, first.api);
    assert.equal(stopped.state, 'draft');
    const log = path.join(setup.worktree, `.mend/evidence/${setup.itemId}/critique-r1.md`);
    const original = readFileSync(log, 'utf8');
    const second = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const resumed = await runWorkflow('mend-quality', args, second.api);
    assert.equal(resumed.state, 'draft');
    assert.match(resumed.reason, /budget spent/);
    assert.equal(readFileSync(log, 'utf8'), original);
    assert.equal(second.calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  test('a restart keeps the first spec and never asks the planner again', async () => {
    const setup = await makeRepo();
    const args = { item: setup.itemPath, pkg: PKG, critic: CRITIC };
    const first = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 5 }) });
    assert.equal((await runWorkflow('mend-quality', args, first.api)).state, 'draft');
    const second = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }), spec: { spec: 'A different spec that must not replace the frozen one.' } });
    await runWorkflow('mend-quality', args, second.api);
    assert.equal(second.calls.agents.some((call) => call.label.startsWith('spec')), false);
    const stored = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/spec.json`), 'utf8'));
    assert.equal(stored.spec, DEFAULT_SPEC);
  });

  test('a restatement outside the edit set stops before the owner edits anything', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({
      ...setup,
      owner: ownerSteps([FIXED]),
      critic: () => criticReply({ head: 9 }),
      restate: { goal: 'x', finish: 'y', files: ['src/total.js', 'src/other.js'] },
    });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /outside the edit set: src\/other\.js/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  test('the supervisor rejects a restatement that changes the goal or finish condition before integration', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }),
      restate: { goal: 'remove the helper', finish: 'the file is gone', files: ['src/total.js'] },
      supervisor: { approved: true, reason: 'proposal is fine', restatementMatches: false } });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /restatement/i);
    assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  test('the actual committed diff cannot exceed the profile file cap', async () => {
    const setup = await makeRepo({ item: { editSet: ['src/**'] } });
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`src/file${n}.js`, `export const value${n} = ${n};\n`]));
    const { api } = harness({ ...setup, owner: ownerSteps([{ files }]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'draft');
    assert.deepEqual(result.rejectedBy, ['rubric', 'rubric']);
  });

  test('a repository that does not ignore .mend/ is blocked before any worktree is made', async () => {
    const setup = await makeRepo();
    await fs.writeFile(path.join(setup.repo, '.gitignore'), '');
    sh(setup.repo, 'git add -A && git commit -q -m "no ignore"');
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(existsSync(setup.worktree), false);
  });

  test('bugfix proposal measures a red regression and rejects unrelated changes', async () => {
    // `named: false` is an owner that does not list the reproduction: the workflow wrote it and records it itself.
    for (const [unrelated, named] of [[false, true], [true, true], [false, false]]) {
      const command = 'node src/total.test.cjs';
      const setup = await makeRepo({ item: { profiles: ['bugfix'], editSet: ['src/total.js', 'src/total.test.cjs'], regression: command } });
      await prepareProfile(setup, 'bugfix');
      const artifact = `.mend/evidence/${setup.itemId}/proposal/reproduction.json`;
      const plan = `.mend/evidence/${setup.itemId}/proposal/bugfix-proposal.json`;
      const { api, calls } = harness({
        ...setup,
        owner: ownerSteps([{ files: { 'src/total.test.cjs': "const fs = require('node:fs');\nif (fs.readFileSync('src/total.js', 'utf8').includes('+ 0')) { console.error('regression reproduced'); process.exit(1); }\n", ...(unrelated ? { 'src/total.js': 'unrelated change\n' } : {}), ...(named ? {} : { [plan]: '{"plan":"guard the total"}\n' }) }, proposals: [named ? artifact : plan], profileEvidence: { bugfix: { approvedProposal: named ? artifact : plan } }, card: { proof: { changeType: 'bugfix', note: 'src/total.js:1 contains the redundant zero' } } }]),
        critic: (_round, prompt) => {
          const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
          return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The reproduction exercises the regression.`), 'gaming: no - checked'].join('\n');
        },
        supervisor: { approved: false, reason: 'Stop after reviewing the reproduction.', restatementMatches: true },
      });
      const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
      if (unrelated) {
        assert.equal(result.state, 'blocked');
        assert.match(result.reason, /outside the regression test scope/);
        assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
      } else {
        assert.ok(existsSync(path.join(setup.worktree, artifact)), result.reason);
        const red = JSON.parse(await fs.readFile(path.join(setup.worktree, artifact), 'utf8'));
        assert.equal(red.command, command);
        assert.notEqual(red.baseExit, 0);
        assert.match(red.output, /regression reproduced/);
        assert.deepEqual(red.files, ['src/total.test.cjs']);
        assert.ok(calls.agents.some((call) => call.label.startsWith('critique')), result.reason);
      }
    }
  });

  test('bugfix without a declared regression stops before owner dispatch', async () => {
    const setup = await makeRepo({ item: { profiles: ['bugfix'] } });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /needs a regression command/);
    assert.equal(calls.agents.length, 0);
  });

  test('slash model forms are normalized for the owner and critic', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: 'openai/critic', model: 'openai/owner' }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.ok(calls.agents.filter((call) => /^(restate|owner)/.test(call.label)).every((call) => call.model === 'openai:owner'));
    assert.ok(calls.agents.filter((call) => /^(supervise|critique)/.test(call.label)).every((call) => call.model === 'openai:critic'));
  });

  test('already normalized model identifiers retain their provider path', async () => {
    const setup = await makeRepo();
    const model = 'openrouter:anthropic/claude-sonnet-4';
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const result = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: model, model }, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.ok(calls.agents.every((call) => call.model === model));
    const delivery = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, delivery.api);
    assert.equal(delivery.calls.agents.find((call) => call.label.startsWith('audit'))?.model, model);
  });

  test('restart during integration retains the approved proposal', async () => {
    const setup = await makeRepo({ item: { profiles: ['bugfix'], editSet: ['src/total.js', 'src/total.test.cjs'], regression: 'node src/total.test.cjs' } });
    await prepareProfile(setup, 'bugfix');
    const artifact = `.mend/evidence/${setup.itemId}/proposal/reproduction.json`;
    const proposal = { files: { 'src/total.test.cjs': "if (require('node:fs').readFileSync('src/total.js', 'utf8').includes('+ 0')) { console.error('bug'); process.exit(1); }\n" }, proposals: [artifact], profileEvidence: { bugfix: { approvedProposal: artifact } }, card: { proof: { changeType: 'bugfix', note: 'src/total.js:1 contains the redundant zero' } } };
    const critic = (_round, prompt) => {
      const categories = JSON.parse(prompt.match(/Required score categories \(exact ids\): (\[[^\n]+?\])\./)[1]);
      return ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The reproduction exercises the regression.`), 'gaming: no - checked'].join('\n');
    };
    const first = harness({ ...setup, owner: ownerSteps([proposal]), critic });
    const dispatch = first.api.agent;
    first.api.agent = async (prompt, options) => {
      if (options.label.startsWith('owner')) throw new Error('interrupted integration');
      return dispatch(prompt, options);
    };
    await assert.rejects(runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, first.api), /interrupted integration/);
    const state = JSON.parse(await fs.readFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
    assert.equal(state.phase, 'integration');
    assert.ok(state.proposalApproval.inputs.length);
    const retry = harness({ ...setup, owner: ownerSteps([FIXED]), critic });
    await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, retry.api);
    assert.equal(retry.calls.agents.some((call) => call.label.startsWith('proposal')), false);
    assert.ok(retry.calls.agents.some((call) => call.label.startsWith('owner')));
  });

  test('on the Claude Code engine every agent carries the engine and an exact model', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const runArgs = { item: setup.itemPath, pkg: PKG, critic: 'claude-opus', engine: 'claude', model: 'claude-sonnet' };
    const result = await runWorkflow('mend-quality', runArgs, api);
    assert.equal(result.state, 'critiqued', result.reason);
    assert.deepEqual(
      calls.agents.map((call) => [call.label.split(' ')[0], call.engine, call.model]),
      [['spec', 'claude', 'claude-opus'], ['restate', 'claude', 'claude-sonnet'], ['supervise', 'claude', 'claude-opus'], ['owner', 'claude', 'claude-sonnet'], ['critique', 'claude', 'claude-opus']],
    );
    assert.equal(result.engine, 'claude');
  });

  test('an engine without an exact worker model, or an ACP engine, is refused before anything runs', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    await assert.rejects(runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: 'claude-opus', engine: 'claude' }, api), /model is required/);
    await assert.rejects(runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: 'x', engine: 'acp:opencode', model: 'y' }, api), /do not accept ACP/);
    assert.equal(calls.agents.length, 0);
  });

  test('missing arguments are refused', async () => {
    const setup = await makeRepo();
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    await assert.rejects(runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG }, api), /argument critic is required/);
  });
});

describe('mend-pr', () => {
  async function freezeFixtureQuality(setup) {
    const receiptPath = path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const index = receipt.quality.findIndex((input) => input.path === `.mend/evidence/${setup.itemId}/quality.json`);
    assert.notEqual(index, -1);
    [receipt.quality[index]] = await approvalSnapshot(setup.worktree, [receipt.quality[index]]);
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
  }

  async function critiquedItem(itemOverrides) {
    const setup = await makeRepo({ item: itemOverrides });
    const { api } = harness({
      ...setup,
      owner: ownerSteps([FIXED, FIXED]),
      critic: (n) => (n === 1 ? criticReply({ head: 8, findings: ['F1 [should]', 'F2 [nit]'] }) : criticReply({ head: 8, resolved: ['F1'] })),
    });
    const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, api);
    assert.equal(quality.state, 'critiqued', quality.reason);
    return setup;
  }

  test('requires both audit lanes and preserves actual session identities', async () => {
    const setup = await critiquedItem();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const card = readValidCard(result.card);
    assert.equal(result.state, 'merge-ready');
    assert.deepEqual(card.auditLanes.map((lane) => lane.lane), ['checks', 'driven-path']);
    assert.equal(card.verdict.author, card.owner.session);
    assert.equal(card.verdict.verifier, 'audit-task-1');
    assert.match(calls.agents.find((call) => call.label.startsWith('audit')).prompt, /driven path/i);
  });

  for (const [proof, missing] of [[{ changeType: 'ui' }, 'artifacts'], [{ changeType: 'bugfix' }, 'redGreen'], [{ changeType: 'backend' }, 'figures']]) {
    test(`invalid ${proof.changeType} proof keeps delivery draft`, async () => {
      const setup = await critiquedItem();
      const file = path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`);
      const quality = JSON.parse(await fs.readFile(file, 'utf8'));
      quality.card.proof = proof;
      await fs.writeFile(file, JSON.stringify(quality));
      await freezeFixtureQuality(setup);
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.equal(result.state, 'draft');
      assert.ok(result.cardFailures.some((failure) => failure.rule === 'card-schema' && failure.detail.includes(`missing ${missing}`)), JSON.stringify(result));
    });
  }

  test('missing driven path or session cannot produce a ready card', async () => {
    const setup = await critiquedItem();
    for (const auditor of [
      { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran checks' }], notVerified: [] },
      { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran checks' }, { lane: 'driven-path', result: 'PASS', method: 'drove path' }], notVerified: [], noSession: true },
    ]) {
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '', auditor });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.notEqual(result.state, 'merge-ready');
      assert.notEqual(result.state, 'ready');
    }
  });

  test('same-family audit attention is not attributed as independent cross-family review', async () => {
    const setup = await critiquedItem();
    const auditor = { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran checks' }, { lane: 'driven-path', result: 'PASS', method: 'drove path' }], notVerified: [], attention: ['inspect boundary'] };
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '', auditor });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const card = readValidCard(result.card);
    assert.equal(card.attention, undefined);
    assert.ok(card.notVerified.some((entry) => entry.includes('inspect boundary')));
  });

  test('a failing verification-record command outside item checks prevents readiness', async () => {
    const setup = await critiquedItem();
    const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.steps.push({ name: 'another-check', command: 'test -f src/absent.js', exit: 0 });
    await fs.writeFile(recordPath, JSON.stringify(record));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.notEqual(result.state, 'ready');
    assert.ok(calls.inputs.some(({ command, ...options }) => isHost(command, options, 'execute') && hostData(options).command === 'test -f src/absent.js'));
  });

  test('verification caches do not dirty delivery but actual source edits still do', async () => {
    const setup = await critiquedItem();
    const recordPath = path.join(setup.repo, '.mend/evidence/verify.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    const command = 'mkdir -p cache/__pycache__ && printf cache > cache/build.tsbuildinfo && printf bytecode > cache/__pycache__/helper.pyc';
    record.steps.push({ name: 'cache', command, exit: 0 });
    await fs.writeFile(recordPath, JSON.stringify(record));
    const first = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, first.api);
    assert.ok(result.card, result.reason);
    const card = readValidCard(result.card);
    assert.equal(card.checks.find((entry) => entry.command === command).exit, 0);
    assert.ok(first.calls.agents.some((call) => call.label.startsWith('audit')));
    await fs.writeFile(path.join(setup.worktree, 'src/total.js'), 'real dirty change\n');
    const second = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const blocked = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, second.api);
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.reason, /dirty/);
    assert.equal(second.calls.agents.some((call) => call.label.startsWith('audit')), false);
  });

  test('delivery cannot recapture ignored review policy changed after critique', async () => {
    const setup = await critiquedItem();
    await fs.writeFile(path.join(setup.worktree, '.mend/quality.json'), '{"generatedFiles":["src/**"]}');
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.some((call) => call.label.startsWith('audit')), false);
  });

  for (const [answer, expectedPass, dryRun] of [['The archived export covers recovery', true, true], ['no', false, true], ['', false, true], ['   ', false, true], [null, false, true], [undefined, false, true], [false, false, true], ['The archived export covers recovery', false, false]]) {
    test(`irreversible migration countersign ${String(answer)} with dry run ${dryRun} ${expectedPass ? 'passes review and delivery' : 'blocks before result approval'}`, async () => {
      const fixture = JSON.parse(readFileSync(path.join(PKG, 'profiles/schema-migration/fixtures/migration-safety/pass-irreversible-countersigned.json'), 'utf8'));
      const migration = fixture.files[0];
      const setup = await makeRepo({ item: { profiles: ['schema-migration'], editSet: ['src/total.js', migration.path] } });
      await prepareProfile(setup, 'schema-migration');
      const evidence = `.mend/evidence/${setup.itemId}`;
      const proposal = `${evidence}/migration-plan.json`;
      const categories = MIGRATION_CATEGORIES;
      const reply = criticReply({ head: 8 })
        .replace('\n\nvs:', `\n${categories.map((name) => `| ${name} | 7 | 8 | 8 |`).join('\n')}\n\nvs:`)
        .replace('gaming: no', `${categories.map((name) => `vs: ${name} base=better sum-helper=same - The migration follows the plan.`).join('\n')}\ngaming: no`);
      const scriptedOwner = ownerSteps([
        { files: { [proposal]: JSON.stringify(fixture.plan) }, proposals: [proposal], profileEvidence: { 'schema-migration': { approvedProposal: proposal } } },
        { files: { 'src/total.js': FIXED.files['src/total.js'], [migration.path]: migration.head }, card: { irreversible: [migration.path] } },
      ]);
      const qualityHarness = harness({
        ...setup,
        owner: async (context) => {
          const report = await scriptedOwner(context);
          if (context.prompt.includes('Implement the item') || context.prompt.includes('previous round was sent back')) {
            await captureEvidence({ root: setup.worktree, itemId: setup.itemId, kind: 'compatibility', value: { database: { kind: 'ephemeral' }, combinations: ['base-head', 'head-base'] } });
            if (dryRun) await captureEvidence({ root: setup.worktree, itemId: setup.itemId, kind: 'migration', value: fixture.dryRun });
          }
          return report;
        },
        critic: () => reply,
        answers: expectedPass ? ['approve', 'proposal-reviewer', answer, 'approve', 'result-reviewer'] : ['approve', 'proposal-reviewer', answer, answer],
      });
      const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, qualityHarness.api);
      if (!expectedPass) {
        assert.equal(quality.state, 'draft', quality.reason);
        assert.deepEqual(quality.rejectedBy, ['rubric', 'rubric']);
        assert.equal(qualityHarness.calls.asks.some(({ question }) => question.includes('Approve the result')), false);
        assert.equal(qualityHarness.calls.agents.filter(({ label }) => label.startsWith('critique')).length, 1, 'only the proposal reached critique');
        const state = JSON.parse(await fs.readFile(path.join(setup.worktree, `${evidence}/round-state.json`), 'utf8'));
        assert.match(state.feedback, dryRun ? /rollback-or-irreversible-countersign/ : /dry-run-missing/);
        return;
      }
      assert.equal(quality.state, 'critiqued', quality.reason);
      assert.ok(qualityHarness.calls.asks.some(({ question }) => question.startsWith('Countersign irreversible step ')));
      const migrationResult = quality.checkResults.rubric.profiles.find((entry) => entry.kind === 'schema-migration');
      assert.equal(migrationResult.deferred, undefined);
      assert.equal(migrationResult.checks.find((entry) => entry.id === 'migration-safety').pass, true);
      const sign = quality.countersigns.find((entry) => entry.kind === 'irreversible');
      assert.equal(Boolean(sign), expectedPass);
      if (expectedPass) assert.deepEqual([sign.subject, sign.reason], [migration.path, answer]);
      const audit = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, audit.api);
      const card = readValidCard(result.card);
      assert.equal(card.countersigns.some((entry) => entry.kind === 'irreversible'), expectedPass);
      assert.equal(result.cardFailures.some((failure) => failure.rule === 'rollback-or-irreversible-countersign'), !expectedPass);
      assert.equal(result.state, expectedPass ? 'merge-ready' : 'draft', result.reasons.join('; '));
      assert.equal(card.state, result.state);
    });
  }

  test('the card retains the approved proposal and evidence belonging to each profile', async () => {
    const setup = await critiquedItem();
    const file = path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`);
    const quality = JSON.parse(await fs.readFile(file, 'utf8'));
    quality.approvedProposals = ['preview.html', 'contract.json'];
    quality.profileEvidence = {
      ui: { approvedProposal: 'preview.html', exemplarPairs: [{ exemplar: 'src/view.js', proposal: 'preview.html' }], changeCallouts: [] },
      'api-backend': { approvedProposal: 'contract.json', requests: ['request.log'] },
    };
    quality.plan.profiles.push(
      { kind: 'ui', riskFloor: 'low', proposalArtifact: { name: 'preview' }, cardFields: ['approvedProposal', 'exemplarPairs', 'changeCallouts'] },
      { kind: 'api-backend', riskFloor: 'medium', proposalArtifact: { name: 'contract' }, cardFields: ['approvedProposal', 'requests'] },
    );
    quality.checkResults.rubric.profiles.push(
      { kind: 'ui', rubric: { pass: true, failures: [] } },
      { kind: 'api-backend', rubric: { pass: true, failures: [] } },
    );
    await fs.writeFile(file, JSON.stringify(quality));
    await freezeFixtureQuality(setup);
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const card = readValidCard(result.card);
    assert.equal(card.profiles.find((entry) => entry.kind === 'ui').approvedProposal, 'preview.html');
    assert.deepEqual(card.profiles.find((entry) => entry.kind === 'api-backend').requests, ['request.log']);
    assert.equal(card.profiles.find((entry) => entry.kind === 'api-backend').approvedProposal, 'contract.json');
  });

  test('revoking implementation authorization blocks delivery before checks or auditor dispatch', async () => {
    const setup = await critiquedItem();
    await fs.writeFile(path.join(setup.repo, '.mend/grants.json'), JSON.stringify({ rung: 'investigate', queue: true }));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'blocked');
    assert.equal(calls.agents.length, 0);
    assert.equal(calls.inputs.some(({ command, ...options }) => isHost(command, options, 'execute')), false);
  });

  test('a draft item cannot become ready just because an autopilot grant has a queue', async () => {
    const setup = await critiquedItem({ rung: 'draft' });
    await fs.writeFile(path.join(setup.repo, '.mend/grants.json'), JSON.stringify({ rung: 'autopilot', queue: true }));
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'merge-ready', JSON.stringify(result));
    assert.equal(readValidCard(result.card).rung, 'draft');
    assert.ok(calls.agents[0].prompt.includes(setup.worktree));
  });

  for (const deletion of [false, true]) {
    test(`delivery uses the actual diff to ${deletion ? 'downgrade a deletion' : 'retain low-risk autopilot'}`, async () => {
      const setup = await makeRepo({ item: { rung: 'autopilot', editSet: ['src/total.js', 'notes.txt'] } });
      await fs.writeFile(path.join(setup.repo, 'notes.txt'), 'fixture note\n');
      sh(setup.repo, 'git add notes.txt && git commit -q -m "note"');
      await fs.writeFile(path.join(setup.repo, '.mend/grants.json'), JSON.stringify({ rung: 'autopilot', queue: true }));
      const qualityHarness = harness({
        ...setup,
        owner: ownerSteps([{ files: { ...FIXED.files, ...(deletion ? { 'notes.txt': null } : {}) } }]),
        critic: () => criticReply({ head: 9 }),
      });
      const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, qualityHarness.api);
      assert.equal(quality.state, 'critiqued', quality.reason);
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.equal(result.state, deletion ? 'merge-ready' : 'ready', JSON.stringify(result));
      const card = readValidCard(result.card);
      assert.equal(card.risk.tier, deletion ? 'high' : 'low');
      assert.equal(card.rung, deletion ? 'draft' : 'autopilot');
    });
  }

  test('a critiqued item with a passing audit gets a card that its own card checks accept', async () => {
    const setup = await critiquedItem();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.deepEqual(result.cardFailures, []);
    assert.equal(result.state, 'merge-ready', result.reasons.join('; '));
    const card = readValidCard(result.card);
    assert.equal(card.goal, 'total returns the sum without the redundant zero');
    assert.equal(card.headSha, card.verdict.sha);
    assert.deepEqual(card.critique.findings.map((finding) => [finding.id, finding.status]), [['F1', 'resolved'], ['F2', 'declined']]);
    assert.equal(card.profiles[0].critique.score, 8);
    assert.equal(card.proposalApproval.approver, 'supervisor');
    assert.equal(card.proposalApproval.by, CRITIC);
    assert.ok(card.proposalApproval.reason.length > 0);
    assert.equal(card.rung, 'draft');
    assert.ok(card.checks.some((entry) => entry.command === 'test -f src/total.js' && entry.exit === 0));
    const audit = calls.agents.find((call) => call.label.startsWith('audit'));
    assert.equal(audit.mode, 'work', 'the host gives read mode no shell, and the auditor reruns the checks');
  });

  test('non-blocking integrity warnings do not require countersigns or leave the card draft', async () => {
    const setup = await makeRepo();
    await fs.mkdir(path.join(setup.repo, '.mend'), { recursive: true });
    await fs.writeFile(path.join(setup.repo, '.mend', 'integrity.json'), JSON.stringify({ unsupportedSetting: true }));
    sh(setup.repo, 'git add -f .mend/integrity.json && git commit -q -m "synthetic integrity config warning"');
    const { api: qualityApi } = harness({ ...setup, owner: ownerSteps([FIXED, FIXED]), critic: (n) => (n === 1 ? criticReply({ head: 8, findings: ['F1 [should]'] }) : criticReply({ head: 8, resolved: ['F1'] })) });
    const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, qualityApi);
    assert.equal(quality.state, 'critiqued', quality.reason);
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'merge-ready', result.reasons.join('; '));
    const card = readValidCard(result.card);
    const warning = card.integrity.flags.find((flag) => flag.rule === 'config-warning');
    assert.ok(warning, JSON.stringify(card.integrity.flags));
    assert.equal(warning.severity, 'warn');
    assert.deepEqual(card.integrity.countersigned, []);
    assert.equal(card.integrity.pass, true);
  });

  test('a secret added only to the composed owner card blocks delivery', async () => {
    const fakeToken = `ghp_${'a1B2'.repeat(9)}`;
    const setup = await critiquedItem();
    const qualityPath = path.join(setup.worktree, '.mend', 'evidence', setup.itemId, 'quality.json');
    const quality = JSON.parse(await fs.readFile(qualityPath, 'utf8'));
    quality.card.problem = `token: ${fakeToken}`;
    await fs.writeFile(qualityPath, JSON.stringify(quality));
    await freezeFixtureQuality(setup);
    const { api } = harness({
      ...setup,
      owner: ownerSteps([FIXED]),
      critic: () => '',
    });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const card = readValidCard(result.card);
    assert.equal(card.problem, quality.card.problem);
    assert.equal(result.state, 'draft');
    assert.equal(card.integrity.pass, false);
    assert.ok(card.integrity.flags.some((flag) => flag.rule === 'secret-like' && flag.file === '(card)'));
    assert.ok(!JSON.stringify(card.integrity).includes(fakeToken));
  });

  test('card scanning covers raw owner text, audit messages and base-config patterns', async () => {
    const setup = await makeRepo();
    const customValue = ['internal', 'credential', '4826'].join('-');
    await fs.writeFile(path.join(setup.repo, '.mend', 'integrity.json'), JSON.stringify({ patterns: { 'secret-like': [`^${customValue}$`] } }));
    assert.equal(sh(setup.repo, 'git add -f .mend/integrity.json && git commit -q -m "synthetic secret pattern"').status, 0);
    const { api: qualityApi } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 8 }) });
    const qualityResult = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, qualityApi);
    assert.equal(qualityResult.state, 'critiqued', qualityResult.reason);
    const qualityPath = path.join(setup.worktree, '.mend', 'evidence', setup.itemId, 'quality.json');
    const quality = JSON.parse(await fs.readFile(qualityPath, 'utf8'));
    const value = ['q7R2', 'm9T4', 'v6N8', 'z3L5'].join('');
    for (const source of ['owner', 'audit', 'custom']) {
      quality.card.uncertain = source === 'owner' ? [`password = "${value}"`] : source === 'custom' ? [customValue] : ['none'];
      await fs.writeFile(qualityPath, JSON.stringify(quality));
      await freezeFixtureQuality(setup);
      const { api, calls } = harness({
        ...setup, owner: ownerSteps([FIXED]), critic: () => '',
        auditor: { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: source === 'audit' ? `password = "${value}"` : 'reran checks' }], notVerified: ['production data'] },
      });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      const card = readValidCard(result.card);
      assert.equal(result.state, 'draft', source);
      assert.equal(card.integrity.pass, false, source);
      assert.ok(card.integrity.flags.some((flag) => flag.rule === 'secret-like' && flag.file === '(card)' && flag.severity === 'block'), source);
      assert.equal(card.integrity.flags.some((flag) => flag.file === '(item)' && flag.rule === 'secret-like'), false);
      assert.ok(calls.checks.some((command) => command.includes('integrity.mjs')));
      assert.ok(!JSON.stringify(card.integrity).includes(value));
      assert.ok(!JSON.stringify(card.integrity).includes(customValue));
    }
  });

  test('a justified inapplicable category reaches delivery, but an unjustified one is blocked', async () => {
    const category = 'generic.sink-floor';
    assert.ok(GENERIC_CATEGORIES.includes(category));
    const reply = criticReply({ head: 8 })
      .replace(`| ${category} | 7 | 8 | 8 |`, `| ${category} | n/a | n/a | n/a |`)
      .replace(/^vs: generic\.sink-floor .*$/m, `vs: ${category} base=n/a sum-helper=n/a - Neither helper decrements consumable values.`);
    for (const justified of [false, true]) {
      const setup = await makeRepo();
      const qualityHarness = harness({
        ...setup, owner: ownerSteps([FIXED]),
        critic: () => reply + (justified ? `\nnot-applicable: ${category} - This pure addition helper has no balances, stock or other consumable state.` : ''),
      });
      const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, qualityHarness.api);
      if (!justified) {
        assert.equal(quality.state, 'blocked');
        assert.match(quality.reason, /not-applicable reason/);
        assert.equal(existsSync(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`)), false);
        continue;
      }
      assert.equal(quality.state, 'critiqued', quality.reason);
      assert.equal(quality.critique.rounds.at(-1).scores[category].head, null);
      assert.equal(quality.critiqueScores.generic, 8);
      const delivery = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, delivery.api);
      assert.deepEqual(result.cardFailures, []);
      assert.equal(result.state, 'merge-ready', result.reason ?? result.reasons?.join('; '));
      const card = readValidCard(result.card);
      assert.equal(card.critique.rounds.at(-1).scores[category].head, null);
      assert.equal(card.profiles.find((profile) => profile.kind === 'generic').critique.score, 8);
    }
  });

  test('delivery uses the receipt-protected planned categories for a non-default lens path', async () => {
    const setup = await makeRepo();
    const pkg = await fs.mkdtemp(path.join(ROOT, 'custom installed package-with-long-path-'));
    await fs.cp(PKG, pkg, { recursive: true });
    const profilePath = path.join(pkg, 'profiles/generic/profile.json');
    const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    profile.critiqueLens = 'custom.md';
    await fs.writeFile(path.join(pkg, 'profiles/generic/custom.md'), '1. **Custom goal** — Check the goal.\n2. **Custom evidence** — Check the evidence.\n');
    await fs.writeFile(profilePath, JSON.stringify(profile));
    const categories = ['generic.custom-goal', 'generic.custom-evidence'];
    const reply = ['| category | base | head | sum-helper |', '|---|---|---|---|', ...categories.map((category) => `| ${category} | 7 | 8 | 8 |`), ...categories.map((category) => `vs: ${category} base=better sum-helper=same - The change meets the custom lens.`), 'gaming: no - checked'].join('\n');
    const qualityHarness = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => reply });
    const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg, critic: CRITIC }, qualityHarness.api);
    assert.equal(quality.state, 'critiqued', quality.reason);
    assert.deepEqual(quality.plan.critiqueCategories, categories);
    assert.equal(quality.plan.profiles[0].critiqueLens, path.join(pkg, 'profiles/generic/custom.md'));
    const receipt = JSON.parse(await fs.readFile(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`), 'utf8'));
    assert.ok(receipt.quality.some((input) => input.path.endsWith('/quality.json') && /^[a-f0-9]{64}$/.test(input.sha256)));
    const delivery = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg }, delivery.api);
    assert.deepEqual(result.cardFailures, []);
    assert.equal(result.state, 'merge-ready', result.reasons?.join('; ') ?? result.reason);
    readValidCard(result.card);

    quality.plan.critiqueCategories = ['generic.goal'];
    await fs.writeFile(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`), JSON.stringify(quality));
    const tampered = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const refused = await runWorkflow('mend-pr', { item: setup.itemPath, pkg }, tampered.api);
    assert.equal(refused.state, 'draft');
    assert.match(refused.reason, /approved inputs changed/);
    assert.equal(tampered.calls.agents.some((call) => call.label.startsWith('audit')), false);
  });

  test('on the Claude Code engine the auditor runs there too, on the owners model unless one is given', async () => {
    const setup = await makeRepo();
    const quality = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: 'claude-opus', engine: 'claude', model: 'claude-haiku' }, quality.api);
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const audit = calls.agents.find((call) => call.label.startsWith('audit'));
    assert.deepEqual([audit.engine, audit.model], ['claude', 'claude-haiku']);
    const card = readValidCard(result.card);
    assert.equal(card.owner.model, 'claude-haiku');
    assert.equal(card.verdict.verifierModel, 'claude-haiku');
  });

  test('slash auditor model is normalized before agent dispatch', async () => {
    const setup = await critiquedItem();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG, auditor: 'openai/auditor' }, api);
    const audit = calls.agents.find((call) => call.label.startsWith('audit'));
    assert.ok(audit, result.reason);
    assert.equal(audit.model, 'openai:auditor');
    assert.equal(readValidCard(result.card).verdict.verifierModel, 'openai:auditor');
  });

  test('an auditor that reports issues leaves the card at draft', async () => {
    const setup = await critiquedItem();
    const { api } = harness({
      ...setup,
      owner: ownerSteps([FIXED]),
      critic: () => '',
      auditor: { result: 'ISSUES', lanes: [{ lane: 'checks', result: 'ISSUES', method: 'acceptance line 2 not met' }], notVerified: ['x'] },
    });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'draft');
    assert.ok(result.reasons.some((reason) => /auditor reported ISSUES/.test(reason)));
    assert.equal(readValidCard(result.card).verdict.result, 'ISSUES');
  });

  test('an audit rejection spends the remaining item budget and survives a quality restart', async () => {
    const setup = await critiquedItem();
    const audit = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '',
      auditor: { result: 'ISSUES', lanes: [{ lane: 'checks', result: 'ISSUES', method: 'acceptance not met' }], notVerified: ['x'] } });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, audit.api);
    assert.equal(result.state, 'draft');
    assert.deepEqual(readValidCard(result.card).rounds.rejectedBy, ['critique', 'auditor']);
    const state = JSON.parse(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/round-state.json`), 'utf8'));
    assert.deepEqual(state.rejectedBy, ['critique', 'auditor']);
    const resumed = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => criticReply({ head: 9 }) });
    const quality = await runWorkflow('mend-quality', { item: setup.itemPath, pkg: PKG, critic: CRITIC }, resumed.api);
    assert.equal(quality.state, 'draft');
    assert.match(quality.reason, /budget spent/);
    assert.equal(resumed.calls.agents.some((call) => call.label.startsWith('owner')), false);
  });

  test('an audit blocked without issues does not spend a rejection round', async () => {
    const setup = await critiquedItem();
    const audit = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '',
      auditor: { result: 'BLOCKED', lanes: [{ lane: 'checks', result: 'BLOCKED', method: 'environment unavailable' }], notVerified: ['x'] } });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, audit.api);
    assert.equal(result.state, 'draft');
    assert.deepEqual(readValidCard(result.card).rounds.rejectedBy, ['critique']);
  });

  test('a contract check that fails keeps the card at draft and its real exit on the card', async () => {
    const setup = await critiquedItem({ checks: ['test -f src/missing.js'] });
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'draft');
    const card = readValidCard(result.card);
    assert.equal(card.checks[0].exit, 1);
  });

  test('an item command the guard refuses is never run, since check() bypasses the hooks', async () => {
    const setup = await critiquedItem({ checks: ['git push --force origin main'] });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /git-force/);
    assert.equal(calls.inputs.some(({ command, ...options }) => isHost(command, options, 'execute') && hostData(options).command.includes('push --force')), false);
  });

  test('a head that moved after critique is refused', async () => {
    const setup = await critiquedItem();
    sh(setup.worktree, 'git commit -q --allow-empty -m "late change"');
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /head moved/);
  });

  for (const change of ['unstaged', 'staged', 'untracked']) {
    test(`a ${change} worktree is refused before checks`, async () => {
      const setup = await critiquedItem();
      await fs.writeFile(path.join(setup.worktree, change === 'untracked' ? 'src/new.js' : 'src/total.js'), 'synthetic change\n');
      if (change === 'staged') sh(setup.worktree, 'git add src/total.js');
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.notEqual(result.state, 'merge-ready');
      assert.match(result.reason, /worktree|checkout/i);
      assert.equal(calls.agents.some((call) => call.label.startsWith('audit')), false);
    });
  }

  for (const mutation of ['check', 'audit', 'head']) {
    test(`a ${mutation} mutation prevents a ready card`, async () => {
      const setup = await critiquedItem();
      const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const check = api.check;
      const agent = api.agent;
      api.check = async (command, options) => {
        const result = await check(command, options);
        if (mutation === 'check' && isHost(command, options, 'execute')) await fs.writeFile(path.join(setup.worktree, 'src/total.js'), 'changed by check\n');
        if (mutation === 'head' && isHost(command, options, 'execute')) sh(setup.worktree, 'git commit -q --allow-empty -m mutation');
        return result;
      };
      api.agent = async (prompt, options) => {
        const result = await agent(prompt, options);
        if (mutation === 'audit' && options.label.startsWith('audit')) await fs.writeFile(path.join(setup.worktree, 'src/total.js'), 'changed by audit\n');
        return result;
      };
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.notEqual(result.state, 'merge-ready');
      assert.match(result.reason, /worktree|checkout|head/i);
    });
  }

  for (const response of [
    { ok: false, detail: 'scanner crashed' },
    { ok: true, detail: '{}' },
    { ok: false, detail: '{"pass":true,"flags":[]}' },
    { ok: true, detail: '{"pass":false,"flags":[]}' },
    { ok: false, detail: '{"pass":false,"flags":[{}]}' },
  ]) {
    test(`invalid integrity response blocks: ${response.detail}`, async () => {
      const setup = await critiquedItem();
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const check = api.check;
      api.check = async (command, options) => command.includes('integrity.mjs') ? response : check(command, options);
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /integrity/i);
      assert.equal(calls.agents.some((call) => call.label.startsWith('audit')), false);
    });
  }
  test('editing or removing the approved quality receipt cannot reach the auditor', async () => {
    for (const mutation of ['edit', 'remove']) {
      const setup = await critiquedItem();
      const file = path.join(setup.worktree, `.mend/evidence/${setup.itemId}/quality.json`);
      if (mutation === 'edit') {
        const quality = JSON.parse(await fs.readFile(file, 'utf8'));
        quality.critiqueScores.generic = 10;
        await fs.writeFile(file, JSON.stringify(quality));
      } else {
        await fs.rm(path.join(setup.repo, `.mend/approvals/${setup.itemId}.json`));
      }
      const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
      const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
      assert.equal(result.state, 'draft');
      assert.match(result.reason, /approv|changed/i);
      assert.equal(calls.agents.some((call) => call.label.startsWith('audit')), false);
    }
  });

  test('a declared regression command is run at base and head and recorded as red-green', async () => {
    const setup = await critiquedItem({ regression: "grep -q 'a + b;' src/total.js" });
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    const card = readValidCard(result.card);
    assert.equal(card.redGreen.baseExit, 1);
    assert.equal(card.redGreen.headExit, 0);
  });

  test('regression alias and red-green options are forwarded to the delivery runner', async () => {
    const setup = await critiquedItem({ regression: "grep -q 'a + b;' src/total.js || { echo 'synthetic failure'; exit 1; }", regressionSetup: 'true', regressionKeep: 'echo preserved', regressionExpect: 'synthetic failure', regressionTimeoutMs: 1234 });
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'merge-ready', result.reasons.join('; '));
    const card = readValidCard(result.card);
    assert.equal(card.redGreen.setup, 'true');
    assert.equal(card.redGreen.expectBase, 'synthetic failure');
    assert.equal(card.redGreen.timeoutMs, 1234);
    assert.deepEqual(card.redGreen.keep, { command: 'echo preserved', baseExit: 0, headExit: 0, logs: { base: 'preserved\n', head: 'preserved\n' } });
    const invocation = calls.inputs.find(({ command }) => command.includes('red-green.mjs'));
    const forwarded = inputArgs(invocation);
    for (const [flag, value] of [['--setup', 'true'], ['--expect-base', 'synthetic failure'], ['--timeout-ms', '1234'], ['--keep', 'echo preserved']]) {
      assert.equal(forwarded[forwarded.indexOf(flag) + 1], value);
      assert.equal(invocation.command.includes(flag), false, 'regression data must only travel by stdin');
    }
  });

  test('a failed red-green result is rejected even when its exits look red then green', async () => {
    const setup = await critiquedItem({ regression: "grep -q 'a + b;' src/total.js", regressionExpect: 'MISSING_SIGNATURE' });
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => '' });
    const result = await runWorkflow('mend-pr', { item: setup.itemPath, pkg: PKG }, api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /red-green did not pass/);
    assert.match(result.reason, /expected \/MISSING_SIGNATURE\//);
  });
});

describe('mend-lite', () => {
  const MERGE = { verdict: 'merge', summary: 'Meets the item and the spec.', findings: [{ severity: 'nit', file: 'src/total.js', issue: 'name the helper' }] };
  const BLOCKER = { verdict: 'fix', summary: 'One case is missing.', findings: [{ severity: 'blocker', file: 'src/total.js', issue: 'negative numbers keep the zero' }] };
  const lite = (setup, extra = {}) => runWorkflowLite({ item: setup.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model', ...extra });
  let runWorkflowLite;
  const start = (setup, options) => {
    const made = harness({ ...setup, ...options });
    runWorkflowLite = (runArgs) => runWorkflow('mend-lite', runArgs, made.api);
    return made;
  };
  const labels = (calls) => calls.agents.map((call) => call.label.split(' ')[0] + (call.label.match(/ r\d$/)?.[0] ?? ''));

  test('the strong model specs read-only, the cheap owner builds, the workflow verifies and the reviewer merges', async () => {
    const setup = await makeRepo();
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.deepEqual(labels(calls), ['spec', 'owner r1', 'critique r1']);
    const [spec, owner, critique] = calls.agents;
    assert.deepEqual([spec.mode, spec.model], ['read', CRITIC]);
    assert.deepEqual([owner.model, critique.mode, critique.model], ['cheap-test-model', 'read', CRITIC]);
    // Readers get no skills or shell; the owner keeps its full toolset.
    assert.deepEqual([spec.allowedTools, critique.allowedTools, owner.allowedTools], [['read', 'grep', 'glob'], ['read', 'grep', 'glob'], undefined]);
    assert.ok(owner.prompt.includes(`.mend/evidence/${setup.itemId}/spec.md`));
    assert.equal(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/spec.md`), 'utf8'), DEFAULT_SPEC + '\n');
    assert.ok(existsSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/verify-r1-1.log`)), 'the workflow ran verification itself');
    assert.match(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/diff-r1.patch`), 'utf8'), /\+export const total = \(a, b\) => a \+ b;/);
    const card = JSON.parse(readFileSync(path.join(setup.worktree, result.card), 'utf8'));
    assert.equal(card.state, 'reviewed');
    assert.equal(card.head, result.head);
    assert.deepEqual(card.review.findings, MERGE.findings, 'nits reach the human without blocking');
  });

  test('on the Claude Code engine every agent carries the engine and no tool allowlist it cannot enforce', async () => {
    const setup = await makeRepo();
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup, { engine: 'claude', model: 'claude-sonnet', critic: 'claude-opus' });
    assert.equal(result.state, 'reviewed', result.reason);
    assert.deepEqual(calls.agents.map((call) => [call.label.split(' ')[0], call.engine, call.model, call.allowedTools]), [['spec', 'claude', 'claude-opus', undefined], ['owner', 'claude', 'claude-sonnet', undefined], ['critique', 'claude', 'claude-opus', undefined]]);
  });

  test('an item with profiles the setup never verified still runs: mend-lite needs only the generic verification', async () => {
    const setup = await makeRepo({ item: { profiles: ['bugfix', 'schema-migration'] } });
    start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
  });

  test('an owner that deletes the untracked setup does not break verification: the workflow restores it', async () => {
    const setup = await makeRepo();
    // As in the pilots: the verification skill is local setup, not tracked by the repository.
    sh(setup.repo, 'git rm -q -r --cached .mendcode && git commit -q -m "untrack local verification"');
    const steps = ownerSteps([FIXED]);
    const { calls } = start(setup, {
      owner: async (context) => {
        const result = await steps(context);
        await fs.rm(path.join(context.worktree, '.mendcode'), { recursive: true, force: true });
        return result;
      },
      critic: () => MERGE,
    });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.ok(existsSync(path.join(setup.worktree, '.mendcode/skills/verify-fixture/SKILL.md')));
    assert.match(calls.agents[1].prompt, /never delete, move, edit or commit them/);
  });

  test('a declared regression is proven red at base and green at head, and the card carries it with the delivery risk tier', async () => {
    const setup = await makeRepo({ item: { regression: "grep -q 'a + b;' src/total.js" } });
    start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.equal(result.redGreen.pass, true);
    assert.notEqual(result.redGreen.baseExit, 0);
    assert.equal(result.redGreen.headExit, 0);
    assert.ok(['low', 'medium', 'high'].includes(result.risk.tier), JSON.stringify(result.risk));
    const card = JSON.parse(readFileSync(path.join(setup.worktree, result.card), 'utf8'));
    assert.deepEqual([card.redGreen, card.risk], [result.redGreen, result.risk]);
  });

  test('a regression that already passes at base sends the owner back instead of reaching review', async () => {
    const setup = await makeRepo({ item: { regression: 'test -f src/total.js' } });
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /must fail at base and pass at head/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
  });

  test('without a declared regression the card records no red-green but still a risk tier', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.redGreen, null);
    assert.ok(result.risk.tier);
  });

  test('a reviewer blocker sends exactly that blocker back for one fix round', async () => {
    const setup = await makeRepo();
    const { calls } = start(setup, { owner: ownerSteps([FIXED, FIXED]), critic: (n) => (n === 1 ? BLOCKER : MERGE) });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.deepEqual(labels(calls), ['spec', 'owner r1', 'critique r1', 'owner r2', 'critique r2']);
    assert.match(calls.agents[3].prompt, /fix round 2/);
    assert.match(calls.agents[3].prompt, /negative numbers keep the zero/);
  });

  test('a blocker after the last round leaves a draft with the review for the human', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => BLOCKER });
    const result = await lite(setup, { fixRounds: 0 });
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /reviewer still finds blockers/);
    assert.equal(result.review.verdict, 'fix');
  });

  test('failing repository verification goes back to the owner without paying for a review', async () => {
    const setup = await makeRepo({ item: { editSet: ['src/total.js', 'src/marker.js'] } });
    const record = path.join(setup.repo, '.mend/evidence/verify.json');
    const verify = JSON.parse(readFileSync(record, 'utf8'));
    verify.steps.push({ name: 'marker', command: 'test -f src/marker.js', exit: 0 });
    await fs.writeFile(record, JSON.stringify(verify));
    const { calls } = start(setup, { owner: ownerSteps([FIXED, { files: { 'src/marker.js': 'export {};\n' } }]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.deepEqual(labels(calls), ['spec', 'owner r1', 'owner r2', 'critique r2']);
    assert.match(calls.agents[2].prompt, /repository verification failed/);
    assert.match(calls.agents[2].prompt, /test -f src\/marker\.js/);
  });

  test('a change outside the editSet goes back to the owner', async () => {
    const setup = await makeRepo();
    const { calls } = start(setup, { owner: ownerSteps([{ files: { ...FIXED.files, 'src/reference.js': 'export const sum = 1;\n' } }]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /files outside the editSet changed: src\/reference\.js/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('critique')), false);
  });

  test('an owner that stops early is judged on what it committed instead of failing the workflow', async () => {
    const setup = await makeRepo();
    let call = 0;
    const steps = ownerSteps([FIXED]);
    const { calls } = start(setup, {
      owner: async (context) => {
        call += 1;
        if (call === 1) throw new Error('agent("owner tidy-total r1") failed: blocked: the test file belongs to another session');
        return steps(context);
      },
      critic: () => MERGE,
    });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    assert.match(calls.agents[2].prompt, /nothing was committed/);
  });

  test('a spec longer than the host prompt limit never grows any prompt', async () => {
    const setup = await makeRepo();
    const long = 'Handle this case exactly. '.repeat(600);
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE, spec: { spec: long } });
    const result = await lite(setup);
    assert.equal(result.state, 'reviewed', result.reason);
    for (const call of calls.agents) assert.ok(call.prompt.length <= 8000, `${call.label}: ${call.prompt.length}`);
  });

  for (const empty of [{ spec: '' }, {}, null]) {
    test(`an empty planner spec ${JSON.stringify(empty)} blocks before any owner`, async () => {
      const setup = await makeRepo();
      const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE, spec: empty });
      const result = await lite(setup);
      assert.equal(result.state, 'blocked');
      assert.match(result.reason, /planner returned no spec/);
      assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
    });
  }

  test('a planner that needs files outside the editSet stops before any owner round, naming them', async () => {
    const setup = await makeRepo();
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE, spec: { spec: DEFAULT_SPEC, editSetMissing: ['src/total.js', 'src/registry.js', ' '] } });
    const result = await lite(setup);
    assert.equal(result.state, 'draft');
    assert.deepEqual(result.editSetMissing, ['src/registry.js'], 'paths already inside the editSet and blanks are dropped');
    assert.match(result.reason, /needs files outside its editSet: src\/registry\.js/);
    assert.equal(calls.agents.some((call) => call.label.startsWith('owner')), false);
    assert.equal(readFileSync(path.join(setup.worktree, result.spec), 'utf8'), DEFAULT_SPEC + '\n');
  });

  test('a planner that only names paths already allowed proceeds normally', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE, spec: { spec: DEFAULT_SPEC, editSetMissing: ['src/total.js'] } });
    assert.equal((await lite(setup)).state, 'reviewed');
  });

  test('a restart keeps the first spec and resumes after the recorded rounds', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => BLOCKER });
    assert.equal((await lite(setup, { fixRounds: 0 })).state, 'draft');
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE, spec: { spec: 'A different spec.' } });
    const result = await lite(setup, { fixRounds: 1 });
    assert.equal(result.state, 'reviewed', result.reason);
    assert.deepEqual(labels(calls), ['owner r2', 'critique r2']);
    assert.match(calls.agents[0].prompt, /negative numbers keep the zero/);
    assert.equal(readFileSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}/spec.md`), 'utf8'), DEFAULT_SPEC + '\n');
  });

  test('rerunning a reviewed item returns the recorded result without new agents', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const first = await lite(setup);
    assert.equal(first.state, 'reviewed', first.reason);
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => BLOCKER });
    const again = await lite(setup);
    assert.equal(again.state, 'reviewed', again.reason);
    assert.equal(again.head, first.head);
    assert.equal(calls.agents.length, 0);
  });

  test('a worktree without mend-lite state is refused instead of being reused', async () => {
    const setup = await makeRepo();
    sh(setup.repo, `git worktree add -q -b mend/${setup.itemId} .mend/worktrees/${setup.itemId}`);
    const { calls } = start(setup, { owner: ownerSteps([FIXED]), critic: () => MERGE });
    const result = await lite(setup);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /without a valid mend-lite state/);
    assert.equal(calls.agents.length, 0);
  });

  test('an invalid review blocks rather than counting as a merge', async () => {
    const setup = await makeRepo();
    start(setup, { owner: ownerSteps([FIXED]), critic: () => ({ verdict: 'merge' }) });
    const result = await lite(setup);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /no valid review/);
  });
});

describe('mend-lite-pr', () => {
  const MERGE = { verdict: 'merge', summary: 'Meets the item and the spec.', findings: [{ severity: 'nit', file: 'src/total.js', issue: 'name the helper' }] };
  const AUDIT = { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran test -f src/total.js at head' }, { lane: 'driven-path', result: 'PASS', method: 'imported total and called it' }], drivenSteps: ['node -e "import(\'./src/total.js\').then((m) => console.log(m.total(2, 3)))" printed 5'], notVerified: ['callers outside this repository'] };
  async function reviewed(item) {
    const setup = await makeRepo({ item });
    const { api } = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => MERGE });
    const lite = await runWorkflow('mend-lite', { item: setup.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model' }, api);
    assert.equal(lite.state, 'reviewed', lite.reason);
    return setup;
  }
  const prove = (setup, auditor = AUDIT, extra = {}) => {
    const made = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => MERGE, auditor });
    return { calls: made.calls, result: runWorkflow('mend-lite-pr', { item: setup.itemPath, pkg: PKG, ...extra }, made.api) };
  };

  test('a reviewed item gets a schema-valid light card: checks rerun, an auditor in its own session, merge-ready for a human', async () => {
    const setup = await reviewed();
    const { calls, result: running } = prove(setup);
    const result = await running;
    assert.equal(result.state, 'merge-ready', result.reason);
    const card = readValidCard(result.card);
    assert.equal(card.path, 'light');
    assert.deepEqual(card.checks.map((entry) => [entry.command, entry.exit]), [['test -f src/total.js', 0]]);
    assert.deepEqual([card.verdict.author, card.verdict.verifier, card.verdict.verifierModel], ['owner-task-1', 'audit-task-1', CRITIC]);
    assert.deepEqual(card.review.rounds.map((round) => [round.round, round.verdict, round.diff]), [[1, 'merge', `.mend/evidence/${setup.itemId}/diff-r1.patch`]]);
    assert.deepEqual(card.drivenPath.steps, AUDIT.drivenSteps);
    assert.deepEqual(card.profiles, [{ kind: 'generic', skipped: true, skipReason: card.profiles[0].skipReason }]);
    assert.ok(card.notVerified.some((line) => /light path/.test(line)), 'the missing rubric and scored critique are on the card');
    assert.ok(card.notVerified.some((line) => /name the helper/.test(line)), 'reviewer nits reach the human');
    const audit = calls.agents.find((call) => call.label.startsWith('audit'));
    assert.deepEqual([calls.agents.length, audit.mode, audit.model], [1, 'work', CRITIC]);
    assert.match(audit.prompt, /drivenSteps/);
  });

  test('an auditor that stops blocked is reported with its reason, and other agent errors still fail the run', async () => {
    const setup = await reviewed();
    const made = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => MERGE, auditor: AUDIT });
    let failure = 'agent("audit tidy-total") failed: blocked: the e2e verifier writes files';
    made.api.agent = async () => { throw new Error(failure); };
    const result = await runWorkflow('mend-lite-pr', { item: setup.itemPath, pkg: PKG }, made.api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /auditor stopped before a verdict: the e2e verifier writes files/);
    failure = 'agent("audit tidy-total") failed: interrupted';
    await assert.rejects(runWorkflow('mend-lite-pr', { item: setup.itemPath, pkg: PKG }, made.api), /interrupted/);
  });

  test('an auditor that changes a file is blocked: work mode gives it a shell, the clean-checkout gate keeps it read-only', async () => {
    const setup = await reviewed();
    const made = harness({ ...setup, owner: ownerSteps([FIXED]), critic: () => MERGE, auditor: AUDIT });
    const agent = made.api.agent;
    made.api.agent = async (prompt, options) => {
      if (String(options?.label).startsWith('audit')) await fs.writeFile(path.join(setup.worktree, 'src/total.js'), 'export const total = () => 0;\n');
      return agent(prompt, options);
    };
    const result = await runWorkflow('mend-lite-pr', { item: setup.itemPath, pkg: PKG }, made.api);
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /dirty/);
    assert.equal(existsSync(path.join(setup.worktree, `.mend/evidence/${setup.itemId}.json`)), false, 'no card for a tampered head');
  });

  test('an auditor that drives nothing or finds issues leaves the card draft and says why', async () => {
    const setup = await reviewed();
    const silent = await prove(setup, { ...AUDIT, drivenSteps: [] }).result;
    assert.equal(silent.state, 'draft');
    assert.match(silent.reason, /drove nothing/);
    readValidCard(silent.card);
    const issues = await prove(setup, { ...AUDIT, result: 'ISSUES', lanes: [AUDIT.lanes[0], { lane: 'driven-path', result: 'ISSUES', method: 'total(-1, 1) is wrong at src/total.js:1' }] }).result;
    assert.equal(issues.state, 'draft');
    assert.deepEqual(readValidCard(issues.card).rounds.rejectedBy, ['auditor']);
  });

  test('an item mend-lite did not review, or whose head moved, gets no card and no auditor', async () => {
    const setup = await makeRepo();
    const fresh = prove(setup);
    assert.match((await fresh.result).reason, /run mend-lite first/);
    assert.equal(fresh.calls.agents.length, 0);
    const done = await reviewed();
    await fs.writeFile(path.join(done.worktree, 'src/total.js'), 'export const total = (a, b) => b + a;\n');
    sh(done.worktree, 'git commit -q -am "after review"');
    const moved = prove(done);
    assert.match((await moved.result).reason, /head moved/);
    assert.equal(moved.calls.agents.length, 0);
  });

  test('a bugfix needs red-green on the light card too: without a regression it stays draft, with one it is merge-ready', async () => {
    const without = await reviewed({ profiles: ['bugfix'] });
    const draft = await prove(without).result;
    assert.equal(draft.state, 'draft');
    assert.ok(draft.cardFailures.some((failure) => failure.detail.includes('missing redGreen')), JSON.stringify(draft));
    const withRegression = await reviewed({ profiles: ['bugfix'], regression: 'grep -q "a + b;" src/total.js' });
    const ready = await prove(withRegression).result;
    assert.equal(ready.state, 'merge-ready', ready.reason);
    const card = readValidCard(ready.card);
    assert.deepEqual([card.redGreen.baseExit !== 0, card.redGreen.headExit], [true, 0]);
  });

  test('an untracked setup helper the workflow copies is not counted as the worker leaving changes behind', async () => {
    const setup = await makeRepo();
    // As in the dashboard pilot: the skill is tracked, its helper script is local and untracked.
    await fs.mkdir(path.join(setup.repo, '.mendcode/skills/verify-fixture/scripts'), { recursive: true });
    await fs.writeFile(path.join(setup.repo, '.mendcode/skills/verify-fixture/scripts/check.sh'), 'test -f src/total.js\n');
    // Like the pilot's owners, this one commits only its own file and leaves the helper untracked.
    const owner = async ({ worktree }) => {
      await fs.writeFile(path.join(worktree, 'src/total.js'), FIXED.files['src/total.js']);
      sh(worktree, 'git add src/total.js && git commit -q -m "drop the zero"');
      return { text: 'Done.', taskId: 'owner-task-1' };
    };
    const { api } = harness({ ...setup, owner, critic: () => MERGE });
    const lite = await runWorkflow('mend-lite', { item: setup.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model' }, api);
    assert.equal(lite.state, 'reviewed', lite.reason);
    assert.ok(existsSync(path.join(setup.worktree, '.mendcode/skills/verify-fixture/scripts/check.sh')), 'the helper was propagated');
    const ready = await prove(setup).result;
    assert.equal(ready.state, 'merge-ready', ready.reason);
    // A file the worker leaves is still caught.
    const stray = await makeRepo();
    const { api: strayApi } = harness({ ...stray, owner: async (context) => { const result = await ownerSteps([FIXED])(context); await fs.writeFile(path.join(stray.worktree, 'notes.txt'), 'scratch\n'); return result; }, critic: () => MERGE });
    const left = await runWorkflow('mend-lite', { item: stray.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model', fixRounds: 0 }, strayApi);
    assert.equal(left.state, 'draft');
    assert.match(left.reason, /uncommitted changes remain: \?\? notes\.txt/);
  });

  test('a regression that needs its declared setup runs it in both clean checkouts, on the light path and its card', async () => {
    const setup = await reviewed({ profiles: ['bugfix'], regression: 'test -f .ready && grep -q "a + b;" src/total.js', regressionSetup: 'touch .ready' });
    const ready = await prove(setup).result;
    assert.equal(ready.state, 'merge-ready', ready.reason);
    const card = readValidCard(ready.card);
    assert.deepEqual([card.redGreen.setup, card.redGreen.baseExit !== 0, card.redGreen.headExit], ['touch .ready', true, 0]);
  });

  test('the schema refuses a light card that claims merge-ready over a blocking review, borrows a critique block or says merged', async () => {
    const setup = await reviewed();
    const card = readValidCard((await prove(setup).result).card);
    const blocked = structuredClone(card);
    blocked.review.verdict = 'fix';
    blocked.review.rounds[0] = { ...blocked.review.rounds[0], verdict: 'fix', findings: [{ severity: 'blocker', file: 'src/total.js', issue: 'wrong' }] };
    assert.ok(validateSchema(CARD_SCHEMA, blocked).length > 0);
    assert.ok(validateSchema(CARD_SCHEMA, { ...card, critique: { threshold: 8, driftTolerance: 1, rounds: [], findings: [] } }).length > 0);
    assert.ok(validateSchema(CARD_SCHEMA, { ...card, state: 'merged' }).length > 0);
    const { review, ...noReview } = card;
    assert.ok(review && validateSchema(CARD_SCHEMA, noReview).some((error) => /missing review/.test(error.message)));
  });
});

describe('mend (one run per item)', () => {
  test('the composed script stays under MendCode\'s 49152-byte limit with room to grow, and carries no whole-line comments of its sources', async () => {
    const source = await fs.readFile(path.join(WORKFLOWS, 'mend.js'), 'utf8');
    assert.ok(Buffer.byteLength(source) <= 49152 - 2048, `mend.js is ${Buffer.byteLength(source)} bytes`);
    const body = source.slice(source.indexOf('async function mendLite('), source.indexOf('\nlet built = await mendLite('));
    assert.deepEqual(body.split('\n').filter((line) => /^\s*\/\//.test(line)), [], 'source comments leaked into the composed script');
  });

  const MERGE = { verdict: 'merge', summary: 'Meets the item and the spec.', findings: [] };
  const PASS = { result: 'PASS', lanes: [{ lane: 'checks', result: 'PASS', method: 'reran test -f src/total.js at head' }, { lane: 'driven-path', result: 'PASS', method: 'imported total and called it' }], drivenSteps: ['total(2, 3) printed 5'], notVerified: ['callers outside this repository'] };
  const ISSUES = { ...PASS, result: 'ISSUES', lanes: [PASS.lanes[0], { lane: 'driven-path', result: 'ISSUES', method: 'total(-1, 1) is wrong at src/total.js:1' }] };

  test('an auditor finding goes back to the owner for one round, then a fresh review and audit make the item merge-ready', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED, { files: { 'src/total.js': 'export const total = (a, b) => b + a;\n' } }]), critic: () => MERGE });
    const agent = api.agent;
    let audits = 0;
    api.agent = async (prompt, options = {}) => {
      if (!String(options.label).startsWith('audit')) return agent(prompt, options);
      calls.agents.push({ label: options.label, prompt });
      audits += 1;
      return { value: audits === 1 ? ISSUES : PASS, text: 'audit', taskId: `audit-task-${audits}` };
    };
    const result = await runWorkflow('mend', { item: setup.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model', fixRounds: 0, publish: 'no' }, api);
    assert.equal(result.state, 'merge-ready', result.reason);
    const owners = calls.agents.filter((call) => String(call.label).startsWith('owner'));
    assert.equal(owners.length, 2, 'one more owner round after the audit, though fixRounds is 0');
    assert.match(owners[1].prompt, /total\(-1, 1\) is wrong at src\/total\.js:1/, 'the second owner round starts from the audit finding');
    assert.equal(calls.agents.filter((call) => String(call.label).startsWith('critique')).length, 2, 'the new head is reviewed again');
    assert.equal(audits, 2);
  });

  test('an auditor that keeps finding problems ends the item as a draft after the audit rounds, never in a loop', async () => {
    const setup = await makeRepo();
    const { api, calls } = harness({ ...setup, owner: ownerSteps([FIXED, { files: { 'src/total.js': 'export const total = (a, b) => b + a;\n' } }, { files: { 'src/total.js': 'export const total = (a, b) => a + b + 0 * 0;\n' } }]), critic: () => MERGE, auditor: ISSUES });
    const result = await runWorkflow('mend', { item: setup.itemPath, pkg: PKG, critic: CRITIC, model: 'cheap-test-model', fixRounds: 0, publish: 'no' }, api);
    assert.equal(result.state, 'draft');
    assert.match(result.reason, /auditor reported ISSUES/);
    assert.equal(calls.agents.filter((call) => String(call.label).startsWith('owner')).length, 2, 'auditRounds defaults to one');
  });

  test('the auditor is told to judge the change, not its own harness, and never to stop over a look it cannot see', () => {
    const source = readFileSync(path.join(WORKFLOWS, 'mend.js'), 'utf8');
    assert.match(source, /Judge the change, not your own tooling/);
    assert.match(source, /never by itself ISSUES or BLOCKED/);
  });

  test('the auditor reports serious maintainability problems to the human as attention, not as ISSUES', () => {
    const source = readFileSync(path.join(WORKFLOWS, 'mend.js'), 'utf8');
    assert.match(source, /serious maintainability problem the review let through in attention with file:line and the fix/);
    assert.match(source, /they are not ISSUES unless they break an acceptance line/);
  });
});
