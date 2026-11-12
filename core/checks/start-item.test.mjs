import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startItem, workflowArgs, StartError } from './start-item.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = {
  '/pkg/autopilot.json': { critic: 'claude-opus', model: 'claude-sonnet', auditor: 'claude-opus', engine: 'claude' },
  '/repo/.mend/items/low.json': { id: 'low', risk: 'low' },
  '/repo/.mend/items/risky.json': { id: 'risky', risk: 'high' },
};
const readJson = (file) => {
  if (!(file in files)) throw new Error(`no file ${file}`);
  return files[file];
};
function recorder(reply) {
  const calls = [];
  const run = (command, args, cwd) => { calls.push({ command, args, cwd }); return reply; };
  return { calls, run };
}
const pause = () => {};
const started = { ok: true, stdout: JSON.stringify({ schema: 'mendcode.cli', kind: 'result', data: { workflow: { workflowId: 'wfl_1', state: 'running' } } }), stderr: '' };

test('a low-risk item starts at once through the CLI, already approved, with the models from autopilot.json', () => {
  const { calls, run } = recorder(started);
  const result = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, run);
  assert.deepEqual(result, { started: true, item: '.mend/items/low.json', workflowId: 'wfl_1' });
  const [{ command, args, cwd }] = calls;
  assert.ok(calls.slice(1).every((call) => call.args[1] === 'show'), 'after the start it only looks at the run');
  assert.equal(command, 'mendcode');
  assert.equal(cwd, '/repo');
  assert.deepEqual(args.slice(0, 5), ['workflow', 'run', '/pkg/workflows/mend.js', '--dir', '/repo']);
  assert.ok(args.includes('--yes'), 'the start needs no card');
  assert.deepEqual(JSON.parse(args[args.indexOf('--args') + 1]), { repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', critic: 'claude-opus', model: 'claude-sonnet', auditor: 'claude-opus', engine: 'claude' });
});

test('a package without an engine (engine null, the native one) passes no engine at all', () => {
  const args = workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/native', readJson: (file) => (file === '/native/autopilot.json' ? { critic: 'gpt-6-astra', model: 'gpt-6.1-terra', auditor: 'gpt-6-astra', engine: null } : readJson(file)) });
  assert.ok(!('engine' in args), JSON.stringify(args));
});

test('a high-risk item is not started until the user said yes to it', () => {
  const { calls, run } = recorder(started);
  const held = startItem({ repo: '/repo', item: '.mend/items/risky.json', pkg: '/pkg', readJson, pause }, run);
  assert.equal(held.started, false);
  assert.match(held.reason, /high risk/);
  assert.equal(calls.length, 0);
  assert.equal(startItem({ repo: '/repo', item: '.mend/items/risky.json', pkg: '/pkg', approved: true, readJson, pause }, run).workflowId, 'wfl_1');
});

test('a refused start or an answer without a workflow id is reported, never taken as started', () => {
  const refused = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, recorder({ ok: false, stdout: '', stderr: 'error: project not trusted' }).run);
  assert.equal(refused.started, false);
  assert.match(refused.reason, /not trusted/);
  const empty = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, recorder({ ok: true, stdout: 'plan: mend', stderr: '' }).run);
  assert.equal(empty.started, false);
});

test('a run that fails in its first seconds is reported as not started, with its reason', () => {
  const run = (command, args) => (args[1] === 'run' ? started : { ok: true, stdout: JSON.stringify({ data: { workflow: { workflowId: 'wfl_1', state: 'failed', reason: 'an agent on another engine needs the full tier' } } }), stderr: '' });
  const result = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, run);
  assert.equal(result.started, false);
  assert.equal(result.workflowId, 'wfl_1');
  assert.match(result.reason, /full tier/);
});

test('named models win, publish no is passed on, and bad paths are refused', () => {
  const args = workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', models: { model: 'claude-haiku' }, publish: 'no', readJson });
  assert.equal(args.model, 'claude-haiku');
  assert.equal(args.publish, 'no');
  assert.throws(() => workflowArgs({ repo: 'repo', item: '.mend/items/low.json', pkg: '/pkg', readJson }), StartError);
  assert.throws(() => workflowArgs({ repo: '/repo', item: '../x.json', pkg: '/pkg', readJson }), StartError);
});

test('the skill starts items with start-item, not with a workflow_script card that dies with the turn', () => {
  const skill = readFileSync(path.join(here, '../skills/mend-autopilot/SKILL.md'), 'utf8');
  assert.match(skill, /checks\/start-item\.mjs/);
  assert.doesNotMatch(skill, /approve every start/i);
  assert.doesNotMatch(skill, /call the `workflow_script` tool/);
});
